import { z } from "zod";

const serviceKinds = ["haircut", "colour", "beard"] as const;
const serviceKindSchema = z.enum(serviceKinds);
type ServiceKind = z.infer<typeof serviceKindSchema>;

export const answerStateSchema = z.enum(["yes", "no", "unknown"]);
export type AnswerState = z.infer<typeof answerStateSchema>;

export const namedColourSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unknown") }),
  z.strictObject({ state: z.literal("known"), value: z.string().trim().min(1).max(80) }),
]);

export const datedAnswerSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unknown") }),
  z.strictObject({ state: z.literal("known"), date: z.string().refine(isIsoDate, "Use a real calendar date.") }),
]);

export const colourHistorySchema = z.strictObject({
  naturalColour: namedColourSchema,
  dyed: answerStateSchema,
  boxDye: answerStateSchema,
  henna: answerStateSchema,
  bleach: answerStateSchema,
  treatmentDate: datedAnswerSchema,
  keratin: answerStateSchema,
  permOrRelaxer: answerStateSchema,
  reportedDamage: answerStateSchema,
});
export type ColourHistory = z.infer<typeof colourHistorySchema>;

export const priorityScopeSchema = z.enum(["all", "haircut", "colour", "beard"]);
export const priorityCategorySchema = z.enum(["must_keep", "dont_want", "flexible"]);
export const maintenanceLevelSchema = z.enum(["low", "moderate", "high", "unspecified"]);

export const confirmedPrioritySchema = z.strictObject({
  scope: priorityScopeSchema,
  category: priorityCategorySchema,
  text: z.string().trim().min(1).max(200),
  confirmed: z.literal(true),
});
export type ConfirmedPriority = z.infer<typeof confirmedPrioritySchema>;

export const extractedProposalSchema = z.strictObject({
  scope: priorityScopeSchema,
  category: priorityCategorySchema,
  text: z.string().trim().min(1).max(200),
  confirmed: z.literal(false),
  source: z.literal("extraction"),
});
export type ExtractedProposal = z.infer<typeof extractedProposalSchema>;

export const preferencesInputSchema = z.strictObject({
  maintenance: maintenanceLevelSchema,
  stylingWillingness: maintenanceLevelSchema,
  goals: z.array(z.string().trim().min(1).max(200)).max(8),
  priorities: z.array(confirmedPrioritySchema).max(24),
  proposals: z.array(extractedProposalSchema).max(12),
});
export type PreferencesInput = z.infer<typeof preferencesInputSchema>;

export const clientBriefSchema = z.strictObject({
  data: z.strictObject({
    version: z.number().int().positive(),
    historyRequired: z.boolean(),
    history: colourHistorySchema.nullable(),
    preferences: preferencesInputSchema.nullable(),
    services: z.array(z.strictObject({
      kind: serviceKindSchema,
      priorities: z.array(confirmedPrioritySchema),
    })),
  }),
});
export type ClientBrief = z.infer<typeof clientBriefSchema>["data"];

export function briefFieldErrors(
  services: readonly ServiceKind[],
  history: ColourHistory | undefined,
  preferences: PreferencesInput | undefined,
): Record<string, string[]> | null {
  const errors: Record<string, string[]> = {};
  if (history && !services.includes("colour")) {
    errors.history = ["Colour history applies only when colour is selected."];
  }
  const misplaced = [...(preferences?.priorities ?? []), ...(preferences?.proposals ?? [])]
    .some((item) => item.scope !== "all" && !services.includes(item.scope));
  if (misplaced) errors.preferences = ["A priority must use all or a selected service."];
  return Object.keys(errors).length > 0 ? errors : null;
}

export function prioritiesForService(kind: ServiceKind, preferences: PreferencesInput | null): ConfirmedPriority[] {
  if (!preferences) return [];
  return preferences.priorities.filter((item) => item.scope === "all" || item.scope === kind);
}

export function affectedServiceKinds(
  services: readonly ServiceKind[],
  previous: { history: ColourHistory | null; preferences: PreferencesInput | null },
  next: { history?: ColourHistory; preferences?: PreferencesInput },
): ServiceKind[] {
  const selected = new Set(services);
  const affected = new Set<ServiceKind>();
  if (next.history && selected.has("colour") && !sameJson(previous.history, next.history)) affected.add("colour");
  if (next.preferences) {
    const effect = preferenceEffect(previous.preferences, next.preferences);
    const kinds = effect === "all" ? services : effect;
    for (const kind of kinds) {
      if (selected.has(kind)) affected.add(kind);
    }
  }
  return serviceKinds.filter((kind) => affected.has(kind));
}

export function readStoredPreferences(value: unknown): PreferencesInput | null {
  const parsed = preferencesInputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && record.maintenance === "unspecified") {
    return {
      maintenance: "unspecified",
      stylingWillingness: "unspecified",
      goals: [],
      priorities: [],
      proposals: [],
    };
  }
  return null;
}

export function readStoredHistory(value: unknown): ColourHistory | null {
  const parsed = colourHistorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function preferenceEffect(previous: PreferencesInput | null, next: PreferencesInput): "all" | ServiceKind[] {
  if (!previous) return "all";
  const globalChanged = previous.maintenance !== next.maintenance
    || previous.stylingWillingness !== next.stylingWillingness
    || !sameJson(previous.goals, next.goals);
  if (globalChanged) return "all";
  const scopes = changedScopes(previous.priorities, next.priorities);
  if (scopes.has("all")) return "all";
  return [...scopes].filter((scope): scope is ServiceKind => scope === "haircut" || scope === "colour" || scope === "beard");
}

function changedScopes(previous: readonly ConfirmedPriority[], next: readonly ConfirmedPriority[]): Set<string> {
  const before = new Set(previous.map((item) => JSON.stringify(item)));
  const after = new Set(next.map((item) => JSON.stringify(item)));
  const scopes = new Set<string>();
  for (const item of previous) {
    if (!after.has(JSON.stringify(item))) scopes.add(item.scope);
  }
  for (const item of next) {
    if (!before.has(JSON.stringify(item))) scopes.add(item.scope);
  }
  return scopes;
}

export function sameBriefValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function sameJson(left: unknown, right: unknown): boolean {
  return sameBriefValue(left, right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${key}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
