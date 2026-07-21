import { z } from "zod";

import type {
  CancelMembershipInput,
  CreateMembershipInput,
  RenewMembershipInput,
} from "./memberships.types.js";

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  if (!calendarDatePattern.test(value)) {
    return false;
  }

  const [yearPart, monthPart, dayPart] = value.split("-", 3);

  if (!yearPart || !monthPart || !dayPart) {
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

  const candidate = new Date(Date.UTC(yearValue, monthValue - 1, dayValue));

  return (
    candidate.getUTCFullYear() === yearValue &&
    candidate.getUTCMonth() === monthValue - 1 &&
    candidate.getUTCDate() === dayValue
  );
}

export const createMembershipSchema = z
  .object({
    plan_id: z.number().int().positive(),
    cycles: z.number().int().min(1, "Debe ser al menos 1 ciclo"),
    start_date: z
      .string()
      .refine(isValidCalendarDate, "Fecha inválida")
      .optional(),
  })
  .strict() satisfies z.ZodType<CreateMembershipInput>;

export const renewMembershipSchema = z
  .object({
    plan_id: z.number().int().positive(),
    cycles: z.number().int().min(1, "Debe ser al menos 1 ciclo"),
    start_date: z
      .string()
      .refine(isValidCalendarDate, "Fecha inválida")
      .optional(),
  })
  .strict() satisfies z.ZodType<RenewMembershipInput>;

export const cancelMembershipSchema = z
  .object({
    status: z.literal("cancelled"),
  })
  .strict() satisfies z.ZodType<CancelMembershipInput>;
