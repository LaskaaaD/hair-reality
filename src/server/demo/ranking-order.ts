import { groupRankingCards, mergeRankingCards } from "../../client/flow/ranking-groups.js";
import type { Person } from "../../domain/person.js";
import { varyReasonsInOrder } from "../../domain/reason-variety.js";
import { spreadTiedDisplayScores, type Answers, type ScoredVariant } from "../../domain/scoring.js";

type Card = Parameters<typeof mergeRankingCards>[0][number];

/** The order the client shows the cards in: grouped, then by Fit inside each group. */
export function displayOrder(cards: readonly Card[], goalCards: readonly Card[] = []): string[] {
  return groupRankingCards(mergeRankingCards([...cards], [...goalCards])).flatMap((section) => section.cards.map((card) => card.key));
}

/**
 * Makes the reasons read specifically in the order the client sees them: no five-word phrase in more than two
 * cards, and Fit strictly falls down the displayed list (a tie costs the later card one point).
 */
export function varyReasonsForDisplay(input: {
  show: readonly ScoredVariant[];
  goals: readonly ScoredVariant[];
  person: Person;
  answers: Answers;
  toCard: (look: ScoredVariant) => unknown;
}): { show: ScoredVariant[]; goals: ScoredVariant[] } {
  const apply = (looks: readonly ScoredVariant[], varied: ReadonlyMap<string, ScoredVariant>) => looks.map((look) => {
    const next = varied.get(look.variant.key);
    return next && (next.reasons[0] !== look.reasons[0] || next.score !== look.score) ? { ...look, reasons: next.reasons, score: next.score } : look;
  });
  // Which cards are shown depends on Fit, and spreading ties changes Fit, so settle the order on the spread scores
  // (a few passes at most) before the reasons are varied; otherwise a re-ordered list can show two equal Fits.
  let show = [...input.show];
  let goals = [...input.goals];
  let previous = "";
  for (let pass = 0; pass < 4; pass += 1) {
    const order = displayOrder(show.map((look) => input.toCard(look) as Card), goals.map((look) => input.toCard(look) as Card));
    const key = order.join("|");
    const current = new Map([...show, ...goals].map((look) => [look.variant.key, look]));
    const ordered = order.map((k) => current.get(k)).filter((look): look is ScoredVariant => look !== undefined);
    if (key === previous) {
      const varied = new Map(spreadTiedDisplayScores(varyReasonsInOrder(ordered, input.person, input.answers)).map((look) => [look.variant.key, look]));
      return { show: apply(show, varied), goals: apply(goals, varied) };
    }
    previous = key;
    const spread = new Map(spreadTiedDisplayScores(ordered).map((look) => [look.variant.key, look]));
    show = apply(show, spread);
    goals = apply(goals, spread);
  }
  const order = displayOrder(show.map((look) => input.toCard(look) as Card), goals.map((look) => input.toCard(look) as Card));
  const current = new Map([...show, ...goals].map((look) => [look.variant.key, look]));
  const ordered = order.map((k) => current.get(k)).filter((look): look is ScoredVariant => look !== undefined);
  const varied = new Map(spreadTiedDisplayScores(varyReasonsInOrder(ordered, input.person, input.answers)).map((look) => [look.variant.key, look]));
  return { show: apply(show, varied), goals: apply(goals, varied) };
}
