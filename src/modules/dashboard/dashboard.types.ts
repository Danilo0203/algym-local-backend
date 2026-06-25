export type DashboardKPIs = {
  totalRevenue: number;
  revenueChange: number;
  activeMembers: number;
  inactiveMembers: number;
  churnRate: number;
  avgTicket: number;
  cashAmount: number;
  cardAmount: number;
  transferAmount: number;
};

export type RevenueByMonth = {
  month: string;
  revenue: number;
};

export type PlanDistribution = {
  name: string;
  count: number;
  percentage: number;
  color: string;
};

export type RecentPayment = {
  id: string;
  user_id: string;
  user_name: string;
  avatar_url: string | null;
  plan_name: string | null;
  amount: number;
  method: "cash" | "card" | "transfer";
  date: string;
};

export type ExpiringSubscription = {
  user_id: string;
  user_name: string;
  avatar_url: string | null;
  phone: string | null;
  plan_name: string;
  end_date: string;
  days_left: number;
};

export type InactiveCustomer = {
  user_id: string;
  user_name: string;
  avatar_url: string | null;
  phone: string | null;
  last_plan: string;
  expired_date: string;
  days_inactive: number;
};

export type SubscriptionsFlow = {
  month: string;
  newSubs: number;
  cancelled: number;
};

export type PaymentMethodDistribution = {
  method: string;
  amount: number;
  count: number;
  color: string;
};

export type DashboardOverviewResponse = {
  kpis: DashboardKPIs;
  revenueByMonth: RevenueByMonth[];
  planDistribution: PlanDistribution[];
  subscriptionsFlow: SubscriptionsFlow[];
  paymentMethodDistribution: PaymentMethodDistribution[];
  recentPayments: RecentPayment[];
  expiringSubscriptions: ExpiringSubscription[];
  inactiveCustomers: InactiveCustomer[];
};

export type DashboardOverviewQuery = {
  from?: string;
  to?: string;
};
