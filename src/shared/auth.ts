import { z } from "zod";

export const membershipSchema = z.object({
  salonId: z.uuid(),
  salonSlug: z.string().min(1),
  role: z.enum(["stylist", "admin"]),
});

export const sessionUserSchema = z.object({
  id: z.uuid(),
  email: z.string().min(1),
  displayName: z.string().min(1),
  memberships: z.array(membershipSchema),
});

export const sessionResponseSchema = z.object({
  data: z.object({
    user: sessionUserSchema.nullable(),
    csrfToken: z.string().min(1),
  }),
});

export const registerRequestSchema = z.strictObject({
  email: z.string(),
  password: z.string(),
  displayName: z.string(),
});

export const loginRequestSchema = z.strictObject({
  email: z.string(),
  password: z.string(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type Membership = z.infer<typeof membershipSchema>;
