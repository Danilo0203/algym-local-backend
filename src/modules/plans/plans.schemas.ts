import { z } from "zod";

export const planIdParamSchema = z.coerce.number().int().positive("Id de plan inválido");

const planFieldsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullable(),
  price: z.number().finite().nonnegative().max(99_999_999.99)
    .refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-8, "El precio admite dos decimales"),
  duration_days: z.number().int().min(1).max(3650),
  is_active: z.boolean(),
});

export const createPlanSchema = planFieldsSchema.extend({
  description: planFieldsSchema.shape.description.optional().default(null),
  is_active: planFieldsSchema.shape.is_active.optional().default(true),
}).strict();

export const updatePlanSchema = planFieldsSchema.partial().strict()
  .refine((value) => Object.keys(value).length > 0, "Debe indicar al menos un cambio");

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
