import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import sharp from "sharp";
import { z } from "zod";
import { type ServiceKind } from "../../domain/catalogue.js";
import { interviewPlan } from "../../domain/interview.js";
import { personForRanking } from "../../domain/profile-overrides.js";
import { adrianPerson, fixturePerson, jordanPerson, mayaPerson, ninaPerson, recordedYouCamPerson, type Person } from "../../domain/person.js";
import { variantByKey } from "../../domain/knowledge-base.js";
import {
  type Answers,
  type ScoredVariant,
  RENDER_LIMIT,
  PALETTE_LIMIT,
  analysisUnits,
  acceptsPresentation,
  emptyAnswers,
  canRender,
  needsPresentationAnswer,
  previewUnitCost,
  resolvedPresentation,
  selectLooks,
} from "../../domain/scoring.js";
import { errorResponseSchema } from "../../shared/http.js";
import { ImageRejected, normalizeImage } from "../assets/images.js";
import { readUpload } from "../assets/multipart.js";
import type { PrivateStorage } from "../assets/storage.js";
import { AttemptWindow } from "../auth/rate-limit.js";
import type { AppConfig } from "../config.js";
import { analysisCapabilities } from "./analysis.js";
import { crownReadingNotice, enqueueAnalysis, loadAnalysisJobs, retakeReadingNotice, retakeSlotFor, settleDemoAnalysis } from "./jobs.js";
import { reviewRecommendations } from "./llm.js";
import { liveRenderGate } from "./render-gate.js";
import { renderFailureReason } from "./render-failure.js";
import { llmRankLooks } from "./llm-rank.js";
import { compareLooks } from "./compare-notes.js";
import { buildRankCapture, rankCaptureEnabled, writeRankCapture } from "./rank-capture.js";
import { findSharedReference, referenceIdentity, sharedReferenceMessage } from "./render-pick.js";
import { varyReasonsForDisplay } from "./ranking-order.js";
import { waitForVision } from "./llm.js";
import { catalogueReferenceFile, referenceCacheStyle, TEMPLATE_RENDER_REFUSAL, templateRenderRefused } from "./reference-photo.js";
import type { OpenAIClient } from "../providers/openai/client.js";
import { renderLookOnPhoto } from "./render.js";
import {
  publishThumb as publishCatalogueThumb,
  referenceAssetExists,
  personaHasLooks,
  readCatalogueImage,
} from "./catalogue-images.js";
import { cachedPreviewBytes, detailWithSource, renderCacheDir, type PreviewImageSource } from "./render-cache.js";
import { PersonaPhotosMissing, personaPhotosAvailable, seedPersonaPhotos, type PersonaId } from "./persona-photos.js";
import { loadSampleAnalysis } from "./sample-analysis.js";
import {
  countReferences,
  hashToken,
  insertReference,
  insertSession,
  listPhotos,
  listPreviews,
  listReferenceIds,
  listReferences,
  newToken,
  photoForSession,
  previewForSession,
  reserveUnits,
  saveAnalysis,
  saveAnswers,
  saveBrief,
  saveLikes,
  saveSalon,
  savePhoto,
  deletePhoto,
  sessionByBriefToken,
  sessionByToken,
  storageKey,
  type DemoPhoto,
  type DemoSession,
} from "./store.js";

const PRESENTATION_MISSING = "Choose men's styles, women's styles or both before we rank or render haircuts.";

const services = ["haircut", "colour", "beard"] as const;
const createSchema = z.object({
  service: z.enum(services),
  consent: z.literal(true),
  judgeKey: z.string().min(8).max(200).optional(),
});
const renderSchema = z.object({ keys: z.array(z.string().min(1).max(80)).min(1).max(RENDER_LIMIT) });
const likesSchema = z.object({ templateIds: z.array(z.string().min(1).max(80)).max(12) });
const salonSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
const recommendSchema = z.object({ regenerate: z.boolean().optional(),referenceId:z.string().uuid().optional() });

export type DemoRouterOptions = {
  pool: Pool;
  config: AppConfig;
  storage: PrivateStorage;
  now?: () => Date;
  ipLimit?: AttemptWindow;
  openai?: OpenAIClient | null;
};

