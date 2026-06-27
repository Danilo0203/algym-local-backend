import { z } from "zod";

import type {
  CustomerCreateInput,
  CustomerDetail,
  CustomerGender,
  CustomerListItem,
  CustomerListQuery,
  CustomerMembershipSummary,
  CustomersListResponse,
  CustomerStatusUpdateInput,
  CustomerUpdateInput,
} from "./customers.types.js";

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  const candidate = new Date(
    Date.UTC(yearValue, monthValue - 1, dayValue),
  );

  return (
    candidate.getUTCFullYear() === yearValue &&
    candidate.getUTCMonth() === monthValue - 1 &&
    candidate.getUTCDate() === dayValue
  );
}

function normalizeOptionalText(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

const customerGenderSchema = z.enum([
  "male",
  "female",
  "other",
]) satisfies z.ZodType<CustomerGender>;

const nullableTrimmedTextSchema = z
  .string()
  .trim()
  .max(500, "El texto excede el máximo permitido")
  .optional()
  .transform(normalizeOptionalText);

const customerMembershipSummarySchema = z.object({
  plan_name: z.string().nullable(),
  status: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  grace_days: z.number().int().nullable(),
  access_until: z.string().nullable(),
}) satisfies z.ZodType<CustomerMembershipSummary>;

export const customerListItemSchema = z.object({
  id: z.uuid(),
  email: z.email().nullable(),
  full_name: z.string(),
  phone: z.string(),
  avatar_url: z.string().nullable(),
  birth_date: z
    .string()
    .refine(isValidCalendarDate, "Fecha inválida"),
  gender: customerGenderSchema,
  is_active: z.boolean(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  current_membership: customerMembershipSummarySchema.nullable(),
}) satisfies z.ZodType<CustomerListItem>;

export const customerDetailSchema = customerListItemSchema.extend({
  role: z.string(),
  injuries: z.string().nullable(),
  medical_notes: z.string().nullable(),
}) satisfies z.ZodType<CustomerDetail>;

export const customersListResponseSchema = z.object({
  data: z.array(customerListItemSchema),
  meta: z.object({
    page: z.number().int().positive(),
    page_size: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
  }),
}) satisfies z.ZodType<CustomersListResponse>;

export const customerIdParamSchema = z
  .string()
  .regex(uuidPattern, "Id inválido");

export const customersListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().max(1000).default(1),
    page_size: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().trim().max(100).optional(),
    sort: z.string().trim().default("full_name"),
  })
  .strict() satisfies z.ZodType<CustomerListQuery>;

export const customerCreateSchema = z
  .object({
    full_name: z
      .string()
      .trim()
      .min(2, "El nombre debe tener al menos 2 caracteres"),
    phone: z
      .string()
      .trim()
      .min(1, "El teléfono es obligatorio")
      .max(40, "El teléfono excede el máximo permitido"),
    birth_date: z
      .string()
      .refine(
        isValidCalendarDate,
        "La fecha debe tener formato YYYY-MM-DD y ser válida",
      ),
    gender: customerGenderSchema,
    email: z
      .string()
      .trim()
      .max(320, "El email excede el máximo permitido")
      .optional()
      .refine(
        (value) =>
          value === undefined ||
          value === "" ||
          z.email().safeParse(value).success,
        "Email inválido",
      ),
    injuries: nullableTrimmedTextSchema,
    medical_notes: nullableTrimmedTextSchema,
  })
  .strict() satisfies z.ZodType<CustomerCreateInput>;

export const customerUpdateSchema = z
  .object({
    full_name: z
      .string()
      .trim()
      .min(2, "El nombre debe tener al menos 2 caracteres")
      .optional(),
    phone: z
      .string()
      .trim()
      .min(1, "El teléfono es obligatorio")
      .max(40, "El teléfono excede el máximo permitido")
      .optional(),
    birth_date: z
      .string()
      .refine(
        isValidCalendarDate,
        "La fecha debe tener formato YYYY-MM-DD y ser válida",
      )
      .optional(),
    gender: customerGenderSchema.optional(),
    injuries: nullableTrimmedTextSchema,
    medical_notes: nullableTrimmedTextSchema,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Debes enviar al menos un campo para actualizar",
    path: ["body"],
  }) satisfies z.ZodType<CustomerUpdateInput>;

export const customerStatusUpdateSchema = z
  .object({
    is_active: z.boolean(),
  })
  .strict() satisfies z.ZodType<CustomerStatusUpdateInput>;
