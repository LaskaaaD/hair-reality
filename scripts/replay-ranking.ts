// Offline replay of the full ranking on the saved live-run data. No YouCam or OpenAI call is possible here:
// the model is a mock that returns recorded JSON. Usage: npx tsx scripts/replay-ranking.ts [out.md]
// or, to replay one captured recommend call exactly (var/rank-captures/*.json): npx tsx scripts/replay-ranking.ts <capture.json> [out.md]
process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.OPENAI_DEMO_LEDGER ??= path.join(mkdtempSync(path.join(tmpdir(), "hr-replay-ledger-")), "ledger.json");

import { fitScoreForCard, rankingGroupFor } from "../src/client/flow/flow-mappers.js";
import { parsePerson, type Person } from "../src/domain/person.js";
import { emptyAnswers, needsPresentationAnswer, selectLooks, type Answers, type ScoredVariant } from "../src/domain/scoring.js";
import { cardFrom } from "../src/server/demo/routes.js";
import { llmRankLooks } from "../src/server/demo/llm-rank.js";
import { reviewRecommendations } from "../src/server/demo/llm.js";
import { catalogueReferenceFile, renderModeFor, type RenderMode } from "../src/server/demo/reference-photo.js";
import { displayOrder, varyReasonsForDisplay } from "../src/server/demo/ranking-order.js";
import { MAX_PHRASE_REPEATS, reasonPhrases } from "../src/domain/reason-variety.js";
import { readRankCapture, type RankCapture } from "../src/server/demo/rank-capture.js";
import { applyVisionDetailed, readVision } from "../src/server/demo/vision.js";
import { rankCandidates } from "../src/server/demo/llm-rank.js";
import { curlyDenseMan, recedingThinMan, wavyWoman, type EvalProfile } from "../tests/fixtures/eval-profiles.js";
import { fixtureStylistReply } from "../tests/fixtures/stylist-fixture.js";
import type { OpenAIClient } from "../src/server/providers/openai/client.js";

export const REPLAY_DIR = path.join("tests", "fixtures", "user-replay");

export const EXPECTED_TOP = [
  "Textured French crop with low taper", "Soft French crop with scissor sides", "Short curtains with low taper", "Mod cut", "Textured Caesar with low taper",
  "Korean two-block with curtain fringe", "Messy fringe", "Side-swept textured crop", "Soft side part", "Ivy League",
];
export const EXPECTED_BOTTOM = ["quiff", "pompadour", "high and tight", "disconnected undercut", "faux hawk"];

export const SPOT_CHECK_TITLES = ["Short curtains with low taper", "Middle part short", "Middle part with taper", "Ivy League", "Crew cut"];

const readJson = (name: string): unknown => JSON.parse(readFileSync(path.join(REPLAY_DIR, name), "utf8"));

/** What the wizard sends when the client picks "Men". The replayed client is a man; nothing here is guessed from the photos. */
export const MALE_ANSWERS: Answers = { ...emptyAnswers(), presentation: "masculine" };

export function replayProfile(visionFile = "vision-reply.json", visionReply?: unknown, visionFailed = false): { person: Person; filled: string[]; skipped: string[] } {
  const youcam = parsePerson(readJson("youcam-analysis.json"));
  if (!youcam) throw new Error("youcam-analysis.json is not a readable profile");
  if (visionFailed) return { person: youcam, filled: [], skipped: [] };
  const read = readVision(visionReply ?? readJson(visionFile));
  if (!read) throw new Error(`${visionReply ? "the given reply" : visionFile} is not a readable vision reply`);
  const merged = applyVisionDetailed(youcam, read.reading);
  return { person: merged.person, filled: merged.filled.map((item) => item.field), skipped: merged.skipped.map((item) => `${item.field}: ${item.reason}`) };
}

/** A model that only ever answers with the recorded JSON; it cannot reach any network. */
export function recordedModel(reply: unknown): { client: OpenAIClient; prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    async completeJson(input: { instructions: string; userText: string }) {
      prompts.push(`${input.instructions}\n${input.userText}`);
      return { kind: "completed", text: typeof reply === "string" ? reply : JSON.stringify(reply), usage: { inputTokens: 5000, outputTokens: 900 } };
    },
  } as unknown as OpenAIClient;
  return { client, prompts };
}

