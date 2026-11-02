import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import express from "express";
import {cardFrom,createDemoRouter} from "../../src/server/demo/routes.js";
import {varyReasonsForDisplay} from "../../src/server/demo/ranking-order.js";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import sharp from "sharp";
import { createApp } from "../../src/server/app.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { AttemptWindow } from "../../src/server/auth/rate-limit.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { installFixtureNetworkGuard } from "../../src/server/providers/network-guard.js";
import {parsePerson} from "../../src/domain/person.js";
import {previewUnitCost,selectLooks,type Answers} from "../../src/domain/scoring.js";

const { Pool } = pg;

test("the demo wizard scores a haircut, serves a free persona, and caps session creation", async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-demo-"));
  const config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    APP_ORIGIN: "http://127.0.0.1:3000",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: testUrl,
    PRIVATE_STORAGE_DIR: storageRoot,
    DELETION_JOURNAL_DIR: await mkdtemp(path.join(tmpdir(), "hr-demo-journal-")),
    DELETION_JOURNAL_MODE: "local",
    BUDGET_PHASE: "development",
    YOUCAM_DEV_CAP: "500",
    YOUCAM_DEMO_CAP: "300",
    YOUCAM_TOTAL_CAP: "800",
    YOUCAM_RESERVE: "200",
    OPENAI_BUDGET_USD: "5",
    TRUST_PROXY: "0",
  });
  const restore = installFixtureNetworkGuard("127.0.0.1");
  const storage = createPrivateStorage(storageRoot);
  const app = createApp(config, storageRoot, { pool, storage, demoIpLimit: new AttemptWindow(10, 60_000) });
  const server = createServer(app);
  await listen(server);
  const base = baseUrl(server);
  try {
    await assert.rejects(fetch("https://yce-api-01.makeupar.com"), /Blocked outbound provider traffic/);
    const jpeg = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
    const started = await send(base, "", "POST", "/api/v1/demo/sessions", { service: "haircut", consent: true });
    assert.equal(started.status, 201);
    const cookie = cookieOf(started);
    for (const role of ["front", "left", "right", "crown"]) {
      const uploaded = await send(base, cookie, "POST", "/api/v1/demo/session/photos", undefined, multipart(role, jpeg));
      assert.equal(uploaded.status, 201, role);
    }
    const analysis = await send(base, cookie, "POST", "/api/v1/demo/session/analyze", {});
    assert.equal(analysis.status, 200);
    await assertRearRequired(base, jpeg);
    const answers = await send(base, cookie, "POST", "/api/v1/demo/session/answers", {
      stylingMinutes: "15",
      heatStyle: "sometimes",
      keep: "nothing",
      presentation: "either",
      wish: "  szczuplejsza twarz, baby face  ",
    });
    assert.equal(answers.status, 200);
    const saved = (await (await send(base, cookie, "GET", "/api/v1/demo/session")).json() as { data: { answers: { wish: string } } }).data;
    assert.equal(saved.answers.wish, "szczuplejsza twarz, baby face");
    const palette = await send(base, cookie, "GET", "/api/v1/demo/session/palette");
    const paletteBody = await palette.json() as { data: { top: { key: string; imageUrl: string; feasible: boolean | null }[]; all: { key: string }[] } };
    assert.equal(paletteBody.data.top.length, 50);
    assert.ok(paletteBody.data.all.length >= 57);
    assert.equal(paletteBody.data.top.every((item) => item.imageUrl.includes("/api/v1/demo/catalogue/")), true);
    assert.equal(paletteBody.data.top.some((item) => item.key === "haircut:all_long_straight_black"), false);
    const liked = await send(base, cookie, "POST", "/api/v1/demo/session/likes", {
      templateIds: ["haircut:side-part--classic-side-part", "haircut:all_long_straight_black"],
    });
    assert.equal(liked.status, 200);
    const results = await send(base, cookie, "POST", "/api/v1/demo/session/recommend", {});
    assert.equal(results.status, 200);
    const recommended = await results.json() as { data: { briefToken?: string; goals: { title: string; missingCm: number | null }[]; recommendations: { key: string; stylistScript?: string }[] } };
    assert.equal(recommended.data.goals.some((goal) => goal.title === "Long Blunt" && (goal.missingCm ?? 0) > 0), true);
    assert.match(recommended.data.briefToken ?? "", /^[a-f0-9]{64}$/);
    const brief = await send(base, "", "GET", `/api/v1/demo/brief/${recommended.data.briefToken}`);
    assert.equal(brief.status, 200);
    const briefBody = await brief.json() as { data: { looks: unknown[]; photos?: unknown } };
    assert.equal(briefBody.data.photos, undefined);
    assert.deepEqual(briefBody.data.looks, []);
    const renderKey = recommended.data.recommendations[0]?.key;
    assert.ok(renderKey);
    const rendered = await send(base, cookie, "POST", "/api/v1/demo/session/renders", { keys: ["haircut:side-part--classic-side-part"] });
    assert.equal(rendered.status, 200);
    const looks = (await rendered.json() as { data: { looks: { title: string; status: string; label: string; imageUrl: string | null }[] } }).data.looks;
    const ready = looks.filter((look) => look.status === "ready");
    assert.ok(ready.length > 0 && ready.length <= 3);
    const curly = looks.find((look) => look.title === "Classic side part");
    assert.equal(curly?.status, "ready");
    assert.ok(curly?.imageUrl);
    const image = await send(base, cookie, "GET", curly.imageUrl);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    const stats = await sharp(bytes).extract({ left: 0, top: 0, width: 40, height: 40 }).stats();
    assert.ok((stats.channels[0]?.mean ?? 0) > 150);
    const salonSaved = await send(base, cookie, "POST", "/api/v1/demo/session/salon", { name: "Studio Aria", color: "#b4532a" });
    assert.equal(salonSaved.status, 200);
    assert.equal((await send(base, cookie, "POST", "/api/v1/demo/session/salon", { name: "Bad", color: "red" })).status, 400);
    const briefLink = await send(base, `${cookie}; hr_brief=${recommended.data.briefToken}`, "GET", "/api/v1/demo/session/brief-link");
    assert.equal((await briefLink.json() as { data: { token: string | null } }).data.token, recommended.data.briefToken);
    const fullBrief = await send(base, "", "GET", `/api/v1/demo/brief/${recommended.data.briefToken}`);
    assert.equal(fullBrief.status, 200);
    const fullBriefBody = await fullBrief.json() as { data: { salon: { name: string } | null; photoUrl: string | null; looks: { imageUrl: string; title: string }[] } };
    assert.equal(fullBriefBody.data.salon?.name, "Studio Aria");
    assert.ok(fullBriefBody.data.photoUrl);
    assert.ok(fullBriefBody.data.looks.some((look) => look.title === "Classic side part"));
    const briefPhoto = await send(base, "", "GET", fullBriefBody.data.photoUrl);
    assert.equal(briefPhoto.status, 200);
    const briefLook = await send(base, "", "GET", fullBriefBody.data.looks[0]?.imageUrl ?? "");
    assert.equal(briefLook.status, 200);
    assert.equal(briefLook.headers.get("content-type"), "image/jpeg");
    assert.equal((await send(base, "", "GET", `/api/v1/demo/brief/${"b".repeat(64)}/photo`)).status, 404);
    const units = await pool.query<{ units: number }>(`SELECT COALESCE(SUM(units), 0)::int AS units FROM demo_usage`);
    assert.equal(units.rows[0]?.units, 0);
    const rejected = await send(base, "", "POST", "/api/v1/demo/sessions", { service: "colour", consent: true });
    assert.equal(rejected.status, 201);
    const rejectedCookie = cookieOf(rejected);
    assert.equal((await send(base, rejectedCookie, "POST", "/api/v1/demo/session/photos", undefined, multipart("front", jpeg))).status, 201);
    assert.equal((await send(base, rejectedCookie, "POST", "/api/v1/demo/session/analyze", {})).status, 200);
    await pool.query(`UPDATE demo_sessions SET analysis_status = 'failed' WHERE id = (SELECT id FROM demo_sessions ORDER BY created_at DESC LIMIT 1)`);
    const retake = await send(base, rejectedCookie, "POST", "/api/v1/demo/session/recommend", {});
    assert.equal(retake.status, 409);
    assert.equal((await retake.json() as { error: { code: string } }).error.code, "retake");
    await assertGender(base, jpeg, "masculine");
    await assertGender(base, jpeg, "feminine");

    assert.equal((await send(base, "", "POST", "/api/v1/demo/personas/adrian", {})).status, 409);
    const persona = await send(base, "", "POST", "/api/v1/demo/personas/sample", {});
    assert.equal(persona.status, 201);
    const personaCookie = cookieOf(persona);
    const emptyPersona = await send(base, personaCookie, "GET", "/api/v1/demo/session/results");
    assert.equal((await emptyPersona.json() as { data: { looks: unknown[] } }).data.looks.length, 0);
    const personaRendered = await send(base, personaCookie, "POST", "/api/v1/demo/session/renders", { keys: ["haircut:side-part--classic-side-part"] });
    assert.equal(personaRendered.status, 200);
    const sampleLooks = (await personaRendered.json() as { data: { looks: { status: string; source: string | null }[] } }).data.looks;
    assert.equal(sampleLooks.filter((look) => look.status === "ready").every((look) => look.source === "fixture"), true);
    assert.equal((await send(base, "", "POST", "/api/v1/demo/personas/maya", {})).status, 409);
    const afterPersona = await pool.query<{ units: number }>(`SELECT COALESCE(SUM(units), 0)::int AS units FROM demo_usage`);
    assert.equal(afterPersona.rows[0]?.units, 0);
    await assertReferencePresentation(base,cookie,personaCookie,jpeg);
    await assertPreviewRetry(base,cookie,personaCookie,pool,storage,config);

    const limited = createApp(config, storageRoot, { pool, storage, demoIpLimit: new AttemptWindow(1, 60_000) });
    const limitServer = createServer(limited);
    await listen(limitServer);
    const limitBase = baseUrl(limitServer);
    try {
      assert.equal((await send(limitBase, "", "POST", "/api/v1/demo/sessions", { service: "colour", consent: true })).status, 201);
      assert.equal((await send(limitBase, "", "POST", "/api/v1/demo/sessions", { service: "beard", consent: true })).status, 429);
    } finally {
      await close(limitServer);
    }
  } finally {
    restore();
    await close(server);
    await pool.end();
  }
});

