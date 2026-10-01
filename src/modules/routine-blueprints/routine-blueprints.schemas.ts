import { z } from "zod";

export const blueprintIdSchema = z.uuid();
export const blueprintRoutineIdSchema = z.uuid();
export const blueprintCustomerIdSchema = z.uuid();

const optionalNumber = (min: number, max: number) => z.number().min(min).max(max).nullable();
const exerciseSchema = z.object({
  exercise_id: z.number().int().positive(),
  block_type: z.enum(["warmup", "strength", "accessory", "cardio", "mobility"]),
  sets: z.number().int().min(1).max(100).nullable(),
  reps: z.string().trim().max(80).nullable(),
  rest_seconds: z.number().int().min(0).max(3600).nullable(),
  duration_minutes: z.number().int().min(0).max(600).nullable(),
  target_rir: optionalNumber(0, 10),
}).strict();

export const createBlueprintSchema = z.object({
  title: z.string().trim().min(1).max(160),
  primary_goal: z.string().trim().min(1).max(80),
  secondary_goal: z.string().trim().max(80).nullable(),
  days: z.array(z.object({ exercises: z.array(exerciseSchema).max(60) }).strict())
    .min(1).max(7),
}).strict().refine(
  (value) => value.days.some((day) => day.exercises.length > 0),
  "Debe tener al menos un ejercicio",
);

export const renameBlueprintSchema = z.object({
  name: z.string().trim().min(1).max(160),
}).strict();

export const assignBlueprintSchema = z.object({
  userId: blueprintCustomerIdSchema,
}).strict();

export const searchClientsSchema = z.object({
  query: z.string().trim().max(120).default(""),
});

export type CreateBlueprintInput = z.infer<typeof createBlueprintSchema>;