export type SpotCheck = { title: string; rankOfAll: number | null; shownAt: number | null; renderMode: RenderMode; reason: string };

export type ReplayRow = { rank: number; key: string; title: string; fit: number; group: string; reason: string; renderMode: RenderMode; referenceFile: string | null; look: ScoredVariant };

/** A model call that kept hitting a transient network error: the rank call ends uncertain, so the deterministic list is shown. */
export function failingModel(): OpenAIClient {
  return { async completeJson() { return { kind: "uncertain", detail: "transport_TypeError:UND_ERR_CONNECT_TIMEOUT after_retry" }; } } as unknown as OpenAIClient;
}

export async function runReplay(input: { llm: "none" | "recorded" | "failing"; answers?: Answers; visionFile?: string; visionReply?: unknown; rankReply?: unknown; visionFailed?: boolean; person?: Person; likes?: readonly string[] }): Promise<{ rows: ReplayRow[]; ranked: ScoredVariant[]; person: Person; path: string; note: string; filled: string[]; prompts: string[]; spot: SpotCheck[] }> {
  const { person, filled } = input.person ? { person: input.person, filled: [] as string[] } : replayProfile(input.visionFile, input.visionReply, input.visionFailed);
  const answers = input.answers ?? MALE_ANSWERS;
  const selection = selectLooks({ service: "haircut", person, answers, likes: [...(input.likes ?? [])] });
  const deterministic = reviewRecommendations(selection.show);
  let ranking: { show: ScoredVariant[]; path: string; note: string } = { show: deterministic, path: "deterministic", note: "mocked model: deterministic path" };
  let prompts: string[] = [];
  if (input.llm === "recorded") {
    const model = recordedModel(input.rankReply ?? readJson("llm-rank-reply.json"));
    prompts = model.prompts;
    ranking = await llmRankLooks({ person, ranked: selection.ranked, fallback: deterministic, openai: model.client, budgetUsd: 6 });
  }
  if (input.llm === "failing") ranking = await llmRankLooks({ person, ranked: selection.ranked, fallback: deterministic, openai: failingModel(), budgetUsd: 6 });
  const varied = varyReasonsForDisplay({ show: ranking.show, goals: selection.goals, person, answers, toCard: (look) => cardFrom(look, false) });
  const byKey = new Map([...varied.show, ...varied.goals].map((look) => [look.variant.key, look]));
  const order = displayOrder(varied.show.map((look) => cardFrom(look, false) as never), varied.goals.map((look) => cardFrom(look, false) as never));
  const rows = order.flatMap((key, index) => {
    const look = byKey.get(key);
    if (!look) return [];
    const card = cardFrom(look, false) as never;
    const reference = catalogueReferenceFile(look.variant);
    return [{ rank: index + 1, key, title: look.variant.title, fit: fitScoreForCard(card), group: rankingGroupFor(card), reason: look.reasons[0] ?? "", renderMode: renderModeFor(look.variant), referenceFile: reference, look }];
  });
  const ranked = selection.ranked.filter((look) => !look.excluded);
  const spot = SPOT_CHECK_TITLES.map((title): SpotCheck => {
    const index = ranked.findIndex((look) => look.variant.title === title);
    const look = byKey.get(ranked[index]?.variant.key ?? "") ?? ranked[index];
    const shown = rows.find((row) => row.title === title);
    return { title, rankOfAll: index < 0 ? null : index + 1, shownAt: shown?.rank ?? null, renderMode: look ? renderModeFor(look.variant) : "none", reason: look?.reasons[0] ?? "" };
  });
  return { rows, ranked, person, path: ranking.path, note: ranking.note, filled, prompts, spot };
}

export function reasonsOk(rows: readonly ReplayRow[]): boolean {
  const counts = new Map<string, number>();
  for (const row of rows.slice(0, 20)) {
    if (row.reason.trim().length < 24) return false;
    for (const phrase of new Set(reasonPhrases(row.reason, row.title))) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.values()].every((count) => count <= MAX_PHRASE_REPEATS);
}

