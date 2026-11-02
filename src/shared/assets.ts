import { z } from "zod";

export const importRoles = [
  "current_front",
  "current_left",
  "current_right",
  "current_density",
  "current_length",
  "current_face",
  "beard",
  "inspiration",
] as const;
export const legacyAssetRoles = ["current_side", "current_back"] as const;
export const assetRoles = [...importRoles, ...legacyAssetRoles] as const;
export const providerNames = ["youcam", "openai"] as const;

export const assetSchema = z.object({
  id: z.uuid(),
  consultationId: z.uuid(),
  role: z.enum([
    "current_front",
    "current_left",
    "current_right",
    "current_density",
    "current_length",
    "current_face",
    "beard",
    "inspiration",
    "preview",
    "current_side",
    "current_back",
  ]),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  provenance: z.enum(["client_upload", "provider_derivative"]),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});

export const assetResponseSchema = z.object({
  data: assetSchema,
});

export const assetListSchema = z.object({
  data: z.array(assetSchema),
});

export const consentRequestSchema = z.strictObject({
  consentVersion: z.string().trim().min(1).max(80),
  providers: z.array(z.enum(providerNames)).max(2),
  assetIds: z.array(z.uuid()).max(20),
  accepted: z.boolean(),
  statement: z.string().trim().min(1).max(2000),
  deleteAssets: z.boolean().optional(),
});

export const deletionDataSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(["pending", "completed"]),
  scope: z.enum(["asset", "consultation"]),
  retained: z.enum(["textual_plan", "accounting_only"]),
  currentVersion: z.number().int().positive(),
  message: z.string().min(1),
});

export const consentResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    consultationId: z.uuid(),
    consentVersion: z.string().min(1),
    providers: z.array(z.enum(providerNames)),
    assetIds: z.array(z.uuid()),
    accepted: z.boolean(),
    withdrawn: z.boolean(),
    recordedAt: z.iso.datetime(),
    deletions: z.array(deletionDataSchema).optional(),
  }),
});

export const deletionRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});

export const deletionResponseSchema = z.object({
  data: deletionDataSchema,
});

export type AssetRole = (typeof assetRoles)[number];
export type ProviderName = (typeof providerNames)[number];
export type AssetDto = z.infer<typeof assetSchema>;
export type ConsentRequest = z.infer<typeof consentRequestSchema>;
export type DeletionResponse = z.infer<typeof deletionResponseSchema>;
