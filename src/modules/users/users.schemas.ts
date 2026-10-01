import { z } from "zod";

export const internalUserRoleSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{2,39}$/);
export type InternalUserRole = z.infer<typeof internalUserRoleSchema>;

export const userIdParamSchema = z.uuid();

const fullNameSchema = z.string().trim().min(2).max(160);
const passwordSchema = z.string().min(8).max(128);

export const createUserSchema = z.strictObject({
  email: z.email().max(254).transform((email) => email.trim().toLowerCase()),
  full_name: fullNameSchema,
  role: internalUserRoleSchema,
  password: passwordSchema,
});

export const updateUserSchema = z.strictObject({
  full_name: fullNameSchema.optional(),
  role: internalUserRoleSchema.optional(),
  password: passwordSchema.optional(),
  is_active: z.boolean().optional(),
}).refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: "Indica al menos un campo para actualizar",
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
