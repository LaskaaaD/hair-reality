import { z } from "zod";

export const serviceSchema = z.enum(["haircut", "colour", "beard"]);
export type ServiceName = z.infer<typeof serviceSchema>;

const sessionSchema = z.object({
  id:z.string().optional(),
  service: serviceSchema,
  personaId: z.string().nullable(),
  analysisStatus: z.string(),
  analysisNotice: z.string().nullable().optional(),
  retakeSlot: z.enum(["front", "sides"]).nullable().optional(),
  answers: z.record(z.string(), z.string()),
  likes: z.array(z.string()),
  requiredRoles: z.array(z.string()),
  photos: z.array(z.object({ id: z.string(), role: z.string(), url: z.string() })),
  analysis: z.object({
    face: z.object({
      shape: z.object({ value: z.string(), confidence: z.number(), source: z.string().optional() }).optional(),
      youcamShape: z.object({ value: z.string(), confidence: z.number(), source: z.string().optional() }).optional(),
    }).optional(),
    hair: z.object({
      curl: z.object({ value: z.string(), confidence: z.number(), source: z.string().optional() }).optional(),
      density: z.object({ value: z.union([z.number(),z.literal("unknown")]), confidence: z.number(), source: z.string().optional() }).optional(),
      growthDirection: z.object({ value: z.string(), confidence: z.number(), source: z.string().optional() }).optional(),
      hairline: z.object({ value: z.string(), confidence: z.number(), source: z.string().optional() }).optional(),
      lengthCm: z.object({ value: z.union([z.number(),z.literal("unknown")]), confidence: z.number(), source: z.string().optional() }).optional(),
      topCm: z.object({ value: z.union([z.number(),z.literal("unknown")]), confidence: z.number(), source: z.string().optional() }).optional(),
      sideCm: z.object({ value: z.union([z.number(),z.literal("unknown")]), confidence: z.number(), source: z.string().optional() }).optional(),
      diameter: z.object({ value: z.string(), confidence: z.number(), source: z.string().optional() }).optional(),
      frizz: z.object({ value: z.string(), confidence: z.number(), source: z.string().optional() }).optional(),
    }).optional(),
    facialHair: z.object({growth:z.object({value:z.string(),confidence:z.number(),source:z.string().optional()}),style:z.object({value:z.string(),confidence:z.number(),source:z.string().optional()})}).optional(),
  }).nullable().optional(),
});
export type SessionView = z.infer<typeof sessionSchema>;

const componentsSchema = z.object({
  hairBehavior: z.number(),
  face: z.number(),
  hairline: z.number(),
  head: z.number(),
  lifestyle: z.number(),
  features: z.number(),
  trend: z.number(),
  goals: z.number().optional(),
});

const rankCardSchema = z.object({
  key: z.string(),
  title: z.string(),
  referencePhoto: z.string().nullable().optional(),
  renderable: z.boolean().optional(),
  score: z.number(),
  label: z.string(),
  reasons: z.array(z.string()),
  stylistScript: z.string(),
  stylingMinutes: z.number(),
  maintenanceWeeks: z.number(),
  components: componentsSchema,
  confidence: z.number(),
  missingCm: z.number().nullable(),
  months: z.number().nullable(),
  family:z.string().optional(),
  affinity:z.enum(["masculine","feminine","either"]).optional(),
  targetLengthCm:z.number().nullable().optional(),
  criteria:z.array(z.object({id:z.string(),status:z.enum(["ok","watch","block"]),text:z.string()})).optional(),
  tellYourBarber: z.string().nullable().optional(),
  lengthBand: z.enum(["short", "medium", "long", "any"]),
  imageKind:z.enum(["photo","illustration"]).optional(),
  feasible: z.boolean().nullable(),
  imageUrl: z.string().nullable(),
});
const paletteSchema = z.object({
  top: z.array(rankCardSchema),
  all: z.array(rankCardSchema),
});
export type PaletteItem = z.infer<typeof rankCardSchema>;
export type Palette = z.infer<typeof paletteSchema>;
const referencesSchema=z.array(z.object({id:z.string(),url:z.string(),match:rankCardSchema.nullable()}));
export type ReferenceView=z.infer<typeof referencesSchema>[number];
export function loadReferences():Promise<ReferenceView[]>{return get("/api/v1/demo/session/references",referencesSchema);}

