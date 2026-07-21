export interface Plan {
  id: number;
  name: string;
  description: string | null;
  price: number;
  duration_days: number;
  is_active: boolean;
}

export interface PlansListResponse {
  data: Plan[];
}