function spotAcceptance(spot: readonly SpotCheck[]): Acceptance[] {
  const get = (title: string) => spot.find((item) => item.title === title);
  const curtains = get("Short curtains with low taper");
  const middle = ["Middle part short", "Middle part with taper"].map((title) => get(title)).filter((item): item is SpotCheck => item !== undefined);
  const ivy = get("Ivy League");
  const crew = get("Crew cut");
  return [
    { name: "Middle part short and Middle part with taper rank below Short curtains", ok: Boolean(curtains?.rankOfAll) && middle.length === 2 && middle.every((item) => item.rankOfAll !== null && item.rankOfAll > curtains!.rankOfAll!), detail: middle.map((item) => `${item.title} #${item.rankOfAll}`).join(", ") + ` vs Short curtains #${curtains?.rankOfAll}` },
    { name: "Middle part short and Middle part with taper never render from a template", ok: middle.length === 2 && middle.every((item) => item.renderMode !== "template"), detail: middle.map((item) => `${item.title}: ${item.renderMode}`).join(", ") },
    { name: "Ivy League has its own reason, not the Crew cut one", ok: Boolean(ivy?.reason) && ivy!.reason !== crew?.reason, detail: ivy?.reason ?? "none" },
  ];
}

export type Acceptance = { name: string; ok: boolean; detail: string };

/** The checks that must hold whatever the photo reading gave: no women's style anywhere and one Fit order. Reason variety needs vision facts, so it is not asked of a YouCam-only profile. */
export function baselineAcceptance(rows: readonly ReplayRow[], ranked: readonly ScoredVariant[]): Acceptance[] {
  const feminineShown = rows.filter((row) => row.look.variant.affinity === "feminine");
  const feminineRanked = ranked.filter((look) => look.variant.affinity === "feminine");
  let strict = true;
  rows.forEach((row, index) => { if (index > 0 && !(rows[index - 1]!.fit > row.fit)) strict = false; });
  return [
    { name: "0 feminine styles shown", ok: rows.length > 0 && feminineShown.length === 0, detail: `${rows.length} shown; ${feminineShown.map((row) => row.title).join(", ") || "none feminine"}` },
    { name: "0 feminine styles in the whole ranked list", ok: ranked.length > 0 && feminineRanked.length === 0, detail: `${ranked.length} ranked; ${feminineRanked.length} feminine` },
    { name: "strictly descending Fit", ok: strict, detail: rows.slice(0, 20).map((row) => row.fit).join(" > ") },
    { name: "every card shown has a reason", ok: rows.every((row) => row.reason.trim().length >= 24), detail: `${rows.length} cards` },
  ];
}

export function acceptance(rows: readonly ReplayRow[], person: Person, ranked: readonly ScoredVariant[], spot: readonly SpotCheck[] = []): Acceptance[] {
  const top10 = rows.slice(0, 10);
  const overlap = EXPECTED_TOP.filter((name) => top10.some((row) => row.title === name));
  const cutoff = Math.floor(ranked.length * 0.75);
  const hard = ranked.map((look, index) => ({ look, index })).filter(({ look }) => /pompadour|classic quiff|textured quiff|side-swept quiff|messy quiff|quiff with fade|high and tight|disconnected undercut|faux hawk/i.test(look.variant.title));
  const misplaced = hard.filter(({ index }) => index < cutoff);
  const feminine = rows.filter((row) => row.look.variant.affinity === "feminine");
  const curl = person.hair.curl.value;
  const curlNeeding = rows.filter((row) => curl !== "unknown" && (curl === "1" || curl.startsWith("2")) && !row.look.variant.requirements.curl.some((code) => code === "1" || code.startsWith("2")));
  let strict = true;
  rows.forEach((row, index) => { if (index > 0 && !(rows[index - 1]!.fit > row.fit)) strict = false; });
  return [
    { name: "0 feminine styles", ok: feminine.length === 0, detail: feminine.map((row) => row.title).join(", ") || "none" },
    { name: "0 curl-requiring styles", ok: curlNeeding.length === 0, detail: curlNeeding.map((row) => row.title).join(", ") || "none" },
    { name: "top 10 overlaps expected list by at least 7", ok: overlap.length >= 7, detail: `${overlap.length} of 10: ${overlap.join(", ")}` },
    { name: "tall quiffs, pompadour, high and tight, disconnected undercut, faux hawk are in the bottom quarter of all ranked styles", ok: hard.length > 0 && misplaced.length === 0, detail: `${hard.length} styles, worst at #${Math.min(...hard.map(({ index }) => index + 1))} of ${ranked.length}${misplaced.length ? `; too high: ${misplaced.map(({ look }) => look.variant.title).join(", ")}` : ""}` },
    { name: "high, temple and skin fades are not in the top 15 of the shown list", ok: !rows.slice(0, 15).some((row) => /high fade|temple fade|skin\/bald fade/i.test(row.title)), detail: rows.slice(0, 15).filter((row) => /high fade|temple fade|skin\/bald fade/i.test(row.title)).map((row) => row.title).join(", ") || "none" },
    { name: "Japanese mash cut is not in the top 10", ok: !top10.some((row) => row.title === "Japanese mash cut"), detail: `at #${rows.findIndex((row) => row.title === "Japanese mash cut") + 1 || "-"} of ${rows.length} shown` },
    { name: "strictly descending Fit", ok: strict, detail: rows.slice(0, 20).map((row) => row.fit).join(" > ") },
    ...spotAcceptance(spot),
    { name: "every card shown has a reason, and no five-word phrase repeats in more than two", ok: reasonsOk(rows), detail: `${rows.length} cards` },
  ];
}