const resultsSchema = z.object({
  recommendations:z.array(rankCardSchema).optional(),
  goals:z.array(rankCardSchema).optional(),
  beforePhotoId: z.string().nullable(),
  looks: z.array(z.object({
    id: z.string(),
    key:z.string().optional(),
    title: z.string(),
    score: z.number(),
    label: z.string(),
    reasons: z.array(z.string()),
    status: z.string(),
    errorCode: z.string().nullable(),
    failureReason: z.string().nullable().optional(),
    imageUrl: z.string().nullable(),
    source: z.enum(["youcam", "cached", "fixture"]).nullable().optional(),
  })),
});
export type Results = z.infer<typeof resultsSchema>;
export type Look = Results["looks"][number];

export const previewSourceSchema = z.enum(["youcam", "cached", "fixture"]);
export type PreviewSource = z.infer<typeof previewSourceSchema>;

export async function createSession(service: ServiceName): Promise<void> {
  await post("/api/v1/demo/sessions", { service, consent: true }, z.object({ service: serviceSchema }));
}

export async function openPersona(personaId: string): Promise<void> {
  await post(`/api/v1/demo/personas/${personaId}`, {}, z.object({ service: serviceSchema, personaId: z.string() }));
}

export function loadSamples(): Promise<{ jordan: boolean; maya: boolean; adrian: boolean; nina: boolean; sample: boolean }> {
  return get(
    "/api/v1/demo/samples",
    z.object({
      jordan: z.boolean(),
      maya: z.boolean(),
      adrian: z.boolean(),
      nina: z.boolean(),
      sample: z.boolean().optional().default(true),
    }),
  );
}

const questionSchema = z.array(z.object({
  id: z.string(),
  legend: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
}));
export type InterviewQuestion = z.infer<typeof questionSchema>[number];

export function loadQuestions(): Promise<InterviewQuestion[]> {
  return get("/api/v1/demo/session/questions", questionSchema);
}

const cardSchema = z.object({
  key: z.string(),
  title: z.string(),
  referencePhoto: z.string().nullable().optional(),
  renderable: z.boolean().optional(),
  score: z.number(),
  label: z.string(),
  reasons: z.array(z.string()),
  stylistScript: z.string(),
  stylingMinutes: z.number(),
  maintenanceWeeks: z.number(),
  components: componentsSchema.optional(),
  confidence: z.number().optional(),
  missingCm: z.number().nullable().optional(),
  months: z.number().nullable().optional(),
  family: z.string().optional(),
  affinity: z.enum(["masculine", "feminine", "either"]).optional(),
  targetLengthCm: z.number().nullable().optional(),
  criteria: z.array(z.object({ id: z.string(), status: z.enum(["ok", "watch", "block"]), text: z.string() })).optional(),
  tellYourBarber: z.string().nullable().optional(),
  lengthBand: z.enum(["short", "medium", "long", "any"]).optional(),
  imageKind: z.enum(["photo", "illustration"]).optional(),
  feasible: z.boolean().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
});
export type RecommendationCard = z.infer<typeof cardSchema> & { missingCm?: number | null | undefined; months?: number | null | undefined };

