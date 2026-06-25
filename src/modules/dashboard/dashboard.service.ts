import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import {
  dashboardOverviewResponseSchema,
  paymentMethodLabelMap,
} from "./dashboard.schemas.js";
import type {
  DashboardOverviewQuery,
  DashboardOverviewResponse,
  PaymentMethodDistribution,
  PlanDistribution,
  RevenueByMonth,
  SubscriptionsFlow,
} from "./dashboard.types.js";

type DashboardAuthorizationRow = {
  role_slug: string | null;
  permissions: string[] | null;
  is_owner: boolean;
};

type DashboardRevenueSummaryRow = {
  current_revenue: string | null;
  previous_revenue: string | null;
  current_payments_count: string | null;
  cash_amount: string | null;
  card_amount: string | null;
  transfer_amount: string | null;
};

type DashboardMembershipSummaryRow = {
  active_members: string | null;
  inactive_members: string | null;
  churned_members: string | null;
};

type MonthlyRevenueRow = {
  month_key: string;
  revenue: string | null;
};

type PlanDistributionRow = {
  plan_name: string;
  count: string | null;
};

type SubscriptionFlowRow = {
  month_key: string;
  new_subs: string | null;
  cancelled: string | null;
};

type PaymentMethodDistributionRow = {
  method: "cash" | "card" | "transfer";
  amount: string | null;
  count: string | null;
};

type RecentPaymentRow = {
  id: string;
  user_id: string;
  user_name: string | null;
  avatar_url: string | null;
  plan_name: string | null;
  amount: string | null;
  method: "cash" | "card" | "transfer";
  date: Date;
};

type ExpiringSubscriptionRow = {
  user_id: string;
  user_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  plan_name: string | null;
  end_date: string;
  days_left: string | null;
};

type InactiveCustomerRow = {
  user_id: string;
  user_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  last_plan: string | null;
  expired_date: string;
  days_inactive: string | null;
};

const guatemalaTimeZone = "America/Guatemala";
const dashboardViewPermission = "dashboard.view";
const monthLabelFormatter = new Intl.DateTimeFormat("es-GT", {
  month: "short",
});

const forbiddenDashboardError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para consultar el dashboard",
);

function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function parseNumeric(value: string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }

  return Number(value);
}

function parseInteger(value: string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }

  return Number.parseInt(value, 10);
}

function computeRevenueChange(
  currentRevenue: number,
  previousRevenue: number,
): number {
  if (currentRevenue === 0 && previousRevenue === 0) {
    return 0;
  }

  if (previousRevenue === 0 && currentRevenue > 0) {
    return 100;
  }

  if (currentRevenue === 0 && previousRevenue > 0) {
    return -100;
  }

  return roundTo(
    ((currentRevenue - previousRevenue) / previousRevenue) * 100,
    1,
  );
}

function computeChurnRate(
  activeMembers: number,
  churnedThisPeriod: number,
): number {
  const totalMembers = activeMembers + churnedThisPeriod;

  if (totalMembers === 0) {
    return 0;
  }

  return roundTo((churnedThisPeriod / totalMembers) * 100, 1);
}

function buildMonthKeys(anchorDate: string): string[] {
  const [yearValue, monthValue] = anchorDate.split("-", 2);
  const year = Number.parseInt(yearValue ?? "", 10);
  const month = Number.parseInt(monthValue ?? "", 10);
  const monthKeys: string[] = [];

  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(year, month - 1 - offset, 15));
    const currentYear = date.getUTCFullYear();
    const currentMonth = String(date.getUTCMonth() + 1).padStart(
      2,
      "0",
    );
    monthKeys.push(`${currentYear}-${currentMonth}`);
  }

  return monthKeys;
}

function formatMonthLabel(monthKey: string): string {
  const [yearValue, monthValue] = monthKey.split("-", 2);
  const year = Number.parseInt(yearValue ?? "", 10);
  const month = Number.parseInt(monthValue ?? "", 10);

  return monthLabelFormatter.format(
    new Date(Date.UTC(year, month - 1, 15, 12)),
  );
}

async function getAuthorization(
  client: PoolClient,
): Promise<DashboardAuthorizationRow> {
  const result = await client.query<DashboardAuthorizationRow>(
    `
      SELECT
        public.get_current_role_slug() AS role_slug,
        public.get_current_permissions() AS permissions,
        public.is_owner() AS is_owner
    `,
  );

  return (
    result.rows[0] ?? {
      role_slug: null,
      permissions: null,
      is_owner: false,
    }
  );
}

