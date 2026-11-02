import { z } from "zod";
import { hairProfileCapabilities } from "./hair-profile.js";

export const faceColourCapabilities = ["face-attributes", "facial-color-tones"] as const;
export const faceColourCapabilitySchema = z.enum(faceColourCapabilities);
export type FaceColourCapability = z.infer<typeof faceColourCapabilitySchema>;

export const analysisCapabilities = [...hairProfileCapabilities, ...faceColourCapabilities] as const;
export const analysisCapabilitySchema = z.enum(analysisCapabilities);
export type AnalysisCapability = z.infer<typeof analysisCapabilitySchema>;

const colourValueSchema = z.strictObject({
  skinColor: z.string().nullable(),
  hairColor: z.string().nullable(),
  hairColorName: z.string().nullable(),
  eyeColor: z.string().nullable(),
  eyeColorName: z.string().nullable(),
  eyebrowColor: z.string().nullable(),
  lipColor: z.string().nullable(),
  unknown: z.array(z.string()),
});

const faceValueSchema = z.strictObject({
  faceShape: z.string(),
  horizontalThird: z.array(z.number().int()),
  verticalFifth: z.array(z.number().int()),
  faceAspectRatio: z.array(z.number().int()),
});

export const analysisPlanSchema = z.strictObject({
  data: z.strictObject({
    presentation: z.enum(["real", "fixture"]),
    suggestions: z.strictObject({
      silhouette: z.boolean(),
      tones: z.boolean(),
    }),
    coverage: z.array(faceColourCapabilitySchema),
    schedule: z.array(analysisCapabilitySchema),
    slots: z.array(z.strictObject({
      capability: faceColourCapabilitySchema,
      enabled: z.boolean(),
      status: z.enum(["current", "retake", "unknown"]),
      freshness: z.enum(["current", "unknown"]),
      source: z.enum(["youcam", "fixture"]).nullable(),
      uncertainty: z.string().nullable(),
      observedAt: z.string().nullable(),
      evidenceAssetIds: z.array(z.uuid()),
      nextAction: z.enum(["none", "retake", "stylist_review"]),
      value: z.union([faceValueSchema, colourValueSchema]).nullable(),
    })),
  }),
});

export type AnalysisPlan = z.infer<typeof analysisPlanSchema>["data"];
export type FaceColourSlot = AnalysisPlan["slots"][number];

export function analysisPlanQuery(choices: { silhouette: boolean; tones: boolean }): string {
  return `silhouette=${choices.silhouette ? "1" : "0"}&tones=${choices.tones ? "1" : "0"}`;
}
