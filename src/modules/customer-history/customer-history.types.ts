export type CustomerHistoryProfile = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string;
  avatar_url: string | null;
  gender: string | null;
  birth_date: string | null;
  created_at: string;
  is_active: boolean;
  subscription_status: string | null;
  subscription_end_date: string | null;
  subscription_grace_days: number | null;
  subscription_access_until: string | null;
  injuries: string | null;
  medical_notes: string | null;
};

export type CustomerHistoryKpis = {
  totalSpent: number;
  memberSince: string | null;
  totalVisits: number;
  initialWeight: number | null;
  currentWeight: number | null;
  weightChange: number | null;
};

export type CustomerAccessHistoryEntry = {
  id: string;
  check_in_time: string;
  day_of_week: string;
  status: "authorized" | "denied";
};

export type CustomerPaymentHistoryEntry = {
  id: string;
  payment_date: string;
  plan_name: string;
  amount_original: number;
  amount_paid: number;
  discount_applied: number;
  payment_method: string;
  subscription_status: string;
  subscription_start: string;
  subscription_end: string;
};

export type CustomerSubscriptionHistoryEntry = {
  id: string;
  plan_id: number | null;
  plan_name: string;
  start_date: string;
  end_date: string;
  grace_days: number | null;
  access_until: string | null;
  status: string;
  price: number;
  discount_amount: number;
};

export type CustomerBodyAssessmentEntry = {
  id: string;
  assessment_date: string;
  weight_kg: number | null;
  height_cm: number | null;
  body_fat_percentage: number | null;
  muscle_mass: number | null;
  waist_cm: number | null;
  chest_cm: number | null;
  arm_cm: number | null;
  hip_cm: number | null;
  arm_right_cm: number | null;
  arm_left_cm: number | null;
  leg_right_cm: number | null;
  leg_left_cm: number | null;
  activity_level: string | null;
  diet_type: string | null;
  daily_calories: number | null;
  protein_grams: number | null;
  carbs_grams: number | null;
  fat_grams: number | null;
  water_liters_goal: number | null;
  body_type: string | null;
};

export type CustomerHistoryResponse = {
  profile: CustomerHistoryProfile;
  kpis: CustomerHistoryKpis;
  access_history: CustomerAccessHistoryEntry[];
  payment_history: CustomerPaymentHistoryEntry[];
  subscription_history: CustomerSubscriptionHistoryEntry[];
  body_assessments: CustomerBodyAssessmentEntry[];
  heatmap_data: Record<string, number>;
};
