import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "0";
process.env.OPENAI_LIVE_SUBMISSION = "0";
process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-round7-")), "ledger.json");

import { currentKey, loadStyles, variantByKey } from "../../src/domain/knowledge-base.js";
import { known, type Person } from "../../src/domain/person.js";
import { emptyAnswers, PALETTE_LIMIT, selectLooks, type ScoredVariant } from "../../src/domain/scoring.js";
import { MAX_PHRASE_REPEATS, reasonPhrases, specificReasonCandidates } from "../../src/domain/reason-variety.js";
import { stylistEntry } from "../fixtures/stylist-fixture.js";
import { mergeRanking, rankCandidates } from "../../src/server/demo/llm-rank.js";
import { renderModeFor } from "../../src/server/demo/reference-photo.js";
import { YOUCAM_MATCH_BY_VARIANT_ID } from "../../src/client/flow/fixtures.js";
import { replayProfile, runReplay } from "../../scripts/replay-ranking.js";

/** The reason-variety guarantee covers the first page of the top-50 list; the cards behind "Show more" may share stock clauses. */
const FIRST_PAGE = 16;

const UNLINKED = [
  "curtains--middle-part-short", "curtains--middle-part-with-taper", "asian-fringe--japanese-mash-cut", "asian-fringe--mash-with-two-block",
  "undercut--disconnected-undercut", "undercut--side-swept-undercut", "undercut--undercut-fade", "undercut--undercut-fringe-forward", "undercut--shaved-sides-long-top",
];

const rank = (ranked: readonly ScoredVariant[], title: string) => ranked.filter((look) => !look.excluded).findIndex((look) => look.variant.title === title) + 1;
const select = (mutate?: (person: Person) => void) => {
  const { person } = replayProfile();
  mutate?.(person);
  return selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] });
};
const older = (person: Person) => {
  person.hair.curl = known("1", "vision", 0.8);
  person.hair.growthDirection = known("forward", "vision", 0.7);
};

test("render: a style whose reference photo was unlinked never falls back to a mismatched template", () => {
  const styles = loadStyles();
  for (const id of UNLINKED) {
    const variant = styles.find((item) => item.id === id);
    assert.ok(variant, id);
    assert.notEqual(variant.reference.kind, "youcam", `${id} still points at a YouCam template`);
    assert.equal(renderModeFor(variant), "reference", id); // own men's photo since round 22, never the mismatched template
    assert.equal(YOUCAM_MATCH_BY_VARIANT_ID[id], undefined, `${id} still has a client-side template match`);
  }
  const tousled = styles.filter((item) => item.reference.kind === "youcam" && item.reference.templateId === "all_tousled_waves");
  assert.ok(tousled.every((item) => (item.requirements.topCm ?? 0) >= 12 && !/middle part (short|with taper)/i.test(item.title)), "the long curly template only serves its own flow and curtain styles");
});

test("ranking: Middle part short ranks under Short curtains, on the live reading and on the older straight forward-growth one", () => {
  for (const mutate of [undefined, older]) {
    const { ranked } = select(mutate);
    const curtains = rank(ranked, "Short curtains with low taper");
    assert.ok(curtains > 0 && curtains <= 3, `Short curtains at #${curtains}`);
    assert.ok(rank(ranked, "Middle part short") > curtains + 5, "Middle part short");
    assert.ok(rank(ranked, "Middle part with taper") > curtains + 5, "Middle part with taper");
  }
});

test("ranking: the barber bias keeps top-tier styles ahead of favoured ones and does not read across the title and id", () => {
  const { ranked } = select();
  const part = (title: string) => ranked.find((look) => look.variant.title === title)!.components.taste;
  assert.ok(part("Soft side part") - part("Classic side part") >= 6, "top tier +10 against favoured +4");
  assert.ok(part("Short curtains with low taper") - part("Middle part short") >= 8, "'middle part short' + 'curtains--...' must not read as 'short curtains'");
});

test("ranking: ties are broken by score components, never by catalogue order", () => {
  const forward = select().ranked.map((look) => look.variant.key);
  const { person } = replayProfile();
  const backward = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [], styles: [...loadStyles()].reverse() }).ranked.map((look) => look.variant.key);
  assert.deepEqual(backward.slice(0, 60), forward.slice(0, 60));
});

test("ranking: tall quiffs and pompadours fall into the bottom quarter for an oval face with hair that falls forward or to the side", () => {
  const { ranked } = select();
  const live = ranked.filter((look) => !look.excluded);
  const cutoff = Math.floor(live.length * 0.75);
  for (const title of ["Messy quiff", "Classic quiff", "Side-swept quiff", "Textured quiff", "Quiff with fade", "Short pompadour", "Classic pompadour"]) {
    assert.ok(rank(ranked, title) > cutoff, `${title} is at #${rank(ranked, title)} of ${live.length}`);
  }
  assert.ok(rank(ranked, "Short quiff") <= cutoff, "a short quiff may stay mid");
  const back = select((person) => { person.hair.growthDirection = known("back", "vision", 0.8); });
  assert.ok(rank(back.ranked, "Classic quiff") < rank(ranked, "Classic quiff"), "hair that grows back keeps a quiff higher");
});

