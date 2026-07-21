import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { customerHistoryResponseSchema } from "./customer-history.schemas.js";
import type {
  CustomerAccessHistoryEntry,
  CustomerBodyAssessmentEntry,
  CustomerHistoryResponse,
  CustomerPaymentHistoryEntry,
  CustomerSubscriptionHistoryEntry,
} from "./customer-history.types.js";

const customersViewPermission = "customers.view";
const accessTimeZone = "America/Guatemala";

type AuthorizationRow = {
  permissions: string[] | null;
  is_owner: boolean;
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string;
  phone: string;
  avatar_url: string | null;
  gender: string | null;
  birth_date: string | null;
  created_at: Date | string;
  is_active: boolean;
  subscription_status: string | null;
  subscription_end_date: string | null;
  subscription_grace_days: number | null;
  subscription_access_until: string | null;
  injuries: string | null;
  medical_notes: string | null;
  biometric_id: number | null;
};

type AttendanceRow = {
  id: string | number;
  punch_time: Date | string;
  status1: number | null;
  raw_line: string | null;
};

type CountRow = { total: string };

type PaymentRow = {
  id: string;
  payment_date: Date | string;
  amount_original: string | number;
  amount_paid: string | number;
  discount_amount: string | number | null;
  method: string | null;
  subscription_status: string | null;
  subscription_start: string | null;
  subscription_end: string | null;
  plan_name: string | null;
};

type SubscriptionRow = {
  id: string;
  plan_id: string | number | null;
  plan_name: string | null;
  start_date: string;
  end_date: string;
  grace_days: number | null;
  access_until: string | null;
  status: string;
  price: string | number | null;
  discount_amount: string | number | null;
};

type BodyAssessmentRow = {
  id: string;
  assessment_date: string;
  weight_kg: string | number | null;
  height_cm: string | number | null;
  body_fat_percentage: string | number | null;
  muscle_mass: string | number | null;
  waist_cm: string | number | null;
  chest_cm: string | number | null;
  hip_cm: string | number | null;
  arm_right_cm: string | number | null;
  arm_left_cm: string | number | null;
  leg_right_cm: string | number | null;
  leg_left_cm: string | number | null;
  activity_level: string | null;
  diet_type: string | null;
  daily_calories: number | null;
  protein_grams: number | null;
  carbs_grams: number | null;
  fat_grams: number | null;
  water_liters_goal: string | number | null;
  body_type: string | null;
};

const customerNotFoundError = new AppError(
  404,
  "CUSTOMER_NOT_FOUND",
  "Cliente no encontrado",
);

const forbiddenError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para consultar el historial del cliente",
);

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoString(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return parsed.toISOString();
}

function isAuthorizedAccess(row: Pick<AttendanceRow, "raw_line" | "status1">): boolean {
  const rawLine = (row.raw_line ?? "").toLowerCase();
  const isAccessControlEvent = rawLine.includes("pin=") && rawLine.includes("event=");

  return !isAccessControlEvent || row.status1 === null || row.status1 === 0;
}