const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

export function renderReport(result: Awaited<ReturnType<typeof runReplay>>, label: string, checks: "full" | "baseline" = "full"): string[] {
  const items = checks === "full" ? acceptance(result.rows, result.person, result.ranked, result.spot) : baselineAcceptance(result.rows, result.ranked);
  return [
    `## ${label}`, "", `Path: **${result.path}** (${result.note})`, "",
    "| # | Name | Fit | Group | Render | Reason |", "|---|---|---|---|---|---|",
    ...result.rows.slice(0, 20).map((row) => `| ${row.rank} | ${cell(row.title)} | ${row.fit} | ${row.group} | ${row.renderMode}${row.referenceFile ? ` (${row.referenceFile})` : ""} | ${cell(row.reason)} |`), "",
    "Spot checks (rank among all ranked styles, rank on the shown list, render mode, reason):", "",
    ...result.spot.map((item) => `- ${item.title}: #${item.rankOfAll ?? "-"} of ${result.ranked.length}, shown ${item.shownAt ? "#" + item.shownAt : "no"}, render ${item.renderMode}, "${cell(item.reason)}"`), "",
    "Acceptance:", "", ...items.map((item) => `- ${item.ok ? "PASS" : "FAIL"} ${item.name}: ${cell(item.detail)}`), "",
  ];
}

/** Replays a captured recommend call: its merged profile, answers and raw model answer go through the same ranking code, offline. A capture with no model answer replays the deterministic list. */
export async function replayCapture(capture: RankCapture): ReturnType<typeof runReplay> {
  return runReplay({ llm: capture.rawRank === null ? "none" : "recorded", person: capture.profile, answers: capture.answers, likes: capture.likes, ...(capture.rawRank !== null ? { rankReply: capture.rawRank } : {}) });
}

/** The four evaluation profiles of the professional-matching spec: the reference client (live v9 vision values) and three synthetic ones. */
export function evalProfiles(): EvalProfile[] {
  const user = replayProfile("vision-reply-v9.json");
  return [{ name: "Reference client (YouCam + live v9 vision values)", person: user.person, answers: MALE_ANSWERS }, curlyDenseMan(), recedingThinMan(), wavyWoman()];
}

/** Rules-only and fixture-stylist rankings of one evaluation profile, as the top 10 with Fit. */
export async function evalReport(profile: EvalProfile): Promise<string[]> {
  const rules = await runReplay({ llm: "none", person: profile.person, answers: profile.answers });
  const selection = selectLooks({ service: "haircut", person: profile.person, answers: profile.answers, likes: [] });
  const shortlist = new Set(selection.show.map((look) => look.variant.key));
  const stylist = await runReplay({ llm: "recorded", person: profile.person, answers: profile.answers, rankReply: fixtureStylistReply(rankCandidates(selection.ranked).filter((look) => shortlist.has(look.variant.key))) });
  const count = (status: string) => selection.ranked.filter((look) => look.feasibility.status === status).length;
  const top = (result: typeof rules) => result.rows.slice(0, 10).map((row) => `- ${row.rank}. ${row.title} (Fit ${row.fit}, ${row.group}${row.look.feasibility.status === "adapt" ? ", adapt" : ""})`);
  return [`## Evaluation: ${profile.name}`, "", `Hard filters: ${count("fail")} fail, ${count("goal")} goal, ${count("adapt")} adapt, of ${selection.ranked.length} styles for this audience.`, "", "Rules only, top 10:", "", ...top(rules), "", `Fixture stylist (path ${stylist.path}), top 10:`, "", ...top(stylist), ""];
}

