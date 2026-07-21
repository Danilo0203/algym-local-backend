import { z } from "zod";

import { createMembershipSchema } from "../memberships/memberships.schemas.js";

import type {
  CustomerCreateInput,
  CustomerDetail,
  CustomerGender,
  CustomerHistoryQuery,
  CustomerListItem,
  CustomerListQuery,
  CustomerMembershipStatus,
  CustomerMembershipSummary,
  CustomerSidebarQuery,
  CustomerStatusUpdateInput,
  CustomersListResponse,
  CustomerUpdateInput,
} from "./customers.types.js";

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function normalizeOptionalText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

const customerGenderSchema = z.enum([
  "male",
  "female",
  "other",
]) satisfies z.ZodType<CustomerGender>;

export const customerMembershipStatusSchema = z.enum([
  "active",
  "expiring",
  "grace",
  "expired",
  "cancelled",
  "none",
]) satisfies z.ZodType<CustomerMembershipStatus>;

const nullableTrimmedTextSchema = z
  .string()
  .trim()
  .max(500, "El texto excede el máximo permitido")
  .optional()
  .transform(normalizeOptionalText);

const customerMembershipSummarySchema = z.object({
  plan_id: z.number().int().nullable(),
  plan_name: z.string().nullable(),
  status: z.string().nullable(),
  display_status: customerMembershipStatusSchema,
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
  birth_date: z.string().refine(isValidCalendarDate, "Fecha inválida"),
  gender: customerGenderSchema,
  biometric_id: z.number().int(),
  is_active: z.boolean(),
  membership_status: customerMembershipStatusSchema,
  last_check_in: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  current_membership: customerMembershipSummarySchema.nullable(),
}) satisfies z.ZodType<CustomerListItem>;

export const customerDetailSchema = customerListItemSchema.extend({
  role: z.string(),
  injuries: z.string().nullable(),
  medical_notes: z.string().nullable(),
  account: z.object({
    email: z.email().nullable(),
    has_password: z.boolean(),
    login_enabled: z.boolean(),
  }),
  capabilities: z.object({
    update_customer: z.boolean(),
    manage_membership: z.boolean(),
    view_payments: z.boolean(),
  }),
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

export const customerIdParamSchema = z.string().regex(uuidPattern, "Id inválido");

const strictBooleanQuerySchema = z.enum(["true", "false"])
  .transform((value) => value === "true");

export const customersListQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(1000).default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(100).optional(),
  sort: z.string().trim().default("full_name"),
  is_active: strictBooleanQuerySchema.optional(),
  plan_id: z.coerce.number().int().positive().optional(),
  membership_status: customerMembershipStatusSchema.optional(),
}).strict() satisfies z.ZodType<CustomerListQuery>;

export const customerSidebarQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
}).strict() satisfies z.ZodType<CustomerSidebarQuery>;

export const customerHistoryQuerySchema = z.object({
  attendance_limit: z.coerce.number().int().positive().max(50).default(50),
  heatmap_days: z.coerce.number().int().positive().max(365).default(365),
  memberships_page: z.coerce.number().int().positive().max(1000).default(1),
  memberships_page_size: z.coerce.number().int().positive().max(100).default(20),
  payments_page: z.coerce.number().int().positive().max(1000).default(1),
  payments_page_size: z.coerce.number().int().positive().max(100).default(20),
  assessments_page: z.coerce.number().int().positive().max(1000).default(1),
  assessments_page_size: z.coerce.number().int().positive().max(100).default(20),
}).strict() satisfies z.ZodType<CustomerHistoryQuery>;

export const customerCreateSchema = z.object({
  full_name: z.string().trim().min(2, "El nombre debe tener al menos 2 caracteres"),
  phone: z.string().trim().min(1, "El teléfono es obligatorio").max(40),
  birth_date: z.string().refine(isValidCalendarDate, "La fecha debe tener formato YYYY-MM-DD y ser válida"),
  gender: customerGenderSchema,
  email: z.string().trim().max(320).optional().refine(
    (value) => value === undefined || value === "" || z.email().safeParse(value).success,
    "Email inválido",
  ),
  injuries: nullableTrimmedTextSchema,
  medical_notes: nullableTrimmedTextSchema,
  membership: createMembershipSchema.optional(),
}).strict() satisfies z.ZodType<CustomerCreateInput>;

export const customerUpdateSchema = z.object({
  full_name: z.string().trim().min(2).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  birth_date: z.string().refine(isValidCalendarDate, "Fecha inválida").optional(),
  gender: customerGenderSchema.optional(),
  injuries: nullableTrimmedTextSchema,
  medical_notes: nullableTrimmedTextSchema,
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Debes enviar al menos un campo para actualizar",
  path: ["body"],
}) satisfies z.ZodType<CustomerUpdateInput>;

export const customerStatusUpdateSchema = z.object({
  is_active: z.boolean(),
}).strict() satisfies z.ZodType<CustomerStatusUpdateInput>;
