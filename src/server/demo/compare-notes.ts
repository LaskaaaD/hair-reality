import { z } from "zod";
import type { Person } from "../../domain/person.js";
import type { OpenAIClient } from "../providers/openai/client.js";
import { EXPLAIN_MODEL, demoBudgetAllows, demoMicro, recordDemoSpend } from "./openai-budget.js";

export type CompareInput = { key: string; title: string; score: number; label: string; reasons: readonly string[] };
export type CompareNote = { key: string; summary: string; pros: string[]; cons: string[] };
export type CompareNotes = { notes: CompareNote[]; source: "ai" | "fallback" };

const answerSchema = z.object({
  notes: z.array(z.object({
    id: z.string().min(1).max(120),
    summary: z.string().min(8).max(200),
    pros: z.array(z.string().min(4).max(120)).min(1).max(3),
    cons: z.array(z.string().min(4).max(120)).min(1).max(3),
  })).max(6),
});

const answerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["notes"],
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "summary", "pros", "cons"],
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          pros: { type: "array", items: { type: "string" } },
          cons: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const cache = new Map<string, CompareNotes>();

/** Plain notes from the ranking reasons, used when the model is unavailable or over budget. */
export function fallbackCompareNotes(looks: readonly CompareInput[]): CompareNotes {
  const best = Math.max(...looks.map((look) => look.score));
  return {
    source: "fallback",
    notes: looks.map((look) => ({
      key: look.key,
      summary: look.reasons[0] ?? `${look.title} was ranked for your hair and face.`,
      pros: look.reasons.slice(0, 2).length > 0 ? look.reasons.slice(0, 2) : [`Fit score ${look.score}.`],
      cons: [look.score < best ? `Fits ${best - look.score} points lower than your best pick.` : "Confirm the details with your stylist."],
    })),
  };
}

export async function compareLooks(input: {
  sessionId: string;
  looks: readonly CompareInput[];
  person: Person;
  openai: OpenAIClient | null;
  budgetUsd: number;
}): Promise<CompareNotes> {
  const { looks } = input;
  if (looks.length === 0) return { notes: [], source: "fallback" };
  const cacheKey = `${input.sessionId}:${looks.map((look) => `${look.key}@${look.score}`).sort().join("|")}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const fallback = fallbackCompareNotes(looks);
  if (!input.openai || looks.length < 2) return fallback;
  const reserve = demoMicro(EXPLAIN_MODEL, 3000, 900);
  if (!(await demoBudgetAllows(input.budgetUsd, reserve))) return fallback;
  try {
    const profile = {
      curl: input.person.hair.curl.value,
      density: input.person.hair.density.value,
      topCm: input.person.hair.topCm.value,
      faceShape: input.person.face.shape.value,
    };
    const call = await input.openai.completeJson({
      name: "demo_compare_notes",
      model: EXPLAIN_MODEL,
      instructions:
        "You compare the haircuts a client chose to try on. For each style give a one sentence summary of how it differs from the other styles, one to two short pros and one to two short cons, each specific to that style against the others and to the client's hair profile. Plain words, no hype, no markdown, and never invent numbers beyond the ones given. Make every style's text different from the others. Use only the given ids.",
      schema: answerJsonSchema,
      userText: JSON.stringify({
        client: profile,
        styles: looks.map((look) => ({ id: look.key, title: look.title, fitScore: look.score, label: look.label, reasons: look.reasons.slice(0, 4) })),
      }),
    });
    await recordDemoSpend(call.kind === "failed" || call.kind === "uncertain" ? 0 : demoMicro(EXPLAIN_MODEL, call.usage?.inputTokens ?? 3000, call.usage?.outputTokens ?? 500));
    if (call.kind !== "completed") return fallback;
    const parsed = answerSchema.safeParse(JSON.parse(call.text));
    if (!parsed.success) return fallback;
    const byId = new Map(parsed.data.notes.map((note) => [note.id, note]));
    if (!looks.every((look) => byId.has(look.key))) return fallback;
    const result: CompareNotes = {
      source: "ai",
      notes: looks.map((look) => {
        const note = byId.get(look.key)!;
        return { key: look.key, summary: note.summary.trim(), pros: note.pros.map((line) => line.trim()), cons: note.cons.map((line) => line.trim()) };
      }),
    };
    if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
    cache.set(cacheKey, result);
    return result;
  } catch {
    return fallback;
  }
}
