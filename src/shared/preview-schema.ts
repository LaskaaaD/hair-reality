import { z } from "zod";

/** Honest try-on image provenance for demo session previews (ADR-0010 / HR-086). */
export const demoPreviewSourceSchema = z.enum(["youcam", "cached", "fixture"]).nullable();

export const demoSessionLookSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  score: z.number(),
  label: z.string(),
  reasons: z.array(z.string()),
  status: z.enum(["pending", "ready", "skipped", "failed"]),
  source: demoPreviewSourceSchema,
  errorCode: z.string().nullable(),
  imageUrl: z.string().nullable(),
});

/** GET /api/v1/demo/session body when a demo cookie is present (HR-089). */
export const demoSessionViewSchema = z.strictObject({
  id: z.string(),
  service: z.enum(["haircut", "colour", "beard"]),
  personaId: z.string().nullable(),
  analysisStatus: z.string(),
  analysisNotice: z.string().nullable().optional(),
  retakeSlot: z.enum(["front", "sides"]).nullable().optional(),
  answers: z.record(z.string(), z.string()),
  likes: z.array(z.string()),
  requiredRoles: z.array(z.string()),
  photos: z.array(z.strictObject({
    id: z.string(),
    role: z.string(),
    url: z.string(),
  })),
  analysis: z.unknown().nullable().optional(),
  looks: z.array(demoSessionLookSchema),
});

/** GET /api/v1/demo/session envelope; `data` is null when there is no demo session cookie. */
export const demoSessionGetResponseSchema = z.strictObject({
  data: demoSessionViewSchema.nullable(),
});

const proposalSchema = z.strictObject({
  candidateId: z.uuid(),
  title: z.string(),
  length: z.string().nullable(),
  texture: z.string().nullable(),
  shade: z.string().nullable(),
  referenceFullness: z.string().nullable(),
  unsupported: z.array(z.string()),
});

const alternativeSchema = z.strictObject({
  candidateId: z.uuid(),
  title: z.string(),
  retained: z.array(z.string()),
  changed: z.array(z.string()),
  note: z.string().nullable(),
  colourRole: z.enum(["dream", "possible_first_step", "lower_complexity"]).nullable(),
});

const storedPreviewSchema = z.strictObject({
  id: z.uuid(),
  candidateId: z.uuid().nullable(),
  sourceVersion: z.number().int().positive().nullable(),
  freshness: z.string(),
  stale: z.boolean(),
  selected: z.boolean(),
  resultAssetId: z.uuid().nullable(),
  limits: z.array(z.string()),
  providerVersion: z.string().nullable(),
});

export const haircutPreviewResponseSchema = z.strictObject({
  data: z.strictObject({
    consultationId: z.uuid(),
    version: z.number().int().positive(),
    sourceAssetId: z.uuid().nullable(),
    services: z.array(z.strictObject({
  serviceId: z.uuid(),
  kind: z.enum(["haircut", "colour", "beard"]),
  sourceAssetId: z.uuid().nullable(),
  inputVersion: z.number().int().positive(),
      dream: proposalSchema.nullable(),
      alternatives: z.array(alternativeSchema),
      findings: z.array(z.strictObject({
        ruleId: z.string(),
        dimension: z.string(),
        outcome: z.string(),
        reason: z.string(),
      })),
      previews: z.array(storedPreviewSchema),
      pendingCandidateIds: z.array(z.uuid()),
    })),
  }),
});
