import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { EnrollmentQuote } from "./enrollment.schemas.js";
import { queueAutomaticDrawer } from "../cash/cash-devices.service.js";

export type EnrollmentState = {
  year: number; fee: number; status: "needs_review" | "pending" | "paid" | "recognized";
  amount: number | null; recorded_at: string | null; can_manage: boolean; can_collect: boolean;
};

async function access(client: PoolClient, permission?: string) {
  const { rows } = await client.query<{ manage: boolean; collect: boolean; read: boolean }>(`SELECT
    (public.is_owner() OR public.has_permission('enrollment.manage')) AS manage,
    (public.is_owner() OR public.has_permission('cash.operate')) AS collect,
    (public.is_owner() OR public.has_permission('cash.operate') OR public.has_permission('customers.view')
      OR public.has_permission('plans.view') OR public.has_permission('enrollment.manage')) AS read`);
  const a = rows[0]!;
  if (!a.read || (permission === "manage" && !a.manage) || (permission === "collect" && !a.collect)) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para esta operación de inscripción");
  }
  return a;
}

export async function enrollmentLock(client: PoolClient, customerId: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('membership-payment:' || $1::text, 0))`, [customerId]);
}

export async function readEnrollment(client: PoolClient, customerId?: string): Promise<EnrollmentState> {
  const a = await access(client);
  if (customerId) {
    const customer = await client.query(`SELECT id FROM public.profiles WHERE id = $1 AND role::text = 'client'`, [customerId]);
    if (!customer.rows[0]) throw new AppError(404, "CUSTOMER_NOT_FOUND", "Cliente no encontrado");
  }
  const { rows } = await client.query<{
    year: number; fee: string; status: EnrollmentState["status"]; amount: string | null; recorded_at: Date | null;
  }>(`SELECT y.year, s.fee::text, COALESCE(e.status, 'pending') AS status,
      e.amount::text, e.recorded_at
    FROM public.enrollment_settings s
    CROSS JOIN (SELECT extract(year FROM now() AT TIME ZONE 'America/Guatemala')::int AS year) y
    LEFT JOIN public.customer_enrollments e ON e.customer_id = $1::uuid AND e.year = y.year
    WHERE s.singleton`, [customerId ?? null]);
  const row = rows[0]!;
  return { ...row, fee: Number(row.fee), amount: row.amount === null ? null : Number(row.amount),
    recorded_at: row.recorded_at?.toISOString() ?? null, can_manage: a.manage, can_collect: a.collect };
}

export async function getEnrollment(actor: string, customerId?: string) {
  return withUserTransaction(actor, (client) => readEnrollment(client, customerId));
}

export async function setEnrollmentFee(actor: string, fee: number) {
  return withUserTransaction(actor, async (client) => {
    await access(client, "manage");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('enrollment-settings', 0))`);
    const old = await client.query(`SELECT fee FROM public.enrollment_settings WHERE singleton FOR UPDATE`);
    await client.query(`UPDATE public.enrollment_settings SET fee = $1, updated_at = now(), updated_by = $2 WHERE singleton`, [fee, actor]);
    await client.query(`INSERT INTO public.enrollment_audit (action, details, created_by)
      VALUES ('fee_changed', $1::jsonb, $2)`, [JSON.stringify({ before: old.rows[0].fee, after: fee }), actor]);
    return readEnrollment(client);
  });
}

export async function reviewEnrollment(actor: string, customerId: string,
  input: { year: number; status: "pending" | "recognized"; reason: string }) {
  return withUserTransaction(actor, async (client) => {
    await access(client, input.status === "recognized" ? "manage" : "collect");
    await enrollmentLock(client, customerId);
    const state = await readEnrollment(client, customerId);
    if (state.year !== input.year) throw new AppError(409, "ENROLLMENT_CHANGED", "Cambió el año; actualiza la inscripción");
    if (state.status === "paid" || state.status === "recognized") {
      throw new AppError(409, "ALREADY_ENROLLED", "El cliente ya está inscrito este año");
    }
    await client.query(`INSERT INTO public.customer_enrollments (customer_id, year, status, recorded_by, reason)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (customer_id, year) DO UPDATE
      SET status = EXCLUDED.status, recorded_by = EXCLUDED.recorded_by, reason = EXCLUDED.reason, recorded_at = now()`,
    [customerId, input.year, input.status, actor, input.reason]);
    await client.query(`INSERT INTO public.enrollment_audit (customer_id, year, action, details, created_by)
      VALUES ($1, $2, 'reviewed', $3::jsonb, $4)`,
    [customerId, input.year, JSON.stringify({ before: state.status, ...input }), actor]);
    return readEnrollment(client, customerId);
  });
}

