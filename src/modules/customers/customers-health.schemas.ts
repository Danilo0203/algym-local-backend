import { z } from "zod";

import type {
  BodyAssessmentsQuery,
  BodyAssessmentWriteInput,
  CustomerHealthProfileUpdateInput,
} from "./customers-health.types.js";

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  if (!calendarDatePattern.test(value)) return false;
  const [yearPart, monthPart, dayPart] = value.split("-", 3);
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function normalizeNullableText(value: string | null): string | null {
  if (value === null) return null;
  return value.trim() || null;
}

function normalizeNullableTextArray(
  value: string[] | null,
): string[] | null {
  if (value === null) return null;

  return [...new Set(
    value
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )];
}

function hasAtLeastOneOwnProperty(value: object): boolean {
  return Object.keys(value).length > 0;
}

function hasAssessmentContent(value: BodyAssessmentWriteInput): boolean {
  const measurementFields = [
    "weight_kg",
    "height_cm",
    "body_fat_percentage",
    "muscle_mass_kg",
    "chest",
    "waist",
    "hip",
    "arm_right",
    "arm_left",
    "leg_right",
    "leg_left",
  ] as const satisfies ReadonlyArray<keyof BodyAssessmentWriteInput>;

  if (measurementFields.some((field) => value[field] != null)) return true;
  if (value.notes != null) return true;

  return value.nutrition_snapshot != null &&
    Object.values(value.nutrition_snapshot).some(
      (nutritionValue) => nutritionValue != null,
    );
}

const shortNullableText = z.string()
  .max(500, "El texto excede el máximo permitido")
  .nullable()
  .transform(normalizeNullableText);

const longNullableText = z.string()
  .max(5_000, "El texto excede el máximo permitido")
  .nullable()
  .transform(normalizeNullableText);

const nullableTextArray = z.array(
  z.string().max(200, "El valor excede el máximo permitido"),
).max(100, "Se excedió el máximo de valores")
  .nullable()
  .transform(normalizeNullableTextArray);

export const customerHealthProfileUpdateSchema = z.object({
  parq_requires_attention: z.boolean().nullable().optional(),
  parq_details: longNullableText.optional(),
  injuries_or_pain: longNullableText.optional(),
  medical_conditions: longNullableText.optional(),
  medications: longNullableText.optional(),
  medical_clearance_notes: longNullableText.optional(),
  restricted_movements: longNullableText.optional(),
  primary_goal: shortNullableText.optional(),
  secondary_goal: shortNullableText.optional(),
  focus_areas: nullableTextArray.optional(),
  experience_level: shortNullableText.optional(),
  days_per_week: z.number().int().min(1).max(7).nullable().optional(),
  session_minutes: z.number().int().min(15).max(480).nullable().optional(),
  training_location: shortNullableText.optional(),
  equipment_available: nullableTextArray.optional(),
  cardio_preference: shortNullableText.optional(),
  exercise_preferences: longNullableText.optional(),
  exercise_dislikes: longNullableText.optional(),
  diet_type: shortNullableText.optional(),
  activity_level: shortNullableText.optional(),
}).strict().refine(hasAtLeastOneOwnProperty, {
  message: "Debes enviar al menos un campo para actualizar",
  path: ["body"],
}) satisfies z.ZodType<CustomerHealthProfileUpdateInput>;

const nullablePositiveMagnitude = (maximum: number) => z.number()
  .positive("El valor debe ser mayor que cero")
  .max(maximum, "El valor excede el máximo permitido")
  .nullable();

const nutritionSnapshotSchema = z.object({
  body_type: shortNullableText.optional(),
  activity_level: shortNullableText.optional(),
  water_liters_goal: nullablePositiveMagnitude(30).optional(),
  daily_calories: z.number().int().min(0).max(30_000).nullable().optional(),
  protein_grams: z.number().int().min(0).max(10_000).nullable().optional(),
  carbs_grams: z.number().int().min(0).max(10_000).nullable().optional(),
  fat_grams: z.number().int().min(0).max(10_000).nullable().optional(),
  diet_type: shortNullableText.optional(),
}).strict();

const bodyAssessmentFields = {
  assessment_date: z.string()
    .refine(isValidCalendarDate, "Fecha inválida")
    .optional(),
  weight_kg: nullablePositiveMagnitude(700).optional(),
  height_cm: nullablePositiveMagnitude(300).optional(),
  body_fat_percentage: z.number().min(0).max(100).nullable().optional(),
  muscle_mass_kg: nullablePositiveMagnitude(500).optional(),
  chest: nullablePositiveMagnitude(500).optional(),
  waist: nullablePositiveMagnitude(500).optional(),
  hip: nullablePositiveMagnitude(500).optional(),
  arm_right: nullablePositiveMagnitude(500).optional(),
  arm_left: nullablePositiveMagnitude(500).optional(),
  leg_right: nullablePositiveMagnitude(500).optional(),
  leg_left: nullablePositiveMagnitude(500).optional(),
  notes: longNullableText.optional(),
  nutrition_snapshot: nutritionSnapshotSchema.nullable().optional(),
};

export const bodyAssessmentCreateSchema = z.object(
  bodyAssessmentFields,
).strict().refine(hasAssessmentContent, {
  message: "Debes enviar al menos una medición, nota o dato nutricional",
  path: ["body"],
}) satisfies z.ZodType<BodyAssessmentWriteInput>;

export const bodyAssessmentUpdateSchema = z.object(
  bodyAssessmentFields,
).strict().refine(hasAtLeastOneOwnProperty, {
  message: "Debes enviar al menos un campo para actualizar",
  path: ["body"],
}) satisfies z.ZodType<BodyAssessmentWriteInput>;

export const bodyAssessmentsQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(1000).default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
}).strict() satisfies z.ZodType<BodyAssessmentsQuery>;

export const bodyAssessmentIdParamSchema = z.uuid("Id inválido");