const recommendationSchema = resultsSchema.extend({
  briefToken: z.string().optional(),
  recommendations: z.array(cardSchema).optional(),
  goals: z.array(cardSchema.extend({ missingCm: z.number().nullable(), months: z.number().nullable() })).optional(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

export function loadSession(): Promise<SessionView | null> {
  return getSession("/api/v1/demo/session", sessionSchema);
}

export function loadPalette(): Promise<Palette> {
  return get("/api/v1/demo/session/palette", paletteSchema);
}

const compareNotesSchema = z.object({
  source: z.enum(["ai", "fallback"]),
  notes: z.array(z.object({ key: z.string(), summary: z.string(), pros: z.array(z.string()), cons: z.array(z.string()) })),
});
export type CompareNotes = z.infer<typeof compareNotesSchema>;

export function loadCompareNotes(): Promise<CompareNotes> {
  return get("/api/v1/demo/session/compare-notes", compareNotesSchema);
}

export function loadResults(): Promise<Results> {
  return get("/api/v1/demo/session/results", resultsSchema);
}

export async function saveAnswers(
  body: Record<string, string>,
  profileOverrides: Record<string, string> = {},
): Promise<void> {
  await post(
    "/api/v1/demo/session/answers",
    { ...body, profileOverrides },
    z.object({ saved: z.literal(true) }),
  );
}

export async function saveLikes(templateIds: string[]): Promise<string[]> {
  const saved=await post("/api/v1/demo/session/likes", { templateIds }, z.object({ likes: z.array(z.string()) }));
  return saved.likes;
}

export async function analyze(): Promise<void> {
  await post("/api/v1/demo/session/analyze", {}, z.object({ status: z.string() }));
}

export async function recommend(referenceId?:string,regenerate=false): Promise<Recommendation> {
  return post("/api/v1/demo/session/recommend", referenceId ? {referenceId,regenerate:true} : regenerate ? {regenerate:true} : {}, recommendationSchema);
}

export async function renderLooks(keys: string[]): Promise<Results> {
  return post("/api/v1/demo/session/renders", { keys }, resultsSchema);
}

export async function saveSalon(salon: { name: string; color: string }): Promise<void> {
  await post("/api/v1/demo/session/salon", salon, z.object({ saved: z.literal(true) }));
}

export async function loadBriefLink(): Promise<string | null> {
  const body = await get("/api/v1/demo/session/brief-link", z.object({ token: z.string().nullable() }));
  return body.token;
}

const briefSchema = z.object({
  service: serviceSchema,
  salon: z.object({ name: z.string(), color: z.string() }).nullable(),
  expiresAt: z.string(),
  photoUrl: z.string().nullable(),
  analysis: sessionSchema.shape.analysis,
  answers: z.record(z.string(), z.string()),
  looks: z.array(z.object({
    id: z.string(),
    key: z.string(),
    title: z.string(),
    score: z.number(),
    reasons: z.array(z.string()),
    imageUrl: z.string(),
    tellYourBarber: z.string().nullable(),
    stylingMinutes: z.number().nullable(),
    maintenanceWeeks: z.number().nullable(),
    missingCm: z.number().nullable(),
  })),
});
export type Brief = z.infer<typeof briefSchema>;

export function loadBrief(token: string): Promise<Brief> {
  return get(`/api/v1/demo/brief/${encodeURIComponent(token)}`, briefSchema);
}

export function retryPreview(id:string):Promise<Results>{return post(`/api/v1/demo/previews/${encodeURIComponent(id)}/retry`,{},resultsSchema);}

export async function uploadPhoto(role: string, file: Blob): Promise<void> {
  const form = new FormData();
  form.set("role", role);
  form.set("expectedVersion", "1");
  form.set("file", file, "photo.jpg");
  const response = await fetch("/api/v1/demo/session/photos", { method: "POST", body: form, headers: { accept: "application/json" } });
  await parse(response, z.object({ role: z.string() }));
}

export async function removePhoto(role: string): Promise<void> {
  const response = await fetch(`/api/v1/demo/session/photos/${encodeURIComponent(role)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  await parse(response, z.object({ removed: z.boolean() }));
}

export async function uploadReference(file: Blob): Promise<{id:string}> {
  const form = new FormData();
  form.set("role", "reference");
  form.set("expectedVersion", "1");
  form.set("file", file, "reference.jpg");
  const response = await fetch("/api/v1/demo/session/references", { method: "POST", body: form, headers: { accept: "application/json" } });
  return parse(response, z.object({ id: z.string() }));
}

function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return fetch(path, { headers: { accept: "application/json" } }).then((response) => parse(response, schema));
}

function getSession<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  return fetch(path, { headers: { accept: "application/json" } }).then((response) => parseNullableSession(response, schema));
}

function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  return fetch(path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => parse(response, schema));
}

export class DemoRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "DemoRequestError";
  }
}

async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) throw new DemoRequestError(messageOf(body), codeOf(body), response.status);
  if (!isRecord(body)) throw new Error("The server sent an unexpected response.");
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) throw new Error("The server sent an unexpected response.");
  return parsed.data;
}

async function parseNullableSession<T>(response: Response, schema: z.ZodType<T>): Promise<T | null> {
  const body: unknown = await response.json();
  if (response.status === 401) return null;
  if (!response.ok) throw new DemoRequestError(messageOf(body), codeOf(body), response.status);
  if (!isRecord(body)) throw new Error("The server sent an unexpected response.");
  if (body.data === null) return null;
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) throw new Error("The server sent an unexpected response.");
  return parsed.data;
}

function messageOf(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  return "Something went wrong. Try that again.";
}

function codeOf(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") return body.error.code;
  return "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
