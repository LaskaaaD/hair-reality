import type { PaletteItem, RecommendationCard } from "../api.js";
import { FIT_STEP, roundFit } from "../../shared/fit.js";
import {
  cardTargetTopCm,
  fitScoreForCard,
  isBoldStyleCard,
  isShortClassicCrop,
  isStructuredAdjustmentCard,
  rankingGroupFor,
  type RankingGroup,
} from "./flow-mappers.js";

export type RankCard = RecommendationCard | PaletteItem;

export const RANKING_GROUP_ORDER: RankingGroup[] = [
  "less-styling",
  "works-today",
  "grow-out",
  "bolder",
];

/** Minimum cards shown before "Show more" on wide layouts. */
export const RANKING_FOLD_MIN = 4;

/** Display headings for HR-106 grouped ranking sections. */
export function rankingSectionLabel(group: RankingGroup): string {
  switch (group) {
    case "less-styling":
      return "Low maintenance";
    case "works-today":
      return "With small adjustments";
    case "grow-out":
      return "Needs growth";
    case "bolder":
      return "Bold change";
  }
}

/** Match breakpoints in e34.css `.flow-style-grid`. */
export function rankingGridColumnsForViewportWidth(width: number): number {
  if (width >= 1100) return 4;
  if (width >= 820) return 3;
  if (width >= 560) return 2;
  return 1;
}

/**
 * Collapsed visible count: full grid rows only (no orphan slots in the visible set).
 */
export function collapsedRankingVisibleCount(
  totalCards: number,
  columns: number,
  foldMin = RANKING_FOLD_MIN,
): number {
  if (totalCards <= 0) return 0;
  if (columns <= 1) return Math.min(totalCards, foldMin);
  if (totalCards <= columns) return totalCards;

  const cap = Math.min(totalCards, Math.max(foldMin, columns));
  let visible = Math.floor(cap / columns) * columns;
  if (visible <= 0) visible = columns;
  if (visible > totalCards) {
    visible = Math.floor(totalCards / columns) * columns;
    if (visible <= 0) return totalCards;
  }
  return visible;
}

export type RankingGroupVisibility = {
  visible: RankCard[];
  hiddenCount: number;
  autoExpanded: boolean;
};

export function cardsVisibleInGroup(
  cards: RankCard[],
  groupKey: string,
  selectedKeys: string[],
  expandedGroups: ReadonlySet<string>,
  columns: number,
): RankingGroupVisibility {
  const pickedBeyondFold = cards.some((card, index) => {
    const collapsedCount = collapsedRankingVisibleCount(cards.length, columns);
    return index >= collapsedCount && selectedKeys.includes(card.key);
  });
  const autoExpanded = pickedBeyondFold;
  const isExpanded = expandedGroups.has(groupKey) || autoExpanded;

  if (isExpanded || cards.length <= collapsedRankingVisibleCount(cards.length, columns)) {
    return { visible: cards, hiddenCount: 0, autoExpanded };
  }

  const visibleCount = collapsedRankingVisibleCount(cards.length, columns);
  return {
    visible: cards.slice(0, visibleCount),
    hiddenCount: cards.length - visibleCount,
    autoExpanded,
  };
}

function enrichCardWithPalette(
  card: RankCard,
  paletteByKey: ReadonlyMap<string, PaletteItem>,
): RankCard {
  const fromPalette = paletteByKey.get(card.key);
  if (!fromPalette) return card;
  return {
    ...fromPalette,
    ...card,
    affinity: card.affinity ?? fromPalette.affinity,
    targetLengthCm:
      "targetLengthCm" in card && card.targetLengthCm != null
        ? card.targetLengthCm
        : fromPalette.targetLengthCm,
    criteria:
      "criteria" in card && card.criteria != null ? card.criteria : fromPalette.criteria,
  };
}

/**
 * The shown list falls strictly in displayed Fit: a card that ties the one before it (or rises above it) steps down by
 * FIT_STEP (0.1), the same rule the server applies to its own list, so palette extras can never tie a ranked card.
 * `cards` must already be in display order (best Fit first, ties broken by the caller).
 */
function spreadShownFit(cards: RankCard[]): RankCard[] {
  let previous = 101;
  return cards.map((card) => {
    const fit = Math.max(0, roundFit(Math.min(previous - FIT_STEP, fitScoreForCard(card))));
    previous = fit;
    return fit === card.score ? card : { ...card, score: fit };
  });
}