test("catalogue: Ivy League and Crew cut have their own keys, and a model reply maps to the right one", () => {
  const styles = loadStyles();
  const ivy = styles.find((item) => item.title === "Ivy League")!;
  const crew = styles.find((item) => item.title === "Crew cut")!;
  assert.notEqual(ivy.key, crew.key);
  assert.equal(ivy.key, "haircut:crew--ivy-league");
  assert.equal(currentKey("haircut:crew-cut"), ivy.key, "the old Ivy League key maps to the new one");
  assert.equal(variantByKey("haircut:crew-cut")?.title, "Ivy League");
  assert.equal(variantByKey(crew.key)?.title, "Crew cut");
  assert.equal(styles.filter((item) => item.key === "haircut:crew-cut").length, 0);

  const candidates = rankCandidates(select().ranked);
  const allowed = new Set(candidates.map((look) => look.variant.key));
  const person = replayProfile().person;
  const reasonIvy = "A neat, even shape with a slight sweep that follows your side growth.";
  const reasonCrew = "A very short cut with almost nothing to style.";
  const of = (key: string, reason: string) => entryFor(select().ranked.find((look) => look.variant.key === key)!, reason);
  const others = [
    of("haircut:side-part--soft-side-part", "Soft sides and a sweep with your growth direction."),
    of("haircut:crop--side-swept-textured-crop", "A crop that handles the front cowlick."),
  ];
  const keys = mergeRanking(person, candidates, { ranked: [of(ivy.key, reasonIvy), of(crew.key, reasonCrew), ...others] }, allowed)!;
  assert.equal(keys.show.find((look) => look.variant.key === ivy.key)?.reasons[0], reasonIvy);
  assert.notEqual(keys.show.find((look) => look.variant.key === crew.key)?.reasons[0], reasonIvy);
  const legacy = mergeRanking(person, candidates, { ranked: [{ ...of(ivy.key, reasonIvy), id: "haircut:crew-cut" }, ...others] }, allowed)!;
  assert.equal(legacy.show.find((look) => look.variant.key === ivy.key)?.reasons[0], reasonIvy);
});

const entryFor = (look: ScoredVariant, reason: string, move: Record<string, number> = {}) => stylistEntry(look, reason, move);

test("llm: each criterion is averaged with ours, a far-off one keeps ours, and hard filters are untouched", () => {
  const candidates = rankCandidates(select().ranked);
  const [first, second, third] = [candidates[0]!, candidates[1]!, candidates[2]!];
  const merged = mergeRanking(replayProfile().person, candidates, { ranked: [
    entryFor(first, "A specific reason about this client.", { hair_behavior: 4, face_balance: -20 }),
    entryFor(second, "Another specific reason about this client."),
    entryFor(third, "A third specific reason about this client."),
  ] })!;
  const out = merged.show.find((look) => look.variant.key === first.variant.key)!;
  assert.equal(out.components.hairBehavior, Math.round((first.components.hairBehavior + Math.min(30, first.components.hairBehavior + 4)) / 2), "a near score is averaged with ours (the model score is capped at the criterion maximum)");
  assert.equal(out.components.face, first.components.face, "a score further than 40% of the criterion's maximum keeps ours");
  assert.equal(merged.overridden, 1);
  assert.equal(out.tellYourBarber, "Keep it textured on top and tidy at the neckline.");
  assert.ok(merged.show.every((look) => !look.excluded && look.feasibility.status !== "fail"));
});

test("reasons: cards name something specific about fringe, growth, cowlick or sides, and no five-word phrase repeats in more than two", async () => {
  for (const llm of ["none", "recorded"] as const) {
    const { rows } = await runReplay({ llm });
    const counts = new Map<string, number>();
    for (const row of rows.slice(0, FIRST_PAGE)) for (const phrase of new Set(reasonPhrases(row.reason, row.title))) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    assert.deepEqual([...counts].filter(([, count]) => count > MAX_PHRASE_REPEATS), [], llm);
    const generic = rows.slice(0, FIRST_PAGE).filter((row) => /proportions of your oval face stay as they are|suits an oval face without adding extra length/.test(row.reason));
    assert.ok(generic.length <= 2, `${llm}: ${generic.length} cards use the generic oval-face line`);
  }
  const { person } = replayProfile();
  const styles = loadStyles();
  const swept = styles.find((item) => item.id === "side-part--soft-side-part")!;
  const textured = styles.find((item) => item.id === "crop--textured-french-crop-low-taper")!;
  const lines = (variant: typeof swept) => specificReasonCandidates({ person, answers: emptyAnswers(), variant });
  assert.match(lines(swept).slice(0, 3).join(" "), /falls to the side/);
  assert.match(lines(textured).slice(0, 4).join(" "), /front cowlick/);
  assert.match(lines(textured).join(" "), /sides/);
});

test("ranking list: the shown cards are the top of the ranking, and every ranked style is returned as the palette's full list", () => {
  const selection = select();
  assert.equal(selection.show.length, PALETTE_LIMIT);
  const ranked = new Set(selection.ranked.map((look) => look.variant.key));
  for (const look of [...selection.show, ...selection.goals]) assert.ok(ranked.has(look.variant.key));
  assert.ok(selection.ranked.filter((look) => !look.excluded).length > 150);
  const source = readFileSync(path.join("src", "server", "demo", "routes.ts"), "utf8");
  assert.match(source, /for \(const look of selection\?\.ranked \?\? \[\]\)[\s\S]{0,200}all\.push/);
});
