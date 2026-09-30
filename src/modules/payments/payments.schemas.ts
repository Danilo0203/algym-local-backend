import { z } from "zod";

const sortColumns = "(?:payment_date|user_name|subscription_status|plan_name|method|amount_paid)";

export const paymentsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(10),
  user_name: z.string().trim().max(120).optional(),
  method: z.string().regex(/^(cash|card|transfer)(,(cash|card|transfer))*$/).optional(),
  subscription_status: z.string().regex(/^(active|expired|pending|cancelled)(,(active|expired|pending|cancelled))*$/).optional(),
  payment_date_start: z.iso.datetime({ offset: true }).optional(),
  payment_date_end: z.iso.datetime({ offset: true }).optional(),
  sort: z.string().max(400).regex(new RegExp(`^${sortColumns}:(?:asc|desc)(,${sortColumns}:(?:asc|desc))*$`)).optional(),
}).strict().refine(
  (value) => !value.payment_date_start || !value.payment_date_end || value.payment_date_start <= value.payment_date_end,
  { message: "Rango de fechas inválido", path: ["payment_date_end"] },
);

export type PaymentsListQuery = z.infer<typeof paymentsListQuerySchema>;
