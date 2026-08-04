import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import {
  mapBodyAssessmentRow,
} from "./customers-health.service.js";
import type {
  BodyAssessmentRow,
} from "./customers-health.service.js";
import { customerHistoryQuerySchema } from "./customers.schemas.js";
import type {
  CustomerHistoryResponse,
  PaginationMeta,
} from "./customers.types.js";

const accessTimeZone = "America/Guatemala" as const;

type AuthorizationRow = {
  permissions: string[] | null;
  is_owner: boolean;
};

type CustomerRow = {
  id: string;
  biometric_id: number;
};

type AttendanceRow = {
  id: string;
  check_in_time: Date;
  status: "authorized" | "denied";
  total_count: string;
};

type HeatmapRow = {
  local_date: string;
  visit_count: string;
  from_date: string;
  to_date: string;
};

type MembershipRow = {
  id: string;
  plan_id: string;
  plan_name: string | null;
  start_date: string;
  end_date: string;
  grace_days: number;
  access_until: string;
  status: string;
  price: string;
  discount_amount: string;
  created_at: Date;
  total_count: string;
};

type PaymentRow = {
  id: string;
  subscription_id: string | null;
  payment_date: Date;
  amount_original: string;
  discount_amount: string | null;
  amount_paid: string;
  method: string | null;
  plan_name: string | null;
  total_count: string;
};

type KpiRow = {
  member_since: string | null;
  total_visits: string;
  initial_weight: string | null;
  current_weight: string | null;
};

type TotalRow = {
  total: string;
};

const forbiddenError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para consultar el historial del cliente",
);

const customerNotFoundError = new AppError(
  404,
  "CUSTOMER_NOT_FOUND",
  "Cliente no encontrado",
);

