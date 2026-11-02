import { z } from "zod";

export const healthResponseSchema = z.object({
  data: z.object({
    status: z.literal("ok"),
  }),
});

export const readyResponseSchema = z.object({
  data: z.object({
    status: z.literal("ready"),
  }),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.uuid(),
    fieldErrors: z.record(z.string(), z.array(z.string().min(1))).optional(),
    currentVersion: z.number().int().positive().optional(),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