/**
 * Combine ready recommendations (`rec.recommendations`) and growth goals (`rec.goals`),
 * enriched with palette metadata so E3 has both immediate styles and growth-goal styles.
 */
export function mergeRankingCards(
  recommendations: RecommendationCard[],
  goals: RecommendationCard[] = [],
  paletteTop: PaletteItem[] = [],
  paletteAll: PaletteItem[] = [],
): RankCard[] {
  const paletteByKey = new Map<string, PaletteItem>();
  for (const item of paletteAll) paletteByKey.set(item.key, item);
  for (const item of paletteTop) {
    if (!paletteByKey.has(item.key)) paletteByKey.set(item.key, item);
  }

  const baseReady = recommendations.length > 0 ? recommendations : paletteTop;
  if (baseReady.length === 0) return [];

  const seenKeys = new Set<string>();
  const readyCards: RankCard[] = [];
  for (const card of baseReady) {
    if (seenKeys.has(card.key)) continue;
    seenKeys.add(card.key);
    readyCards.push(enrichCardWithPalette(card, paletteByKey));
  }

  const goalCards: RankCard[] = [];
  for (const goal of goals) {
    if (seenKeys.has(goal.key)) continue;
    seenKeys.add(goal.key);
    goalCards.push(enrichCardWithPalette(goal, paletteByKey));
  }

  if (goalCards.length < 3 && paletteAll.length > 0) {
    const usedGoalFamilies = new Set(
      goalCards.map((c) => c.family).filter((f): f is string => Boolean(f)),
    );
    const extraGoals = paletteAll
      .filter(
        (item) =>
          !seenKeys.has(item.key) &&
          item.feasible !== false &&
          (item.missingCm ?? 0) > 0,
      )
      .sort((a, b) => fitScoreForCard(b) - fitScoreForCard(a) || b.score - a.score);

    for (const extra of extraGoals) {
      if (goalCards.length >= 4) break;
      if (extra.family && usedGoalFamilies.has(extra.family)) continue;
      seenKeys.add(extra.key);
      if (extra.family) usedGoalFamilies.add(extra.family);
      goalCards.push(extra);
    }
  }

  const selectedGoals = goalCards.slice(0, 4);
  // A full top-50 list is one run in Fit order: the bold and goal quotas below only make sense for a short page.
  if (readyCards.length > WIDE_LIST_MIN) {
    const wide = [...readyCards, ...selectedGoals.filter((card) => goals.some((goal) => goal.key === card.key))];
    return spreadInDisplayOrder(wide.sort((a, b) => fitScoreForCard(b) - fitScoreForCard(a) || b.score - a.score).slice(0, RANKING_LIST_LIMIT), new Set());
  }
  /** Cards pulled from the palette only to fill a group; they must earn a slot on Fit and never push out a better ranked card. */
  const fillers = new Set<RankCard>(goalCards.filter((card) => !goals.some((goal) => goal.key === card.key)));
  const readyBold = readyCards.filter((card) => rankingGroupFor(card) === "bolder").slice(0, 4);
  const readyEveryday = readyCards.filter((card) => rankingGroupFor(card) !== "bolder");

  if (readyBold.length < 4 && paletteAll.length > 0) {
    const usedBoldFamilies = new Set(
      readyBold.map((c) => c.family).filter((f): f is string => Boolean(f)),
    );
    const extraBold = paletteAll
      .filter(
        (item) =>
          !seenKeys.has(item.key) &&
          item.feasible !== false &&
          (item.missingCm ?? 0) === 0 &&
          rankingGroupFor(item) === "bolder",
      )
      .sort((a, b) => fitScoreForCard(b) - fitScoreForCard(a) || b.score - a.score);

    for (const extra of extraBold) {
      if (readyBold.length >= 4) break;
      if (extra.family && usedBoldFamilies.has(extra.family)) continue;
      seenKeys.add(extra.key);
      if (extra.family) usedBoldFamilies.add(extra.family);
      fillers.add(extra);
      readyBold.push(extra);
    }
  }

  if (selectedGoals.length === 0 && readyBold.length === 0) {
    return spreadInDisplayOrder(readyCards.slice(0, RANKING_LIST_LIMIT), new Set());
  }

  // Real goals and ranked bold cards keep their places; the remaining slots go to ranked everyday cards and palette
  // fillers by Fit, so a filler only appears when it beats the ranked card it would replace (ties go to the ranked card).
  const reserved = [...readyBold.filter((card) => !fillers.has(card)), ...selectedGoals.filter((card) => !fillers.has(card))];
  const slots = Math.max(4, RANKING_LIST_LIMIT - reserved.length);
  // Shown Fit is spread down a dense list, so the contest for a slot compares the Fit the full ranking gave each card, not the spread one.
  const contestFit = (card: RankCard) => Math.max(fitScoreForCard(card), paletteByKey.get(card.key) ? fitScoreForCard(paletteByKey.get(card.key)!) : 0);
  const contenders = [...readyEveryday, ...readyBold.filter((card) => fillers.has(card)), ...selectedGoals.filter((card) => fillers.has(card))]
    .map((card, index) => ({ card, index, filler: fillers.has(card) }))
    .sort((a, b) => contestFit(b.card) - contestFit(a.card) || Number(a.filler) - Number(b.filler) || a.index - b.index)
    .slice(0, slots)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.card);
  const kept = applyReservedMargin({
    reserved,
    // The best 2 reserved cards of the bolder group and of the goals group are a floor that is never displaced.
    floor: [readyBold, selectedGoals].flatMap((group) => reserved.filter((card) => group.includes(card)).sort((a, b) => contestFit(b) - contestFit(a)).slice(0, 2)),
    // Ranked everyday cards that lost the contest for a free slot, best Fit first.
    challengers: readyEveryday.filter((card) => !contenders.includes(card)).sort((a, b) => contestFit(b) - contestFit(a)),
    contestFit,
  });
  const keep = new Set([...contenders, ...kept]);
  return spreadInDisplayOrder([...readyEveryday, ...readyBold, ...selectedGoals].filter((card) => keep.has(card)), fillers);
}