function assertDashboardAccess(
  authorization: DashboardAuthorizationRow,
): void {
  const permissions = authorization.permissions ?? [];

  if (
    authorization.is_owner ||
    permissions.includes(dashboardViewPermission)
  ) {
    return;
  }

  throw forbiddenDashboardError;
}

async function getCurrentDateRange(
  client: PoolClient,
  query: DashboardOverviewQuery,
): Promise<{
  fromDate: string;
  toDate: string;
}> {
  if (query.from && query.to) {
    return {
      fromDate: query.from,
      toDate: query.to,
    };
  }

  const result = await client.query<{
    from_date: string;
    to_date: string;
  }>(
    `
      SELECT
        to_char(
          date_trunc(
            'month',
            now() AT TIME ZONE '${guatemalaTimeZone}'
          )::date,
          'YYYY-MM-DD'
        ) AS from_date,
        to_char(
          (
            date_trunc(
              'month',
              now() AT TIME ZONE '${guatemalaTimeZone}'
            )::date
            + INTERVAL '1 month'
            - INTERVAL '1 day'
          )::date,
          'YYYY-MM-DD'
        ) AS to_date
    `,
  );

  const range = result.rows[0];

  if (!range) {
    throw new AppError(
      500,
      "DASHBOARD_RANGE_FAILED",
      "No se pudo determinar el rango del dashboard",
    );
  }

  return {
    fromDate: range.from_date,
    toDate: range.to_date,
  };
}

async function getRevenueSummary(
  client: PoolClient,
  fromDate: string,
  toDate: string,
): Promise<DashboardRevenueSummaryRow> {
  const result = await client.query<DashboardRevenueSummaryRow>(
    `
      WITH current_period AS (
        SELECT
          $1::date AS from_date,
          $2::date AS to_date,
          ($1::date::timestamp AT TIME ZONE '${guatemalaTimeZone}') AS from_ts,
          ((($2::date + 1)::timestamp) AT TIME ZONE '${guatemalaTimeZone}') AS to_ts_exclusive
      ),
      previous_period AS (
        SELECT
          (
            current_period.from_date
            - ((current_period.to_date - current_period.from_date) + 1)
          )::date AS from_date,
          (current_period.from_date - 1)::date AS to_date,
          (
            (
              current_period.from_date
              - ((current_period.to_date - current_period.from_date) + 1)
            )::date::timestamp AT TIME ZONE '${guatemalaTimeZone}'
          ) AS from_ts,
          (
            (
              current_period.from_date
            )::date::timestamp AT TIME ZONE '${guatemalaTimeZone}'
          ) AS to_ts_exclusive
        FROM current_period
      )
      SELECT
        COALESCE((
          SELECT sum(p.amount_paid)::text
          FROM public.payments AS p
          CROSS JOIN current_period
          WHERE p.status = 'posted'
            AND p.payment_date >= current_period.from_ts
            AND p.payment_date < current_period.to_ts_exclusive
        ), '0') AS current_revenue,
        COALESCE((
          SELECT sum(p.amount_paid)::text
          FROM public.payments AS p
          CROSS JOIN previous_period
          WHERE p.status = 'posted'
            AND p.payment_date >= previous_period.from_ts
            AND p.payment_date < previous_period.to_ts_exclusive
        ), '0') AS previous_revenue,
        COALESCE((
          SELECT count(*)::text
          FROM public.payments AS p
          CROSS JOIN current_period
          WHERE p.status = 'posted'
            AND p.payment_date >= current_period.from_ts
            AND p.payment_date < current_period.to_ts_exclusive
        ), '0') AS current_payments_count,
        COALESCE((
          SELECT sum(p.amount_paid)::text
          FROM public.payments AS p
          CROSS JOIN current_period
          WHERE p.status = 'posted'
            AND p.method = 'cash'
            AND p.payment_date >= current_period.from_ts
            AND p.payment_date < current_period.to_ts_exclusive
        ), '0') AS cash_amount,
        COALESCE((
          SELECT sum(p.amount_paid)::text
          FROM public.payments AS p
          CROSS JOIN current_period
          WHERE p.status = 'posted'
            AND p.method = 'card'
            AND p.payment_date >= current_period.from_ts
            AND p.payment_date < current_period.to_ts_exclusive
        ), '0') AS card_amount,
        COALESCE((
          SELECT sum(p.amount_paid)::text
          FROM public.payments AS p
          CROSS JOIN current_period
          WHERE p.status = 'posted'
            AND p.method = 'transfer'
            AND p.payment_date >= current_period.from_ts
            AND p.payment_date < current_period.to_ts_exclusive
        ), '0') AS transfer_amount
    `,
    [fromDate, toDate],
  );

  return result.rows[0] ?? {
    current_revenue: "0",
    previous_revenue: "0",
    current_payments_count: "0",
    cash_amount: "0",
    card_amount: "0",
    transfer_amount: "0",
  };
}

