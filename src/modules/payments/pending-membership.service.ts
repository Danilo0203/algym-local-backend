import { z } from "zod";
import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { collectPendingMembershipSchema } from "./payments.schemas.js";

type CollectionInput = z.infer<typeof collectPendingMembershipSchema>;
type PendingRow = {
  id: string; customer_id: string; full_name: string; phone: string;
  plan_id: string; plan_name: string; start_date: string; end_date: string;
  amount_original: string;
};

const eligible = `s.status = 'pending' AND s.initial_collection_origin = 'customers'
  AND p.role = 'client' AND p.is_active
  AND NOT EXISTS (SELECT 1 FROM public.payments pay WHERE pay.subscription_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM public.subscriptions previous
    WHERE previous.user_id = s.user_id AND previous.id <> s.id)`;

const pendingColumns = `s.id, s.user_id AS customer_id, p.full_name, p.phone,
  s.plan_id::text, pl.name AS plan_name, s.start_date::text, s.end_date::text,
  (pl.price * GREATEST(1, ROUND((s.end_date - s.start_date)::numeric / pl.duration_days)))::text AS amount_original`;

async function assertCashAccess(client: import("pg").PoolClient) {
  const { rows } = await client.query<{ is_owner: boolean; permissions: string[] | null }>(
    `SELECT public.is_owner() AS is_owner, public.get_current_permissions() AS permissions`,
  );
  const auth = rows[0];
  if (!auth?.is_owner && !(auth?.permissions?.includes("cash.operate")
    && auth.permissions.includes("customers.manage_membership"))) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para cobrar membresías");
  }
}

async function assertOpenSession(client: import("pg").PoolClient, actorUserId: string) {
  const { rows } = await client.query(
    `SELECT id FROM public.cash_sessions WHERE opened_by_user_id = $1 AND status = 'open'
     ORDER BY opened_at DESC LIMIT 1`, [actorUserId],
  );
  if (!rows[0]) throw new AppError(409, "CASH_SESSION_REQUIRED", "Abre una caja antes de registrar el cobro");
}

export async function listPendingMemberships(actorUserId: string, search: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await assertCashAccess(client);
    await assertOpenSession(client, actorUserId);
    const { rows } = await client.query<PendingRow>(
      `SELECT ${pendingColumns} FROM public.subscriptions s
       JOIN public.profiles p ON p.id = s.user_id
       JOIN public.plans pl ON pl.id = s.plan_id
       WHERE ${eligible} AND ($1 = '' OR p.full_name ILIKE '%' || $1 || '%'
         OR p.phone ILIKE '%' || $1 || '%')
       ORDER BY s.created_at ASC, s.id LIMIT 50`, [search],
    );
    return { data: rows.map((row) => ({ ...row, plan_id: Number(row.plan_id),
      amount_original: Number(row.amount_original) })) };
  });
}

export async function collectPendingMembership(actorUserId: string, membershipId: string, input: CollectionInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await assertCashAccess(client);
    await assertOpenSession(client, actorUserId);

    // Mismo candado que el alta/renovación pagada: serializa cobros del mismo cliente.
    const owner = await client.query<{ user_id: string }>(
      `SELECT user_id FROM public.subscriptions WHERE id = $1`, [membershipId],
    );
    if (!owner.rows[0]) throw new AppError(404, "PENDING_MEMBERSHIP_NOT_FOUND", "Membresía pendiente no encontrada");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('membership-payment:' || $1::text, 0))`,
      [owner.rows[0].user_id],
    );

    const { rows } = await client.query<PendingRow>(
      `SELECT ${pendingColumns} FROM public.subscriptions s
       JOIN public.profiles p ON p.id = s.user_id
       JOIN public.plans pl ON pl.id = s.plan_id
       WHERE s.id = $1 AND ${eligible} FOR UPDATE OF s`, [membershipId],
    );
    const membership = rows[0];
    if (!membership) throw new AppError(409, "PENDING_MEMBERSHIP_NOT_FOUND", "Esta membresía ya no está pendiente de cobro");
    const active = await client.query(
      `SELECT id FROM public.subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1`,
      [membership.customer_id],
    );
    if (active.rows.length > 0) throw new AppError(409, "MEMBERSHIP_ALREADY_ACTIVE", "El cliente ya tiene una membresía activa");
    const today = await client.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE 'America/Guatemala')::date::text AS today`,
    );
    if (membership.end_date < today.rows[0]!.today) {
      throw new AppError(409, "MEMBERSHIP_EXPIRED", "La vigencia terminó antes del cobro; revisa las fechas");
    }
    const amountOriginal = Number(membership.amount_original);
    const amountPaid = Math.round((amountOriginal - input.discountAmount) * 100) / 100;
    if (amountOriginal <= 0 || amountPaid <= 0) {
      throw new AppError(400, "INVALID_PAYMENT_AMOUNT", "El importe del cobro debe ser mayor a cero");
    }
    const payment = await client.query<{ id: string }>(
      `INSERT INTO public.payments (subscription_id, user_id, amount_original,
       discount_amount, amount_paid, method, payment_date, created_by_user_id, status)
       VALUES ($1, $2, $3, $4, $5, $6::public.payment_method, now(), $7, 'posted') RETURNING id`,
      [membership.id, membership.customer_id, amountOriginal, input.discountAmount,
        amountPaid, input.paymentMethod, actorUserId],
    );
    const paymentId = payment.rows[0]!.id;
    const movement = await client.query<{ id: string; session_link_status: string }>(
      `SELECT id, session_link_status FROM public.attach_payment_to_cash($1::uuid, $2::uuid, 'membership', NULL)`,
      [paymentId, actorUserId],
    );
    if (movement.rows[0]?.session_link_status !== "assigned") {
      throw new AppError(409, "CASH_SESSION_REQUIRED", "El cobro no quedó asociado a la caja abierta");
    }
    await client.query(`UPDATE public.subscriptions SET status = 'active',
      discount_amount = $2 WHERE id = $1`, [membershipId, input.discountAmount]);
    await client.query(`SELECT private.create_pending_routine_for_cash_payment($1::uuid)`, [paymentId]);
    return { customer_id: membership.customer_id, subscription_id: membershipId,
      payment_id: paymentId, cash_movement_id: movement.rows[0].id,
      amount_paid: amountPaid, session_link_status: "assigned" };
  });
}