/** How many styles the results list shows: the whole top 50 of the ranking. */
export const RANKING_LIST_LIMIT = 50;
/** More ready cards than this is the top-50 list: shown as one section ordered by Fit, not as the short grouped page. */
export const WIDE_LIST_MIN = 24;

/** A reserved bold card or goal loses its slot to a ranked everyday card that beats it by at least this much Fit. */
export const RESERVED_SLOT_MARGIN = 2;

/**
 * Returns the reserved cards that keep their slot plus the challengers that displaced one: worst-Fit reserved cards beyond
 * the floor go first, to the best-Fit challengers first. The card count stays the same; a smaller margin keeps the reserved card.
 */
export function applyReservedMargin(input: { reserved: RankCard[]; floor: RankCard[]; challengers: RankCard[]; contestFit: (card: RankCard) => number }): RankCard[] {
  const { floor, contestFit } = input;
  const exposed = input.reserved.filter((card) => !floor.includes(card)).sort((a, b) => contestFit(a) - contestFit(b));
  const kept = new Set(input.reserved);
  const winners: RankCard[] = [];
  for (let i = 0; i < Math.min(exposed.length, input.challengers.length); i += 1) {
    if (contestFit(input.challengers[i]!) - contestFit(exposed[i]!) < RESERVED_SLOT_MARGIN - 1e-9) break;
    kept.delete(exposed[i]!);
    winners.push(input.challengers[i]!);
  }
  return [...kept, ...winners];
}

/** Applies the strict Fit spread in the order the list will be shown (Fit, then ranked before filler, then merge order); the returned list keeps its input order. */
function spreadInDisplayOrder(cards: RankCard[], fillers: ReadonlySet<RankCard>): RankCard[] {
  const order = cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => fitScoreForCard(b.card) - fitScoreForCard(a.card) || Number(fillers.has(a.card)) - Number(fillers.has(b.card)) || a.index - b.index);
  const spread = spreadShownFit(order.map((item) => item.card));
  const result = [...cards];
  order.forEach((item, rank) => { result[item.index] = spread[rank]!; });
  return result;
}

/** A short classic crop is never a bold change; no step may move one into that group. */
const FORBIDDEN_AFFINITY = -200;

