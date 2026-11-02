import type { StyleVariant } from "./knowledge-base.js";
import type { Answers, ScoredVariant } from "./scoring.js";
import { LONG_FACE_RATIO, faceShapeContested, type Person } from "./person.js";

export function isStatementStyle(variant: StyleVariant): boolean {
  const blob = `${variant.familyId} ${variant.id} ${variant.title}`.toLowerCase();
  return (
    variant.familyId === "mullet" ||
    variant.familyId === "bowl" ||
    /mullet|bowl cut|bowl-cut|mohawk|faux hawk|broccoli|avant-garde|creative shave/.test(blob)
  );
}

/** Face label for copy — aspect ratio alone does not override a known oval/round/square/heart shape. */
export function faceShapeLabel(person: Person): string {
  const shape = faceShapeContested(person) ? "unknown" : person.face.shape.value;
  if (shape !== "unknown") return shape;
  const ratio = person.face.aspectRatio.value;
  if (typeof ratio === "number" && ratio >= 1.42) return "long";
  if (typeof ratio === "number" && ratio > 0 && ratio < 1.2) return "round";
  return "oval";
}

export function faceReadsLong(person: Person): boolean {
  if (person.face.shape.value === "long") return true;
  const ratio = person.face.aspectRatio.value;
  return typeof ratio === "number" && ratio >= LONG_FACE_RATIO;
}

function curlLabel(curl: Person["hair"]["curl"]["value"]): string {
  if (curl === "unknown") return "natural";
  if (curl === "1") return "straight";
  if (curl.startsWith("2")) return "wavy";
  if (curl.startsWith("3")) return "curly";
  return "coily";
}

function strandLabel(strand: Person["hair"]["diameter"]["value"]): string {
  if (strand === "fine" || strand === "medium" || strand === "coarse") return strand;
  return "natural";
}

export function styleFeaturePhrase(variant: StyleVariant): string {
  const blob = `${variant.familyId} ${variant.id} ${variant.title}`.toLowerCase();
  if (/curtain/.test(blob)) return "center-parted curtain pieces";
  if (/comma|crescent|gail/.test(blob)) return "a curved front fringe";
  if (/wispy|see-through|airy|hush/.test(blob)) return "wispy face-framing layers";
  if (/butterfly/.test(blob)) return "fluttery crown and cheekbone layers";
  if (/bixie/.test(blob)) return "cropped pixie-bob layers";
  if (/a-line|graduated|angled/.test(blob)) return "a softly angled perimeter";
  if (/lob|collarbone|shoulder/.test(blob)) return "collarbone-grazing length";
  if (/bob|pageboy/.test(blob)) return "a clean jawline outline";
  if (/pixie|boy-cut|garcon|twotone/.test(blob)) return "close-cropped crown texture";
  if (/shag|wolf/.test(blob)) return "tousled crown and neck layers";
  if (/mullet|jellyfish|hime/.test(blob)) return "contrasting front and back lengths";
  if (/locs|dread|braid|cornrow|twist|goddess|box/.test(blob)) return "protective parted sections";
  if (/afro|twa|coil/.test(blob)) return "rounded natural coil volume";
  if (/c-curl|perm|wave/.test(blob)) return "soft inward-curved ends";
  if (/caesar|french-crop|textured-crop|crop/.test(blob)) return "a neat forward-textured top";
  if (/ivy|crew|short-cut|contour|side-part/.test(blob)) return "cleanly tapered sides and a neat part";
  if (/two-block|undercut/.test(blob)) return "a tucked-in undercut with movement on top";
  if (/quiff|pompadour|slick/.test(blob)) return "lifted front volume";
  if (/taper|fade/.test(blob)) return "graduated temple and neckline weight";
  if (variant.requirements.blunt) return "a crisp, even perimeter";
  if (variant.geometry.coversForehead >= 0.4) return "soft forehead-skimming pieces";
  return "balanced layering through the crown";
}

function goalContextPhrase(answers: Answers, minutes: number, weeks: number): string {
  if (answers.keep === "length") return "keeping your length";
  if (answers.keep === "fringe") return "keeping front fringe coverage";
  if (answers.forehead === "cover") return "softening the forehead";
  if (answers.forehead === "show") return "opening up the forehead";
  if (answers.stylingMinutes === "5" || minutes <= 5) return `a quick ${minutes}-minute morning routine`;
  return `an easy ${weeks}-week upkeep cycle`;
}

