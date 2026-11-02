import type { StyleVariant } from "./knowledge-base.js";
import type { Person } from "./person.js";
import type { Answers } from "./scoring.js";
import { collapseRepeatedWords, faceReadsLong, faceShapeLabel, sanitizeReasonText, styleFeaturePhrase } from "./ranking-reason.js";

/** Specific reasons: one trait of the style plus one fact from the client's own profile. */

type Ctx = { person: Person; answers: Answers; variant: StyleVariant };

const SIDES_TRAIT: Record<string, string> = {
  scissor: "keeps the sides soft and scissor-cut instead of clippered tight",
  "low-taper": "tapers the sides low and clean while leaving some width above the ears",
  mid: "fades the sides in at mid height for a clear but gentle contrast",
  high: "runs the sides high for a sharp contrast with the top",
  skin: "takes the sides right down to skin for a bare, sharp contrast",
};

const FRINGE_TRAIT: Record<string, string> = {
  curtain: "parts the front into soft curtains that frame the forehead",
  blunt: "cuts a straight, heavy fringe across the forehead",
  textured: "breaks the front into a choppy, textured fringe",
  swept: "sweeps the front across to one side",
  none: "lifts the front away from the forehead",
};

function familyTrait(variant: StyleVariant): string | null {
  const blob = `${variant.familyId} ${variant.id} ${variant.title}`.toLowerCase();
  if (/ivy/.test(blob)) return "is the classic Ivy League shape, short and brushed to the side with a neat part";
  if (/caesar/.test(blob)) return "is a short Caesar with a horizontal fringe that needs almost no styling";
  if (/french/.test(blob)) return "is a French crop with a short, forward-combed fringe";
  if (/mod cut|mod-cut/.test(blob)) return "is a 60s mod cut with fullness at the sides and a clean forward top";
  if (/messy fringe|messy-fringe/.test(blob)) return "is a relaxed messy fringe that looks lived-in on purpose";
  if (/side part|side-part/.test(blob)) return "is a tidy side part that reads smart without effort";
  if (/curtain/.test(blob)) return "is a curtain cut, parted in the middle and falling to both sides";
  if (/two-block|two block/.test(blob)) return "is a two-block cut with a tucked-in undercut and movement on top";
  if (/quiff|pompadour/.test(blob)) return "is a lifted quiff shape that depends on height at the front";
  if (/faux hawk|faux-hawk|mohawk/.test(blob)) return "is a faux hawk that pushes the centre line up";
  if (/high and tight|high-and-tight/.test(blob)) return "is a military high and tight with very little hair left on top";
  if (/undercut/.test(blob)) return "is an undercut with a clear step between the top and the sides";
  if (/taper|fade/.test(blob)) return "is a graduated cut where the length changes smoothly from neck to top";
  if (/crop/.test(blob)) return "is a cropped cut with a short, forward-textured top";
  return null;
}

function heightTrait(variant: StyleVariant): string | null {
  const height = variant.geometry.addsHeight;
  if (height >= 0.5) return "adds clear height at the crown";
  if (height <= 0.2) return "stays low and close to the head on top";
  return null;
}

/** Whole-number-free comparison of a client's length with the length a cut asks for (null when either is unknown). */
function lengthGap(have: unknown, need: number | null): "close" | "shorter" | "longer" | null {
  if (typeof have !== "number" || need === null) return null;
  if (Math.abs(have - need) <= 1.5) return "close";
  return need < have ? "shorter" : "longer";
}

