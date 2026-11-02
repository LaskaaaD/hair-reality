import { CRITERIA_MAX, type ScoredVariant } from "../../src/domain/scoring.js";
import { SCORE_KEYS } from "../../src/server/demo/llm-rank.js";

/**
 * The fixture stylist: what a recorded `demo_rank` answer looks like in the consultation schema. Never a network call;
 * it repeats the rule scores (optionally moved) so a test can control exactly how far the "model" disagrees.
 */
export type StylistEntry = {
  id: string;
  scores: Record<string, number>;
  verdict: "great" | "good" | "adapt" | "skip";
  adaptNote: string | null;
  reason: string;
  tellYourBarber: string;
};

export function stylistEntry(look: ScoredVariant, reason: string, move: Record<string, number> = {}, extra: Partial<StylistEntry> = {}): StylistEntry {
  const scores: Record<string, number> = {};
  for (const [jsonKey, key] of Object.entries(SCORE_KEYS)) {
    scores[jsonKey] = Math.max(0, Math.min(CRITERIA_MAX[key], look.components[key] + (move[jsonKey] ?? 0)));
  }
  return {
    id: look.variant.key,
    scores,
    verdict: look.feasibility.status === "adapt" ? "adapt" : "good",
    adaptNote: look.feasibility.adaptNotes[0] ?? null,
    reason,
    tellYourBarber: "Keep it textured on top and tidy at the neckline.",
    ...extra,
  };
}

const CLAUSES = [
  (look: ScoredVariant) => `${look.variant.title} keeps the top and sides in proportion for this client's hair and face.`,
  (look: ScoredVariant) => `The ${look.variant.traits.fringeKind === "none" ? "open" : look.variant.traits.fringeKind} front of ${look.variant.title} sits well with the hairline in the photos.`,
  (look: ScoredVariant) => `${look.variant.title} needs little daily work, which suits the styling time this client gave.`,
  (look: ScoredVariant) => `With ${look.variant.traits.crownLength} length at the crown, ${look.variant.title} falls the way this hair already moves.`,
  (look: ScoredVariant) => `${look.variant.title} has the sides and neckline this head shape carries cleanly.`,
];

/** A fixture stylist answer for any profile: the best candidates with our own scores, one reason and one barber line each. Used by the replay report only. */
export function fixtureStylistReply(candidates: readonly ScoredVariant[], count = 14): { ranked: StylistEntry[]; notes: string } {
  const ranked = candidates.slice(0, count).map((look, index) =>
    stylistEntry(look, `${CLAUSES[index % CLAUSES.length]!(look)}`, {}, { tellYourBarber: `${look.variant.title}, keep it natural and easy to style.` }));
  return { ranked, notes: "Fixture stylist: repeats the rule scores." };
}

const SHORT_KEYS: Record<string, string> = {
  hair_behavior: "hb",
  face_balance: "fc",
  hairline_forehead: "hl",
  head_profile: "hp",
  lifestyle: "ls",
  features_context: "ft",
  trend_2026: "tr",
};

/** The same answer in the compact schema the rank call asks for (id, s, v, a, r, b), with a long adapt note on every entry so a size test is not flattered. */
export function compactStylistReply(candidates: readonly ScoredVariant[], count: number): { ranked: Record<string, unknown>[]; notes: string } {
  const ranked = candidates.slice(0, count).map((look, index) => {
    const entry = stylistEntry(look, `${CLAUSES[index % CLAUSES.length]!(look)} It also keeps the daily routine short for this hair.`, {}, {
      adaptNote: "Ask the barber to leave a little more weight at the front so the fringe sits where this hairline needs it.",
      tellYourBarber: `${look.variant.title}, keep it natural and easy to style, with a softly blended neckline.`,
    });
    return {
      id: entry.id,
      s: Object.fromEntries(Object.entries(entry.scores).map(([long, value]) => [SHORT_KEYS[long]!, value])),
      v: entry.verdict,
      a: entry.adaptNote,
      r: entry.reason,
      b: entry.tellYourBarber,
    };
  });
  return { ranked, notes: "Fixture stylist: repeats the rule scores." };
}