export function sanitizeReasonText(text: string): string {
  return text
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/_/g, " ")
    .replace(/\b[A-Z]{2,}\b/g, (word) => word.toLowerCase())
    .replace(/\b([aA]) (?=[aeiouAEIOU])/g, (_m, a: string) => `${a}n `)
    .replace(/\s+/g, " ")
    .trim();
}

export function firstSixWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
}

function rawFirstSixWords(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");
}

function reasonStructure(reason: string, title: string): string {
  return reason.replaceAll(title, "%STYLE%").replace(/\s+/g, " ").trim().toLowerCase();
}

type ReasonCtx = {
  person: Person;
  answers: Answers;
  variant: StyleVariant;
  liked: boolean;
};

type ReasonCandidate = {
  structure: string;
  text: string;
};

function reasonCandidates(ctx: ReasonCtx): ReasonCandidate[] {
  const { person, answers, variant, liked } = ctx;
  const title = variant.title;
  const shape = faceShapeLabel(person);
  const curl = person.hair.curl.value;
  const curlTex = curlLabel(curl);
  const density = person.hair.density.value;
  const strand = strandLabel(person.hair.diameter.value);
  const height = variant.geometry.addsHeight;
  const width = variant.geometry.addsWidth;
  const cover = variant.geometry.coversForehead;
  const longFace = faceReadsLong(person);
  const top = Math.max(1, Math.round(variant.requirements.topCm ?? 10));
  const minutes = Math.max(1, Math.round(variant.lifestyle.stylingMinutes));
  const weeks = Math.max(2, Math.round(variant.lifestyle.maintenanceWeeks));
  const feature = styleFeaturePhrase(variant);
  const goalPhrase = goalContextPhrase(answers, minutes, weeks);
  const haveCmRaw =
    person.hair.lengthCm.value !== "unknown"
      ? person.hair.lengthCm.value
      : person.hair.topCm.value !== "unknown"
        ? person.hair.topCm.value
        : null;
  const haveDesc =
    typeof haveCmRaw === "number"
      ? haveCmRaw >= 24
        ? "longer"
        : haveCmRaw >= 12
          ? "medium-length"
          : "shorter"
      : "current";

  const out: ReasonCandidate[] = [];
  const seenStructures = new Set<string>();

  const push = (rawText: string) => {
    const text = sanitizeReasonText(rawText);
    const structure = reasonStructure(text, title);
    if (seenStructures.has(structure)) return;
    seenStructures.add(structure);
    out.push({ structure, text });
  };

  if (liked) {
    push(`${title} matches the direction you picked in goals while flattering a ${shape} face and ${curlTex} hair.`);
  }

  const curlMatch = curl !== "unknown" && variant.requirements.curl.includes(curl);
  if (curlMatch && (variant.familyId.includes("curl") || variant.familyId === "afro" || variant.familyId === "locs")) {
    push(`${title} embraces your ${curlTex} pattern so ${feature} sits naturally on a ${shape} face.`);
  }

  if (/\bbob\b|\blob\b|bixie/i.test(title) || variant.familyId === "bob" || variant.familyId === "lob") {
    if (variant.requirements.blunt) {
      push(`${title} lands on a crisp perimeter that complements ${shape} proportions and gives ${strand} ${curlTex} hair a fuller edge.`);
    } else {
      push(`${title} grazes the jawline with soft movement that flatters a ${shape} face and ${strand} ${curlTex} texture.`);
    }
  }

  if (longFace && top >= 12) {
    push(`${title} keeps width through the sides at ${top} cm so a longer ${shape} face looks balanced with ${curlTex} hair.`);
  }

  if (longFace && cover >= 0.4 && height <= 0.35) {
    push(`${title} softens vertical length across the forehead without stacking extra crown height on your ${shape} face.`);
  }

  if (longFace && width >= 0.25 && height <= 0.4) {
    push(`${title} leaves flattering fullness above the ears so a longer ${shape} face never reads narrow with ${curlTex} hair.`);
  }

  if (shape === "round" && height >= 0.35 && width <= 0.4) {
    push(`${title} builds gentle lift at the crown without widening the cheeks on your ${shape} face and ${curlTex} hair.`);
  }

  if (shape === "square" && variant.geometry.softensJaw >= 0.2) {
    push(`${title} softens the corners of a ${shape} jawline using ${feature} suited to your ${curlTex} texture.`);
  }

  if (shape === "heart" && cover >= 0.3) {
    push(`${title} balances a ${shape} forehead with ${feature} that works smoothly on ${strand} ${curlTex} hair.`);
  }

  if (person.hair.growthDirection.value === "forward" && variant.fit.direction === "forward") {
    push(`${title} follows your forward growth pattern so ${curlTex} hair falls into place on a ${shape} face each morning.`);
  }

  if (strand === "fine" && density !== "unknown" && density <= 2 && variant.requirements.densityMin <= 2 && !variant.requirements.blunt) {
    push(`${title} uses airy weight distribution so fine ${curlTex} hair looks fuller around your ${shape} face.`);
  }

  if (isStatementStyle(variant)) {
    push(`${title} delivers a bold silhouette change that frames a ${shape} face while working with ${strand} ${curlTex} hair.`);
  }

  if (/perm|down perm|c-curl/i.test(title)) {
    push(`${title} shapes a lasting wave that flatters ${shape} features when you want gentle bend in ${strand} ${curlTex} hair.`);
  }

  if (variant.familyId === "crop" || variant.familyId === "fade") {
    push(`${title} neatens the sides while leaving ${top} cm on top to suit a ${shape} face and ${curlTex} texture.`);
  }

  if (variant.familyId === "taper" || /taper/i.test(title)) {
    push(`${title} tapers the temples and neckline cleanly to flatter ${shape} proportions with ${strand} ${curlTex} hair.`);
  }

  // Rich pool of 30+ distinct style + profile candidates with unique openings after `${title}`
  push(`${title} frames your ${shape} face with ${feature} that keeps ${strand} ${curlTex} hair looking effortless.`);
  push(`${title} works with your ${strand} ${curlTex} texture to balance ${shape} proportions in about ${minutes} minutes a day.`);
  push(`${title} pairs ${feature} with a ${shape}-flattering outline that suits your ${haveDesc} ${curlTex} hair.`);
  push(`${title} highlights your cheekbones on a ${shape} face while letting ${strand} ${curlTex} strands move naturally.`);
  push(`${title} keeps daily styling around ${minutes} minutes and flatters a ${shape} face with ${strand} ${curlTex} hair.`);
  push(`${title} spaces salon visits to roughly ${weeks} weeks while keeping a clean ${shape}-friendly shape on ${curlTex} hair.`);
  push(`${title} shapes ${top} cm of length into ${feature} that complements a ${shape} face and ${curlTex} texture.`);
  push(`${title} brings light lift to ${strand} ${curlTex} hair so the outline stays proportional on a ${shape} face.`);
  push(`${title} supports ${goalPhrase} while tailoring ${feature} to your ${shape} face and ${curlTex} hair.`);
  push(`${title} blends ${feature} around your ${shape} features without fighting the natural flow of ${curlTex} hair.`);
  push(`${title} gives ${strand} ${curlTex} hair a polished silhouette that sits naturally against ${shape} facial contours.`);
  push(`${title} opens up your ${shape} features with ${feature} designed for ${haveDesc} ${strand} ${curlTex} hair.`);
  push(`${title} holds a clean ${top} cm outline between ${weeks}-week trims on a ${shape} face with ${curlTex} hair.`);
  push(`${title} lightens heavy bulk through ${feature} so ${strand} ${curlTex} hair flatters a ${shape} face.`);
  push(`${title} creates an easy ${minutes}-minute routine that keeps ${strand} ${curlTex} hair balanced on a ${shape} face.`);
  push(`${title} skims around a ${shape} face with ${feature} that respects your ${strand} ${curlTex} texture.`);
  push(`${title} refines the crown and jawline for ${shape} proportions using ${top} cm of ${strand} ${curlTex} hair.`);
  push(`${title} tucks neatly past the temples so ${strand} ${curlTex} hair frames a ${shape} face without extra fuss.`);
  push(`${title} preserves natural softness at ${top} cm while suiting a ${shape} face and ${strand} ${curlTex} strands.`);
  push(`${title} channels ${goalPhrase} through ${feature} that flatters your ${shape} face and ${curlTex} hair.`);
  push(`${title} avoids stiff daily styling while giving ${strand} ${curlTex} hair a flattering line on a ${shape} face.`);
  push(`${title} relaxes into your ${curlTex} texture so ${feature} stays neat on a ${shape} face for ${weeks} weeks.`);
  push(`${title} contours cleanly around a ${shape} face and lets ${haveDesc} ${strand} ${curlTex} hair sit with natural body.`);
  push(`${title} balances crown volume and side weight for a ${shape} face with ${strand} ${curlTex} hair.`);
  push(`${title} flatters ${shape} bone structure through ${feature} while keeping ${curlTex} hair manageable in ${minutes} minutes.`);
  push(`${title} adapts to ${haveDesc} ${strand} ${curlTex} hair and keeps ${shape} proportions looking fresh and even.`);
  push(`${title} combines ${feature} with a ${weeks}-week trim schedule that suits a ${shape} face and ${curlTex} hair.`);
  push(`${title} enhances natural movement in ${strand} ${curlTex} hair while keeping a ${shape} face well proportioned.`);
  push(`${title} delivers ${feature} at about ${top} cm to complement your ${shape} face and ${strand} ${curlTex} hair.`);
  push(`${title} keeps the perimeter airy for ${strand} ${curlTex} hair so your ${shape} face reads balanced and bright.`);

  return out;
}

