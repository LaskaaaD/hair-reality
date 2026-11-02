import { z } from "zod";
import { colourHistorySchema, preferencesInputSchema } from "./client-brief.js";

export const serviceKinds = ["haircut", "colour", "beard"] as const;
export const serviceKindSchema = z.enum(serviceKinds);
export type ServiceKind = z.infer<typeof serviceKindSchema>;

export const readinessRequirements = ["target", "priorities", "assessment", "preview"] as const;
export type ReadinessRequirement = (typeof readinessRequirements)[number];

const serviceSelectionSchema = z.array(serviceKindSchema).min(1).max(3).refine(
  (values) => new Set(values).size === values.length,
  { message: "Choose each service once." },
);

export const createConsultationSchema = z.strictObject({
  salonId: z.uuid(),
  services: serviceSelectionSchema,
});

export const draftUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  services: serviceSelectionSchema,
  history: colourHistorySchema.optional(),
  preferences: preferencesInputSchema.optional(),
});

export const readinessRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});

export const readinessGapSchema = z.strictObject({
  serviceKind: serviceKindSchema,
  requirement: z.enum(readinessRequirements),
  message: z.string(),
});

export const consultationServiceSchema = z.strictObject({
  id: z.uuid(),
  kind: serviceKindSchema,
  inputVersion: z.number().int().positive(),
});

export const consultationSchema = z.strictObject({
  id: z.uuid(),
  salonId: z.uuid(),
  salonSlug: z.string(),
  lifecycle: z.string(),
  version: z.number().int().positive(),
  currentRevisionId: z.uuid().nullable(),
  services: z.array(consultationServiceSchema),
  readiness: z.strictObject({
    ready: z.boolean(),
    missing: z.array(readinessGapSchema),
  }),
  actions: z.array(z.string()),
  jobs: z.array(z.strictObject({
    id: z.uuid(),
    operation: z.string(),
    state: z.string(),
    errorCode: z.string().nullable(),
    mode: z.enum(["fixture", "recorded_demo", "live"]),
    historical: z.boolean(),
  })),
});

export const consultationResponseSchema = z.strictObject({ data: consultationSchema });
export const consultationListSchema = z.strictObject({
  data: z.array(consultationSchema),
  nextCursor: z.string().nullable(),
});

export const publicSalonSchema = z.strictObject({
  data: z.strictObject({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
  }),
});

export type ReadinessGap = z.infer<typeof readinessGapSchema>;
export type ConsultationService = z.infer<typeof consultationServiceSchema>;
export type Consultation = z.infer<typeof consultationSchema>;

export type ReadinessFact = {
  kind: ServiceKind;
  hasTarget: boolean;
  hasPriorities: boolean;
  hasCurrentAssessment: boolean;
  hasCurrentPreview: boolean;
};

const requirementCopy: Record<ReadinessRequirement, string> = {
  target: "A target is missing.",
  priorities: "Priorities are missing.",
  assessment: "An assessment is missing.",
  preview: "A current preview is missing.",
};

export function missingRequirements(facts: readonly ReadinessFact[]): ReadinessGap[] {
  const gaps: ReadinessGap[] = [];
  for (const fact of facts) {
    const present: Record<ReadinessRequirement, boolean> = {
      target: fact.hasTarget,
      priorities: fact.hasPriorities,
      assessment: fact.hasCurrentAssessment,
      preview: fact.hasCurrentPreview,
    };
    for (const requirement of readinessRequirements) {
      if (present[requirement]) continue;
      gaps.push({ serviceKind: fact.kind, requirement, message: requirementCopy[requirement] });
    }
  }
  return gaps;
}

export function serviceInputFingerprint(serviceId: string, inputVersion: number): string {
  return `service:${serviceId}:v${inputVersion}`;
}

export function sortServiceKinds(values: readonly ServiceKind[]): ServiceKind[] {
  const order: Record<ServiceKind, number> = { haircut: 0, colour: 1, beard: 2 };
  return [...values].sort((left, right) => order[left] - order[right]);
}