async function assertPreviewRetry(base:string,cookie:string,otherCookie:string,pool:InstanceType<typeof Pool>,storage:ReturnType<typeof createPrivateStorage>,config:ReturnType<typeof loadConfig>):Promise<void>{
  const response=await send(base,cookie,"GET","/api/v1/demo/session/results");
  const body=await response.json() as {data:{looks:{id:string;key:string;status:string;score:number}[]}};
  const preview=body.data.looks.find(item=>item.status==="ready");assert.ok(preview);
  const session=(await (await send(base,cookie,"GET","/api/v1/demo/session")).json() as {data:{id:string}}).data;
  // The curly crop was liked earlier, but the reference step replaced the likes. Round 7's hard texture rule drops a curly
  // cut from 2a hair unless the client liked it, so like it again to keep it retryable.
  assert.equal((await send(base,cookie,"POST","/api/v1/demo/session/likes",{templateIds:[preview.key]})).status,200);
  const endpoint=`/api/v1/demo/previews/${preview.id}/retry`;
  assert.equal((await send(base,otherCookie,"POST",endpoint,{})).status,404);
  await pool.query(`UPDATE demo_previews SET status='failed' WHERE id=$1`,[preview.id]);
  const retried=await send(base,cookie,"POST",endpoint,{});assert.equal(retried.status,200);
  const recovered=(await retried.json() as {data:{looks:typeof body.data.looks}}).data.looks;
  assert.equal(recovered.length,body.data.looks.length);
  assert.equal(recovered.find(item=>item.id===preview.id)?.status,"ready");
  assert.equal(recovered.find(item=>item.id===preview.id)?.score,preview.score);
  assert.equal((await send(base,cookie,"POST",endpoint,{})).status,200);
  const jobId=randomUUID();
  await pool.query(`UPDATE demo_previews SET status='failed',storage_key=NULL WHERE id=$1`,[preview.id]);
  await pool.query(`INSERT INTO demo_jobs(id,session_id,capability,status,units,idempotency_key,payload,error_code,provider_task_id,submitted_at,created_at,updated_at) VALUES($1,$2,'hairstyle','failed',0,$3,$4::jsonb,'PROVIDER_ERROR','old-task',NOW(),NOW(),NOW())`,[jobId,session.id,`retry-test:${jobId}`,JSON.stringify({candidateKey:preview.key,templateId:preview.key.split(":")[1]})]);
  const unitCost=previewUnitCost("haircut");
  const liveApp=express();
  liveApp.use("/api/v1",createDemoRouter({pool,storage,config:{...config,providerMode:"live",demoSessionCap:unitCost}}));
  const liveServer=createServer(liveApp);await listen(liveServer);
  try{
    const liveBase=baseUrl(liveServer);
    // Live try-ons are paused unless the saved ranking came from the OpenAI model (render gate); this session ranked deterministically.
    const paused=await send(liveBase,cookie,"POST",endpoint,{});
    assert.equal(paused.status,409);
    assert.equal((await paused.json() as {error:{code:string}}).error.code,"RANKING_NOT_LLM");
    await pool.query(`UPDATE demo_sessions SET recommendation=jsonb_set(COALESCE(recommendation,'{}'::jsonb),'{rankPath}','"llm"') WHERE id=$1`,[session.id]);
    assert.equal((await send(liveBase,cookie,"POST",endpoint,{})).status,200);
    const job=await pool.query<{status:string;provider_task_id:string|null;attempt:number}>(`SELECT status,provider_task_id,(payload->>'retryAttempt')::integer AS attempt FROM demo_jobs WHERE id=$1`,[jobId]);
    assert.equal(job.rows[0]?.status,"queued");assert.equal(job.rows[0]?.provider_task_id,null);assert.equal(job.rows[0]?.attempt,1);
    assert.equal((await send(liveBase,cookie,"POST",endpoint,{})).status,200);
    const units=await pool.query<{units:number}>(`SELECT SUM(units)::integer AS units FROM demo_usage WHERE session_id=$1`,[session.id]);assert.equal(units.rows[0]?.units,unitCost);
    await pool.query(`UPDATE demo_jobs SET status='failed',error_code='PROVIDER_ERROR',provider_task_id='second-task',updated_at=NOW() WHERE id=$1`,[jobId]);
    await pool.query(`UPDATE demo_previews SET status='failed' WHERE id=$1`,[preview.id]);
    assert.equal((await send(liveBase,cookie,"POST",endpoint,{})).status,402);
    const capped=await pool.query<{status:string;attempt:number}>(`SELECT status,(payload->>'retryAttempt')::integer AS attempt FROM demo_jobs WHERE id=$1`,[jobId]);assert.equal(capped.rows[0]?.status,"failed");assert.equal(capped.rows[0]?.attempt,1);
    // Two active and two failed previews compete for the one remaining slot.
    const palette=(await (await send(base,cookie,"GET","/api/v1/demo/session/palette")).json() as {data:{all:{key:string;title:string;score:number;excluded:boolean;renderable?:boolean}[]}}).data;
    const keys=[...new Map(palette.all.filter(item=>!item.excluded && item.renderable!==false).map(item=>[item.key,item])).values()].slice(0,4);
    assert.equal(keys.length,4);
    await pool.query("DELETE FROM demo_previews WHERE session_id=$1",[session.id]);
    const failedIds:string[]=[];
    for(const [index,look] of keys.entries()){
      const id=randomUUID();
      await pool.query(`INSERT INTO demo_previews(id,session_id,candidate_key,title,score,label,reasons,status) VALUES($1,$2,$3,$4,$5,'match','[]'::jsonb,$6)`,[id,session.id,look.key,look.title,look.score,index<2 ? "ready" : "failed"]);
      if(index>=2)failedIds.push(id);
    }
    const concurrent=await Promise.all(failedIds.map(id=>send(base,cookie,"POST",`/api/v1/demo/previews/${id}/retry`,{})));
    assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,409]);
    const count=await pool.query<{count:number}>("SELECT COUNT(*)::integer AS count FROM demo_previews WHERE session_id=$1 AND status IN ('ready','pending')",[session.id]);
    assert.equal(count.rows[0]?.count,3);
  }finally{await close(liveServer);}
}

