export type CustomerGender = "male" | "female" | "other";

export type CustomerListQuery = {
  page: number;
  page_size: number;
  search?: string;
  sort: string;
};

export type CustomerCreateInput = {
  full_name: string;
  phone: string;
  birth_date: string;
  gender: CustomerGender;
  email?: string;
  injuries?: string;
  medical_notes?: string;
};

export type CustomerUpdateInput = Partial<
  Omit<CustomerCreateInput, "email">
>;

export type CustomerStatusUpdateInput = {
  is_active: boolean;
};

export type CustomerMembershipSummary = {
  plan_name: string | null;
  status: string | null;
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
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  current_membership: CustomerMembershipSummary | null;
};

export type CustomerDetail = CustomerListItem & {
  role: string;
  injuries: string | null;
  medical_notes: string | null;
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
