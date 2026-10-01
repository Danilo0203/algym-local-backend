import { z } from "zod";

export const exerciseIdSchema = z.coerce.number().int().positive();
export const exerciseNameSchema = z.string().trim().min(2).max(120);
export const localExerciseMediaUrlSchema = z.string().regex(/^\/api\/media\/exercises\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/);
const exerciseMetadataItemSchema = z.string().trim().min(1).max(100);
const exerciseMetadataListSchema = z.array(exerciseMetadataItemSchema).max(20);
const exerciseTypeSchema = z.enum(["strength", "cardio", "mobility", "stretching", "balance"]);

const exerciseMetadataFields = {
  body_parts: exerciseMetadataListSchema.optional(),
  target_muscles: exerciseMetadataListSchema.optional(),
  secondary_muscles: exerciseMetadataListSchema.optional(),
  equipments: exerciseMetadataListSchema.optional(),
  exercise_type: exerciseTypeSchema.optional(),
  instructions: exerciseMetadataListSchema.optional(),
  keywords: exerciseMetadataListSchema.optional(),
};

export const createExerciseSchema = z.object({
  name: exerciseNameSchema,
  image_url: localExerciseMediaUrlSchema.optional(),
  original_file_name: z.string().max(255).optional(),
  ...exerciseMetadataFields,
}).strict().refine((value) => !value.original_file_name || Boolean(value.image_url), {
  message: "El nombre del archivo requiere una imagen local",
});

export const updateExerciseSchema = z.object({
  displayName: exerciseNameSchema.optional(),
  isFavorite: z.boolean().optional(),
  isPreviewHidden: z.boolean().optional(),
  imageUrl: localExerciseMediaUrlSchema.optional(),
  originalFileName: z.string().max(255).optional(),
  ...exerciseMetadataFields,
}).strict()
  .refine((value) => Object.keys(value).some((key) => key !== "originalFileName"), "Debe indicar al menos un cambio")
  .refine((value) => !value.originalFileName || Boolean(value.imageUrl), {
    message: "El nombre del archivo requiere una imagen local",
  });

export type CreateExerciseInput = z.infer<typeof createExerciseSchema>;
export type UpdateExerciseInput = z.infer<typeof updateExerciseSchema>;