async function assertReferencePresentation(base:string,cookie:string,otherCookie:string,jpeg:Buffer):Promise<void>{
  for(let i=0;i<3;i++)assert.equal((await send(base,cookie,"POST","/api/v1/demo/session/references",undefined,multipart("reference",jpeg))).status,201);
  assert.equal((await send(base,cookie,"POST","/api/v1/demo/session/references",undefined,multipart("reference",jpeg))).status,409);
  const response=await send(base,cookie,"GET","/api/v1/demo/session/references");
  assert.equal(response.status,200);
  const references=(await response.json() as {data:{id:string;url:string;storageKey?:string;match:{score:number}}[]}).data;
  assert.equal(references.length,3);
  const current=(await (await send(base,cookie,"GET","/api/v1/demo/session")).json() as {data:{analysis:unknown;answers:Answers;likes:string[]}}).data;
  const person=parsePerson(current.analysis);assert.ok(person);
  const expected=selectLooks({service:"haircut",person,answers:current.answers,likes:current.likes,referenceIds:references.map(item=>item.id)});
  for(const reference of references){
    assert.equal(reference.storageKey,undefined);
    assert.equal(reference.match.score,expected.ranked.find(item=>item.variant.key===`reference:${reference.id}`)?.score);
    const image=await send(base,cookie,"GET",reference.url);assert.equal(image.status,200);assert.match(image.headers.get("content-type") ?? "",/image\/jpeg/);
    assert.equal((await send(base,otherCookie,"GET",reference.url)).status,404);
  }
  const chosen=references[2];assert.ok(chosen);
  assert.equal((await send(base,otherCookie,"POST","/api/v1/demo/session/recommend",{referenceId:chosen.id,regenerate:true})).status,404);
  const selected=await send(base,cookie,"POST","/api/v1/demo/session/recommend",{referenceId:chosen.id,regenerate:true});assert.equal(selected.status,200);
  const recommendations=(await selected.json() as {data:{recommendations:{key:string;score:number}[]}}).data.recommendations;
  const selectedBase=selectLooks({service:"haircut",person,answers:current.answers,likes:current.likes,referenceIds:[chosen.id]});
  // The server shows the list in display order, where a tie costs the later card one point; the expectation applies the same transform.
  const selectedExpected={show:varyReasonsForDisplay({show:selectedBase.show,goals:selectedBase.goals,person,answers:current.answers,toCard:look=>cardFrom(look,false)}).show};
  assert.deepEqual(recommendations.map(item=>({key:item.key,score:item.score})),selectedExpected.show.map(item=>({key:item.variant.key,score:item.score})));
  const persisted=await send(base,cookie,"GET","/api/v1/demo/session/results");
  const persistedBody=await persisted.json() as {data:{recommendations:{key:string;score:number}[]}};
  assert.deepEqual(persistedBody.data.recommendations.map(item=>[item.key,item.score]),selectedExpected.show.map(item=>[item.variant.key,item.score]));
  const referenceKey=`reference:${chosen.id}`;
  const liked=await send(base,cookie,"POST","/api/v1/demo/session/likes",{templateIds:[referenceKey]});
  assert.deepEqual((await liked.json() as {data:{likes:string[]}}).data.likes,[referenceKey]);
  const foreignLike=await send(base,otherCookie,"POST","/api/v1/demo/session/likes",{templateIds:[referenceKey]});
  assert.deepEqual((await foreignLike.json() as {data:{likes:string[]}}).data.likes,[]);

}