function pickDistinctReasonRaw(
  ctx: ReasonCtx,
  usedStructures: Set<string>,
  usedFirstSixWords: Set<string>,
): string {
  const candidates = reasonCandidates(ctx);
  for (const candidate of candidates) {
    const sixNorm = firstSixWords(candidate.text);
    const sixRaw = rawFirstSixWords(candidate.text);
    const structSix = firstSixWords(candidate.structure);
    if (
      !usedStructures.has(candidate.structure) &&
      !usedFirstSixWords.has(sixNorm) &&
      !usedFirstSixWords.has(sixRaw) &&
      !usedFirstSixWords.has(structSix)
    ) {
      return candidate.text;
    }
  }
  for (const candidate of candidates) {
    const sixNorm = firstSixWords(candidate.text);
    const sixRaw = rawFirstSixWords(candidate.text);
    if (!usedFirstSixWords.has(sixNorm) && !usedFirstSixWords.has(sixRaw)) {
      return candidate.text;
    }
  }
  return candidates[0]?.text ?? `${ctx.variant.title} fits your ${faceShapeLabel(ctx.person)} face and ${curlLabel(ctx.person.hair.curl.value)} hair.`;
}

/** Collapse a word repeated back to back ("natural natural hair" becomes "natural hair"). */
export function collapseRepeatedWords(text: string): string {
  return text.replace(/\b([A-Za-z][A-Za-z'-]*)(\s+\1\b)+/gi, "$1");
}

function pickDistinctReason(
  ctx: Parameters<typeof pickDistinctReasonRaw>[0],
  usedStructures: Set<string>,
  usedFirstSixWords: Set<string>,
): string {
  return collapseRepeatedWords(pickDistinctReasonRaw(ctx, usedStructures, usedFirstSixWords));
}

/** One-sentence barber-tone reason from this profile and catalogue attributes (no cutting steps). */
export function personalizedRankingReason(
  person: Person,
  answers: Answers,
  variant: StyleVariant,
  liked: boolean,
): string {
  return pickDistinctReason({ person, answers, variant, liked }, new Set(), new Set());
}

/** Ensure palette reasons use distinct sentence structures, distinct first 6 words, and style-specific copy. */
export function assignDistinctReasons(
  show: readonly ScoredVariant[],
  person: Person,
  answers: Answers,
  sharedState?: { usedStructures: Set<string>; usedFirstSixWords: Set<string> },
): ScoredVariant[] {
  const usedStructures = sharedState?.usedStructures ?? new Set<string>();
  const usedFirstSixWords = sharedState?.usedFirstSixWords ?? new Set<string>();
  return show.map((look) => {
    const reason = pickDistinctReason(
      { person, answers, variant: look.variant, liked: look.liked },
      usedStructures,
      usedFirstSixWords,
    );
    const structure = reasonStructure(reason, look.variant.title);
    usedStructures.add(structure);
    usedFirstSixWords.add(firstSixWords(reason));
    usedFirstSixWords.add(rawFirstSixWords(reason));
    usedFirstSixWords.add(firstSixWords(structure));
    return { ...look, reasons: [reason, ...look.reasons.slice(1)] };
  });
}
