import { z } from "zod";

export const enrollmentFeeSchema = z.number().finite().positive().max(99_999_999.99)
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-8, "El importe admite dos decimales");
export const enrollmentQuoteSchema = z.object({
  year: z.number().int().min(2000).max(9999),
  fee: enrollmentFeeSchema,
}).strict();
export type EnrollmentQuote = z.infer<typeof enrollmentQuoteSchema>;
export const enrollmentCollectionSchema = enrollmentQuoteSchema.extend({
  paymentMethod: z.enum(["cash", "card", "transfer"]),
}).strict();
export const enrollmentReviewSchema = z.object({
  year: z.number().int().min(2000).max(9999),
  status: z.enum(["pending", "recognized"]),
  reason: z.string().trim().min(1).max(500),
}).strict();
