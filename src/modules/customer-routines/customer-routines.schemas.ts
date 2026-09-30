import { z } from "zod";

import type {
  CreateCustomerRoutineInput,
  CreateRoutineDetailInput,
  GenerateCustomerRoutineInput,
  UpdateCustomerRoutineInput,
  UpdateRoutineDetailInput,
} from "./customer-routines.types.js";

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  if (!calendarDatePattern.test(value)) return false;

  const [yearPart, monthPart, dayPart] = value.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

const calendarDateSchema = z.string().refine(isValidCalendarDate, "Fecha inválida");
const nullableTextSchema = (maximum: number) =>
  z.string().trim().max(maximum).nullable();
const routineStatusSchema = z.enum([
  "pending_profile",
  "draft",
  "active",
  "archived",
]);
const routineSourceSchema = z.enum(["system", "admin"]);
const routineBlockTypeSchema = z.enum([
  "warmup",
  "strength",
  "accessory",
  "cardio",
  "mobility",
]);

const routineWriteShape = {
  name: z.string().trim().min(1).max(160),
  start_date: calendarDateSchema,
  end_date: calendarDateSchema.nullable(),
  goal: nullableTextSchema(500),
  status: routineStatusSchema,
  source: routineSourceSchema,
  training_profile_id: z.uuid().nullable(),
  primary_goal: nullableTextSchema(80),
  secondary_goal: nullableTextSchema(80),
  generation_version: nullableTextSchema(120),
};

export const createCustomerRoutineSchema = z
  .object({
    name: routineWriteShape.name,
    start_date: routineWriteShape.start_date.optional(),
    end_date: routineWriteShape.end_date.optional(),
    goal: routineWriteShape.goal.optional(),
    status: routineWriteShape.status.optional(),
    source: routineWriteShape.source.optional(),
    training_profile_id: routineWriteShape.training_profile_id.optional(),
    primary_goal: routineWriteShape.primary_goal.optional(),
    secondary_goal: routineWriteShape.secondary_goal.optional(),
    generation_version: routineWriteShape.generation_version.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.start_date ||
      !value.end_date ||
      value.end_date >= value.start_date,
    { path: ["end_date"], message: "La fecha final no puede ser anterior a la inicial" },
  ) satisfies z.ZodType<CreateCustomerRoutineInput>;

export const updateCustomerRoutineSchema = z
  .object(routineWriteShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Debe enviar al menos un campo",
  })
  .refine(
    (value) =>
      !value.start_date ||
      !value.end_date ||
      value.end_date >= value.start_date,
    { path: ["end_date"], message: "La fecha final no puede ser anterior a la inicial" },
  ) satisfies z.ZodType<UpdateCustomerRoutineInput>;

const detailWriteShape = {
  day_of_week: z.number().int().min(1).max(7),
  exercise_id: z.number().int().positive().nullable(),
  exercise_order: z.number().int().positive().nullable(),
  block_type: routineBlockTypeSchema,
  sets: z.number().int().positive().nullable(),
  reps: nullableTextSchema(80),
  rest_seconds: z.number().int().nonnegative().nullable(),
  duration_minutes: z.number().int().nonnegative().nullable(),
  target_rir: z.number().min(0).max(10).nullable(),
  notes: nullableTextSchema(2000),
  exercise_name_snapshot: nullableTextSchema(240),
};

export const createRoutineDetailSchema = z
  .object({
    day_of_week: detailWriteShape.day_of_week,
    exercise_id: detailWriteShape.exercise_id.optional(),
    exercise_order: detailWriteShape.exercise_order.optional(),
    block_type: detailWriteShape.block_type.optional(),
    sets: detailWriteShape.sets.optional(),
    reps: detailWriteShape.reps.optional(),
    rest_seconds: detailWriteShape.rest_seconds.optional(),
    duration_minutes: detailWriteShape.duration_minutes.optional(),
    target_rir: detailWriteShape.target_rir.optional(),
    notes: detailWriteShape.notes.optional(),
    exercise_name_snapshot: detailWriteShape.exercise_name_snapshot.optional(),
  })
  .strict() satisfies z.ZodType<CreateRoutineDetailInput>;

export const generateCustomerRoutineSchema = z.object({
  status: z.enum(["pending_profile", "draft"]),
  name: routineWriteShape.name,
  goal: routineWriteShape.goal,
  training_profile_id: z.uuid().nullable(),
  primary_goal: routineWriteShape.primary_goal,
  secondary_goal: routineWriteShape.secondary_goal,
  generation_version: z.string().trim().min(1).max(120),
  details: z.array(createRoutineDetailSchema).max(100),
}).strict().superRefine((value, context) => {
  if (value.status === "draft" && (!value.training_profile_id || value.details.length === 0)) {
    context.addIssue({ code: "custom", message: "El borrador requiere perfil y ejercicios" });
  }
  if (value.status === "pending_profile" && value.details.length > 0) {
    context.addIssue({ code: "custom", message: "Una rutina pendiente no admite ejercicios" });
  }
  value.details.forEach((detail, index) => {
    if (!detail.exercise_id && !detail.exercise_name_snapshot?.trim()) {
      context.addIssue({ code: "custom", path: ["details", index], message: "Indica el nombre del ejercicio pendiente" });
    }
  });
}) satisfies z.ZodType<GenerateCustomerRoutineInput>;

export const updateRoutineDetailSchema = z
  .object(detailWriteShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Debe enviar al menos un campo",
  }) satisfies z.ZodType<UpdateRoutineDetailInput>;

export const routineIdParamSchema = z.uuid();
export const routineDetailIdParamSchema = z.coerce.number().int().positive();
