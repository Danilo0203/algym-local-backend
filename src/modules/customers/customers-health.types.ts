export type CustomerHealthProfileStatus =
  | "pending"
  | "completed"
  | "requires_attention";

export type CustomerHealthProfile = {
  customer_id: string;
  parq_requires_attention: boolean | null;
  parq_details: string | null;
  injuries_or_pain: string | null;
  medical_conditions: string | null;
  medications: string | null;
  medical_clearance_notes: string | null;
  restricted_movements: string | null;
  primary_goal: string | null;
  secondary_goal: string | null;
  focus_areas: string[] | null;
  experience_level: string | null;
  days_per_week: number | null;
  session_minutes: number | null;
  training_location: string | null;
  equipment_available: string[] | null;
  cardio_preference: string | null;
  exercise_preferences: string | null;
  exercise_dislikes: string | null;
  diet_type: string | null;
  activity_level: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type CustomerHealthProfileUpdateInput = Partial<
  Omit<CustomerHealthProfile, "created_at" | "customer_id" | "updated_at">
>;

export type BodyAssessmentNutritionSnapshot = {
  body_type: string | null;
  activity_level: string | null;
  water_liters_goal: number | null;
  daily_calories: number | null;
  protein_grams: number | null;
  carbs_grams: number | null;
  fat_grams: number | null;
  diet_type: string | null;
};

export type CustomerBodyAssessment = {
  id: string;
  customer_id: string;
  assessment_date: string | null;
  weight_kg: number | null;
  height_cm: number | null;
  body_fat_percentage: number | null;
  muscle_mass_kg: number | null;
  chest: number | null;
  waist: number | null;
  hip: number | null;
  arm_right: number | null;
  arm_left: number | null;
  leg_right: number | null;
  leg_left: number | null;
  notes: string | null;
  body_type: string | null;
  activity_level: string | null;
  water_liters_goal: number | null;
  daily_calories: number | null;
  protein_grams: number | null;
  carbs_grams: number | null;
  fat_grams: number | null;
  diet_type: string | null;
  nutrition_snapshot: BodyAssessmentNutritionSnapshot | null;
  created_at: string;
  updated_at: string;
};

export type BodyAssessmentWriteInput = {
  assessment_date?: string;
  weight_kg?: number | null;
  height_cm?: number | null;
  body_fat_percentage?: number | null;
  muscle_mass_kg?: number | null;
  chest?: number | null;
  waist?: number | null;
  hip?: number | null;
  arm_right?: number | null;
  arm_left?: number | null;
  leg_right?: number | null;
  leg_left?: number | null;
  notes?: string | null;
  nutrition_snapshot?: Partial<BodyAssessmentNutritionSnapshot> | null;
};

export type BodyAssessmentsQuery = {
  page: number;
  page_size: number;
};

export type BodyAssessmentsResponse = {
  data: CustomerBodyAssessment[];
  meta: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
};