/** Facts that tie this style to this client's fringe, growth direction, cowlick and side length: they lead the list. */
function specificFacts({ person, variant }: Ctx): string[] {
  const facts: string[] = [];
  const fringe = variant.attrs?.fringeType;
  const direction = person.hair.growthDirection.value;
  const style = variant.fit.direction;
  if (direction === "side" && (style === "side" || fringe === "swept")) facts.push("and your hair already falls to the side, so the sweep goes with the grain instead of against it");
  else if (direction === "side" && style === "back") facts.push("though your hair falls to the side, so brushing it back takes a little product");
  else if (direction === "side" && (fringe === "curtain" || fringe === "textured" || fringe === "blunt" || style === "forward")) facts.push("though your hair falls to the side, so the front needs a touch of product to stay where this cut puts it");
  else if (direction === "side") facts.push("and hair that falls to the side settles into this shape without a fight");
  if (direction === "forward" && style !== "back" && fringe && fringe !== "none") facts.push("and your hair already grows forward, so the front lies down without a fight");
  if (person.hair.cowlickFront.value === true) {
    if (fringe === "textured") facts.push("and the choppy front breaks up the front cowlick so it never stands out");
    else if (fringe === "swept") facts.push("and the sweep carries the front cowlick along with it");
    else if (fringe === "curtain") facts.push("and the curtain split lets the front cowlick part where it wants to");
    else if (fringe === "blunt") facts.push(variant.fit.cowlick === "sensitive" ? "though a straight fringe shows a front cowlick, so it needs a firm blow-dry" : "and the front cowlick is hidden under the weight of the fringe");
    else if (variant.fit.cowlick === "ok") facts.push("and the front cowlick disappears into the movement of this cut");
  }
  if (person.hair.cowlickCrown.value === true && variant.geometry.addsHeight <= 0.5) facts.push("and a crown cowlick has little room to stand up at this height");
  const sides = lengthGap(person.hair.sideCm.value, variant.requirements.sidesCm);
  if (sides === "close") facts.push("and your sides are already about the length this cut wants, so the barber only has to tidy them");
  else if (sides === "shorter") facts.push("and it takes your sides in shorter than they are today");
  else if (sides === "longer") facts.push("and it leaves your sides fuller than they are today");
  const top = lengthGap(person.hair.topCm.value, variant.requirements.topCm);
  if (top === "close") facts.push("and your top is already near the length this cut asks for");
  else if (top === "shorter") facts.push("and it shortens the top from where it is today");
  return facts;
}

function profileFacts({ person, answers, variant }: Ctx): string[] {
  const facts: string[] = specificFacts({ person, answers, variant });
  const generic: string[] = [];
  const shape = faceShapeLabel(person);
  const long = faceReadsLong(person);
  const sides = variant.attrs?.sides;
  const fringe = variant.attrs?.fringeType;
  const height = variant.geometry.addsHeight;
  const cover = variant.geometry.coversForehead;
  const curl = person.hair.curl.value;
  const density = person.hair.density.value;
  const strand = person.hair.diameter.value;
  const minutes = Math.max(1, Math.round(variant.lifestyle.stylingMinutes));
  const weeks = Math.max(2, Math.round(variant.lifestyle.maintenanceWeeks));

  if (person.face.foreheadWidth?.value === "wide") facts.push(cover >= 0.2 ? "so a wider forehead gets a softer frame" : "and a wider forehead is shown off cleanly");
  if (person.face.forehead.value === "average" && fringe === "none") facts.push("and an average forehead can be shown without any cover");
  if (curl === "1") facts.push("and straight hair keeps every line crisp");
  else if (typeof curl === "string" && curl.startsWith("2")) facts.push("and your natural wave adds texture without much product");
  if (typeof density === "number" && density >= 3) facts.push("and dense hair gives the top plenty of body");
  if (strand === "medium") facts.push("and medium strands hold the shape without heavy product");
  if (strand === "fine") facts.push("and fine strands stay light rather than flat");
  if (person.context.glasses.value === false && fringe && fringe !== "none") facts.push("and nothing sits between the fringe and your eyes");
  if (answers.keep === "fringe") facts.push("and it keeps the fringe you asked to keep");

  if (long && height <= 0.4) generic.push("which keeps a longer face from looking any longer");
  else if (shape === "oval") generic.push("which suits an oval face without adding extra length or width");
  else generic.push(`which balances a ${shape} face`);
  if (shape === "oval" && !long && height <= 0.45) generic.push("so the proportions of your oval face stay as they are");
  if (person.hair.hairline.value === "average" && fringe !== "blunt") generic.push("and your average hairline needs no hiding");
  if (person.head.ears?.value === "average" && sides) generic.push(sides === "scissor" ? "and average ears stay softly covered" : "and average ears look tidy against sides cut this clean");
  if (person.face.jaw.value === "average") generic.push("and an average jaw does not need extra width at the sides");
  generic.push(`and it takes about ${minutes} minutes a day`);
  generic.push(`and it needs a trim only every ${weeks} weeks`);
  return [...facts, ...generic];
}