function hasPermission(
  authorization: AuthorizationRow,
  permission: string,
): boolean {
  return authorization.is_owner ||
    (authorization.permissions ?? []).includes(permission);
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function paginationMeta(
  page: number,
  pageSize: number,
  total: number,
): PaginationMeta {
  return {
    page,
    page_size: pageSize,
    total,
    total_pages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

function totalFromRows(rows: Array<{ total_count: string }>): number {
  return Number.parseInt(rows[0]?.total_count ?? "0", 10);
}

async function getAuthorization(client: PoolClient): Promise<AuthorizationRow> {
  const result = await client.query<AuthorizationRow>(`
    SELECT
      public.get_current_permissions() AS permissions,
      public.is_owner() AS is_owner
  `);
  return result.rows[0] ?? { permissions: [], is_owner: false };
}

async function getCustomer(
  client: PoolClient,
  customerId: string,
): Promise<CustomerRow> {
  const result = await client.query<CustomerRow>(
    `
      SELECT profiles.id, profiles.biometric_id
      FROM public.profiles
      INNER JOIN auth.users ON users.id = profiles.id
      WHERE profiles.id = $1
        AND profiles.role = 'client'
        AND users.deleted_at IS NULL
      LIMIT 1
    `,
    [customerId],
  );
  const customer = result.rows[0];
  if (!customer) throw customerNotFoundError;
  return customer;
}

export async function getCustomerHistory(
  actorUserId: string,
  customerId: string,
  query: unknown,
): Promise<CustomerHistoryResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await getAuthorization(client);
    if (!hasPermission(authorization, "customers.view")) throw forbiddenError;

    const input = customerHistoryQuerySchema.parse(query);
    const customer = await getCustomer(client, customerId);
    const attendanceResult = await client.query<AttendanceRow>(
      `
        SELECT
          attendance.id::text,
          attendance.punch_time AS check_in_time,
          CASE
            WHEN NOT (
              lower(coalesce(attendance.raw_line, '')) LIKE '%pin=%'
              AND lower(coalesce(attendance.raw_line, '')) LIKE '%event=%'
            ) OR attendance.status1 IS NULL OR attendance.status1 = 0
              THEN 'authorized'
            ELSE 'denied'
          END AS status,
          count(*) OVER()::text AS total_count
        FROM public.attendance_logs AS attendance
        WHERE attendance.biometric_id = $1
        ORDER BY attendance.punch_time DESC, attendance.id DESC
        LIMIT $2
      `,
      [customer.biometric_id, input.attendance_limit],
    );

    const heatmapResult = await client.query<HeatmapRow>(
      `
        WITH bounds AS (
          SELECT
            (CURRENT_DATE - ($2::integer - 1))::date AS from_date,
            CURRENT_DATE::date AS to_date
        ), visits AS (
          SELECT (attendance.punch_time AT TIME ZONE $1)::date AS local_date
          FROM public.attendance_logs AS attendance
          CROSS JOIN bounds
          WHERE attendance.biometric_id = $3
            AND attendance.punch_time >= bounds.from_date::timestamp AT TIME ZONE $1
            AND attendance.punch_time < (bounds.to_date + 1)::timestamp AT TIME ZONE $1
            AND (
              NOT (
                lower(coalesce(attendance.raw_line, '')) LIKE '%pin=%'
                AND lower(coalesce(attendance.raw_line, '')) LIKE '%event=%'
              )
              OR attendance.status1 IS NULL
              OR attendance.status1 = 0
            )
        )
        SELECT
          to_char(visits.local_date, 'YYYY-MM-DD') AS local_date,
          count(*)::text AS visit_count,
          to_char(bounds.from_date, 'YYYY-MM-DD') AS from_date,
          to_char(bounds.to_date, 'YYYY-MM-DD') AS to_date
        FROM bounds
        LEFT JOIN visits ON true
        GROUP BY bounds.from_date, bounds.to_date, visits.local_date
        ORDER BY visits.local_date
      `,
      [accessTimeZone, input.heatmap_days, customer.biometric_id],
    );

    const membershipsResult = await client.query<MembershipRow>(
      `
        SELECT
          subscriptions.id,
          subscriptions.plan_id,
          plans.name AS plan_name,
          to_char(subscriptions.start_date, 'YYYY-MM-DD') AS start_date,
          to_char(subscriptions.end_date, 'YYYY-MM-DD') AS end_date,
          subscriptions.grace_days,
          to_char(
            public.subscription_access_until(subscriptions.end_date, subscriptions.grace_days),
            'YYYY-MM-DD'
          ) AS access_until,
          subscriptions.status::text AS status,
          plans.price,
          subscriptions.discount_amount,
          subscriptions.created_at,
          count(*) OVER()::text AS total_count
        FROM public.subscriptions
        LEFT JOIN public.plans ON plans.id = subscriptions.plan_id
        WHERE subscriptions.user_id = $1
        ORDER BY subscriptions.created_at DESC, subscriptions.id DESC
        LIMIT $2 OFFSET $3
      `,
      [
        customerId,
        input.memberships_page_size,
        (input.memberships_page - 1) * input.memberships_page_size,
      ],
    );
    const membershipsCountResult = await client.query<TotalRow>(
      `
        SELECT count(*)::text AS total
        FROM public.subscriptions
        WHERE user_id = $1
      `,
      [customerId],
    );

    const canViewBodyAssessments = hasPermission(
      authorization,
      "body_assessments.view",
    );
    let assessmentRows: BodyAssessmentRow[] = [];
    let assessmentTotal = 0;

    if (canViewBodyAssessments) {
      const assessmentsResult = await client.query<BodyAssessmentRow>(
        `
        SELECT
          assessments.id,
          assessments.user_id AS customer_id,
          to_char(assessments.date, 'YYYY-MM-DD') AS assessment_date,
          assessments.weight_kg,
          assessments.height_cm,
          assessments.body_fat_percentage,
          assessments.muscle_mass_kg,
          assessments.body_type,
          assessments.activity_level,
          assessments.water_liters_goal,
          assessments.daily_calories,
          assessments.protein_grams,
          assessments.carbs_grams,
          assessments.fat_grams,
          assessments.chest,
          assessments.waist,
          assessments.hip,
          assessments.arm_right,
          assessments.arm_left,
          assessments.leg_right,
          assessments.leg_left,
          assessments.notes,
          assessments.diet_type,
          assessments.created_at,
          assessments.updated_at,
          count(*) OVER()::text AS total_count
        FROM public.body_assessments AS assessments
        WHERE assessments.user_id = $1
        ORDER BY assessments.date DESC, assessments.id DESC
        LIMIT $2 OFFSET $3
        `,
        [
          customerId,
          input.assessments_page_size,
          (input.assessments_page - 1) * input.assessments_page_size,
        ],
      );
      assessmentRows = assessmentsResult.rows;
      const assessmentsCountResult = await client.query<TotalRow>(
        `
        SELECT count(*)::text AS total
        FROM public.body_assessments
        WHERE user_id = $1
        `,
        [customerId],
      );
      assessmentTotal = Number.parseInt(
        assessmentsCountResult.rows[0]?.total ?? "0",
        10,
      );
    }

    const kpiResult = await client.query<KpiRow>(
      `
        SELECT
          (
            SELECT to_char(min(subscriptions.start_date), 'YYYY-MM-DD')
            FROM public.subscriptions
            WHERE subscriptions.user_id = $1
          ) AS member_since,
          (
            SELECT count(*)::text
            FROM public.attendance_logs AS attendance
            WHERE attendance.biometric_id = $2
              AND (
                NOT (
                  lower(coalesce(attendance.raw_line, '')) LIKE '%pin=%'
                  AND lower(coalesce(attendance.raw_line, '')) LIKE '%event=%'
                )
                OR attendance.status1 IS NULL
                OR attendance.status1 = 0
              )
          ) AS total_visits,
          (
            SELECT assessments.weight_kg::text
            FROM public.body_assessments AS assessments
            WHERE $3::boolean
              AND assessments.user_id = $1
            ORDER BY assessments.date, assessments.id
            LIMIT 1
          ) AS initial_weight,
          (
            SELECT assessments.weight_kg::text
            FROM public.body_assessments AS assessments
            WHERE $3::boolean
              AND assessments.user_id = $1
            ORDER BY assessments.date DESC, assessments.id DESC
            LIMIT 1
          ) AS current_weight
      `,
      [customerId, customer.biometric_id, canViewBodyAssessments],
    );

    const canViewPayments = hasPermission(authorization, "payments.view");
    let paymentRows: PaymentRow[] = [];
    let totalSpent: number | null = null;
    let paymentTotal = 0;

    if (canViewPayments) {
      const paymentsResult = await client.query<PaymentRow>(
        `
          SELECT
            payments.id,
            payments.subscription_id,
            payments.payment_date,
            payments.amount_original,
            payments.discount_amount,
            payments.amount_paid,
            payments.method::text AS method,
            plans.name AS plan_name,
            count(*) OVER()::text AS total_count
          FROM public.payments
          LEFT JOIN public.subscriptions
            ON subscriptions.id = payments.subscription_id
          LEFT JOIN public.plans
            ON plans.id = subscriptions.plan_id
          WHERE payments.user_id = $1
            AND payments.status = 'posted'
          ORDER BY payments.payment_date DESC, payments.id DESC
          LIMIT $2 OFFSET $3
        `,
        [
          customerId,
          input.payments_page_size,
          (input.payments_page - 1) * input.payments_page_size,
        ],
      );
      paymentRows = paymentsResult.rows;
      const spentResult = await client.query<{
        total: string;
        total_spent: string;
      }>(
        `
          SELECT
            count(*)::text AS total,
            coalesce(sum(payments.amount_paid), 0)::text AS total_spent
          FROM public.payments
          WHERE payments.user_id = $1
            AND payments.status = 'posted'
        `,
        [customerId],
      );
      totalSpent = Number(spentResult.rows[0]?.total_spent ?? "0");
      paymentTotal = Number.parseInt(spentResult.rows[0]?.total ?? "0", 10);
    }

    const kpis = kpiResult.rows[0] ?? {
      member_since: null,
      total_visits: "0",
      initial_weight: null,
      current_weight: null,
    };
    const initialWeight = toNumber(kpis.initial_weight);
    const currentWeight = toNumber(kpis.current_weight);
    const heatmapBounds = heatmapResult.rows[0] ?? {
      from_date: "",
      to_date: "",
    };

    return {
      customer_id: customerId,
      memberships: {
        data: membershipsResult.rows.map((row) => ({
          id: row.id,
          plan_id: Number(row.plan_id),
          plan_name: row.plan_name,
          start_date: row.start_date,
          end_date: row.end_date,
          grace_days: row.grace_days,
          access_until: row.access_until,
          status: row.status,
          price: Number(row.price),
          discount_amount: Number(row.discount_amount),
          created_at: row.created_at.toISOString(),
        })),
        meta: paginationMeta(
          input.memberships_page,
          input.memberships_page_size,
          Number.parseInt(membershipsCountResult.rows[0]?.total ?? "0", 10),
        ),
      },
      payments: canViewPayments ? {
        data: paymentRows.map((row) => ({
          id: row.id,
          subscription_id: row.subscription_id,
          payment_date: row.payment_date.toISOString(),
          amount_original: Number(row.amount_original),
          discount_amount: Number(row.discount_amount ?? 0),
          amount_paid: Number(row.amount_paid),
          method: row.method,
          plan_name: row.plan_name,
        })),
        meta: paginationMeta(
          input.payments_page,
          input.payments_page_size,
          paymentTotal,
        ),
      } : null,
      attendance: {
        data: attendanceResult.rows.map((row) => ({
          id: row.id,
          check_in_time: row.check_in_time.toISOString(),
          status: row.status,
        })),
        limit: input.attendance_limit,
        total: totalFromRows(attendanceResult.rows),
      },
      heatmap: {
        timezone: accessTimeZone,
        days: input.heatmap_days,
        from: heatmapBounds.from_date,
        to: heatmapBounds.to_date,
        data: heatmapResult.rows
          .filter((row) => row.local_date !== null)
          .map((row) => ({
            date: row.local_date,
            count: Number.parseInt(row.visit_count, 10),
          })),
      },
      assessments: canViewBodyAssessments ? {
        data: assessmentRows.map(mapBodyAssessmentRow),
        meta: paginationMeta(
          input.assessments_page,
          input.assessments_page_size,
          assessmentTotal,
        ),
      } : null,
      kpis: {
        member_since: kpis.member_since,
        total_visits: Number.parseInt(kpis.total_visits, 10),
        total_spent: totalSpent,
        initial_weight: initialWeight,
        current_weight: currentWeight,
        weight_change: initialWeight !== null && currentWeight !== null
          ? currentWeight - initialWeight
          : null,
      },
    };
  });
}
