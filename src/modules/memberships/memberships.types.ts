export interface MembershipSummary {
  id: string;
  plan_id: number;
  plan_name: string;
  start_date: string;
  end_date: string;
  grace_days: number;
  access_until: string;
  status: string;
  display_status:
    | "active"
    | "expiring"
    | "grace"
    | "expired"
    | "cancelled"
    | "none";
  cycles: number;
  price: number;
  created_at: string;
}

export interface CustomerMembershipResponse {
  customer_id: string;
  current_membership: MembershipSummary | null;
}

export interface CreateMembershipInput {
  plan_id: number;
  cycles: number;
  start_date?: string;
}

export interface RenewMembershipInput {
  plan_id: number;
  cycles: number;
  start_date?: string;
}

export interface MembershipResponse {
  customer_id: string;
  membership: MembershipSummary;
}

export interface RenewMembershipResponse extends MembershipResponse {
  previous_membership_id?: string;
}

export interface CancelMembershipInput {
  status: "cancelled";
}