async function assertRearRequired(base: string, jpeg: Buffer): Promise<void> {
  const created = await send(base, "", "POST", "/api/v1/demo/sessions", { service: "haircut", consent: true });
  assert.equal(created.status, 201);
  const cookie = cookieOf(created);
  for (const role of ["front", "left", "right"]) {
    assert.equal((await send(base, cookie, "POST", "/api/v1/demo/session/photos", undefined, multipart(role, jpeg))).status, 201);
  }
  const session = await send(base, cookie, "GET", "/api/v1/demo/session");
  const view = await session.json() as {data:{requiredRoles:string[]}};
  assert.deepEqual(view.data.requiredRoles, ["front", "left", "right", "crown"]);
  assert.equal((await send(base, cookie, "POST", "/api/v1/demo/session/analyze", {})).status, 409);
  assert.equal((await send(base, cookie, "POST", "/api/v1/demo/session/photos", undefined, multipart("crown", jpeg))).status, 201);
  assert.equal((await send(base, cookie, "POST", "/api/v1/demo/session/analyze", {})).status, 200);
}

async function assertGender(base: string, jpeg: Buffer, presentation: "masculine" | "feminine"): Promise<void> {
  const started = await send(base, "", "POST", "/api/v1/demo/sessions", { service: "haircut", consent: true });
  assert.equal(started.status, 201);
  const cookie = cookieOf(started);
  for (const role of ["front", "left", "right", "crown"]) {
    assert.equal((await send(base, cookie, "POST", "/api/v1/demo/session/photos", undefined, multipart(role, jpeg))).status, 201);
  }
  assert.equal((await send(base, cookie, "POST", "/api/v1/demo/session/analyze", {})).status, 200);
  assert.equal((await send(base, cookie, "POST", "/api/v1/demo/session/answers", {
    stylingMinutes: "15",
    heatStyle: "sometimes",
    keep: "nothing",
    presentation,
  })).status, 200);
  const palette = await send(base, cookie, "GET", "/api/v1/demo/session/palette");
  const paletteBody = await palette.json() as { data: { top: { key: string }[]; all: { key: string }[] } };
  assert.equal(paletteBody.data.top.length, 50);
  const opposite = presentation === "masculine" ? "haircut:all_short_bob" : "haircut:side-part--classic-side-part";
  const saved = await send(base, cookie, "POST", "/api/v1/demo/session/likes", { templateIds: [opposite] });
  assert.equal(saved.status, 200);
  assert.equal(paletteBody.data.all.some((item) => item.key === opposite), false);
  const results = await send(base, cookie, "POST", "/api/v1/demo/session/recommend", {});
  assert.equal(results.status, 200);
  const titles = (await results.json() as { data: { recommendations: { key: string; title: string }[]; goals: { key: string; title: string }[] } }).data;
  const visible = [...titles.recommendations, ...titles.goals].map((item) => item.key);
  assert.equal(visible.includes(opposite), false);
  assert.ok(titles.recommendations.length > 0);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}

function cookieOf(response: Response): string {
  const header = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie()[0] : response.headers.get("set-cookie");
  const pair = header?.split(";")[0];
  if (!pair) throw new Error("missing session cookie");
  return pair;
}

function multipart(role: string, file: Buffer): { body: Buffer; type: string } {
  const boundary = "----hairreality";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="role"\r\n\r\n${role}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  return { body: Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
}

function send(
  base: string,
  cookie: string,
  method: string,
  pathName: string,
  json?: unknown,
  file?: { body: Buffer; type: string },
): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  if (file) headers["content-type"] = file.type;
  else if (json !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${pathName}`, {
    method,
    headers,
    ...(file ? { body: new Uint8Array(file.body) } : json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
}
