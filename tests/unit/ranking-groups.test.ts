import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaletteItem } from "../../src/client/api.js";
import {
  deduplicateRankingCardImages,
  fitScoreForCard,
  isShortClassicCrop,
  whyTextForCard,
} from "../../src/client/flow/flow-mappers.js";
import { firstSixWords } from "../../src/domain/ranking-reason.js";
import {
  cardsVisibleInGroup,
  collapsedRankingVisibleCount,
  groupRankingCards,
  mergeRankingCards,
  rankingGridColumnsForViewportWidth,
} from "../../src/client/flow/ranking-groups.js";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { fixturePerson, jordanPerson, ninaPerson, type Person } from "../../src/domain/person.js";
import { applyProfileOverrides } from "../../src/domain/profile-overrides.js";
import { emptyAnswers, selectLooks, type ScoredVariant } from "../../src/domain/scoring.js";

test("ranking grid columns follow e34 breakpoints", () => {
  assert.equal(rankingGridColumnsForViewportWidth(1440), 4);
  assert.equal(rankingGridColumnsForViewportWidth(900), 3);
  assert.equal(rankingGridColumnsForViewportWidth(600), 2);
  assert.equal(rankingGridColumnsForViewportWidth(390), 1);
});

test("collapsed visible counts are full rows on multi-column grids", () => {
  assert.equal(collapsedRankingVisibleCount(10, 4), 4);
  assert.equal(collapsedRankingVisibleCount(8, 4), 4);
  assert.equal(collapsedRankingVisibleCount(6, 4), 4);
  assert.equal(collapsedRankingVisibleCount(5, 4), 4);
  assert.equal(collapsedRankingVisibleCount(4, 4), 4);
  assert.equal(collapsedRankingVisibleCount(3, 4), 3);
  assert.equal(collapsedRankingVisibleCount(10, 2), 4);
  assert.equal(collapsedRankingVisibleCount(5, 2), 4);
});

test("cardsVisibleInGroup hides partial rows until expanded", () => {
  const cards = Array.from({ length: 6 }, (_, index) => ({
    key: `haircut:style-${index}`,
    title: `Style ${index}`,
    score: 80,
    label: "realistic" as const,
    reasons: ["ok"],
    stylistScript: "",
    stylingMinutes: 5,
    maintenanceWeeks: 4,
    components: { hairBehavior: 1, face: 1, hairline: 1, head: 1, lifestyle: 1, features: 1, trend: 1, goals: 0 },
    confidence: 0.8,
    missingCm: null,
    months: null,
    lengthBand: "short" as const,
    feasible: true,
    imageUrl: null,
  }));

  const collapsed = cardsVisibleInGroup(cards, "works-today", [], new Set(), 4);
  assert.equal(collapsed.visible.length, 4);
  assert.equal(collapsed.hiddenCount, 2);

  const expanded = cardsVisibleInGroup(cards, "works-today", [], new Set(["works-today"]), 4);
  assert.equal(expanded.visible.length, 6);
  assert.equal(expanded.hiddenCount, 0);
});

test("groupRankingCards merges 1-card groups into nearest group and sorts by best Fit inside", () => {
  const makeCard = (
    key: string,
    fit: number,
    opts: { stylingMinutes?: number; maintenanceWeeks?: number; missingCm?: number | null; label?: "realistic" | "needs-treatment" },
  ) => ({
    key: `haircut:${key}`,
    title: key,
    score: fit,
    label: opts.label ?? ("realistic" as const),
    reasons: ["ok"],
    stylistScript: "",
    stylingMinutes: opts.stylingMinutes ?? 5,
    maintenanceWeeks: opts.maintenanceWeeks ?? 5,
    components: {
      hairBehavior: fit - 30,
      face: 20,
      hairline: 5,
      head: 5,
      lifestyle: 8,
      features: 3,
      trend: 5,
      goals: 0,
    },
    confidence: 0.85,
    missingCm: opts.missingCm ?? null,
    months: opts.missingCm ? 3 : null,
    lengthBand: "short" as const,
    feasible: true,
    imageUrl: null,
  });

  // 4 low-maintenance cards + 1 needs-growth card -> 1-card group must be merged
  const cards = [
    makeCard("crop--a", 72, { stylingMinutes: 2, maintenanceWeeks: 6 }),
    makeCard("crop--b", 88, { stylingMinutes: 2, maintenanceWeeks: 6 }),
    makeCard("crop--c", 81, { stylingMinutes: 3, maintenanceWeeks: 6 }),
    makeCard("crop--d", 79, { stylingMinutes: 3, maintenanceWeeks: 6 }),
    makeCard("long--single-goal", 84, { stylingMinutes: 5, maintenanceWeeks: 6, missingCm: 4 }),
  ];

  const grouped = groupRankingCards(cards);
  for (const section of grouped) {
    assert.ok(section.cards.length >= 2, `Group ${section.label} has only ${section.cards.length} card(s)`);
    for (let i = 1; i < section.cards.length; i += 1) {
      const prevFit = fitScoreForCard(section.cards[i - 1]!);
      const currFit = fitScoreForCard(section.cards[i]!);
      assert.ok(prevFit >= currFit, `Group ${section.label} not sorted by Fit desc: ${prevFit} < ${currFit}`);
    }
  }
});