async function getMembershipSummary(
  client: PoolClient,
  fromDate: string,
  toDate: string,
): Promise<DashboardMembershipSummaryRow> {
  const result = await client.query<DashboardMembershipSummaryRow>(
    `
      WITH active_users AS (
        SELECT DISTINCT s.user_id
        FROM public.subscriptions AS s
        WHERE s.status = 'active'
      ),
      all_users AS (
        SELECT DISTINCT s.user_id
        FROM public.subscriptions AS s
      ),
      churned_users AS (
        SELECT DISTINCT s.user_id
        FROM public.subscriptions AS s
        WHERE s.status IN ('expired', 'cancelled')
          AND s.end_date >= $1::date
          AND s.end_date <= $2::date
          AND NOT EXISTS (
            SELECT 1
            FROM public.subscriptions AS active_check
            WHERE active_check.user_id = s.user_id
              AND active_check.status = 'active'
          )
      )
      SELECT
        (SELECT count(*)::text FROM active_users) AS active_members,
        (
          SELECT count(*)::text
          FROM all_users AS all_u
          WHERE NOT EXISTS (
            SELECT 1
            FROM active_users AS active_u
            WHERE active_u.user_id = all_u.user_id
          )
        ) AS inactive_members,
        (SELECT count(*)::text FROM churned_users) AS churned_members
    `,
    [fromDate, toDate],
  );

  return result.rows[0] ?? {
    active_members: "0",
    inactive_members: "0",
    churned_members: "0",
  };
}

async function getRevenueByMonthRows(
  client: PoolClient,
  anchorToDate: string,
): Promise<MonthlyRevenueRow[]> {
  const result = await client.query<MonthlyRevenueRow>(
    `
      WITH months AS (
        SELECT
          generate_series(
            date_trunc('month', $1::date) - INTERVAL '5 months',
            date_trunc('month', $1::date),
            INTERVAL '1 month'
          ) AS month_start
      ),
      monthly_revenue AS (
        SELECT
          to_char(
            date_trunc(
              'month',
              p.payment_date AT TIME ZONE '${guatemalaTimeZone}'
            ),
            'YYYY-MM'
          ) AS month_key,
          sum(p.amount_paid)::text AS revenue
        FROM public.payments AS p
        WHERE p.status = 'posted'
          AND (
            p.payment_date AT TIME ZONE '${guatemalaTimeZone}'
          ) >= date_trunc('month', $1::date) - INTERVAL '5 months'
          AND (
            p.payment_date AT TIME ZONE '${guatemalaTimeZone}'
          ) < date_trunc('month', $1::date) + INTERVAL '1 month'
        GROUP BY 1
      )
      SELECT
        to_char(months.month_start, 'YYYY-MM') AS month_key,
        COALESCE(monthly_revenue.revenue, '0') AS revenue
      FROM months
      LEFT JOIN monthly_revenue
        ON monthly_revenue.month_key = to_char(months.month_start, 'YYYY-MM')
      ORDER BY months.month_start ASC
    `,
    [anchorToDate],
  );

  return result.rows;
}

async function getPlanDistributionRows(
  client: PoolClient,
): Promise<PlanDistributionRow[]> {
  const result = await client.query<PlanDistributionRow>(
    `
      SELECT
        pl.name AS plan_name,
        count(*)::text AS count
      FROM public.subscriptions AS s
      INNER JOIN public.plans AS pl
        ON pl.id = s.plan_id
      WHERE s.status = 'active'
      GROUP BY pl.name
      ORDER BY count(*) DESC, pl.name ASC
    `,
  );

  return result.rows;
}