function groupAffinityScore(card: RankCard, group: RankingGroup): number {
  const topCm = cardTargetTopCm(card);
  const missing = card.missingCm ?? 0;
  switch (group) {
    case "grow-out":
      return (missing > 0 ? 100 + missing * 10 : 0) + topCm * 2;
    case "bolder":
      if (isShortClassicCrop(card)) return FORBIDDEN_AFFINITY;
      return (
        (card.label === "needs-treatment" ? 80 : 0) +
        (isBoldStyleCard(card) ? 60 : 0) +
        (topCm <= 1.2 ? 40 : 0) +
        (6 - (card.components?.trend ?? 3)) * 4
      );
    case "works-today":
      return (
        card.stylingMinutes * 4 +
        Math.max(0, 10 - card.maintenanceWeeks) * 3 +
        (isStructuredAdjustmentCard(card) ? 25 : 0) -
        (missing > 0 ? 80 : 0) -
        (card.label === "needs-treatment" ? 80 : 0)
      );
    case "less-styling":
      return (
        Math.max(0, 16 - card.stylingMinutes) * 4 +
        Math.min(12, card.maintenanceWeeks) * 2 -
        (isBoldStyleCard(card) ? 25 : 0) -
        (missing > 0 ? 80 : 0) -
        (card.label === "needs-treatment" ? 80 : 0)
      );
  }
}

function sizeViolations(sizes: ReadonlyMap<RankingGroup, number>, minSize: number, maxSize: number): number {
  let count = 0;
  for (const n of sizes.values()) {
    if (n > maxSize || (n > 4 && n % 4 === 1) || (n > 0 && n < minSize)) count += 1;
  }
  return count;
}

/** Depth-limited search over single-card moves; picks the cheapest sequence that leaves no size violation. */
function repairGroupSizes(buckets: Map<RankingGroup, RankCard[]>, minSize: number, maxSize: number): void {
  const sizes = () => new Map(RANKING_GROUP_ORDER.map((g) => [g, buckets.get(g)!.length] as const));
  if (sizeViolations(sizes(), minSize, maxSize) === 0) return;
  type Move = { from: RankingGroup; to: RankingGroup; card: RankCard; cost: number };
  const used = new Set<RankCard>();
  const bestCard = (from: RankingGroup, to: RankingGroup): Move | null => {
    let best: Move | null = null;
    for (const card of buckets.get(from)!) {
      if (used.has(card)) continue;
      const target = groupAffinityScore(card, to);
      if (target <= FORBIDDEN_AFFINITY) continue;
      const cost = groupAffinityScore(card, from) - target;
      if (!best || cost < best.cost) best = { from, to, card, cost };
    }
    return best;
  };
  let winner: Move[] | null = null;
  let winnerCost = Infinity;
  const walk = (state: Map<RankingGroup, number>, path: Move[], cost: number, depth: number): void => {
    if (sizeViolations(state, minSize, maxSize) === 0) {
      if (cost < winnerCost) {
        winner = [...path];
        winnerCost = cost;
      }
      return;
    }
    if (depth === 0) return;
    for (const from of RANKING_GROUP_ORDER) {
      for (const to of RANKING_GROUP_ORDER) {
        if (from === to || (state.get(from) ?? 0) === 0) continue;
        const move = bestCard(from, to);
        if (!move) continue;
        used.add(move.card);
        const next = new Map(state);
        next.set(from, (next.get(from) ?? 0) - 1);
        next.set(to, (next.get(to) ?? 0) + 1);
        walk(next, [...path, move], cost + move.cost, depth - 1);
        used.delete(move.card);
      }
    }
  };
  walk(sizes(), [], 0, 3);
  for (const move of (winner ?? []) as Move[]) {
    const from = buckets.get(move.from)!;
    from.splice(from.indexOf(move.card), 1);
    buckets.get(move.to)!.push(move.card);
  }
}

