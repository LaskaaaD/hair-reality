import { z } from "zod";
import { serviceKindSchema } from "./consultations.js";

const lengths = ["short", "medium", "long", "unknown"] as const;
const textures = ["straight", "wavy", "curly", "unknown"] as const;

export const catalogueEntrySchema = z.strictObject({
  id: z.uuid(),
  serviceKind: serviceKindSchema,
  title: z.string().min(1).max(80),
  provenance: z.enum(["youcam", "fixture"]),
  providerReference: z.string().min(1).max(80).nullable(),
  length: z.enum(lengths),
  texture: z.enum(textures),
  configuration: z.strictObject({
    templateId: z.string().min(1).max(80).nullable(),
    preset: z.string().min(1).max(80).nullable(),
  }),
  unsupported: z.array(z.string().min(1).max(80)).max(8),
  maintenance: z.enum(["low", "moderate", "high"]).optional(),
});
export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>;

export const catalogueResponseSchema = z.strictObject({
  data: z.array(catalogueEntrySchema),
  nextCursor: z.string().nullable(),
});

const confirmedAttributesSchema = z.strictObject({
  length: z.enum(lengths),
  texture: z.enum(textures),
  shade: z.string().trim().min(1).max(80).nullable(),
  referenceFullness: z.enum(["low", "moderate", "high"]),
}).partial();

export const targetInputSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  serviceKind: serviceKindSchema,
  sourceKind: z.enum(["catalogue", "text", "upload"]),
  candidateId: z.uuid().optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  inspirationAssetId: z.uuid().optional(),
  confirmed: confirmedAttributesSchema,
  unsupported: z.array(z.string().trim().min(1).max(200)).max(8),
  proposals: z.array(z.strictObject({
    statement: z.string().trim().min(1).max(800),
    support: z.literal("unknown"),
    confirmed: z.literal(false),
  })).max(8),
});
export type TargetInput = z.infer<typeof targetInputSchema>;

export const storedTargetSchema = z.strictObject({
  serviceKind: serviceKindSchema,
  sourceKind: z.enum(["catalogue", "text", "upload"]),
  candidateId: z.uuid().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inspirationAssetId: z.uuid().nullable(),
  confirmed: confirmedAttributesSchema,
  unsupported: z.array(z.string()),
  proposals: z.array(z.strictObject({
    statement: z.string(),
    support: z.literal("unknown"),
    confirmed: z.literal(false),
  })),
});
export type StoredTarget = z.infer<typeof storedTargetSchema>;

export const targetResponseSchema = z.strictObject({
  data: z.strictObject({
    version: z.number().int().positive(),
    targets: z.array(storedTargetSchema),
  }),
});

export function targetFieldErrors(input: TargetInput, serviceSelected: boolean): Record<string, string[]> | null {
  const errors: Record<string, string[]> = {};
  if (!serviceSelected) errors.serviceKind = ["Choose a selected service."];
  if (input.sourceKind === "catalogue" && !input.candidateId) errors.candidateId = ["Choose a catalogue entry."];
  if (input.sourceKind === "text" && !input.description) errors.description = ["Write the target."];
  if (input.sourceKind === "upload" && !input.inspirationAssetId) errors.inspirationAssetId = ["Choose an inspiration photograph."];
  if (input.sourceKind !== "catalogue" && input.candidateId) errors.candidateId = ["A catalogue entry belongs on a catalogue target."];
  if (input.sourceKind !== "upload" && input.inspirationAssetId) errors.inspirationAssetId = ["An inspiration photograph belongs on an uploaded target."];
  return Object.keys(errors).length > 0 ? errors : null;
}
