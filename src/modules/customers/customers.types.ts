import type { CreateMembershipInput } from "../memberships/memberships.types.js";

export type CustomerGender = "male" | "female" | "other";

export type CustomerMembershipStatus =
  | "active"
  | "expiring"
  | "grace"
  | "expired"
  | "cancelled"
  | "none";

export type CustomerListQuery = {
  page: number;
  page_size: number;
  search?: string;
  sort: string;
  is_active?: boolean;
  plan_id?: number;
  membership_status?: CustomerMembershipStatus;
};

export type CustomerSidebarQuery = {
  search?: string;
  limit: number;
};

export type CustomerHistoryQuery = {
  attendance_limit: number;
  heatmap_days: number;
  memberships_page: number;
  memberships_page_size: number;
  payments_page: number;
  payments_page_size: number;
  assessments_page: number;
  assessments_page_size: number;
};

export type CustomerCreateInput = {
  full_name: string;
  phone: string;
  birth_date: string;
  gender: CustomerGender;
  email?: string;
  injuries?: string;
  medical_notes?: string;
  membership?: CreateMembershipInput;
};

export type CustomerUpdateInput = Partial<
  Omit<CustomerCreateInput, "email" | "membership">
>;

export type CustomerStatusUpdateInput = {
  is_active: boolean;
};

export type CustomerMembershipSummary = {
  plan_id: number | null;
  plan_name: string | null;
  status: string | null;
  display_status: CustomerMembershipStatus;
  start_date: string | null;
  end_date: string | null;
  grace_days: number | null;
  access_until: string | null;
};

export type CustomerListItem = {
  id: string;
  email: string | null;
  full_name: string;
  phone: string;
  avatar_url: string | null;
  birth_date: string;
  gender: CustomerGender;
  biometric_id: number;
  is_active: boolean;
  membership_status: CustomerMembershipStatus;
  last_check_in: string | null;
  created_at: string | null;
  updated_at: string | null;
  current_membership: CustomerMembershipSummary | null;
};

export type CustomerDetail = CustomerListItem & {
  role: string;
  injuries: string | null;
  medical_notes: string | null;
  account: {
    email: string | null;
    has_password: boolean;
    login_enabled: boolean;
  };
  capabilities: {
    update_customer: boolean;
    manage_membership: boolean;
    view_payments: boolean;
  };
};

export type CustomersListResponse = {
  data: CustomerListItem[];
  meta: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
};

export type CustomerSidebarResponse = {
  data: Array<{
    id: string;
    full_name: string;
    avatar_url: string | null;
    biometric_id: number;
    is_active: boolean;
    membership_status: CustomerMembershipStatus;
    plan_name: string | null;
  }>;
};

export type PaginationMeta = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type CustomerMembershipHistoryItem = {
  id: string;
  plan_id: number;
  plan_name: string | null;
  start_date: string;
  end_date: string;
  grace_days: number;
  access_until: string;
  status: string;
  price: number;
  discount_amount: number;
  created_at: string;
};

export type CustomerPaymentHistoryItem = {
  id: string;
  subscription_id: string | null;
  payment_date: string;
  amount_original: number;
  discount_amount: number;
  amount_paid: number;
  method: string | null;
  plan_name: string | null;
};

export type CustomerAttendanceHistoryItem = {
  id: string;
  check_in_time: string;
  status: "authorized" | "denied";
};

export type CustomerAssessmentHistoryItem = {
  id: string;
  assessment_date: string;
  weight_kg: number | null;
  height_cm: number | null;
  body_fat_percentage: number | null;
  muscle_mass_kg: number | null;
  body_type: string | null;
  activity_level: string | null;
  water_liters_goal: number | null;
  daily_calories: number | null;
  protein_grams: number | null;
  carbs_grams: number | null;
  fat_grams: number | null;
  chest: number | null;
  waist: number | null;
  hip: number | null;
  arm_right: number | null;
  arm_left: number | null;
  leg_right: number | null;
  leg_left: number | null;
  diet_type: string | null;
};

export type CustomerHistoryResponse = {
  customer_id: string;
  memberships: {
    data: CustomerMembershipHistoryItem[];
    meta: PaginationMeta;
  };
  payments: {
    data: CustomerPaymentHistoryItem[];
    meta: PaginationMeta;
  } | null;
  attendance: {
    data: CustomerAttendanceHistoryItem[];
    limit: number;
    total: number;
  };
  heatmap: {
    timezone: "America/Guatemala";
    days: number;
    from: string;
    to: string;
    data: Array<{ date: string; count: number }>;
  };
  assessments: {
    data: CustomerAssessmentHistoryItem[];
    meta: PaginationMeta;
  };
  kpis: {
    member_since: string | null;
    total_visits: number;
    total_spent: number | null;
    initial_weight: number | null;
    current_weight: number | null;
    weight_change: number | null;
  };
};