export function groupRankingCards(
  cards: RankCard[],
): { group: RankingGroup; label: string; cards: RankCard[] }[] {
  if (cards.length === 0) return [];
  if (cards.length > WIDE_LIST_MIN) {
    const ordered = [...cards].sort((a, b) => fitScoreForCard(b) - fitScoreForCard(a) || b.score - a.score);
    return [{ group: "works-today", label: "Your best matches, strongest first", cards: ordered }];
  }

  const buckets = new Map<RankingGroup, RankCard[]>();
  for (const group of RANKING_GROUP_ORDER) buckets.set(group, []);
  for (const card of cards) {
    buckets.get(rankingGroupFor(card))!.push(card);
  }

  const minSize = cards.length >= 12 ? 3 : 2;
  const maxSize = 6;

  // 1. Cap oversized groups (> maxSize) by moving best-fit card to under-capacity groups
  let guard = 0;
  while (guard++ < 32) {
    const over = RANKING_GROUP_ORDER.find((g) => (buckets.get(g)?.length ?? 0) > maxSize);
    if (!over) break;
    const list = buckets.get(over)!;
    const candidates = RANKING_GROUP_ORDER.filter(
      (g) => g !== over && (buckets.get(g)?.length ?? 0) < maxSize,
    );
    if (candidates.length === 0) break;
    let bestIdx = 0;
    let bestTarget = candidates[0]!;
    let bestScore = -Infinity;
    for (let i = 0; i < list.length; i += 1) {
      const card = list[i]!;
      for (const target of candidates) {
        const scarcityBonus = (maxSize - (buckets.get(target)?.length ?? 0)) * 6;
        const score = groupAffinityScore(card, target) + scarcityBonus;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
          bestTarget = target;
        }
      }
    }
    const [moved] = list.splice(bestIdx, 1);
    if (moved) buckets.get(bestTarget)!.push(moved);
  }

  // 2. If total cards >= 12, top up groups that have 1..minSize-1 cards from groups with > minSize cards
  if (cards.length >= 12) {
    for (const under of RANKING_GROUP_ORDER) {
      const targetList = buckets.get(under)!;
      while (targetList.length > 0 && targetList.length < minSize) {
        const donors = RANKING_GROUP_ORDER.filter(
          (g) => g !== under && (buckets.get(g)?.length ?? 0) > minSize,
        );
        if (donors.length === 0) break;
        let bestDonor: RankingGroup | null = null;
        let bestIdx = -1;
        let bestScore = -Infinity;
        for (const donor of donors) {
          const dList = buckets.get(donor)!;
          for (let i = 0; i < dList.length; i += 1) {
            const score = groupAffinityScore(dList[i]!, under);
            if (score <= FORBIDDEN_AFFINITY) continue;
            if (score > bestScore) {
              bestScore = score;
              bestDonor = donor;
              bestIdx = i;
            }
          }
        }
        if (!bestDonor || bestIdx < 0) break;
        const [moved] = buckets.get(bestDonor)!.splice(bestIdx, 1);
        if (moved) targetList.push(moved);
      }
    }

    // Keep desktop 4-column rows free of single-card orphans by balancing >4 groups into <4 groups
    let balanceGuard = 0;
    while (balanceGuard++ < 16) {
      const heavy = RANKING_GROUP_ORDER.find((g) => (buckets.get(g)?.length ?? 0) > 4);
      const light = RANKING_GROUP_ORDER.find(
        (g) => (buckets.get(g)?.length ?? 0) > 0 && (buckets.get(g)?.length ?? 0) < 4,
      );
      if (!heavy || !light) break;
      const heavyList = buckets.get(heavy)!;
      let bestIdx = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < heavyList.length; i += 1) {
        const score = groupAffinityScore(heavyList[i]!, light);
        if (score <= FORBIDDEN_AFFINITY) continue;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const [moved] = heavyList.splice(bestIdx, 1);
      if (moved) buckets.get(light)!.push(moved);
    }

    // If any group still has an orphan card on a 4-column desktop row (count % 4 === 1, e.g. 5), move it to the nearest group
    for (let i = 0; i < RANKING_GROUP_ORDER.length; i += 1) {
      const g = RANKING_GROUP_ORDER[i]!;
      const list = buckets.get(g)!;
      if (list.length > 4 && list.length % 4 === 1) {
        const recipients = RANKING_GROUP_ORDER.filter((other) => {
          if (other === g) return false;
          const len = buckets.get(other)?.length ?? 0;
          return len > 0 && len < maxSize && (len + 1) % 4 !== 1;
        }).sort(
          (a, b) =>
            Math.abs(RANKING_GROUP_ORDER.indexOf(a) - i) -
            Math.abs(RANKING_GROUP_ORDER.indexOf(b) - i),
        );
        const target = recipients[0];
        if (target) {
          let bestIdx = 0;
          let bestScore = -Infinity;
          for (let idx = 0; idx < list.length; idx += 1) {
            const score = groupAffinityScore(list[idx]!, target);
            if (score <= FORBIDDEN_AFFINITY) continue;
            if (score > bestScore) {
              bestScore = score;
              bestIdx = idx;
            }
          }
          if (bestScore > -Infinity) {
            const [moved] = list.splice(bestIdx, 1);
            if (moved) buckets.get(target)!.push(moved);
          }
        }
      }
    }
  }

  // 3. Never show a group with 1 card (or < minSize if it couldn't be topped up): merge into nearest group
  if (cards.length >= 2) {
    for (let i = 0; i < RANKING_GROUP_ORDER.length; i += 1) {
      const g = RANKING_GROUP_ORDER[i]!;
      const list = buckets.get(g)!;
      const threshold = cards.length >= 6 ? minSize : 2;
      if (list.length > 0 && list.length < threshold) {
        const neighbors = RANKING_GROUP_ORDER.filter(
          (other) => other !== g && (buckets.get(other)?.length ?? 0) > 0,
        ).sort(
          (a, b) =>
            Math.abs(RANKING_GROUP_ORDER.indexOf(a) - i) -
            Math.abs(RANKING_GROUP_ORDER.indexOf(b) - i),
        );
        const target =
          neighbors.find((n) => (buckets.get(n)?.length ?? 0) + list.length <= maxSize) ??
          neighbors[0];
        if (target) {
          buckets.get(target)!.push(...list);
          buckets.set(g, []);
        }
      }
    }
  }

  // 3b. Last resort: a few card moves that remove any 4-column orphan or oversized group left by the steps above.
  if (cards.length >= 12) repairGroupSizes(buckets, minSize, maxSize);

  // 4. Strict order: the whole page is descending by displayed Fit. Groups are labels over consecutive runs.
  const byFit = (a: RankCard, b: RankCard) => fitScoreForCard(b) - fitScoreForCard(a) || b.score - a.score;
  const groupOf = new Map<RankCard, RankingGroup>();
  for (const [group, list] of buckets) for (const card of list) groupOf.set(card, group);
  const sections: { group: RankingGroup; label: string; cards: RankCard[] }[] = [];
  const ordered = [...groupOf.keys()].sort(byFit);
  for (const card of ordered) {
    const group = groupOf.get(card)!;
    const last = sections.at(-1);
    const seen = sections.some((section) => section.group === group);
    if (last && (seen || (last.cards.length < 2 && cards.length >= 6))) last.cards.push(card);
    else sections.push({ group, label: rankingSectionLabel(group), cards: [card] });
  }
  const sizesOk = sections.every((section) => section.cards.length >= minSize && section.cards.length <= maxSize && !(section.cards.length > 4 && section.cards.length % 4 === 1));
  if (cards.length < 12 || sizesOk) return sections;
  // Runs would leave a thin or oversized group: cut the Fit-sorted list into balanced consecutive segments and label each
  // with the group that most of its cards belong to (a short classic crop never lands under Bold change).
  const sizeOk = (n: number) => n >= minSize && n <= maxSize && !(n > 4 && n % 4 === 1);
  let best: { score: number; sizes: number[]; labels: RankingGroup[] } | null = null;
  const tryLabels = (sizes: number[]): void => {
    const segments: RankCard[][] = [];
    let at = 0;
    for (const size of sizes) {
      segments.push(ordered.slice(at, at + size));
      at += size;
    }
    const used: RankingGroup[] = [];
    const walk = (index: number, score: number): void => {
      if (index === segments.length) {
        if (!best || score > best.score) best = { score, sizes, labels: [...used] };
        return;
      }
      for (const group of RANKING_GROUP_ORDER) {
        if (used.includes(group)) continue;
        const cardsHere = segments[index]!;
        if (group === "bolder" && cardsHere.some(isShortClassicCrop)) continue;
        used.push(group);
        walk(index + 1, score + cardsHere.filter((card) => groupOf.get(card) === group).length);
        used.pop();
      }
    };
    walk(0, 0);
  };
  const compose = (left: number, parts: number[]): void => {
    if (parts.length > 4) return;
    if (left === 0) {
      if (parts.length >= 2) tryLabels(parts);
      return;
    }
    for (let n = minSize; n <= maxSize; n += 1) if (sizeOk(n) && n <= left) compose(left - n, [...parts, n]);
  };
  compose(ordered.length, []);
  const chosen = best as { sizes: number[]; labels: RankingGroup[] } | null;
  if (!chosen) return sections;
  let cursor = 0;
  return chosen.sizes.map((size, index) => {
    const group = chosen.labels[index]!;
    const slice = ordered.slice(cursor, cursor + size);
    cursor += size;
    return { group, label: rankingSectionLabel(group), cards: slice };
  });
}