async function getSubscriptionsFlowRows(
  client: PoolClient,
  anchorToDate: string,
): Promise<SubscriptionFlowRow[]> {
  const result = await client.query<SubscriptionFlowRow>(
    `
      WITH months AS (
        SELECT
          generate_series(
            date_trunc('month', $1::date) - INTERVAL '5 months',
            date_trunc('month', $1::date),
            INTERVAL '1 month'
          ) AS month_start
      ),
      created_subscriptions AS (
        SELECT
          to_char(
            date_trunc(
              'month',
              s.created_at AT TIME ZONE '${guatemalaTimeZone}'
            ),
            'YYYY-MM'
          ) AS month_key,
          count(*)::text AS new_subs
        FROM public.subscriptions AS s
        WHERE (
          s.created_at AT TIME ZONE '${guatemalaTimeZone}'
        ) >= date_trunc('month', $1::date) - INTERVAL '5 months'
          AND (
            s.created_at AT TIME ZONE '${guatemalaTimeZone}'
          ) < date_trunc('month', $1::date) + INTERVAL '1 month'
        GROUP BY 1
      ),
      cancelled_subscriptions AS (
        SELECT
          to_char(
            date_trunc('month', s.end_date::timestamp),
            'YYYY-MM'
          ) AS month_key,
          count(*)::text AS cancelled
        FROM public.subscriptions AS s
        WHERE s.status IN ('expired', 'cancelled')
          AND s.end_date >= (
            date_trunc('month', $1::date) - INTERVAL '5 months'
          )::date
          AND s.end_date < (
            date_trunc('month', $1::date) + INTERVAL '1 month'
          )::date
        GROUP BY 1
      )
      SELECT
        to_char(months.month_start, 'YYYY-MM') AS month_key,
        COALESCE(created_subscriptions.new_subs, '0') AS new_subs,
        COALESCE(cancelled_subscriptions.cancelled, '0') AS cancelled
      FROM months
      LEFT JOIN created_subscriptions
        ON created_subscriptions.month_key = to_char(months.month_start, 'YYYY-MM')
      LEFT JOIN cancelled_subscriptions
        ON cancelled_subscriptions.month_key = to_char(months.month_start, 'YYYY-MM')
      ORDER BY months.month_start ASC
    `,
    [anchorToDate],
  );

  return result.rows;
}

async function getPaymentMethodDistributionRows(
  client: PoolClient,
  fromDate: string,
  toDate: string,
): Promise<PaymentMethodDistributionRow[]> {
  const result = await client.query<PaymentMethodDistributionRow>(
    `
      SELECT
        p.method,
        COALESCE(sum(p.amount_paid)::text, '0') AS amount,
        count(*)::text AS count
      FROM public.payments AS p
      WHERE p.status = 'posted'
        AND p.payment_date >= ($1::date::timestamp AT TIME ZONE '${guatemalaTimeZone}')
        AND p.payment_date < ((($2::date + 1)::timestamp) AT TIME ZONE '${guatemalaTimeZone}')
      GROUP BY p.method
      ORDER BY
        CASE p.method
          WHEN 'cash' THEN 1
          WHEN 'card' THEN 2
          WHEN 'transfer' THEN 3
          ELSE 4
        END
    `,
    [fromDate, toDate],
  );

  return result.rows;
}

async function getRecentPaymentsRows(
  client: PoolClient,
): Promise<RecentPaymentRow[]> {
  const result = await client.query<RecentPaymentRow>(
    `
      SELECT
        p.id::text AS id,
        p.user_id,
        COALESCE(p.user_name, 'Usuario') AS user_name,
        p.avatar_url,
        p.plan_name,
        p.amount_paid::text AS amount,
        p.method,
        p.payment_date AS date
      FROM public.payments_overview AS p
      ORDER BY p.payment_date DESC, p.id DESC
      LIMIT 10
    `,
  );

  return result.rows;
}

