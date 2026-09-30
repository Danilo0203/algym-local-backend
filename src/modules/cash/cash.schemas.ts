import { z } from "zod";

const money = z.number().finite().nonnegative().max(99_999_999.99)
  .refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-8,
    "El monto admite dos decimales");

export const cashSessionIdSchema = z.string().uuid();

export const cashHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(10),
  sessionNumber: z.string().trim().max(80).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  status: z.enum(["all", "open", "closed", "closed_with_difference", "cancelled"]).default("all"),
  openedByUserId: z.string().uuid().optional(),
  sort: z.string().max(300).optional(),
}).strict().refine((input) => !input.dateFrom || !input.dateTo || input.dateFrom <= input.dateTo,
  "El rango de fechas es inválido");

export const openCashSessionSchema = z.object({
  registerId: z.string().uuid(),
  openingAmount: money,
  notes: z.string().trim().max(1000).optional(),
}).strict();

export const closeCashSessionSchema = z.object({
  countedAmount: money,
  notes: z.string().trim().max(1000).optional(),
  adminPassword: z.string().max(1024).optional(),
}).strict();

export const manualCashMovementSchema = z.object({
  movementType: z.enum(["manual_income", "withdrawal"]),
  amount: money.positive(),
  note: z.string().trim().min(3).max(500),
}).strict();

export type OpenCashSessionInput = z.infer<typeof openCashSessionSchema>;
export type CloseCashSessionInput = z.infer<typeof closeCashSessionSchema>;
export type CashHistoryQuery = z.infer<typeof cashHistoryQuerySchema>;
export type ManualCashMovementInput = z.infer<typeof manualCashMovementSchema>;
