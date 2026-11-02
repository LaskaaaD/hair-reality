import { z } from "zod";
import { serviceKindSchema } from "./consultations.js";

export const providerModes = ["fixture", "recorded_demo", "live"] as const;
export const providerModeSchema = z.enum(providerModes);
export type ProviderMode = z.infer<typeof providerModeSchema>;

export const jobOperations = ["analysis", "interpretation", "preview", "probe"] as const;
export const jobOperationSchema = z.enum(jobOperations);
export type JobOperation = z.infer<typeof jobOperationSchema>;

export const analysisJobSchema = z.strictObject({
  capabilities: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).min(1).max(9),
  assetIds: z.array(z.uuid()).min(1).max(8),
  expectedVersion: z.number().int().positive(),
});

export const interpretationOperations = [
  "target_interpretation",
  "priority_extraction",
  "candidate_ranking",
  "finding_explanation",
  "stylist_brief",
  "preview_deviation",
] as const;

export const interpretationJobSchema = z.strictObject({
  serviceId: z.uuid().optional(),
  serviceKind: serviceKindSchema.optional(),
  expectedVersion: z.number().int().positive(),
  operation: z.enum(interpretationOperations).optional(),
}).refine((value) => Boolean(value.serviceId || value.serviceKind), {
  message: "Choose a service.",
});

export const interpretationResultSchema = z.strictObject({
  capability: z.string(),
  source: z.string(),
  uncertainty: z.string().nullable(),
  observedAt: z.string(),
  summary: z.string(),
});

export const interpretationResultsSchema = z.strictObject({
  data: z.array(interpretationResultSchema),
});

export const previewJobSchema = z.strictObject({
  serviceId: z.uuid(),
  candidateId: z.uuid(),
  sourceAssetId: z.uuid(),
  expectedVersion: z.number().int().positive(),
});

export const previewSelectionSchema = z.strictObject({
  serviceId: z.uuid(),
  previewId: z.uuid(),
  expectedVersion: z.number().int().positive(),
});

export const resolutionSchema = z.strictObject({
  outcome: z.enum(["not_billed", "billed"]),
  actualUnits: z.number().int().nonnegative().optional(),
});

export const jobSchema = z.strictObject({
  id: z.uuid(),
  consultationId: z.uuid(),
  operation: z.string(),
  state: z.string(),
  mode: providerModeSchema,
  historical: z.boolean(),
  errorCode: z.string().nullable(),
  resultAssetId: z.uuid().nullable(),
});

export const jobResponseSchema = z.strictObject({ data: jobSchema });

export const usageResponseSchema = z.strictObject({
  data: z.strictObject({
    mode: providerModeSchema,
    phase: z.enum(["development", "demo"]),
    accounts: z.array(z.strictObject({
      provider: z.enum(["youcam", "openai"]),
      phase: z.enum(["development", "demo"]),
      mode: providerModeSchema,
      unit: z.enum(["youcam_unit", "usd_micro"]),
      settledUnits: z.number().int().nonnegative(),
      reservedUnits: z.number().int().nonnegative(),
      uncertainUnits: z.number().int().nonnegative(),
      externalUnits: z.number().int().nonnegative(),
      phaseCap: z.number().int().nonnegative(),
      totalCap: z.number().int().nonnegative(),
      reserveUnits: z.number().int().nonnegative(),
    })),
  }),
});

export type JobView = z.infer<typeof jobSchema>;
