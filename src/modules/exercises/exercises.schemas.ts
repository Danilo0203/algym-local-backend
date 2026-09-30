import { z } from "zod";

export const exerciseIdSchema = z.coerce.number().int().positive();
export const exerciseNameSchema = z.string().trim().min(2).max(120);
export const localExerciseMediaUrlSchema = z.string().regex(/^\/api\/media\/exercises\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/);

export const createExerciseSchema = z.object({
  name: exerciseNameSchema,
  image_url: localExerciseMediaUrlSchema,
  original_file_name: z.string().max(255).optional(),
}).strict();

export const updateExerciseSchema = z.object({
  displayName: exerciseNameSchema.optional(),
  isFavorite: z.boolean().optional(),
  isPreviewHidden: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Debe indicar al menos un cambio");

export type CreateExerciseInput = z.infer<typeof createExerciseSchema>;
export type UpdateExerciseInput = z.infer<typeof updateExerciseSchema>;