function traitsFor(ctx: Ctx): string[] {
  const { variant } = ctx;
  const out: string[] = [];
  const family = familyTrait(variant);
  if (family) out.push(family);
  const sides = variant.attrs?.sides ? SIDES_TRAIT[variant.attrs.sides] : undefined;
  if (sides) out.push(sides);
  const fringe = variant.attrs?.fringeType ? FRINGE_TRAIT[variant.attrs.fringeType] : undefined;
  if (fringe) out.push(fringe);
  const height = heightTrait(variant);
  if (height) out.push(height);
  if (out.length === 0) out.push(`brings ${styleFeaturePhrase(variant)}`);
  return out;
}

export function specificReasonCandidates(ctx: Ctx): string[] {
  const facts = profileFacts(ctx);
  const out: string[] = [];
  for (const trait of traitsFor(ctx)) {
    for (const fact of facts) out.push(collapseRepeatedWords(sanitizeReasonText(`${ctx.variant.title} ${trait}, ${fact}.`)));
  }
  return out;
}

const PHRASE_WORDS = 5;
export const MAX_PHRASE_REPEATS = 2;
/** A clause is a run of this many words: long enough to be a stock sentence part ("your hair falls to the side, so the front needs a touch of product...") rather than a short shared phrase. */
export const CLAUSE_WORDS = 8;
/** A clause used in one card is replaced in the next: no card may repeat a clause an earlier card already carries. */
export const MAX_CLAUSE_REPEATS = 1;

/** Every run of five words in a reason with the style name removed: the unit a "template phrase" is counted in. */
export function reasonPhrases(reason: string, title: string, size = PHRASE_WORDS): string[] {
  const words = reason.replaceAll(title, " ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let index = 0; index + size <= words.length; index += 1) out.push(words.slice(index, index + size).join(" "));
  return out;
}

/**
 * Walks the ranking in display order so no five-word phrase appears in more than two reasons. A reason that is
 * already fine is kept (a model-written one included); a template-written one (it opens with the style name) and
 * one that repeats a phrase are replaced by the first specific reason (style trait plus a fact from this client's profile) that does not.
 */
export function varyReasonsInOrder<T extends { variant: StyleVariant; reasons: string[] }>(
  ordered: readonly T[],
  person: Person,
  answers: Answers,
  limit = 24,
): T[] {
  const uses = new Map<string, number>();
  const clauseUses = new Map<string, number>();
  const fits = (reason: string, title: string) =>
    reasonPhrases(reason, title).every((phrase) => (uses.get(phrase) ?? 0) < MAX_PHRASE_REPEATS)
    && reasonPhrases(reason, title, CLAUSE_WORDS).every((clause) => (clauseUses.get(clause) ?? 0) < MAX_CLAUSE_REPEATS);
  const record = (reason: string, title: string) => {
    for (const phrase of new Set(reasonPhrases(reason, title))) uses.set(phrase, (uses.get(phrase) ?? 0) + 1);
    for (const clause of new Set(reasonPhrases(reason, title, CLAUSE_WORDS))) clauseUses.set(clause, (clauseUses.get(clause) ?? 0) + 1);
  };
  return ordered.map((look, index) => {
    if (index >= limit) return look;
    const current = look.reasons[0] ?? "";
    const title = look.variant.title;
    const templated = current.startsWith(title);
    if (!templated && current.trim().length >= 24 && fits(current, title)) {
      record(current, title);
      return look;
    }
    const pick = specificReasonCandidates({ person, answers, variant: look.variant }).find((text) => fits(text, title));
    if (!pick) {
      // No unused specific reason is left: drop the repeated clause (the part after the first comma) instead of pasting it again.
      const head = current.split(", ")[0] ?? "";
      if (templated && head.length >= 24 && head !== current && fits(head, title)) {
        record(head, title);
        return { ...look, reasons: [`${head}.`, ...look.reasons.slice(1)] };
      }
      record(current, title);
      return look;
    }
    record(pick, title);
    return { ...look, reasons: [pick, ...look.reasons.slice(1)] };
  });
}
