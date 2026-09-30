export type TrainingProfileRecord = {
  id: string;
  user_id: string;
  primary_goal: string | null;
  secondary_goal: string | null;
  focus_areas: string[];
  experience_level: string | null;
  days_per_week: number | null;
  session_minutes: number | null;
  training_location: string | null;
  equipment_available: string[];
  activity_level: string | null;
  cardio_preference: string | null;
  exercise_preferences: string | null;
  exercise_dislikes: string | null;
  injuries_or_pain: string | null;
  restricted_movements: string[];
  parq_requires_attention: boolean | null;
  medical_clearance_notes: string | null;
  is_complete: boolean;
  created_at: string;
  updated_at: string;
};

export type RoutineRecord = {
  id: string;
  user_id: string | null;
  created_by: string | null;
  name: string;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean | null;
  goal: string | null;
  status: "pending_profile" | "draft" | "active" | "archived";
  source: "system" | "admin";
  training_profile_id: string | null;
  primary_goal: string | null;
  secondary_goal: string | null;
  generation_version: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
};

export type RoutineDetailRecord = {
  id: number;
  routine_id: string;
  day_of_week: number;
  exercise_id: number | null;
  exercise_order: number | null;
  block_type: "warmup" | "strength" | "accessory" | "cardio" | "mobility";
  sets: number | null;
  reps: string | null;
  rest_seconds: number | null;
  duration_minutes: number | null;
  target_rir: number | null;
  notes: string | null;
  exercise_name_snapshot: string | null;
  exercise_image_url: string | null;
  exercise_video_url: string | null;
};

export type CustomerRoutineWorkspaceResponse = {
  trainingProfile: TrainingProfileRecord | null;
  nutritionContext: {
    birthDate: string | null;
    gender: "male" | "female" | "other" | null;
    weightKg: number | null;
    heightCm: number | null;
    bodyType: string | null;
    dietType: string | null;
    activityLevel: string | null;
  };
  trainingProfileStatus: "pending" | "complete";
  missingRequirements: string[];
  draftRoutine: RoutineRecord | null;
  activeRoutine: RoutineRecord | null;
  pendingRoutine: RoutineRecord | null;
  draftDetails: RoutineDetailRecord[];
  activeDetails: RoutineDetailRecord[];
  pendingDetails: RoutineDetailRecord[];
};

export type RoutineStatus = RoutineRecord["status"];
export type RoutineSource = RoutineRecord["source"];
export type RoutineBlockType = RoutineDetailRecord["block_type"];

export type CreateCustomerRoutineInput = {
  name: string;
  start_date?: string;
  end_date?: string | null;
  goal?: string | null;
  status?: RoutineStatus;
  source?: RoutineSource;
  training_profile_id?: string | null;
  primary_goal?: string | null;
  secondary_goal?: string | null;
  generation_version?: string | null;
};

export type GenerateCustomerRoutineInput = {
  status: "pending_profile" | "draft";
  name: string;
  goal: string | null;
  training_profile_id: string | null;
  primary_goal: string | null;
  secondary_goal: string | null;
  generation_version: string;
  details: CreateRoutineDetailInput[];
};

export type UpdateCustomerRoutineInput = Partial<CreateCustomerRoutineInput>;

export type CreateRoutineDetailInput = {
  day_of_week: number;
  exercise_id?: number | null;
  exercise_order?: number | null;
  block_type?: RoutineBlockType;
  sets?: number | null;
  reps?: string | null;
  rest_seconds?: number | null;
  duration_minutes?: number | null;
  target_rir?: number | null;
  notes?: string | null;
  exercise_name_snapshot?: string | null;
};

export type UpdateRoutineDetailInput = Partial<CreateRoutineDetailInput>;

export type CustomerRoutineMutationResponse = {
  customer_id: string;
  routine: RoutineRecord;
};

export type RoutineDetailMutationResponse = {
  customer_id: string;
  routine_id: string;
  detail: RoutineDetailRecord;
};
