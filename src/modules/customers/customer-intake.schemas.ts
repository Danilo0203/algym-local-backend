import { z } from "zod";

import {
  bodyAssessmentCreateSchema,
  customerHealthProfileUpdateSchema,
} from "./customers-health.schemas.js";

const nullableText = z.string().trim().max(5_000).nullable().optional();
const goal = z.enum([
  "fat_loss", "muscle_gain", "recomp", "strength", "general_fitness", "cardio",
]).nullable().optional();

export const initialTrainingProfileSchema = z.object({
  primary_goal: goal,
  secondary_goal: goal,
  focus_areas: z.array(z.enum([
    "upper_body", "lower_body", "glutes", "core", "chest", "back",
    "shoulders", "arms", "conditioning",
  ])).max(20).optional(),
  experience_level: z.enum(["beginner", "intermediate", "advanced"]).nullable().optional(),
  days_per_week: z.number().int().min(1).max(7).nullable().optional(),
  session_minutes: z.number().int().min(1).max(480).nullable().optional(),
  training_location: z.enum(["gym", "home", "mixed"]).nullable().optional(),
  equipment_available: z.array(z.enum([
    "full_gym", "body_weight", "dumbbell", "barbell", "machine", "bands",
    "kettlebell", "treadmill", "bike", "rower",
  ])).max(20).optional(),
  activity_level: z.enum([
    "sedentario", "1_3_dias", "3_5_dias", "6_7_dias", "2_veces_dia",
  ]).nullable().optional(),
  cardio_preference: z.enum(["none", "light", "moderate", "high"]).nullable().optional(),
  exercise_preferences: nullableText,
  exercise_dislikes: nullableText,
  injuries_or_pain: nullableText,
  restricted_movements: z.array(z.enum([
    "deep_knee_flexion", "overhead_pressing", "loaded_spinal_flexion",
    "high_impact", "horizontal_pressing", "vertical_pulling", "hip_hinge",
    "unilateral_lower_body",
  ])).max(20).optional(),
  parq_requires_attention: z.boolean().nullable().optional(),
  medical_clearance_notes: nullableText,
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Incluye al menos un dato de entrenamiento",
});

export const customerIntakeSchema = z.object({
  health_profile: customerHealthProfileUpdateSchema.optional(),
  body_assessment: bodyAssessmentCreateSchema.optional(),
  training_profile: initialTrainingProfileSchema.optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "Incluye al menos un dato de salud o entrenamiento",
});

export type CustomerIntakeInput = z.infer<typeof customerIntakeSchema>;

const renewalProfileUpdateSchema = z.object({
  injuries: nullableText,
  medical_notes: nullableText,
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Incluye al menos un cambio de perfil",
});

export const customerRenewalIntakeSchema = z.object({
  profile_update: renewalProfileUpdateSchema.optional(),
  health_profile: customerHealthProfileUpdateSchema.optional(),
  body_assessment: bodyAssessmentCreateSchema.optional(),
  training_profile: initialTrainingProfileSchema.optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "Incluye al menos un dato para la renovación",
});

export type CustomerRenewalIntakeInput = z.infer<typeof customerRenewalIntakeSchema>;
