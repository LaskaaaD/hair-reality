import type { ServiceKind } from "./catalogue.js";
import { lowConfidence, type Person } from "./person.js";

export type InterviewQuestion = {
  id: string;
  legend: string;
  options: readonly { value: string; label: string }[];
};

const styling: InterviewQuestion = {
  id: "stylingMinutes",
  legend: "Morning time",
  options: [
    { value: "5", label: "5 minutes" },
    { value: "15", label: "15 minutes" },
    { value: "30", label: "30 minutes" },
  ],
};

export const PRESENTATION_QUESTION: InterviewQuestion = {
  id: "presentation",
  legend: "Show styles closer to",
  options: [
    { value: "masculine", label: "Men" },
    { value: "feminine", label: "Women" },
    { value: "either", label: "Both" },
  ],
};

const naturalState: InterviewQuestion = {
  id: "naturalState",
  legend: "In the photos, the hair is",
  options: [
    { value: "natural", label: "Air dried" },
    { value: "styled", label: "Styled" },
    { value: "unknown", label: "Not sure" },
  ],
};

const chemical: InterviewQuestion = {
  id: "chemical",
  legend: "Chemical history",
  options: [
    { value: "none", label: "None" },
    { value: "lightened", label: "Lightened" },
    { value: "permed", label: "Permed" },
    { value: "relaxed", label: "Relaxed" },
    { value: "unknown", label: "Not sure" },
  ],
};

const facialHair: InterviewQuestion = {
  id: "facialHair",
  legend: "Facial hair right now",
  options: [
    { value: "none", label: "None" },
    { value: "stubble", label: "Stubble" },
    { value: "short", label: "Short beard" },
    { value: "medium", label: "Medium beard" },
    { value: "long", label: "Long beard" },
  ],
};

const beardGrowth: InterviewQuestion = {
  id: "beardGrowth",
  legend: "How the beard grows",
  options: [
    { value: "full", label: "Even" },
    { value: "patchy", label: "Patchy" },
    { value: "unknown", label: "Not sure" },
  ],
};

const colourHistory: InterviewQuestion = {
  id: "colourHistory",
  legend: "Colour history",
  options: [
    { value: "natural", label: "Natural" },
    { value: "box-dye", label: "Box dye" },
    { value: "lightened", label: "Lightened before" },
    { value: "unknown", label: "Not sure" },
  ],
};

const cowlick: InterviewQuestion = {
  id: "cowlick",
  legend: "A cowlick that always sticks up",
  options: [
    { value: "none", label: "No" },
    { value: "front", label: "At the front" },
    { value: "crown", label: "At the crown" },
    { value: "both", label: "Both" },
  ],
};

const glasses: InterviewQuestion = {
  id: "glassesDaily",
  legend: "Glasses most days",
  options: [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ],
};

const forehead: InterviewQuestion = {
  id: "forehead",
  legend: "Forehead",
  options: [
    { value: "cover", label: "Keep it covered" },
    { value: "show", label: "Show it" },
    { value: "either", label: "Either" },
  ],
};

const canGrow: InterviewQuestion = {
  id: "canGrow",
  legend: "Growing the hair out",
  options: [
    { value: "yes", label: "Yes" },
    { value: "a-little", label: "A little" },
    { value: "no", label: "No" },
  ],
};

export function interviewPlan(person: Person, service: ServiceKind): InterviewQuestion[] {
  const base = service === "beard"
    ? [styling, beardGrowth, facialHair, PRESENTATION_QUESTION]
    : service === "colour"
      ? [naturalState, chemical, colourHistory, styling, PRESENTATION_QUESTION]
      : [chemical, styling, facialHair, PRESENTATION_QUESTION, glasses, forehead];
  const extra: InterviewQuestion[] = [];
  // Haircuts always ask about glasses (the photos are taken without them) and the forehead; the photos already read cowlicks, strand and curl.
  if (service === "colour" && lowConfidence(person.context.glasses)) extra.push(glasses);
  if (service === "colour" && (lowConfidence(person.hair.cowlickFront) || lowConfidence(person.hair.cowlickCrown))) extra.push(cowlick);
  if (service === "beard" && lowConfidence(person.context.glasses)) extra.push(glasses);
  if (service === "haircut" && lowConfidence(person.hair.lengthCm)) extra.push(canGrow);
  return [...base, ...extra];
}