function getLocalizedDayOfWeek(value: string): string {
  const formatted = new Intl.DateTimeFormat("es-GT", {
    timeZone: accessTimeZone,
    weekday: "long",
  }).format(new Date(value));

  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function getLocalDateKey(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: accessTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";

  return `${year}-${month}-${day}`;
}

async function assertViewAccess(client: PoolClient): Promise<void> {
  const result = await client.query<AuthorizationRow>(
    `
      SELECT
        public.get_current_permissions() AS permissions,
        public.is_owner() AS is_owner
    `,
  );
  const authorization = result.rows[0];

  if (
    authorization?.is_owner ||
    (authorization?.permissions ?? []).includes(customersViewPermission)
  ) {
    return;
  }

  throw forbiddenError;
}

async function getProfile(client: PoolClient, customerId: string): Promise<ProfileRow> {
  const result = await client.query<ProfileRow>(
    `
      SELECT
        overview.id,
        users.email,
        overview.full_name,
        overview.phone,
        overview.avatar_url,
        overview.gender::text AS gender,
        to_char(overview.birth_date, 'YYYY-MM-DD') AS birth_date,
        profiles.created_at,
        overview.is_active,
        overview.subscription_status,
        to_char(overview.subscription_end_date, 'YYYY-MM-DD') AS subscription_end_date,
        overview.subscription_grace_days,
        to_char(overview.subscription_access_until, 'YYYY-MM-DD') AS subscription_access_until,
        profiles.injuries,
        profiles.medical_notes,
        profiles.biometric_id
      FROM public.customer_overview AS overview
      INNER JOIN public.profiles AS profiles ON profiles.id = overview.id
      INNER JOIN auth.users AS users ON users.id = overview.id
      WHERE overview.id = $1
        AND profiles.role = 'client'
        AND users.deleted_at IS NULL
      LIMIT 1
    `,
    [customerId],
  );

  const profile = result.rows[0];
  if (!profile) throw customerNotFoundError;
  return profile;
}

async function getAttendanceData(client: PoolClient, biometricId: number | null) {
  if (biometricId === null) {
    return {
      history: [] as CustomerAccessHistoryEntry[],
      heatmap: {} as Record<string, number>,
      totalVisits: 0,
    };
  }

  const historyResult = await client.query<AttendanceRow>(
      `
        SELECT id, punch_time, status1, raw_line
        FROM public.attendance_logs
        WHERE biometric_id = $1
        ORDER BY punch_time DESC
        LIMIT 50
      `,
      [biometricId],
    );
  const heatmapResult = await client.query<AttendanceRow>(
      `
        SELECT id, punch_time, status1, raw_line
        FROM public.attendance_logs
        WHERE biometric_id = $1
          AND punch_time >= now() - interval '1 year'
        ORDER BY punch_time DESC
      `,
      [biometricId],
    );
  const countResult = await client.query<CountRow>(
      `
        SELECT count(*)::text AS total
        FROM public.attendance_logs
        WHERE biometric_id = $1
          AND (
            NOT (
              lower(coalesce(raw_line, '')) LIKE '%pin=%'
              AND lower(coalesce(raw_line, '')) LIKE '%event=%'
            )
            OR status1 IS NULL
            OR status1 = 0
          )
      `,
      [biometricId],
    );

  const history = historyResult.rows.map((row): CustomerAccessHistoryEntry => {
    const checkInTime = toIsoString(row.punch_time);
    return {
      id: String(row.id),
      check_in_time: checkInTime,
      day_of_week: getLocalizedDayOfWeek(checkInTime),
      status: isAuthorizedAccess(row) ? "authorized" : "denied",
    };
  });
  const heatmap: Record<string, number> = {};

  for (const row of heatmapResult.rows) {
    if (!isAuthorizedAccess(row)) continue;
    const dateKey = getLocalDateKey(toIsoString(row.punch_time));
    heatmap[dateKey] = (heatmap[dateKey] ?? 0) + 1;
  }

  return {
    history,
    heatmap,
    totalVisits: Number.parseInt(countResult.rows[0]?.total ?? "0", 10),
  };
}

async function getPayments(client: PoolClient, customerId: string): Promise<CustomerPaymentHistoryEntry[]> {
  const result = await client.query<PaymentRow>(
    `
      SELECT
        payments.id,
        payments.payment_date,
        payments.amount_original,
        payments.amount_paid,
        payments.discount_amount,
        payments.method::text AS method,
        subscriptions.status::text AS subscription_status,
        to_char(subscriptions.start_date, 'YYYY-MM-DD') AS subscription_start,
        to_char(subscriptions.end_date, 'YYYY-MM-DD') AS subscription_end,
        plans.name AS plan_name
      FROM public.payments
      LEFT JOIN public.subscriptions ON subscriptions.id = payments.subscription_id
      LEFT JOIN public.plans ON plans.id = subscriptions.plan_id
      WHERE payments.user_id = $1
        AND payments.status = 'posted'
      ORDER BY payments.payment_date DESC, payments.id
    `,
    [customerId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    payment_date: toIsoString(row.payment_date),
    plan_name: row.plan_name ?? "N/A",
    amount_original: toNumber(row.amount_original) ?? 0,
    amount_paid: toNumber(row.amount_paid) ?? 0,
    discount_applied: toNumber(row.discount_amount) ?? 0,
    payment_method: row.method ?? "cash",
    subscription_status: row.subscription_status ?? "N/A",
    subscription_start: row.subscription_start ?? "",
    subscription_end: row.subscription_end ?? "",
  }));
}

