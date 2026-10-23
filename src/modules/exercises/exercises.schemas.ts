import { z } from "zod";

export const exerciseIdSchema = z.coerce.number().int().positive();
export const exerciseNameSchema = z.string().trim().min(2).max(120);
export const localExerciseMediaUrlSchema = z.string().regex(/^\/api\/media\/exercises\/[a-f0-9]{64}\.(png|jpg|webp|gif|mp4)$/);
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

// Preserve the existing upload contract: image_base64/image_url can also hold MP4 media.
const exerciseImagePayload = {
  image_base64: z.string().min(1).max(28_000_000),
  original_file_name: z.string().max(255).optional(),
};

export const createExerciseWithImageSchema = z.object({
  name: exerciseNameSchema,
  ...exerciseMetadataFields,
  ...exerciseImagePayload,
}).strict();

export const attachExerciseImageSchema = z.object({
  exercise_id: exerciseIdSchema,
  ...exerciseImagePayload,
  displayName: exerciseNameSchema.optional(),
  ...exerciseMetadataFields,
}).strict();

export function decodeExerciseImage(base64: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024
    || bytes.toString("base64") !== base64) {
    throw new z.ZodError([{
      code: "custom", path: ["image_base64"],
      message: "El archivo debe estar codificado en base64 y medir como máximo 20 MB",
    }]);
  }
  return bytes;
}

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
export type CreateExerciseWithImageInput = z.infer<typeof createExerciseWithImageSchema>;
export type AttachExerciseImageInput = z.infer<typeof attachExerciseImageSchema>;