test("masculine, curly, and feminine long fine hair profiles produce balanced 3-4 groups of 3-6 cards and no cross-gender images", () => {
  const styles = loadStyles();
  const ninaBase = ninaPerson();
  const profiles: {
    name: string;
    person: Person;
    presentation: "masculine" | "feminine";
  }[] = [
    { name: "masculine sample", person: fixturePerson(), presentation: "masculine" },
    { name: "curly jordan", person: jordanPerson(), presentation: "masculine" },
    {
      name: "feminine long fine hair",
      person: applyProfileOverrides(
        {
          ...ninaBase,
          hair: {
            ...ninaBase.hair,
            diameter: { value: "fine", confidence: 0.9, source: "fixture" },
          },
        },
        { length: "Long", hairType: "Straight", density: "Medium-light" },
      ),
      presentation: "feminine",
    },
  ];

  for (const profile of profiles) {
    const answers = { ...emptyAnswers(), presentation: profile.presentation };
    const selected = selectLooks({
      service: "haircut",
      person: profile.person,
      answers,
      likes: [],
      styles,
      limit: 16,
    });

    const toCard = (look: ScoredVariant): PaletteItem => {
      const topCm = look.variant.requirements.topCm;
      return {
        key: look.variant.key,
        title: look.variant.title,
        family: look.variant.familyId,
        affinity: look.variant.affinity,
        score: look.score,
        label: look.label,
        reasons: look.reasons,
        criteria: look.criteria,
        stylistScript: look.stylistScript,
        stylingMinutes: look.stylingMinutes,
        maintenanceWeeks: look.maintenanceWeeks,
        components: look.components,
        confidence: look.confidence,
        missingCm: look.growth?.missingCm ?? null,
        months: look.growth?.months ?? null,
        targetLengthCm: topCm,
        lengthBand: topCm === null ? "any" : topCm <= 4 ? "short" : topCm <= 12 ? "medium" : "long",
        feasible: !look.excluded,
        imageUrl: null,
      };
    };

    const merged = mergeRankingCards(
      selected.show.map(toCard),
      selected.goals.map(toCard),
      [],
      selected.ranked.map(toCard),
    );
    const sections = groupRankingCards(merged);
    assert.ok(
      sections.length >= 3 && sections.length <= 4,
      `${profile.name}: expected 3-4 groups, got ${sections.length}`,
    );
    for (const section of sections) {
      assert.ok(
        section.cards.length >= 3 && section.cards.length <= 6,
        `${profile.name} group "${section.label}" has ${section.cards.length} cards (expected 3-6)`,
      );
      assert.notEqual(
        section.cards.length % 4,
        1,
        `${profile.name} group "${section.label}" has ${section.cards.length} cards (leaves an orphan card on 4-column desktop)`,
      );
      if (section.group === "bolder") {
        for (const card of section.cards) {
          assert.equal(
            isShortClassicCrop(card),
            false,
            `${profile.name} Bold change contains short classic crop: ${card.title} (${card.key})`,
          );
        }
      }
      for (let i = 1; i < section.cards.length; i += 1) {
        const prevFit = fitScoreForCard(section.cards[i - 1]!);
        const currFit = fitScoreForCard(section.cards[i]!);
        assert.ok(
          prevFit >= currFit,
          `${profile.name} group "${section.label}" not sorted by Fit: ${prevFit} < ${currFit}`,
        );
      }
    }

    const flat = sections.flatMap((s) => s.cards);
    const fitScores = flat.map((c) => fitScoreForCard(c)).sort((a, b) => b - a);
    const top5Fit = fitScores.slice(0, 5);
    assert.ok(top5Fit.every((fit) => fit >= 0 && fit <= 100), `${profile.name}: Fit outside 0-100 (${top5Fit.join(", ")})`);
    assert.ok(top5Fit[0]! < 100, `${profile.name}: top Fit pinned to 100`);

    const seenPrefixes = new Map<string, string>();
    for (const card of flat) {
      const why = whyTextForCard(card);
      const prefix = firstSixWords(why);
      assert.equal(
        seenPrefixes.has(prefix),
        false,
        `${profile.name}: E3 cards share first 6 words "${prefix}": "${seenPrefixes.get(prefix)}" vs "${why}"`,
      );
      seenPrefixes.set(prefix, why);
    }

    const images = deduplicateRankingCardImages(flat);
    if (profile.presentation === "feminine") {
      for (const card of flat) {
        const img = images.get(card.key);
        if (img?.kind === "demo") {
          assert.ok(
            !img.filename.startsWith("catalog/men/") &&
              !img.filename.startsWith("youcam/male_") &&
              !img.filename.startsWith("style-"),
            `Feminine card ${card.key} resolved to male image ${img.filename}`,
          );
        }
      }
    }
  }
});
