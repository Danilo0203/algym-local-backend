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

export const userRoleTransitionSchema = z.strictObject({
  role: z.enum(["trainer", "client"]),
  is_active: z.boolean(),
  birth_date: z.iso.date().optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  password: passwordSchema.optional(),
}).superRefine((input, context) => {
  if (input.role === "trainer" && input.birth_date !== undefined) {
    context.addIssue({ code: "custom", path: ["birth_date"], message: "La fecha de nacimiento se completa al convertir a cliente" });
  }
  if (input.role === "client" && (input.email !== undefined || input.password !== undefined)) {
    context.addIssue({ code: "custom", path: ["role"], message: "La cuenta conserva sus credenciales al convertir a cliente" });
  }
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserRoleTransitionInput = z.infer<typeof userRoleTransitionSchema>;