// Called in the SAME transaction as membership creation/collection. No partial income.
export async function collectEnrollmentInTransaction(client: PoolClient, actor: string, customerId: string,
  quote: EnrollmentQuote, method: "cash" | "card" | "transfer", collectionId: string) {
  await access(client, "collect");
  await enrollmentLock(client, customerId);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('enrollment-settings', 0))`);
  const state = await readEnrollment(client, customerId);
  if (state.year !== quote.year || Math.round(state.fee * 100) !== Math.round(quote.fee * 100)) {
    throw new AppError(409, "ENROLLMENT_CHANGED", "Cambió el año o la tarifa de inscripción. Actualiza el resumen antes de cobrar.");
  }
  if (state.status !== "pending") {
    throw new AppError(409, "ENROLLMENT_CHANGED", state.status === "needs_review"
      ? "Revisa primero si el cliente ya pagó la inscripción." : "El cliente ya está inscrito este año. Actualiza el resumen.");
  }
  const session = await client.query(`SELECT id FROM public.cash_sessions
    WHERE opened_by_user_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`, [actor]);
  if (!session.rows[0]) throw new AppError(409, "CASH_SESSION_REQUIRED", "Abre una caja antes de cobrar la inscripción");
  const payment = await client.query<{ id: string }>(`INSERT INTO public.payments
    (user_id, amount_original, discount_amount, amount_paid, method, created_by_user_id,
      payment_kind, enrollment_year, collection_id, notes)
    VALUES ($1, $2, 0, $2, $3::public.payment_method, $4, 'enrollment', $5, $6, $7) RETURNING id`,
  [customerId, state.fee, method, actor, state.year, collectionId, `Inscripción ${state.year}`]);
  const paymentId = payment.rows[0]!.id;
  const movement = await client.query<{ id: string; session_link_status: string }>(
    `SELECT id, session_link_status FROM public.attach_payment_to_cash($1::uuid, $2::uuid, 'enrollment', $3::text)`,
    [paymentId, actor, `Inscripción ${state.year}`]);
  if (movement.rows[0]?.session_link_status !== "assigned") {
    throw new AppError(409, "CASH_SESSION_REQUIRED", "La inscripción no quedó asociada a una caja abierta");
  }
  await client.query(`INSERT INTO public.customer_enrollments
    (customer_id, year, status, payment_id, amount, recorded_by)
    VALUES ($1, $2, 'paid', $3, $4, $5) ON CONFLICT (customer_id, year) DO UPDATE
    SET status = 'paid', payment_id = EXCLUDED.payment_id, amount = EXCLUDED.amount,
      recorded_by = EXCLUDED.recorded_by, recorded_at = now(), reason = NULL`,
  [customerId, state.year, paymentId, state.fee, actor]);
  await queueAutomaticDrawer(client, actor, movement.rows[0].id, method);
  return { payment_id: paymentId, cash_movement_id: movement.rows[0].id, amount: state.fee, year: state.year };
}

export async function collectEnrollment(actor: string, customerId: string,
  input: EnrollmentQuote & { paymentMethod: "cash" | "card" | "transfer" }) {
  return withUserTransaction(actor, async (client) => {
    const collectionId = randomUUID();
    const payment = await collectEnrollmentInTransaction(client, actor, customerId, input, input.paymentMethod, collectionId);
    return { ...payment, collection_id: collectionId, enrollment: await readEnrollment(client, customerId) };
  });
}
