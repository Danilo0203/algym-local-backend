import { z } from "zod";

import type {
  DashboardOverviewResponse,
  PaymentMethodDistribution,
} from "./dashboard.types.js";

const guatemalaDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/);

export const dashboardOverviewQuerySchema = z
  .object({
    from: guatemalaDateSchema.optional(),
    to: guatemalaDateSchema.optional(),
  })
  .superRefine((value, context) => {
    const hasFrom = value.from !== undefined;
    const hasTo = value.to !== undefined;

    if (hasFrom !== hasTo) {
      context.addIssue({
        code: "custom",
        path: hasFrom ? ["to"] : ["from"],
        message: "from y to deben enviarse juntos",
      });
    }

    if (
      value.from !== undefined &&
      value.to !== undefined &&
      value.from > value.to
    ) {
      context.addIssue({
        code: "custom",
        path: ["from"],
        message: "from no puede ser mayor que to",
      });
    }
  });

const dashboardKpisSchema = z.object({
  totalRevenue: z.number(),
  revenueChange: z.number(),
  activeMembers: z.number().int(),
  inactiveMembers: z.number().int(),
  churnRate: z.number(),
  avgTicket: z.number(),
  cashAmount: z.number(),
  cardAmount: z.number(),
  transferAmount: z.number(),
});

const revenueByMonthSchema = z.object({
  month: z.string(),
  revenue: z.number(),
});

const planDistributionSchema = z.object({
  name: z.string(),
  count: z.number().int(),
  percentage: z.number().int(),
  color: z.string(),
});

const recentPaymentSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  user_name: z.string(),
  avatar_url: z.string().nullable(),
  plan_name: z.string().nullable(),
  amount: z.number(),
  method: z.enum(["cash", "card", "transfer"]),
  date: z.string(),
});

const expiringSubscriptionSchema = z.object({
  user_id: z.string().uuid(),
  user_name: z.string(),
  avatar_url: z.string().nullable(),
  phone: z.string().nullable(),
  plan_name: z.string(),
  end_date: z.string(),
  days_left: z.number().int(),
});

const inactiveCustomerSchema = z.object({
  user_id: z.string().uuid(),
  user_name: z.string(),
  avatar_url: z.string().nullable(),
  phone: z.string().nullable(),
  last_plan: z.string(),
  expired_date: z.string(),
  days_inactive: z.number().int(),
});

const subscriptionsFlowSchema = z.object({
  month: z.string(),
  newSubs: z.number().int(),
  cancelled: z.number().int(),
});

const paymentMethodDistributionSchema = z.object({
  method: z.string(),
  amount: z.number(),
  count: z.number().int(),
  color: z.string(),
});

export const dashboardOverviewResponseSchema = z.object({
  kpis: dashboardKpisSchema,
  revenueByMonth: z.array(revenueByMonthSchema),
  planDistribution: z.array(planDistributionSchema),
  subscriptionsFlow: z.array(subscriptionsFlowSchema),
  paymentMethodDistribution: z.array(
    paymentMethodDistributionSchema,
  ),
  recentPayments: z.array(recentPaymentSchema),
  expiringSubscriptions: z.array(expiringSubscriptionSchema),
  inactiveCustomers: z.array(inactiveCustomerSchema),
}) satisfies z.ZodType<DashboardOverviewResponse>;

export const paymentMethodLabelMap: Record<
  "cash" | "card" | "transfer",
  PaymentMethodDistribution
> = {
  cash: {
    method: "Efectivo",
    amount: 0,
    count: 0,
    color: "var(--success)",
  },
  card: {
    method: "Tarjeta",
    amount: 0,
    count: 0,
    color: "var(--chart-1)",
  },
  transfer: {
    method: "Transferencia",
    amount: 0,
    count: 0,
    color: "var(--chart-4)",
  },
};
