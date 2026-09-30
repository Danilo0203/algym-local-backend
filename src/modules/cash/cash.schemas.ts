import { z } from "zod";

const money = z.number().finite().nonnegative().max(99_999_999.99)
  .refine((value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-8,
    "El monto admite dos decimales");

export const cashSessionIdSchema = z.string().uuid();

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

export type OpenCashSessionInput = z.infer<typeof openCashSessionSchema>;
export type CloseCashSessionInput = z.infer<typeof closeCashSessionSchema>;
