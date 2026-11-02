import { z } from "zod";
import { serviceKindSchema } from "./consultations.js";
import { RULE_VERSION, ruleIds } from "./reality-engine.js";

export const assessmentRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});

export const realityCheckSchema = z.strictObject({
  data: z.strictObject({
    version: z.number().int().positive(),
    services: z.array(z.strictObject({
      kind: serviceKindSchema,
      state: z.enum(["missing", "current", "stale", "review_required"]),
      currentAssetId: z.uuid().nullable(),
      inspirationAssetId: z.uuid().nullable(),
      targetTitle: z.string().nullable(),
      findings: z.array(z.strictObject({
        service: serviceKindSchema,
        section: z.enum(["feasibility", "style", "preference"]),
        dimension: z.string(),
        outcome: z.enum(["compatible", "potential_mismatch", "unknown", "stylist_review_required"]),
        reason: z.string(),
        evidence: z.array(z.strictObject({ ref: z.string(), label: z.string() })),
        ruleId: z.enum(ruleIds),
        ruleVersion: z.literal(RULE_VERSION),
        nextAction: z.enum(["retake", "stylist_review", "offer_alternative", "acknowledge", "none"]),
      })),
      alternatives: z.array(z.strictObject({
        candidateId: z.string(),
        service: serviceKindSchema,
        title: z.string().nullable(),
        retained: z.array(z.string()),
        changed: z.array(z.string()),
        preview: z.enum(["supported", "unavailable"]),
        colourRole: z.enum(["dream", "possible_first_step", "lower_complexity"]).nullable(),
        note: z.string().nullable(),
        editorial: z.boolean(),
      })),
      excluded: z.array(z.strictObject({
        candidateId: z.string(),
        conflicts: z.array(z.strictObject({
          category: z.enum(["must_keep", "dont_want"]),
          text: z.string(),
        })),
      })),
    })),
  }),
});
