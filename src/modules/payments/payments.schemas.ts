import { z } from "zod";
import { customerRenewalIntakeSchema } from "../customers/customer-intake.schemas.js";

const sortColumns = "(?:payment_date|user_name|subscription_status|plan_name|method|amount_paid|status)";

export const paymentsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(10),
  user_name: z.string().trim().max(120).optional(),
  method: z.string().regex(/^(cash|card|transfer)(,(cash|card|transfer))*$/).optional(),
  status: z.string().regex(/^(posted|reversed)(,(posted|reversed))*$/).optional(),
  subscription_status: z.string().regex(/^(active|expired|pending|cancelled)(,(active|expired|pending|cancelled))*$/).optional(),
  payment_date_start: z.iso.datetime({ offset: true }).optional(),
  payment_date_end: z.iso.datetime({ offset: true }).optional(),
  sort: z.string().max(400).regex(new RegExp(`^${sortColumns}:(?:asc|desc)(,${sortColumns}:(?:asc|desc))*$`)).optional(),
}).strict().refine(
  (value) => !value.payment_date_start || !value.payment_date_end || value.payment_date_start <= value.payment_date_end,
  { message: "Rango de fechas inválido", path: ["payment_date_end"] },
);

export type PaymentsListQuery = z.infer<typeof paymentsListQuerySchema>;

const money = z.number().finite().nonnegative().max(99_999_999.99)
  .refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-8,
    "El importe admite dos decimales");

const paidMembershipFieldsSchema = z.object({
  customerId: z.string().uuid(),
  planId: z.number().int().positive(),
  operation: z.enum(["create", "renew"]),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  amountOriginal: money.optional(),
  discountAmount: money.default(0),
  amountPaid: money.optional(),
  graceDays: z.number().int().min(0).max(365).default(3),
  paymentMethod: z.enum(["cash", "card", "transfer"]).default("cash"),
  requireSession: z.boolean().default(false),
}).strict();

const validMembershipDates = (value: { startDate?: string; endDate?: string }) =>
  !value.startDate || !value.endDate || value.endDate > value.startDate;

export const paidMembershipSchema = paidMembershipFieldsSchema
  .extend({ intake: customerRenewalIntakeSchema.optional() })
  .refine(validMembershipDates,
    { message: "La fecha final debe ser posterior al inicio", path: ["endDate"] })
  .refine((value) => !value.intake || (value.operation === "renew" && value.requireSession),
    { message: "La ficha de renovación requiere un cobro en caja", path: ["intake"] });

export const paidMembershipForNewCustomerSchema = paidMembershipFieldsSchema
  .omit({ customerId: true, operation: true })
  .extend({ requireSession: z.literal(true) })
  .refine(validMembershipDates,
    { message: "La fecha final debe ser posterior al inicio", path: ["endDate"] });

export type PaidMembershipInput = z.infer<typeof paidMembershipSchema>;

export const pendingMembershipQuerySchema = z.object({
  search: z.string().trim().max(100).default(""),
}).strict();

export const collectPendingMembershipSchema = z.object({
  discountAmount: money.default(0),
  paymentMethod: z.enum(["cash", "card", "transfer"]).default("cash"),
}).strict();

export const paymentIdSchema = z.string().uuid();

export const reversePaymentSchema = z.object({
  amountOriginal: money,
  discountAmount: money,
  amountPaid: money,
  paymentMethod: z.enum(["cash", "card", "transfer"]),
  reason: z.string().trim().min(1).max(500),
  sourceCategory: z.enum(["membership", "product", "enrollment", "service", "other"]).default("membership"),
  note: z.string().trim().max(500).optional(),
}).strict().refine((value) => value.discountAmount <= value.amountOriginal,
  { message: "El descuento supera el importe original", path: ["discountAmount"] });

export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;
