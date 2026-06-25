import { z } from "zod";

import type {
  ProfileResponse,
  ProfileUpdateInput,
} from "./profile.types.js";

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  if (!calendarDatePattern.test(value)) {
    return false;
  }

  const parts = value.split("-", 3);

  if (parts.length !== 3) {
    return false;
  }

  const yearPart = parts[0];
  const monthPart = parts[1];
  const dayPart = parts[2];

  if (
    yearPart === undefined ||
    monthPart === undefined ||
    dayPart === undefined
  ) {
    return false;
  }

  const yearValue = Number.parseInt(yearPart, 10);
  const monthValue = Number.parseInt(monthPart, 10);
  const dayValue = Number.parseInt(dayPart, 10);

  if (
    Number.isNaN(yearValue) ||
    Number.isNaN(monthValue) ||
    Number.isNaN(dayValue)
  ) {
    return false;
  }

  const candidate = new Date(
    Date.UTC(yearValue, monthValue - 1, dayValue),
  );

  return (
    candidate.getUTCFullYear() === yearValue &&
    candidate.getUTCMonth() === monthValue - 1 &&
    candidate.getUTCDate() === dayValue
  );
}

export const profileGenderSchema = z.enum([
  "male",
  "female",
  "other",
]);

export const profileResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.email().nullable(),
  full_name: z.string(),
  phone: z.string(),
  birth_date: z
    .string()
    .refine(isValidCalendarDate, "Fecha inválida"),
  gender: profileGenderSchema,
  avatar_url: z.string().nullable(),
  role: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
}) satisfies z.ZodType<ProfileResponse>;

export const profileUpdateSchema = z
  .object({
    full_name: z
      .string()
      .trim()
      .min(2, "El nombre debe tener al menos 2 caracteres"),
    phone: z.string(),
    birth_date: z
      .string()
      .refine(
        isValidCalendarDate,
        "La fecha debe tener formato YYYY-MM-DD y ser válida",
      ),
    gender: profileGenderSchema,
  })
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    {
      message: "Debes enviar al menos un campo para actualizar",
      path: ["body"],
    },
  ) satisfies z.ZodType<ProfileUpdateInput>;
