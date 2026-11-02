// Offline ranking over a profile fixture (no YouCam/OpenAI calls). Usage: npx tsx scripts/rank-offline.ts [out.md]
import { writeFile } from "node:fs/promises";
import { fitScoreForCard, effectivePreferenceScoreForCard, rankingGroupFor } from "../src/client/flow/flow-mappers.js";
import { groupRankingCards, mergeRankingCards } from "../src/client/flow/ranking-groups.js";
import { fixturePerson, known, type Person } from "../src/domain/person.js";
import { emptyAnswers, selectLooks, PALETTE_LIMIT, resolvedPresentation, type ScoredVariant } from "../src/domain/scoring.js";

/** Reference profile for the live-test user (analysis has no hair length): oval/slightly oblong, straight-to-wavy, falls forward, dense front, heavy fringe. */
export function liveTestUserPerson(): Person {
  const p = fixturePerson("fixture");
  p.sex = { value: "unknown", confidence: 0, source: "fixture" };
  p.face.shape = known("oval", "youcam", 0.8);
  p.face.aspectRatio = known(1.47, "youcam", 0.75);
  p.hair.curl = known("2a", "youcam", 0.85);
  p.hair.density = known(3, "youcam", 0.85);
  p.hair.growthDirection = known("forward", "youcam", 0.6);
  p.hair.lengthCm = { value: "unknown", confidence: 0, source: "youcam" }; // hair length is not in the lean live capability set
  p.hair.frizz = known("none", "youcam", 0.8);
  p.facialHair.style = { value: "unknown", confidence: 0, source: "fixture" };
  return p;
}

const card = (look: ScoredVariant) => ({
  key: look.variant.key, title: look.variant.title, score: look.score, label: look.label, reasons: look.reasons,
  criteria: look.criteria, stylistScript: look.stylistScript, stylingMinutes: look.stylingMinutes,
  maintenanceWeeks: look.maintenanceWeeks, components: look.components, confidence: look.confidence,
  missingCm: look.growth?.missingCm ?? null, months: look.growth?.months ?? null, family: look.variant.familyId,
  affinity: look.variant.affinity, targetLengthCm: look.variant.requirements.topCm, swatch: look.variant.swatch,
  fullness: look.variant.beardFullness, feasible: !look.excluded, length: null, texture: null, imageUrl: null,
  imageKind: "illustration" as const,
  lengthBand: "short" as const,
});

const person = liveTestUserPerson();
const answers = emptyAnswers();
const sel = selectLooks({ service: "haircut", person, answers, likes: [], limit: PALETTE_LIMIT });
const show = sel.show.map(card), goals = sel.goals.map(card);
const merged = mergeRankingCards(show as never, goals as never, show as never, sel.ranked.map(card) as never);
const ordered = groupRankingCards(merged).flatMap((s) => s.cards);
const rows = ["# Live-test ranking v2 (offline, cached-profile fixture)", "",
  `Presentation resolved: ${resolvedPresentation(person, answers)}. No YouCam calls; profile = oval/slightly oblong, straight-to-wavy 2a, dense front, falls forward.`, "",
  "| # | Name | Fit | Pref | Group | Affinity | Reason |", "|---|---|---|---|---|---|---|",
  ...ordered.slice(0, 15).map((c, i) => `| ${i + 1} | ${c.title} | ${fitScoreForCard(c)} | ${effectivePreferenceScoreForCard(c, false)} | ${rankingGroupFor(c)} | ${c.affinity} | ${(c.reasons ?? [])[0]} |`), "",
  "## Bottom 8 (all styles ranked by Fit)", "",
  ...[...sel.ranked].slice(-8).map((l) => `- ${l.variant.title} (${l.score})`), ""];
const out = process.argv[2];
if (out) await writeFile(out, rows.join("\n")); else console.log(rows.join("\n"));