async function getSubscriptions(client: PoolClient, customerId: string): Promise<CustomerSubscriptionHistoryEntry[]> {
  const result = await client.query<SubscriptionRow>(
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
        subscriptions.discount_amount
      FROM public.subscriptions
      LEFT JOIN public.plans ON plans.id = subscriptions.plan_id
      WHERE subscriptions.user_id = $1
      ORDER BY subscriptions.created_at DESC, subscriptions.id
    `,
    [customerId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    plan_id: toNumber(row.plan_id),
    plan_name: row.plan_name ?? "N/A",
    start_date: row.start_date,
    end_date: row.end_date,
    grace_days: row.grace_days,
    access_until: row.access_until,
    status: row.status,
    price: toNumber(row.price) ?? 0,
    discount_amount: toNumber(row.discount_amount) ?? 0,
  }));
}

async function getBodyAssessments(client: PoolClient, customerId: string): Promise<CustomerBodyAssessmentEntry[]> {
  const result = await client.query<BodyAssessmentRow>(
    `
      SELECT
        id,
        to_char(date, 'YYYY-MM-DD') AS assessment_date,
        weight_kg,
        height_cm,
        body_fat_percentage,
        muscle_mass_kg AS muscle_mass,
        waist AS waist_cm,
        chest AS chest_cm,
        hip AS hip_cm,
        arm_right AS arm_right_cm,
        arm_left AS arm_left_cm,
        leg_right AS leg_right_cm,
        leg_left AS leg_left_cm,
        activity_level,
        diet_type,
        daily_calories,
        protein_grams,
        carbs_grams,
        fat_grams,
        water_liters_goal,
        body_type
      FROM public.body_assessments
      WHERE user_id = $1
      ORDER BY date DESC, id
    `,
    [customerId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    assessment_date: row.assessment_date,
    weight_kg: toNumber(row.weight_kg),
    height_cm: toNumber(row.height_cm),
    body_fat_percentage: toNumber(row.body_fat_percentage),
    muscle_mass: toNumber(row.muscle_mass),
    waist_cm: toNumber(row.waist_cm),
    chest_cm: toNumber(row.chest_cm),
    arm_cm: toNumber(row.arm_right_cm),
    hip_cm: toNumber(row.hip_cm),
    arm_right_cm: toNumber(row.arm_right_cm),
    arm_left_cm: toNumber(row.arm_left_cm),
    leg_right_cm: toNumber(row.leg_right_cm),
    leg_left_cm: toNumber(row.leg_left_cm),
    activity_level: row.activity_level,
    diet_type: row.diet_type,
    daily_calories: row.daily_calories,
    protein_grams: row.protein_grams,
    carbs_grams: row.carbs_grams,
    fat_grams: row.fat_grams,
    water_liters_goal: toNumber(row.water_liters_goal),
    body_type: row.body_type,
  }));
}

export async function getCustomerHistory(
  actorUserId: string,
  customerId: string,
): Promise<CustomerHistoryResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    await assertViewAccess(client);
    const profileRow = await getProfile(client, customerId);
    const attendance = await getAttendanceData(client, profileRow.biometric_id);
    const payments = await getPayments(client, customerId);
    const subscriptions = await getSubscriptions(client, customerId);
    const bodyAssessments = await getBodyAssessments(client, customerId);
    const currentWeight = bodyAssessments[0]?.weight_kg ?? null;
    const initialWeight = bodyAssessments.at(-1)?.weight_kg ?? null;
    const totalSpent = payments.reduce((total, payment) => total + payment.amount_paid, 0);

    return customerHistoryResponseSchema.parse({
      profile: {
        id: profileRow.id,
        full_name: profileRow.full_name,
        email: profileRow.email,
        phone: profileRow.phone,
        avatar_url: profileRow.avatar_url,
        gender: profileRow.gender,
        birth_date: profileRow.birth_date,
        created_at: toIsoString(profileRow.created_at),
        is_active: profileRow.is_active,
        subscription_status: profileRow.subscription_status,
        subscription_end_date: profileRow.subscription_end_date,
        subscription_grace_days: profileRow.subscription_grace_days,
        subscription_access_until: profileRow.subscription_access_until,
        injuries: profileRow.injuries,
        medical_notes: profileRow.medical_notes,
      },
      kpis: {
        totalSpent,
        memberSince: toIsoString(profileRow.created_at),
        totalVisits: attendance.totalVisits,
        initialWeight,
        currentWeight,
        weightChange:
          initialWeight !== null && currentWeight !== null
            ? currentWeight - initialWeight
            : null,
      },
      access_history: attendance.history,
      payment_history: payments,
      subscription_history: subscriptions,
      body_assessments: bodyAssessments,
      heatmap_data: attendance.heatmap,
    });
  });
}
