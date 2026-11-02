import { addCandidate, known, unknownPerson, type Person } from "../../src/domain/person.js";
import { emptyAnswers, type Answers } from "../../src/domain/scoring.js";

/**
 * Evaluation profiles for the professional-matching rules (spec section 9). Each is a plain `Person` plus the wizard
 * answers; none of them touches a provider. The hair readings carry both a YouCam and a vision candidate, so the
 * side-by-side profile is exercised too.
 */
export type EvalProfile = { name: string; person: Person; answers: Answers };

function base(sex: "male" | "female"): Person {
  const person = unknownPerson("fixture");
  person.sex = known(sex, "answer", 1);
  person.face.shape = known("oval", "youcam", 0.8);
  person.face.aspectRatio = known(1.4, "youcam", 0.8);
  person.face.jaw = known("average", "youcam", 0.7);
  person.face.forehead = known("average", "youcam", 0.7);
  person.hair.growthDirection = known("forward", "vision", 0.7);
  person.hair.hairline = known("average", "vision", 0.7);
  person.hair.damage = known("none", "answer", 0.8);
  person.context.glasses = known(false, "vision", 0.9);
  return person;
}

function both<T extends string | number | boolean>(person: Person, field: string, youcam: T, vision: T, resolved: "youcam" | "vision" = "youcam"): { value: T; confidence: number; source: "youcam" | "vision" } {
  addCandidate(person, field, { source: "youcam", value: youcam, confidence: 0.85 });
  addCandidate(person, field, { source: "vision", value: vision, confidence: 0.7 });
  return resolved === "youcam" ? { value: youcam, confidence: 0.85, source: "youcam" } : { value: vision, confidence: 0.7, source: "vision" };
}

/** A man with dense 3b/3c curls (YouCam 3b, vision 3a), coarse strands, 7 cm on top and a crown whorl. */
export function curlyDenseMan(): EvalProfile {
  const person = base("male");
  person.hair.curl = both(person, "curl", "3b", "3a");
  person.hair.density = known(4, "youcam", 0.85);
  person.hair.diameter = known("coarse", "vision", 0.7);
  person.hair.lengthCm = known(7, "vision", 0.75);
  person.hair.topCm = known(7, "vision", 0.75);
  person.hair.frontCm = known(6, "vision", 0.75);
  person.hair.sideCm = known(3, "vision", 0.75);
  person.hair.cowlickCrown = known(true, "vision", 0.7);
  person.hair.cowlickFront = known(false, "vision", 0.7);
  return { name: "Curly dense man", person, answers: { ...emptyAnswers(), presentation: "masculine" } };
}

/** A man with moderate temple recession (about Norwood 3), fine low-density straight-to-wavy hair, 5 cm on top and a front cowlick. */
export function recedingThinMan(): EvalProfile {
  const person = base("male");
  person.hair.curl = both(person, "curl", "2a", "1");
  person.hair.density = known(1, "youcam", 0.85);
  person.hair.diameter = known("fine", "vision", 0.7);
  person.hair.lengthCm = known(5, "vision", 0.75);
  person.hair.topCm = known(5, "vision", 0.75);
  person.hair.frontCm = known(5, "vision", 0.75);
  person.hair.sideCm = known(2, "vision", 0.75);
  person.hair.recession = known("moderate", "vision", 0.75);
  person.hair.hairline = known("receded", "vision", 0.75);
  person.hair.cowlickFront = known(true, "vision", 0.7);
  person.hair.cowlickCrown = known(false, "vision", 0.7);
  return { name: "Receding thin man", person, answers: { ...emptyAnswers(), presentation: "masculine" } };
}

/** A woman with medium-density 2b hair to the shoulders (about 30 cm), a front cowlick, who air-dries in under 10 minutes. */
export function wavyWoman(): EvalProfile {
  const person = base("female");
  person.hair.curl = both(person, "curl", "2b", "2a");
  person.hair.density = known(3, "youcam", 0.85);
  person.hair.diameter = known("medium", "vision", 0.7);
  person.hair.lengthCm = known(30, "vision", 0.75);
  person.hair.topCm = known(30, "vision", 0.75);
  person.hair.cowlickFront = known(true, "vision", 0.7);
  person.hair.cowlickCrown = known(false, "vision", 0.7);
  return { name: "Wavy woman", person, answers: { ...emptyAnswers(), presentation: "feminine", stylingMinutes: "5", blowdryer: "no" } };
}
