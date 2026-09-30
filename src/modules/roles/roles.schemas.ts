import { z } from "zod";

export const roleIdSchema = z.uuid();

const permissionIdsSchema = z.array(z.uuid()).max(200)
  .refine((ids) => new Set(ids).size === ids.length, "No repitas permisos");

export const createRoleSchema = z.strictObject({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,39}$/),
  permissionIds: permissionIdsSchema,
});

export const updateRoleSchema = z.strictObject({
  name: z.string().trim().min(2).max(100).optional(),
  permissionIds: permissionIdsSchema.optional(),
}).refine((input) => input.name !== undefined || input.permissionIds !== undefined,
  "Indica al menos un cambio");

export const deleteRoleSchema = z.strictObject({
  replacementRoleSlug: z.string().trim().regex(/^[a-z][a-z0-9_]{2,39}$/).optional(),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type DeleteRoleInput = z.infer<typeof deleteRoleSchema>;
