import { z } from "zod";

export const hairProfileCapabilities = ["hair-type", "hair-length", "hair-density", "hair-frizziness"] as const;
export const hairProfileCapabilitySchema = z.enum(hairProfileCapabilities);
export type HairProfileCapability = z.infer<typeof hairProfileCapabilitySchema>;

export const hairProfileSchema = z.strictObject({
  data: z.strictObject({
    presentation: z.enum(["real", "fixture"]),
    schedule: z.array(hairProfileCapabilitySchema),
    slots: z.array(z.strictObject({
      capability: hairProfileCapabilitySchema,
      required: z.boolean(),
      status: z.enum(["current", "retake", "unknown"]),
      freshness: z.enum(["current", "unknown"]),
      source: z.enum(["youcam", "fixture"]).nullable(),
      uncertainty: z.string().nullable(),
      observedAt: z.string().nullable(),
      evidenceAssetIds: z.array(z.uuid()),
      nextAction: z.enum(["none", "retake", "stylist_review"]),
      value: z.strictObject({
        label: z.string(),
        rawTerm: z.string().nullable(),
        providerMapping: z.string().nullable(),
        range: z.strictObject({
          kind: z.literal("categories"),
          from: z.string(),
          to: z.string().nullable(),
          openEnded: z.boolean(),
        }).nullable(),
      }).nullable(),
    })),
  }),
});

export type HairProfile = z.infer<typeof hairProfileSchema>["data"];
export type HairProfileSlot = HairProfile["slots"][number];