async function getExpiringSubscriptionsRows(
  client: PoolClient,
): Promise<ExpiringSubscriptionRow[]> {
  const result = await client.query<ExpiringSubscriptionRow>(
    `
      WITH current_day AS (
        SELECT (now() AT TIME ZONE '${guatemalaTimeZone}')::date AS today
      )
      SELECT
        s.user_id,
        COALESCE(p.full_name, 'Usuario') AS user_name,
        p.avatar_url,
        p.phone,
        COALESCE(pl.name, 'Plan') AS plan_name,
        to_char(s.end_date, 'YYYY-MM-DD') AS end_date,
        (s.end_date - current_day.today)::text AS days_left
      FROM public.subscriptions AS s
      INNER JOIN public.profiles AS p
        ON p.id = s.user_id
      INNER JOIN public.plans AS pl
        ON pl.id = s.plan_id
      CROSS JOIN current_day
      WHERE s.status = 'active'
        AND s.end_date >= current_day.today
        AND s.end_date <= current_day.today + 5
      ORDER BY s.end_date ASC, s.user_id ASC
    `,
  );

  return result.rows;
}

async function getInactiveCustomersRows(
  client: PoolClient,
): Promise<InactiveCustomerRow[]> {
  const result = await client.query<InactiveCustomerRow>(
    `
      WITH current_day AS (
        SELECT (now() AT TIME ZONE '${guatemalaTimeZone}')::date AS today
      ),
      latest_inactive AS (
        SELECT DISTINCT ON (s.user_id)
          s.user_id,
          COALESCE(p.full_name, 'Usuario') AS user_name,
          p.avatar_url,
          p.phone,
          COALESCE(pl.name, 'Plan') AS last_plan,
          s.end_date,
          (current_day.today - s.end_date)::text AS days_inactive
        FROM public.subscriptions AS s
        INNER JOIN public.profiles AS p
          ON p.id = s.user_id
        INNER JOIN public.plans AS pl
          ON pl.id = s.plan_id
        CROSS JOIN current_day
        WHERE s.status IN ('expired', 'cancelled')
          AND NOT EXISTS (
            SELECT 1
            FROM public.subscriptions AS active_check
            WHERE active_check.user_id = s.user_id
              AND active_check.status = 'active'
          )
        ORDER BY s.user_id ASC, s.end_date DESC, s.user_id ASC
      )
      SELECT
        latest_inactive.user_id,
        latest_inactive.user_name,
        latest_inactive.avatar_url,
        latest_inactive.phone,
        latest_inactive.last_plan,
        to_char(latest_inactive.end_date, 'YYYY-MM-DD') AS expired_date,
        latest_inactive.days_inactive
      FROM latest_inactive
      ORDER BY latest_inactive.end_date DESC, latest_inactive.user_id ASC
      LIMIT 10
    `,
  );

  return result.rows;
}

function buildRevenueByMonth(
  rows: MonthlyRevenueRow[],
  toDate: string,
): RevenueByMonth[] {
  const byMonthKey = new Map(
    rows.map((row) => [row.month_key, parseNumeric(row.revenue)]),
  );

  return buildMonthKeys(toDate).map((monthKey) => ({
    month: formatMonthLabel(monthKey),
    revenue: roundTo(byMonthKey.get(monthKey) ?? 0, 2),
  }));
}

function buildPlanDistribution(
  rows: PlanDistributionRow[],
): PlanDistribution[] {
  if (rows.length === 0) {
    return [];
  }

  const total = rows.reduce(
    (sum, row) => sum + parseInteger(row.count),
    0,
  );
  const colors = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
  ];

  return rows.map((row, index) => {
    const count = parseInteger(row.count);

    return {
      name: row.plan_name,
      count,
      percentage:
        total > 0 ? Math.round((count / total) * 100) : 0,
      color: colors[index % colors.length] ?? "var(--chart-1)",
    };
  });
}

function buildSubscriptionsFlow(
  rows: SubscriptionFlowRow[],
  toDate: string,
): SubscriptionsFlow[] {
  const byMonthKey = new Map(
    rows.map((row) => [
      row.month_key,
      {
        newSubs: parseInteger(row.new_subs),
        cancelled: parseInteger(row.cancelled),
      },
    ]),
  );

  return buildMonthKeys(toDate).map((monthKey) => ({
    month: formatMonthLabel(monthKey),
    newSubs: byMonthKey.get(monthKey)?.newSubs ?? 0,
    cancelled: byMonthKey.get(monthKey)?.cancelled ?? 0,
  }));
}

