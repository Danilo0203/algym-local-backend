import { z } from "zod";

export const loginBodySchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email(),
  password: z.string().min(1).max(256),
});

export const sessionTokenSchema = z
  .string()
  .max(128)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i,
  );

export const authorizationScopeSchema = z.enum([
  "panel",
  "client",
]);

export const authenticatedUserContextSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.email().nullable(),
    profile: z.object({
      fullName: z.string(),
      role: z.string(),
      isActive: z.boolean(),
    }),
  }),
  authorization: z.object({
    roleSlug: z.string(),
    scope: authorizationScopeSchema,
    permissions: z.array(z.string()),
    isOwner: z.boolean(),
  }),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type AuthenticatedUserContext = z.infer<
  typeof authenticatedUserContextSchema
>;
