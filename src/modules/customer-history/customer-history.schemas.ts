import { z } from "zod";

import type { CustomerHistoryResponse } from "./customer-history.types.js";

const nullableNumberSchema = z.number().nullable();

const profileSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  email: z.email().nullable(),
  phone: z.string(),
  avatar_url: z.string().nullable(),
  gender: z.string().nullable(),
  birth_date: z.string().nullable(),
  created_at: z.string(),
  is_active: z.boolean(),
  subscription_status: z.string().nullable(),
  subscription_end_date: z.string().nullable(),
  subscription_grace_days: z.number().int().nullable(),
  subscription_access_until: z.string().nullable(),
  injuries: z.string().nullable(),
  medical_notes: z.string().nullable(),
});

const kpisSchema = z.object({
  totalSpent: z.number(),
  memberSince: z.string().nullable(),
  totalVisits: z.number().int().nonnegative(),
  initialWeight: nullableNumberSchema,
  currentWeight: nullableNumberSchema,
  weightChange: nullableNumberSchema,
});

const accessEntrySchema = z.object({
  id: z.string(),
  check_in_time: z.string(),
  day_of_week: z.string(),
  status: z.enum(["authorized", "denied"]),
});

const paymentEntrySchema = z.object({
  id: z.uuid(),
  payment_date: z.string(),
  plan_name: z.string(),
  amount_original: z.number(),
  amount_paid: z.number(),
  discount_applied: z.number(),
  payment_method: z.string(),
  subscription_status: z.string(),
  subscription_start: z.string(),
  subscription_end: z.string(),
});

const subscriptionEntrySchema = z.object({
  id: z.uuid(),
  plan_id: z.number().int().nullable(),
  plan_name: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  grace_days: z.number().int().nullable(),
  access_until: z.string().nullable(),
  status: z.string(),
  price: z.number(),
  discount_amount: z.number(),
});

const bodyAssessmentEntrySchema = z.object({
  id: z.uuid(),
  assessment_date: z.string(),
  weight_kg: nullableNumberSchema,
  height_cm: nullableNumberSchema,
  body_fat_percentage: nullableNumberSchema,
  muscle_mass: nullableNumberSchema,
  waist_cm: nullableNumberSchema,
  chest_cm: nullableNumberSchema,
  arm_cm: nullableNumberSchema,
  hip_cm: nullableNumberSchema,
  arm_right_cm: nullableNumberSchema,
  arm_left_cm: nullableNumberSchema,
  leg_right_cm: nullableNumberSchema,
  leg_left_cm: nullableNumberSchema,
  activity_level: z.string().nullable(),
  diet_type: z.string().nullable(),
  daily_calories: z.number().int().nullable(),
  protein_grams: z.number().int().nullable(),
  carbs_grams: z.number().int().nullable(),
  fat_grams: z.number().int().nullable(),
  water_liters_goal: nullableNumberSchema,
  body_type: z.string().nullable(),
});

export const customerHistoryResponseSchema = z.object({
  profile: profileSchema,
  kpis: kpisSchema,
  access_history: z.array(accessEntrySchema),
  payment_history: z.array(paymentEntrySchema),
  subscription_history: z.array(subscriptionEntrySchema),
  body_assessments: z.array(bodyAssessmentEntrySchema),
  heatmap_data: z.record(z.string(), z.number().int().positive()),
}) satisfies z.ZodType<CustomerHistoryResponse>;