export function createDemoRouter(options: DemoRouterOptions): Router {
  const router = Router();
  const now = options.now ?? (() => new Date());
  const ipLimit = options.ipLimit ?? new AttemptWindow(30, 10 * 60 * 1000);
  const lean = options.config.demoLean;
  const secure = options.config.appOrigin.startsWith("https:");
  router.use(express.json({ limit: "20kb" }));

  router.post("/demo/sessions", async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Choose a haircut, colour, or beard and accept photo processing.");
        return;
      }
      if (blocked(ipLimit, req, now())) {
        sendError(res, 429, "rate_limited", "Too many demo sessions from this network. Wait a few minutes.");
        return;
      }
      const audience = judgeMatch(options.config.demoJudgeSecret, parsed.data.judgeKey);
      if (audience === "rejected") {
        sendError(res, 401, "unauthenticated", "That judge key was not accepted.");
        return;
      }
      const token = newToken();
      await insertSession(options.pool, {
        service: parsed.data.service,
        tokenHash: hashToken(token),
        now: now(),
        personaId: null,
        audience,
      });
      writeCookie(res, token, secure);
      res.status(201).json({ data: { service: parsed.data.service } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/personas/:personaId", async (req, res, next) => {
    try {
      const persona = await personaOf(req.params.personaId);
      if (!persona) {
        sendError(res, 404, "not_found", "That sample person is not available.");
        return;
      }
      if (!(await personaPhotosAvailable(persona.id))) {
        sendError(res, 409, "persona", "That sample person is not available right now.");
        return;
      }
      if (persona.id === "maya" && !(await personaHasLooks("maya"))) {
        sendError(res, 409, "persona", "The colour sample needs a photo of someone who agreed to be shown.");
        return;
      }
      if (blocked(ipLimit, req, now())) {
        sendError(res, 429, "rate_limited", "Too many demo sessions from this network. Wait a few minutes.");
        return;
      }
      const token = newToken();
      const stamp = now();
      const id = await insertSession(options.pool, {
        service: persona.service,
        tokenHash: hashToken(token),
        now: stamp,
        personaId: persona.id,
      });
      const reserved = await reserveUnits(options.pool, {
        sessionId: id,
        capability: "persona",
        units: 0,
        idempotencyKey: `persona:${id}`,
        now: stamp,
        sessionCap: capFor(options.config, "guest").sessionCap,
        dailyCap: capFor(options.config, "guest").dailyCap,
        audience: "guest",
      });
      if (!reserved.ok) {
        sendError(res, 402, reserved.code, "The demo unit cap is reached.");
        return;
      }
      try {
        await seedPersonaPhotos(options.pool, options.storage, id, persona.id, storageKey);
      } catch (error) {
        if (error instanceof PersonaPhotosMissing) {
          sendError(res, 409, "persona", "That sample person is not available right now.");
          return;
        }
        throw error;
      }
      await saveAnalysis(options.pool, { sessionId: id, analysis: persona.analysis, status: "ready", fingerprint: `persona:${persona.id}` });
      await saveAnswers(options.pool, id, persona.answers);
      await saveLikes(options.pool, id, persona.likes);
      writeCookie(res, token, secure);
      res.status(201).json({ data: { service: persona.service, personaId: persona.id } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/samples", async (_req, res, next) => {
    try {
      res.json({
        data: {
          sample: await personaPhotosAvailable("sample"),
          jordan: await personaPhotosAvailable("jordan"),
          maya: await personaHasLooks("maya") && await personaPhotosAvailable("maya"),
          adrian: await personaPhotosAvailable("adrian"),
          nina: await personaPhotosAvailable("nina"),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/catalogue/:key", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const key = req.params.key ?? "";
      const bytes = await readCatalogueImage(key);
      if (!bytes) {
        sendError(res, 404, "not_found", "That style image is not cached.");
        return;
      }
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, no-store");
      res.end(bytes);
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/session", async (req, res, next) => {
    try {
      const token = readCookie(req.headers.cookie);
      if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        res.json({ data: null });
        return;
      }
      const stamp = now();
      const session = await sessionByToken(options.pool, hashToken(token), stamp);
      if (!session) {
        res.json({ data: null });
        return;
      }
      let current = session.analysisStatus === "running"
        ? await settledSession(options, session, req, stamp)
        : session;
      if (current.analysisStatus === "ready") {
        // The OpenAI vision merge lands after the YouCam jobs finish; without this wait
        // the goal screen reads the YouCam-only profile and shows "Not sure" for the rest.
        await waitForVision(current.id);
        current = await reloadSession(options.pool, req, stamp) ?? current;
      }
      res.json({ data: await view(options.pool, current) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/session/photos", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      if (session.personaId) {
        sendError(res, 409, "persona", "Sample sessions already include photos.");
        return;
      }
      const upload = await readUpload(req);
      if (!upload.ok) {
        sendError(res, upload.status, upload.code, upload.message);
        return;
      }
      if (!acceptedPhotoRoles(session.service).includes(upload.body.role)) {
        sendError(res, 400, "invalid_input", "That photo angle is not used for this service.");
        return;
      }
      let image;
      try {
        image = await normalizeImage(upload.body.file);
      } catch (error) {
        if (error instanceof ImageRejected) {
          sendError(res, 400, "invalid_input", "Upload a JPEG, PNG or WebP photograph under 9 MB.");
          return;
        }
        throw error;
      }
      const key = storageKey();
      await options.storage.write(key, image.bytes);
      const previous = await savePhoto(options.pool, {
        sessionId: session.id,
        role: upload.body.role,
        storageKey: key,
        contentHash: image.contentHash,
        mime: image.mimeType,
      });
      if (previous) await options.storage.remove(previous);
      res.status(201).json({ data: { role: upload.body.role } });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/demo/session/photos/:role", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      if (session.personaId) {
        sendError(res, 409, "persona", "Sample sessions already include photos.");
        return;
      }
      const role = String(req.params.role ?? "");
      if (!acceptedPhotoRoles(session.service).includes(role)) {
        sendError(res, 400, "invalid_input", "That photo angle is not used for this service.");
        return;
      }
      const previousKey = await deletePhoto(options.pool, session.id, role);
      if (previousKey) await options.storage.remove(previousKey);
      res.json({ data: { removed: Boolean(previousKey) } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/session/analyze", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const photos = await listPhotos(options.pool, session.id);
      const missing = requiredRoles(session.service).filter((role) => !photos.some((photo) => photo.role === role));
      if (missing.length > 0) {
        sendError(res, 409, "photos_missing", "Add the missing photos before analysis.");
        return;
      }
      const stamp = fingerprint(photos);
      const recorded = session.analysisFingerprint;
      const sameCapture = recorded === stamp || recorded === `${stamp}:vision`;
      if (session.analysisStatus === "ready" && sameCapture && session.analysis) {
        res.json({ data: { status: "ready", analysis: session.analysis } });
        return;
      }
      const capabilities = analysisCapabilities(session.service, options.config.analysisMode, lean);
      const units = options.config.providerMode === "live" ? analysisUnits(session.service, options.config.analysisMode, lean) : 0;
      const caps = capFor(options.config, session.audience);
      const reserved = await reserveUnits(options.pool, {
        sessionId: session.id,
        capability: "analysis",
        units,
        idempotencyKey: `analysis:${session.id}:${stamp}`,
        now: now(),
        sessionCap: caps.sessionCap,
        dailyCap: caps.dailyCap,
        audience: session.audience,
      });
      if (!reserved.ok) {
        sendError(res, 402, reserved.code, "This session has reached its YouCam unit cap.");
        return;
      }
      if (options.config.providerMode !== "live" || capabilities.length === 0) {
        // With a fixture model wired, the base reading is the sparse one live YouCam gives, so the vision merge fills it as in a live run.
        const analysis = session.personaId ? session.analysis ?? fixturePerson() : options.openai ? recordedYouCamPerson() : fixturePerson();
        await saveAnalysis(options.pool, { sessionId: session.id, analysis, status: "ready", fingerprint: stamp });
        // Fixture mode runs the same vision merge as live when a (fixture) model is wired; a sample person keeps its recorded profile.
        if (options.openai && !session.personaId) {
          await settleDemoAnalysis({ pool: options.pool, storage: options.storage, openai: options.openai, sessionId: session.id, budgetUsd: options.config.openaiBudgetUsd });
        }
        const settled = await reloadSession(options.pool, req, now());
        res.json({ data: { status: "ready", analysis: settled?.analysis ?? analysis } });
        return;
      }
      await enqueueAnalysis(options.pool, { sessionId: session.id, capabilities, fingerprint: stamp, now: now() });
      await settleDemoAnalysis({
        pool: options.pool,
        storage: options.storage,
        openai: options.openai ?? null,
        sessionId: session.id,
        budgetUsd: options.config.openaiBudgetUsd,
      });
      const settled = await reloadSession(options.pool, req, now()) ?? session;
      res.status(settled.analysisStatus === "running" ? 202 : 200).json({ data: { status: settled.analysisStatus } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/session/answers", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const answers = readServiceAnswers(session.service, req.body);
      if (!answers) {
        sendError(res, 400, "invalid_input", "Answer each question by choosing a button.");
        return;
      }
      await saveAnswers(options.pool, session.id, answers, profileOverridesFromBody(req.body));
      res.json({ data: { saved: true } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/session/palette", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      await waitForVision(session.id);
      const analysis = (await reloadSession(options.pool, req, now()))?.analysis ?? session.analysis;
      const selection = analysis
        ? selectLooks({
            service: session.service,
            person: personForRanking(analysis, session.profileOverrides),
            answers: session.answers,
            likes: session.likes,
            limit: PALETTE_LIMIT,
          })
        : null;
      const top = [];
      const all = [];
      const withCatalogueImage = !session.personaId;
      const liveCards = previewUsesLiveYouCam(options.config, session.personaId);
      for (const look of selection?.show ?? []) {
        await publishThumb(look);
        top.push(cardFrom(look, withCatalogueImage, liveCards));
      }
      for (const look of selection?.ranked ?? []) {
        await publishThumb(look);
        all.push(cardFrom(look, withCatalogueImage, liveCards));
      }
      res.json({ data: { top, all } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/session/likes", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const parsed = likesSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Choose styles from the palette.");
        return;
      }
      const ownedReferences=new Set((await listReferenceIds(options.pool,session.id)).map(id=>`reference:${id}`));
      const presentation = resolvedPresentation(personForRanking(session.analysis, session.profileOverrides), session.answers);
      const likes = [...new Set(parsed.data.templateIds.filter((key) => {
        const variant = variantByKey(key);
        return (variant?.service === session.service && acceptsPresentation(variant, presentation)) || ownedReferences.has(key);
      }))];
      await saveLikes(options.pool, session.id, likes);
      res.json({ data: { likes } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/session/references",async(req,res,next)=>{
    try{
      const session=await requireSession(options.pool,req,res,now());
      if(!session)return;
      const references=await listReferences(options.pool,session.id);
      const ranked =
        session.analysis && session.analysisStatus === "ready"
          ? selectLooks({
              service: session.service,
              person: personForRanking(session.analysis, session.profileOverrides),
              answers: session.answers,
              likes: session.likes,
              referenceIds: references.map((item) => item.id),
            }).ranked
          : [];
      res.json({data:references.map(reference=>{
        const match=ranked.find(item=>item.variant.key===`reference:${reference.id}`);
        return {id:reference.id,url:`/api/v1/demo/references/${reference.id}`,match:match ? cardFrom(match,false) : null};
      })});
    }catch(error){next(error);}
  });

  router.get("/demo/references/:referenceId",async(req,res,next)=>{
    try{
      const session=await requireSession(options.pool,req,res,now());
      if(!session)return;
      const reference=(await listReferences(options.pool,session.id)).find(item=>item.id===req.params.referenceId);
      if(!reference){sendError(res,404,"not_found","That reference is not in this session.");return;}
      await streamImage(res,options.storage,reference.storageKey,reference.mime);
    }catch(error){next(error);}
  });

  router.post("/demo/session/references", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      if (await countReferences(options.pool, session.id) >= 3) {
        sendError(res, 409, "too_many", "Three reference photos is the maximum.");
        return;
      }
      const upload = await readUpload(req);
      if (!upload.ok) {
        sendError(res, upload.status, upload.code, upload.message);
        return;
      }
      let image;
      try {
        image = await normalizeImage(upload.body.file);
      } catch (error) {
        if (error instanceof ImageRejected) {
          sendError(res, 400, "invalid_input", "Upload a JPEG, PNG or WebP reference under 9 MB.");
          return;
        }
        throw error;
      }
      const key = storageKey();
      await options.storage.write(key, image.bytes);
      const id = await insertReference(options.pool, { sessionId: session.id, storageKey: key, mime: image.mimeType });
      res.status(201).json({ data: { id } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/session/results", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      res.json({ data: await present(options.pool, session) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/session/compare-notes", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const previews = (await listPreviews(options.pool, session.id)).filter((preview) => preview.status === "ready");
      const person = personForRanking(session.analysis, session.profileOverrides);
      res.json({
        data: await compareLooks({
          sessionId: session.id,
          looks: previews.map((preview) => ({ key: preview.candidateKey, title: preview.title, score: preview.score, label: preview.label, reasons: preview.reasons })),
          person,
          openai: options.openai ?? null,
          budgetUsd: options.config.openaiBudgetUsd,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/session/recommend", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      if (session.analysisStatus === "failed") {
        const jobs = await loadAnalysisJobs(options.pool, session.id);
        sendError(res, 409, "retake", retakeReadingNotice(jobs));
        return;
      }
      if (!session.analysis || session.analysisStatus !== "ready") {
        sendError(res, 409, "analysis_missing", "Wait for the photo reading to finish.");
        return;
      }
      if (needsPresentationAnswer(session.service, personForRanking(session.analysis, session.profileOverrides), session.answers)) {
        sendError(res, 409, "presentation_missing", PRESENTATION_MISSING);
        return;
      }
      const parsed = recommendSchema.safeParse(req.body ?? {});
      if(!parsed.success){sendError(res,400,"invalid_input","Choose a saved reference and try again.");return;}
      const regenerate = parsed.data.regenerate === true;
      const referenceId=parsed.data.referenceId;
      const availableReferences=await listReferenceIds(options.pool,session.id);
      if(referenceId && !availableReferences.includes(referenceId)){
        sendError(res,404,"not_found","That reference is not in this session.");
        return;
      }
      const existing = await listPreviews(options.pool, session.id);
      if (existing.length > 0 && !regenerate) {
        res.json({ data: await present(options.pool, session) });
        return;
      }
      const inputsKey = createHash("sha256")
        .update(JSON.stringify([session.answers, session.likes, session.profileOverrides, referenceId ? [referenceId] : availableReferences]))
        .digest("hex");
      if (!regenerate && isRecord(session.recommendation) && session.recommendation.inputsKey === inputsKey && Array.isArray(session.recommendation.show) && session.recommendation.show.length > 0) {
        res.json({ data: await present(options.pool, session) });
        return;
      }
      await settleDemoAnalysis({ pool: options.pool, storage: options.storage, openai: options.openai ?? null, sessionId: session.id, budgetUsd: options.config.openaiBudgetUsd });
      await waitForVision(session.id);
      const fresh = await reloadSession(options.pool, req, now()) ?? session;
      const person = personForRanking(fresh.analysis, session.profileOverrides);
      const selection = selectLooks({
        service: session.service,
        person,
        answers: session.answers,
        likes: session.likes,
        referenceIds: referenceId ? [referenceId] : availableReferences,
      });
      const deterministic = reviewRecommendations(selection.show);
      const ranking = options.openai
        ? await llmRankLooks({ person, ranked: selection.ranked, fallback: deterministic, openai: options.openai, budgetUsd: options.config.openaiBudgetUsd, answers: session.answers })
        : { show: deterministic, path: "fallback" as const, note: "no model configured" };
      if (rankCaptureEnabled()) {
        try {
          writeRankCapture(buildRankCapture({ person, ranking, answers: session.answers, likes: session.likes }), session.id);
        } catch (error) {
          console.warn(`demo_rank_capture failed: ${error instanceof Error ? error.name : "error"}`);
        }
      }
      const liveCards = previewUsesLiveYouCam(options.config, session.personaId);
      const varied = varyReasonsForDisplay({ show: ranking.show, goals: selection.goals, person, answers: session.answers, toCard: (look) => cardFrom(look, false, liveCards) });
      const reviewed = varied.show;
      const briefToken = newToken();
      const recommendation = {
        inputsKey,
        rankPath: ranking.path,
        rankNote: ranking.note,
        show: reviewed.map((look) => cardFrom(look, false, liveCards)),
        goals: varied.goals.map((look) => ({
          ...cardFrom(look, false, liveCards),
          missingCm: look.growth?.missingCm ?? null,
          months: look.growth?.months ?? null,
        })),
      };
      await saveBrief(options.pool, session.id, hashToken(briefToken), recommendation);
      res.setHeader("Set-Cookie", briefCookie(briefToken, secure));
      res.json({ data: { ...await present(options.pool, session), briefToken, recommendations: recommendation.show, goals: recommendation.goals, rankPath: ranking.path, rankNote: ranking.note } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/session/questions", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      res.json({ data: interviewPlan(session.analysis ?? fixturePerson(), session.service) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/session/renders", async (req, res, next) => {
    let client:PoolClient|undefined;
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      if (!session.analysis || session.analysisStatus !== "ready") {
        sendError(res, 409, "analysis_missing", "Wait for the photo reading to finish.");
        return;
      }
      if (needsPresentationAnswer(session.service, personForRanking(session.analysis, session.profileOverrides), session.answers)) {
        sendError(res, 409, "presentation_missing", PRESENTATION_MISSING);
        return;
      }
      const parsed = renderSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Choose one to three styles.");
        return;
      }
      client=await options.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE",[session.id]);
      const existing = await listPreviews(client, session.id);
      const active = existing.filter((preview) => preview.status === "ready" || preview.status === "pending");
      const activeKeys = new Set(active.map((preview) => preview.candidateKey));
      const newKeys = parsed.data.keys.filter((key) => !activeKeys.has(key));
      if (active.length + newKeys.length > RENDER_LIMIT) {
        sendError(res, 409, "too_many", "Three previews is the maximum for a session.");
        return;
      }
      if (newKeys.length === 0) {
        await client.query("COMMIT");
        client.release();
        client = undefined;
        res.json({ data: await present(options.pool, session) });
        return;
      }
      const selection = selectLooks({
        service: session.service,
        person: personForRanking(session.analysis, session.profileOverrides),
        answers: session.answers,
        likes: session.likes,
        referenceIds: await listReferenceIds(client, session.id),
        limit: PALETTE_LIMIT,
      });
      const refused = selection.ranked.find((look) => parsed.data.keys.includes(look.variant.key) && !canRender(look));
      if (refused) {
        sendError(res, 409, "not_on_your_hair", `${refused.variant.title} does not work on your hair. ${refused.feasibility.failReason ?? ""}`.trim());
        return;
      }
      const templateOnly = selection.ranked.find((look) => parsed.data.keys.includes(look.variant.key) && templateRenderRefused(look.variant));
      if (templateOnly) {
        sendError(res, 409, "no_colour_safe_render", `${templateOnly.variant.title}: ${TEMPLATE_RENDER_REFUSAL}`);
        return;
      }
      // A style YouCam has no reference for is never rendered live: refuse it up front instead of saving a "skipped" row that looks pending forever.
      const unrunnable = previewUsesLiveYouCam(options.config, session.personaId)
        ? selection.ranked.find((look) => newKeys.includes(look.variant.key) && !runnablePreview(look))
        : undefined;
      if (unrunnable) {
        sendError(res, 409, "no_preview_for_style", `${unrunnable.variant.title} cannot be previewed yet. Pick a different style.`);
        return;
      }
      const available = new Map(selection.ranked.filter(canRender).map((look) => [look.variant.key, look]));
      const requested = parsed.data.keys.flatMap((key) => {
        const look = available.get(key);
        return look ? [look] : [];
      });
      if (requested.length !== parsed.data.keys.length) {
        sendError(res, 400, "invalid_input", "Choose styles from the recommendations.");
        return;
      }
      const chosen = newKeys.flatMap((key) => {
        const look = available.get(key);
        return look ? [look] : [];
      });
      // Two picks from one reference photo would render the same picture twice: refuse before a task or a unit is spent.
      const shared = findSharedReference(
        [...activeKeys, ...newKeys].flatMap((key) => {
          const look = available.get(key);
          return look ? [{ title: look.variant.title, ref: referenceIdentity(look.variant) }] : [];
        }),
      );
      if (shared) {
        sendError(res, 400, "same_reference_photo", sharedReferenceMessage(shared.first, shared.second));
        return;
      }
      const photos = await listPhotos(client, session.id);
      const frontPhoto = photos.find((photo) => photo.role === "front") ?? null;
      const frontBytes = frontPhoto ? await readStored(options.storage, frontPhoto.storageKey) : await fixturePortrait();
      const frontHash = frontPhoto?.contentHash ?? null;
      const live = previewUsesLiveYouCam(options.config, session.personaId);
      const cacheDir = renderCacheDir(options.config.renderCacheDir);
      let youcamCount = 0;
      if (live) {
        for (const look of chosen) {
          if (!runnablePreview(look)) continue;
          const cached = frontHash
            ? await cachedPreviewBytes({ cacheDir, frontContentHash: frontHash, candidateKey: look.variant.key, templateId: templateIdForLook(look) })
            : null;
          if (!cached) youcamCount += 1;
        }
      }
      const gate = liveRenderGate({ live: live && youcamCount > 0, recommendation: session.recommendation });
      if (gate) {
        console.warn(`demo_render_refused code=${gate.code} session=${session.id}`);
        sendError(res, gate.status, gate.code, gate.message);
        return;
      }
      const units = live ? youcamCount * previewUnitCost(session.service) : 0;
      const caps = capFor(options.config, session.audience);
      const reserved = await reserveUnits(options.pool, {
        sessionId: session.id,
        capability: "previews",
        units,
        idempotencyKey: `renders:${session.id}:${parsed.data.keys.slice().sort().join(",")}`,
        now: now(),
        sessionCap: caps.sessionCap,
        dailyCap: caps.dailyCap,
        audience: session.audience,
      },client);
      if (!reserved.ok) {
        sendError(res, 402, reserved.code, "This session has reached its YouCam unit cap.");
        return;
      }
      for (const look of chosen) {
        const planned = await planPreviewRow({
          live,
          look,
          frontBytes,
          frontHash,
          cacheDir,
          personaId: session.personaId,
          storage: options.storage,
        });
        await client.query(
          `INSERT INTO demo_previews (id, session_id, candidate_key, title, score, label, reasons, status, storage_key, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)`,
          [
            randomUUID(),
            session.id,
            look.variant.key,
            look.variant.title,
            shownScore(session.recommendation, look.variant.key) ?? look.score,
            look.label,
            JSON.stringify(previewReasons(withBriefScript(session.recommendation, look))),
            planned.status,
            planned.storageKey,
            planned.source ? JSON.stringify(detailWithSource(planned.source)) : "{}",
          ],
        );
        if (planned.status === "pending") {
          const referenceId = look.variant.key.startsWith("reference:") ? look.variant.key.slice("reference:".length) : null;
          const capability = look.variant.service === "colour" ? "hair-color" : look.variant.service === "beard" ? "beard" : "hairstyle";
          await client.query(
            `INSERT INTO demo_jobs (id, session_id, capability, status, units, idempotency_key, payload, created_at, updated_at)
             VALUES ($1, $2, $3, 'queued', 0, $4, $5::jsonb, $6, $6)`,
            [randomUUID(), session.id, capability, `job:${session.id}:${look.variant.key}:${photos.length}`, JSON.stringify({
              candidateKey: look.variant.key,
              ...(look.variant.reference.kind === "youcam" && look.variant.service !== "colour" ? { templateId: look.variant.reference.templateId } : {}),
              ...(catalogueReferenceFile(look.variant) ? { catalogueRef: catalogueReferenceFile(look.variant), cacheStyle: templateIdForLook(look) } : {}),
          ...(look.variant.reference.kind === "asset" ? { assetFile: look.variant.reference.file } : {}),
              ...(look.variant.preset ? { preset: look.variant.preset } : {}),
              ...(referenceId ? { referenceId } : {}),
            }), now()],
          );
        }
      }
      await client.query("COMMIT");client.release();client=undefined;
      res.json({ data: await present(options.pool, session) });
    } catch (error) {
      next(error);
    } finally {if(client){await client.query("ROLLBACK");client.release();}}
  });

  router.post("/demo/previews/:previewId/retry",async(req,res,next)=>{
    let client:PoolClient|undefined;
    try{
      const session=await requireSession(options.pool,req,res,now());if(!session)return;
      client=await options.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE",[session.id]);
      const previews=await listPreviews(client,session.id);
      const preview=previews.find(item=>item.id===req.params.previewId);
      if(!preview){sendError(res,404,"not_found","That preview is not in this session.");return;}
      const active=previews.filter(item=>item.status==="ready" || item.status==="pending");
      if(active.some(item=>item.candidateKey===preview.candidateKey)){await client.query("ROLLBACK");client.release();client=undefined;res.json({data:await present(options.pool,session)});return;}
      if(preview.status!=="failed"){sendError(res,409,"invalid_state","Choose another style to create a preview.");return;}
      if(active.length>=RENDER_LIMIT){sendError(res,409,"too_many","Three previews is the maximum for a session.");return;}
      if(!session.analysis || session.analysisStatus!=="ready"){sendError(res,409,"analysis_missing","Review your photos before retrying this preview.");return;}
      const selection = selectLooks({
        service: session.service,
        person: personForRanking(session.analysis, session.profileOverrides),
        answers: session.answers,
        likes: session.likes,
        referenceIds: await listReferenceIds(client, session.id),
      });
      const look=selection.ranked.find(item=>item.variant.key===preview.candidateKey && canRender(item) && !templateRenderRefused(item.variant));
      if(!look){sendError(res,409,"invalid_state","This style is no longer available for your current hair. Choose another style.");return;}
      const live=previewUsesLiveYouCam(options.config,session.personaId);
      if(!live){
        const photos=await listPhotos(client,session.id);const front=photos.find(photo=>photo.role==="front");
        const bytes=front ? await readStored(options.storage,front.storageKey) : await fixturePortrait();
        let key=preview.storageKey;
        if(!key || !await options.storage.exists(key)){key=storageKey();await options.storage.write(key,await renderLookOnPhoto(bytes,look.variant.key,session.personaId));}
        await client.query(`UPDATE demo_previews SET status='ready',storage_key=$3,detail=$4::jsonb WHERE id=$1 AND session_id=$2 AND status='failed'`,[preview.id,session.id,key,JSON.stringify(detailWithSource("fixture"))]);
      }else{
        const jobs=await client.query<{id:string;attempt:number}>(
          `SELECT id,COALESCE((payload->>'retryAttempt')::integer,0) AS attempt FROM demo_jobs WHERE session_id=$1 AND payload->>'candidateKey'=$2 AND status='failed' ORDER BY updated_at DESC LIMIT 1`,[session.id,preview.candidateKey]);
        const job=jobs.rows[0];
        if(!job || !runnablePreview(look)){sendError(res,409,"invalid_state","Choose another style to create a preview.");return;}
        const gate=liveRenderGate({live:true,recommendation:session.recommendation});
        if(gate){sendError(res,gate.status,gate.code,gate.message);return;}
        const stamp=now();const caps=capFor(options.config,session.audience);
        const reserved=await reserveUnits(options.pool,{sessionId:session.id,capability:"previews",units:previewUnitCost(session.service),idempotencyKey:`retry:${job.id}:${job.attempt+1}`,now:stamp,sessionCap:caps.sessionCap,dailyCap:caps.dailyCap,audience:session.audience},client);
        if(!reserved.ok){sendError(res,402,reserved.code,"This session has reached its YouCam unit cap.");return;}
        await client.query(
          `WITH retried AS (UPDATE demo_jobs SET status='queued',provider_task_id=NULL,submitted_at=NULL,error_code=NULL,result='{}'::jsonb,storage_key=NULL,updated_at=$4,payload=jsonb_set(payload,'{retryAttempt}',to_jsonb($3::integer+1)) WHERE id=$1 AND session_id=$2 AND status='failed' AND COALESCE((payload->>'retryAttempt')::integer,0)=$3 RETURNING id)
           UPDATE demo_previews SET status='pending',storage_key=NULL WHERE id=$5 AND session_id=$2 AND status='failed' AND EXISTS(SELECT 1 FROM retried)`,[job.id,session.id,job.attempt,stamp,preview.id]);
      }
      await client.query("COMMIT");client.release();client=undefined;
      res.json({data:await present(options.pool,session)});
    }catch(error){next(error);}finally{if(client){await client.query("ROLLBACK");client.release();}}
  });

  router.get("/demo/brief/:token", async (req, res, next) => {
    try {
      const token = req.params.token ?? "";
      if (!/^[a-f0-9]{64}$/.test(token)) {
        sendError(res, 404, "not_found", "That brief is not available.");
        return;
      }
      const session = await sessionByBriefToken(options.pool, hashToken(token), now());
      if (!session || !isRecord(session.recommendation)) {
        sendError(res, 404, "not_found", "That brief is not available.");
        return;
      }
      const show = Array.isArray(session.recommendation.show) ? session.recommendation.show : [];
      const cards = new Map<string, Record<string, unknown>>();
      for (const item of show) {
        if (isRecord(item) && typeof item.key === "string") cards.set(item.key, item);
      }
      const previews = (await listPreviews(options.pool, session.id)).filter((preview) => preview.status === "ready" && preview.storageKey);
      const photos = await listPhotos(options.pool, session.id);
      const salon = salonSchema.safeParse(session.recommendation.salon);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Robots-Tag", "noindex");
      res.json({
        data: {
          service: session.service,
          salon: salon.success ? salon.data : null,
          expiresAt: session.expiresAt.toISOString(),
          photoUrl: photos.some((photo) => photo.role === "front") ? `/api/v1/demo/brief/${token}/photo` : null,
          analysis: session.analysis,
          answers: session.answers,
          looks: previews.map((preview) => {
            const card = cards.get(preview.candidateKey);
            return {
              id: preview.id,
              key: preview.candidateKey,
              title: preview.title,
              score: preview.score,
              reasons: preview.reasons,
              imageUrl: `/api/v1/demo/brief/${token}/preview/${preview.id}`,
              tellYourBarber: typeof card?.tellYourBarber === "string" && card.tellYourBarber.trim()
                ? card.tellYourBarber
                : typeof card?.stylistScript === "string" && card.stylistScript.trim().length >= 8
                  ? card.stylistScript.trim().slice(0, 180)
                  : null,
              stylingMinutes: typeof card?.stylingMinutes === "number" ? card.stylingMinutes : null,
              maintenanceWeeks: typeof card?.maintenanceWeeks === "number" ? card.maintenanceWeeks : null,
              missingCm: typeof card?.missingCm === "number" ? card.missingCm : null,
            };
          }),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/brief/:token/photo", async (req, res, next) => {
    try {
      const session = await briefSession(options.pool, req.params.token ?? "", now());
      const photo = session ? (await listPhotos(options.pool, session.id)).find((item) => item.role === "front") : null;
      if (!photo) {
        sendError(res, 404, "not_found", "That brief is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      await streamImage(res, options.storage, photo.storageKey, photo.mime);
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/brief/:token/preview/:previewId", async (req, res, next) => {
    try {
      const session = await briefSession(options.pool, req.params.token ?? "", now());
      const preview = session ? await previewForSession(options.pool, session.id, req.params.previewId ?? "") : null;
      if (!preview?.storageKey || preview.status !== "ready") {
        sendError(res, 404, "not_found", "That brief is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      await streamImage(res, options.storage, preview.storageKey, "image/jpeg");
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/session/brief-link", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const token = cookieValue(req.headers.cookie, "hr_brief");
      const owner = token ? await briefSession(options.pool, token, now()) : null;
      res.json({ data: { token: owner && owner.id === session.id ? token : null } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/session/salon", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const parsed = salonSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Salon name or colour is not valid.");
        return;
      }
      await saveSalon(options.pool, session.id, { name: parsed.data.name, color: parsed.data.color.toLowerCase() });
      res.json({ data: { saved: true } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/photos/:photoId", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const photo = await photoForSession(options.pool, session.id, req.params.photoId ?? "");
      if (!photo) {
        sendError(res, 404, "not_found", "That photo is not in this session.");
        return;
      }
      await streamImage(res, options.storage, photo.storageKey, photo.mime);
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/previews/:previewId", async (req, res, next) => {
    try {
      const session = await requireSession(options.pool, req, res, now());
      if (!session) return;
      const preview = await previewForSession(options.pool, session.id, req.params.previewId ?? "");
      if (!preview?.storageKey) {
        sendError(res, 404, "not_found", "That preview is not ready.");
        return;
      }
      await streamImage(res, options.storage, preview.storageKey, "image/jpeg");
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function briefSession(pool: Pool, token: string, at: Date): Promise<DemoSession | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return sessionByBriefToken(pool, hashToken(token), at);
}

function previewUsesLiveYouCam(config: AppConfig, personaId: string | null): boolean {
  if (config.providerMode !== "live") return false;
  if (!personaId) return true;
  return personaId === "sample";
}

/** Render-cache style id: the catalogue reference photo when the style has one, else its YouCam template. */
function templateIdForLook(look: ScoredVariant): string | null {
  const refFile = catalogueReferenceFile(look.variant);
  if (refFile) return referenceCacheStyle(refFile);
  if (look.variant.reference.kind === "youcam" && look.variant.service !== "colour") {
    return look.variant.reference.templateId;
  }
  return null;
}

async function planPreviewRow(input: {
  live: boolean;
  look: ScoredVariant;
  frontBytes: Buffer;
  frontHash: string | null;
  cacheDir: string;
  personaId: string | null;
  storage: PrivateStorage;
}): Promise<{ status: "ready" | "pending" | "skipped"; storageKey: string | null; source: PreviewImageSource | null }> {
  if (input.live && !runnablePreview(input.look)) {
    return { status: "skipped", storageKey: null, source: null };
  }
  if (input.live) {
    const cached = input.frontHash
      ? await cachedPreviewBytes({
        cacheDir: input.cacheDir,
        frontContentHash: input.frontHash,
        candidateKey: input.look.variant.key,
        templateId: templateIdForLook(input.look),
      })
      : null;
    if (cached) {
      const key = storageKey();
      await input.storage.write(key, cached);
      return { status: "ready", storageKey: key, source: "cached" };
    }
    return { status: "pending", storageKey: null, source: null };
  }
  const key = storageKey();
  const bytes = await renderLookOnPhoto(input.frontBytes, input.look.variant.key, input.personaId);
  await input.storage.write(key, bytes);
  return { status: "ready", storageKey: key, source: "fixture" };
}

function runnablePreview(look: ScoredVariant): boolean {
  const referenceId = look.variant.key.startsWith("reference:") ? look.variant.key.slice("reference:".length) : "";
  const asset = look.variant.reference.kind === "asset" && referenceAssetExists(look.variant.reference.file);
  return Boolean(
    (look.variant.reference.kind === "youcam" && look.variant.service !== "colour")
    || asset
    || catalogueReferenceFile(look.variant) !== null
    || look.variant.preset
    || (look.variant.service === "haircut" && referenceId),
  );
}

function previewReasons(look: ScoredVariant): string[] {
  return look.reasons.filter((line) => line.length > 0).slice(0, 3);
}

function withBriefScript(recommendation: unknown, look: ScoredVariant): ScoredVariant {
  const line = briefScript(recommendation, look.variant.key);
  return line ? { ...look, stylistScript: line } : look;
}

/** The score on the ranking card the client saw, so the preview and the brief quote the same Fit. */
function shownScore(recommendation: unknown, key: string): number | null {
  if (!isRecord(recommendation)) return null;
  for (const list of [recommendation.show, recommendation.goals]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isRecord(item) && item.key === key && typeof item.score === "number" && Number.isFinite(item.score)) return item.score;
    }
  }
  return null;
}

function briefScript(recommendation: unknown, key: string): string | null {
  if (!isRecord(recommendation) || !Array.isArray(recommendation.show)) return null;
  for (const item of recommendation.show) {
    if (!isRecord(item) || item.key !== key || typeof item.stylistScript !== "string") continue;
    const line = item.stylistScript.trim();
    if (line.length >= 8) return line.slice(0, 180);
  }
  return null;
}

async function present(pool: Pool, session: DemoSession) {
  const previews = await listPreviews(pool, session.id);
  const photos = await listPhotos(pool, session.id);
  const front = photos.find((photo) => photo.role === "front") ?? null;
  const failures = await failedRenders(pool, session.id);
  return {
    recommendations: isRecord(session.recommendation) && Array.isArray(session.recommendation.show) ? session.recommendation.show : [],
    goals: isRecord(session.recommendation) && Array.isArray(session.recommendation.goals) ? session.recommendation.goals : [],
    analysis: session.analysis,
    beforePhotoId: front?.id ?? null,
    looks: previews.map((preview) => presentLook(preview, failures.get(preview.candidateKey) ?? null)),
  };
}

type RenderFailure = { code: string | null; reason: string | null };

/** The failed YouCam job per candidate key, with the English reason saved when it failed. */
async function failedRenders(pool: Pool, sessionId: string): Promise<Map<string, RenderFailure>> {
  const failures = await pool.query<{ candidate_key: string; error_code: string | null; reason: string | null }>(
    `SELECT payload->>'candidateKey' AS candidate_key, error_code, result->>'reason' AS reason
     FROM demo_jobs WHERE session_id = $1 AND status = 'failed' AND capability IN ('hairstyle', 'hair-color', 'beard')`,
    [sessionId],
  );
  return new Map(failures.rows.map((row) => [row.candidate_key, { code: row.error_code, reason: row.reason }]));
}

function presentLook(
  preview: { id: string; candidateKey: string; title: string; score: number; label: string; reasons: string[]; status: string; storageKey: string | null; source: PreviewImageSource | null },
  failure: RenderFailure | null,
) {
  return {
    id: preview.id,
    key: preview.candidateKey,
    title: preview.title,
    score: preview.score,
    label: preview.label,
    reasons: preview.reasons,
    status: preview.status,
    source: preview.status === "ready" ? preview.source : null,
    errorCode: failure?.code ?? null,
    failureReason: preview.status === "failed" ? failure?.reason ?? renderFailureReason({ code: failure?.code ?? "PROVIDER_UNAVAILABLE" }) : null,
    imageUrl: preview.storageKey ? `/api/v1/demo/previews/${preview.id}` : null,
  };
}

async function readStored(storage: PrivateStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of storage.stream(key)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function fixturePortrait(): Promise<Buffer> {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="640" height="800" viewBox="0 0 640 800" xmlns="http://www.w3.org/2000/svg">
  <rect width="640" height="800" fill="#1b1613"/>
  <ellipse cx="320" cy="340" rx="160" ry="210" fill="#c9926a"/>
  <ellipse cx="260" cy="320" rx="18" ry="12" fill="#1b1613"/>
  <ellipse cx="380" cy="320" rx="18" ry="12" fill="#1b1613"/>
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

async function view(pool: Pool, session: DemoSession) {
  const photos = await listPhotos(pool, session.id);
  const previews = await listPreviews(pool, session.id);
  const jobs = await loadAnalysisJobs(pool, session.id);
  const retakeSlot = session.analysisStatus === "failed" ? retakeSlotFor(jobs) : null;
  const failures = await failedRenders(pool, session.id);
  return {
    id: session.id,
    service: session.service,
    personaId: session.personaId,
    analysisStatus: session.analysisStatus,
    analysisNotice: session.analysisStatus === "failed" ? retakeReadingNotice(jobs) : crownReadingNotice(jobs),
    retakeSlot,
    analysis: session.analysis,
    answers: session.answers,
    likes: session.likes,
    requiredRoles: requiredRoles(session.service),
    photos: photos.map((photo) => ({ id: photo.id, role: photo.role, url: `/api/v1/demo/photos/${photo.id}` })),
    looks: previews.map((preview) => presentLook(preview, failures.get(preview.candidateKey) ?? null)),
  };
}

async function settledSession(options: DemoRouterOptions, session: DemoSession, req: Request, now: Date): Promise<DemoSession> {
  await settleDemoAnalysis({
    pool: options.pool,
    storage: options.storage,
    openai: options.openai ?? null,
    sessionId: session.id,
    budgetUsd: options.config.openaiBudgetUsd,
  });
  return await reloadSession(options.pool, req, now) ?? session;
}

async function reloadSession(pool: Pool, req: Request, now: Date): Promise<DemoSession | null> {
  const token = readCookie(req.headers.cookie);
  if (!token) return null;
  return sessionByToken(pool, hashToken(token), now);
}

function requiredRoles(service: ServiceKind): string[] {
  if (service === "haircut") return ["front", "left", "right", "crown"];
  return ["front"];
}

function acceptedPhotoRoles(service: ServiceKind): string[] {
  return service === "haircut" ? [...requiredRoles(service), "crown"] : requiredRoles(service);
}

function fingerprint(photos: readonly DemoPhoto[]): string {
  return createHash("sha256").update(photos.map((photo) => `${photo.role}:${photo.contentHash}`).sort().join("|")).digest("hex");
}

const profileOverrideBodySchema = z.record(z.string(), z.string());

function profileOverridesFromBody(body: unknown): Record<string, string> {
  if (!isRecord(body)) return {};
  const parsed = profileOverrideBodySchema.safeParse(body.profileOverrides);
  if (!parsed.success) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

function readServiceAnswers(service: ServiceKind, body: unknown): Answers | null {
  const common = {
    stylingMinutes: z.enum(["5", "15", "30"]),
    presentation: z.enum(["masculine", "feminine", "either", "auto"]),
    naturalState: z.enum(["natural", "styled", "unknown"]).optional(),
    chemical: z.enum(["none", "lightened", "permed", "relaxed", "unknown"]).optional(),
    strand: z.enum(["fine", "medium", "coarse", "unknown"]).optional(),
    blowdryer: z.enum(["yes", "no", "unknown"]).optional(),
    products: z.enum(["yes", "no", "unknown"]).optional(),
    canShorten: z.enum(["yes", "no", "unknown"]).optional(),
    canGrow: z.enum(["yes", "a-little", "no", "unknown"]).optional(),
    forehead: z.enum(["cover", "show", "either", "unknown"]).optional(),
    glassesDaily: z.enum(["yes", "no", "unknown"]).optional(),
    facialHair: z.enum(["none", "stubble", "moustache", "short", "medium", "long", "unknown"]).optional(),
    cowlick: z.enum(["none", "front", "crown", "both", "unknown"]).optional(),
    heatStyle: z.enum(["none", "sometimes", "daily"]).optional(),
    keep: z.enum(["length", "fringe", "nothing"]).optional(),
    colourHistory: z.enum(["natural", "box-dye", "lightened", "unknown"]).optional(),
    beardGrowth: z.enum(["full", "patchy", "unknown"]).optional(),
    wish: z.string().max(300).optional(),
  };
  const parsed = z.object(common).safeParse(body);
  if (!parsed.success) return null;
  if (service === "beard" && !parsed.data.beardGrowth) return null;
  if (service === "colour" && !parsed.data.colourHistory) return null;
  const answers = emptyAnswers();
  const data = parsed.data;
  answers.stylingMinutes = data.stylingMinutes;
  answers.presentation = data.presentation;
  if (data.naturalState) answers.naturalState = data.naturalState;
  if (data.chemical) answers.chemical = data.chemical;
  if (data.strand) answers.strand = data.strand;
  if (data.blowdryer) answers.blowdryer = data.blowdryer;
  if (data.products) answers.products = data.products;
  if (data.canShorten) answers.canShorten = data.canShorten;
  if (data.canGrow) answers.canGrow = data.canGrow;
  if (data.forehead) answers.forehead = data.forehead;
  if (data.glassesDaily) answers.glassesDaily = data.glassesDaily;
  if (data.facialHair) answers.facialHair = data.facialHair;
  if (data.cowlick) answers.cowlick = data.cowlick;
  if (data.wish) answers.wish = data.wish.trim();
  if (data.heatStyle) answers.heatStyle = data.heatStyle;
  if (data.keep) answers.keep = data.keep;
  if (data.colourHistory) answers.colourHistory = data.colourHistory;
  if (data.beardGrowth) answers.beardGrowth = data.beardGrowth;
  return answers;
}

async function personaOf(value: string | undefined): Promise<{ id: PersonaId; service: ServiceKind; analysis: Person; answers: Answers; likes: string[] } | null> {
  if (value !== "sample" && value !== "jordan" && value !== "maya" && value !== "adrian" && value !== "nina") return null;
  if (value === "sample") {
    return {
      id: value,
      service: "haircut",
      analysis: await loadSampleAnalysis(),
      answers: { ...emptyAnswers(), stylingMinutes: "15", heatStyle: "sometimes", keep: "nothing", presentation: "masculine" },
      likes: ["haircut:male_short_curly", "haircut:male_textured_crop"],
    };
  }
  if (value === "jordan") {
    return {
      id: value,
      service: "haircut",
      analysis: jordanPerson(),
      answers: { ...emptyAnswers(), stylingMinutes: "15", heatStyle: "sometimes", keep: "nothing", presentation: "masculine" },
      likes: ["haircut:male_short_curly"],
    };
  }
  if (value === "nina") {
    return {
      id: value,
      service: "haircut",
      analysis: ninaPerson(),
      answers: { ...emptyAnswers(), presentation: "feminine", stylingMinutes: "15" },
      likes: ["haircut:all_short_bob"],
    };
  }
  if (value === "maya") {
    return {
      id: value,
      service: "colour",
      analysis: mayaPerson(),
      answers: { ...emptyAnswers(), colourHistory: "natural", presentation: "feminine", stylingMinutes: "30" },
      likes: ["colour:Honey Blonde"],
    };
  }
  return {
    id: value,
    service: "beard",
    analysis: adrianPerson(),
    answers: { ...emptyAnswers(), beardGrowth: "patchy", presentation: "masculine", stylingMinutes: "5" },
    likes: ["beard:all_bandholz", "beard:all_goatee"],
  };
}

export function cardFrom(look: ScoredVariant, withImage: boolean, live = false) {
  return {
    key: look.variant.key,
    title: look.variant.title,
    referencePhoto: referenceIdentity(look.variant),
    renderable: !templateRenderRefused(look.variant) && (!live || runnablePreview(look)),
    score: look.score,
    label: look.label,
    reasons: look.reasons,
    criteria: look.criteria,
    stylistScript: look.stylistScript,
    tellYourBarber: look.tellYourBarber ?? null,
    stylingMinutes: look.stylingMinutes,
    maintenanceWeeks: look.maintenanceWeeks,
    components: look.components,
    confidence: look.confidence,
    missingCm: look.growth?.missingCm ?? null,
    months: look.growth?.months ?? null,
    lengthBand: lengthBand(look.variant.requirements.topCm),
    family: look.variant.familyId,
    affinity:look.variant.affinity,
    targetLengthCm:look.variant.requirements.topCm,
    swatch: look.variant.swatch,
    fullness: look.variant.beardFullness,
    feasible: !look.excluded,
    length: null,
    texture: null,
    imageUrl: withImage ? `/api/v1/demo/catalogue/${encodeURIComponent(look.variant.key)}` : null,
    imageKind:look.variant.reference.kind==="asset" ? "photo" : "illustration",
  };
}

async function publishThumb(look: ScoredVariant): Promise<void> {
  await publishCatalogueThumb({
    key: look.variant.key,
    title: look.variant.title,
    swatch: look.variant.swatch,
    ...(look.variant.reference.kind === "asset" ? { assetFile: look.variant.reference.file } : {}),
  });
}

function lengthBand(topCm: number | null): "short" | "medium" | "long" | "any" {
  if (topCm === null) return "any";
  if (topCm <= 4) return "short";
  if (topCm <= 12) return "medium";
  return "long";
}

function capFor(config: AppConfig, audience: "guest" | "judge"): { sessionCap: number; dailyCap: number } {
  if (audience === "judge") return { sessionCap: config.demoJudgeSessionCap, dailyCap: config.demoJudgeDailyCap };
  return { sessionCap: config.demoSessionCap, dailyCap: config.demoDailyCap };
}

function judgeMatch(secret: string | undefined, key: string | undefined): "guest" | "judge" | "rejected" {
  if (!key) return "guest";
  if (!secret || Buffer.byteLength(secret) !== Buffer.byteLength(key)) return "rejected";
  return timingSafeEqual(Buffer.from(secret), Buffer.from(key)) ? "judge" : "rejected";
}

function briefCookie(token: string, secure: boolean): string {
  const parts = [`hr_brief=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireSession(pool: Pool, req: Request, res: Response, now: Date): Promise<DemoSession | null> {
  const token = readCookie(req.headers.cookie);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    sendError(res, 401, "unauthenticated", "Start a demo session first.");
    return null;
  }
  const session = await sessionByToken(pool, hashToken(token), now);
  if (!session) {
    sendError(res, 401, "unauthenticated", "That demo session has expired.");
    return null;
  }
  return session;
}

function blocked(limit: AttemptWindow, req: Request, now: Date): boolean {
  const ip = req.ip || "unknown";
  if (limit.tooMany(ip, now.getTime())) return true;
  limit.add(ip, now.getTime());
  return false;
}

function readCookie(header: string | undefined): string | null {
  return cookieValue(header, "hr_demo");
}

function cookieValue(header: string | undefined, wanted: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === wanted) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function writeCookie(res: Response, token: string, secure: boolean): void {
  const parts = [`hr_demo=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function streamImage(res: Response, storage: PrivateStorage, key: string, mime: string): Promise<void> {
  try {
    await storage.size(key);
  } catch (error) {
    if (isMissingFile(error)) {
      sendError(res, 404, "not_found", "That image is no longer available.");
      return;
    }
    throw error;
  }
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "private, no-store");
  storage.stream(key).pipe(res);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json(errorResponseSchema.parse({
    error: { code, message, requestId: randomUUID() },
  }));
}