function buildPaymentMethodDistribution(
  rows: PaymentMethodDistributionRow[],
): PaymentMethodDistribution[] {
  return rows
    .map((row) => {
      const configuration = paymentMethodLabelMap[row.method];

      return {
        method: configuration.method,
        amount: roundTo(parseNumeric(row.amount), 2),
        count: parseInteger(row.count),
        color: configuration.color,
      };
    })
    .filter((row) => row.count > 0);
}

export async function getDashboardOverview(
  userId: string,
  query: DashboardOverviewQuery,
): Promise<DashboardOverviewResponse> {
  return withUserTransaction(userId, async (client) => {
    const authorization = await getAuthorization(client);
    assertDashboardAccess(authorization);

    const { fromDate, toDate } = await getCurrentDateRange(
      client,
      query,
    );
    const revenueSummary = await getRevenueSummary(
      client,
      fromDate,
      toDate,
    );
    const membershipSummary = await getMembershipSummary(
      client,
      fromDate,
      toDate,
    );
    const revenueByMonthRows = await getRevenueByMonthRows(
      client,
      toDate,
    );
    const planDistributionRows = await getPlanDistributionRows(client);
    const subscriptionsFlowRows = await getSubscriptionsFlowRows(
      client,
      toDate,
    );
    const paymentMethodDistributionRows =
      await getPaymentMethodDistributionRows(
        client,
        fromDate,
        toDate,
      );
    const recentPaymentsRows = await getRecentPaymentsRows(client);
    const expiringSubscriptionsRows =
      await getExpiringSubscriptionsRows(client);
    const inactiveCustomersRows = await getInactiveCustomersRows(
      client,
    );

    const currentRevenue = roundTo(
      parseNumeric(revenueSummary.current_revenue),
      2,
    );
    const previousRevenue = roundTo(
      parseNumeric(revenueSummary.previous_revenue),
      2,
    );
    const currentPaymentsCount = parseInteger(
      revenueSummary.current_payments_count,
    );
    const activeMembers = parseInteger(
      membershipSummary.active_members,
    );
    const inactiveMembers = parseInteger(
      membershipSummary.inactive_members,
    );
    const churnedMembers = parseInteger(
      membershipSummary.churned_members,
    );

    return dashboardOverviewResponseSchema.parse({
      kpis: {
        totalRevenue: currentRevenue,
        revenueChange: computeRevenueChange(
          currentRevenue,
          previousRevenue,
        ),
        activeMembers,
        inactiveMembers,
        churnRate: computeChurnRate(activeMembers, churnedMembers),
        avgTicket:
          currentPaymentsCount > 0
            ? roundTo(currentRevenue / currentPaymentsCount, 2)
            : 0,
        cashAmount: roundTo(
          parseNumeric(revenueSummary.cash_amount),
          2,
        ),
        cardAmount: roundTo(
          parseNumeric(revenueSummary.card_amount),
          2,
        ),
        transferAmount: roundTo(
          parseNumeric(revenueSummary.transfer_amount),
          2,
        ),
      },
      revenueByMonth: buildRevenueByMonth(
        revenueByMonthRows,
        toDate,
      ),
      planDistribution: buildPlanDistribution(planDistributionRows),
      subscriptionsFlow: buildSubscriptionsFlow(
        subscriptionsFlowRows,
        toDate,
      ),
      paymentMethodDistribution: buildPaymentMethodDistribution(
        paymentMethodDistributionRows,
      ),
      recentPayments: recentPaymentsRows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        user_name: row.user_name ?? "Usuario",
        avatar_url: row.avatar_url,
        plan_name: row.plan_name,
        amount: roundTo(parseNumeric(row.amount), 2),
        method: row.method,
        date: row.date.toISOString(),
      })),
      expiringSubscriptions: expiringSubscriptionsRows.map((row) => ({
        user_id: row.user_id,
        user_name: row.user_name ?? "Usuario",
        avatar_url: row.avatar_url,
        phone: row.phone,
        plan_name: row.plan_name ?? "Plan",
        end_date: row.end_date,
        days_left: parseInteger(row.days_left),
      })),
      inactiveCustomers: inactiveCustomersRows.map((row) => ({
        user_id: row.user_id,
        user_name: row.user_name ?? "Usuario",
        avatar_url: row.avatar_url,
        phone: row.phone,
        last_plan: row.last_plan ?? "Plan",
        expired_date: row.expired_date,
        days_inactive: parseInteger(row.days_inactive),
      })),
    });
  });
}