async function replayCaptureMain(file: string): Promise<void> {
  const capture = readRankCapture(file);
  const result = await replayCapture(capture);
  const lines = [`# Replay of ${path.basename(file)}`, "", `Captured path: ${capture.rankPath} (${capture.rankNote}). Replayed path: ${result.path} (${result.note}).`, "", ...renderReport(result, "Captured profile and model answer", "baseline")];
  const out = process.argv[3];
  const text = lines.join("\n");
  if (out) await writeFile(out, text); else console.log(text);
}

async function main(): Promise<void> {
  if (process.env.PROVIDER_MODE === "live") throw new Error("replay refuses to run in live mode");
  if (process.argv[2]?.endsWith(".json")) return replayCaptureMain(process.argv[2]);
  const liveV7 = JSON.parse(readFileSync(path.join("live-test", "openai-v7.json"), "utf8")) as { rawVision: string; rawRank: string };
  const v7 = { visionReply: JSON.parse(liveV7.rawVision) as unknown, rankReply: JSON.parse(liveV7.rawRank) as unknown };
  const deterministic = await runReplay({ llm: "none" });
  const recorded = await runReplay({ llm: "recorded" });
  const liveRecorded = await runReplay({ llm: "recorded", ...v7 });
  const failedCall = await runReplay({ llm: "failing", visionReply: v7.visionReply });
  const visionFailed = await runReplay({ llm: "none", visionFailed: true });
  const unanswered = await runReplay({ llm: "none", visionFailed: true, answers: emptyAnswers() });
  const profile = [
    "- merged fields from vision: " + deterministic.filled.length + " of 18 (" + deterministic.filled.join(", ") + ")",
    `- face ${deterministic.person.face.shape.value}, ratio ${deterministic.person.face.aspectRatio.value}, curl ${deterministic.person.hair.curl.value}, forward growth ${deterministic.person.hair.growthDirection.value}`,
  ];
  const lines = [
    "# Offline replay v9", "",
    "Every path below is ranked for the male answer (Men), as the wizard sends it. Input: tests/fixtures/user-replay (YouCam analysis real; vision and LLM rank replies recorded in live-test/openai-v6.json) and the live v7 replies in live-test/openai-v7.json (rawVision, rawRank). The model is a mock that returns recorded JSON or fails; no network, no live calls.", "",
    "Profile after merge (v6 vision):", "", ...profile, "",
    ...renderReport(deterministic, "Deterministic path (v6 profile, mocked model gives no answer)"),
    ...renderReport(recorded, "Recorded v6 model reply"),
    ...renderReport(liveRecorded, "Recorded live v7 model reply (live-test/openai-v7.json)"),
    ...renderReport(failedCall, "Fallback path (v7 profile, rank call failed after its one retry)"),
    ...renderReport(visionFailed, "Vision failed (YouCam profile only, no vision merge) with the male answer", "baseline"),
    "## Vision failed and no gender answer", "",
    `Every haircut style the ranking returns: ${unanswered.ranked.length} (the catalogue has no unisex haircuts, so the list stays empty); styles shown: ${unanswered.rows.length}.`,
    `Recommend and render requests are refused with a clear message until the client chooses Men, Women or Both: ${needsPresentationAnswer("haircut", unanswered.person, emptyAnswers()) ? "PASS" : "FAIL"}.`, "",
  ];
  lines.push("# Evaluation profiles (professional matching, round 11)", "");
  for (const profile of evalProfiles()) lines.push(...await evalReport(profile));
  const out = process.argv[2];
  if (out) await writeFile(out, lines.join("\n")); else console.log(lines.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
