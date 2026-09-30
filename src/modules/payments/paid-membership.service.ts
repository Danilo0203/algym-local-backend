import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { PaidMembershipInput } from "./payments.schemas.js";

type Authorization = { permissions: string[] | null; is_owner: boolean };
type Customer = { id: string; role: string; is_active: boolean };
type Plan = { id: number; price: string; duration_days: number | null; is_active: boolean };
type Membership = { id: string; end_date: string };
type CashMovement = { id: string; session_link_status: "assigned" | "out_of_session" };

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function createPaidMembershipInTransaction(
  client: PoolClient, actorUserId: string, input: PaidMembershipInput,
) {
  const authorization = await client.query<Authorization>(
    `SELECT public.get_current_permissions() AS permissions,
            public.is_owner() AS is_owner`,
  );
  const auth = authorization.rows[0];
  if (!auth?.is_owner && !(auth?.permissions?.includes("cash.operate")
    && auth.permissions.includes("customers.manage_membership"))) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para cobrar membresías");
  }

  // Serializa cobros simultáneos al mismo cliente. El índice de una
  // membresía activa sigue siendo la protección final ante otros escritores.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('membership-payment:' || $1::text, 0))`,
    [input.customerId],
  );

  const customerResult = await client.query<Customer>(
    `SELECT id, role::text AS role, is_active FROM public.profiles WHERE id = $1`,
    [input.customerId],
  );
  const customer = customerResult.rows[0];
  if (!customer) throw new AppError(404, "CUSTOMER_NOT_FOUND", "Cliente no encontrado");
  if (customer.role !== "client") {
    throw new AppError(422, "INVALID_CUSTOMER", "El perfil no es un cliente");
  }
  if (!customer.is_active) throw new AppError(409, "CUSTOMER_INACTIVE", "El cliente está inactivo");

  const planResult = await client.query<Plan>(
    `SELECT id, price::text AS price, duration_days, is_active
     FROM public.plans WHERE id = $1`,
    [input.planId],
  );
  const plan = planResult.rows[0];
  if (!plan) throw new AppError(404, "PLAN_NOT_FOUND", "Plan no encontrado");
  if (!plan.is_active) throw new AppError(422, "PLAN_INACTIVE", "El plan no está activo");

  const history = await client.query<Membership>(
    `SELECT id, end_date::text AS end_date FROM public.subscriptions
     WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [input.customerId],
  );
  const active = await client.query<Membership>(
    `SELECT id, end_date::text AS end_date FROM public.subscriptions
     WHERE user_id = $1 AND status = 'active' FOR UPDATE`,
    [input.customerId],
  );
  if (input.operation === "create" && active.rows.length > 0) {
    throw new AppError(409, "MEMBERSHIP_ALREADY_ACTIVE", "El cliente ya tiene una membresía activa");
  }
  if (input.operation === "renew" && history.rows.length === 0) {
    throw new AppError(409, "NO_MEMBERSHIP_TO_RENEW", "El cliente no tiene una membresía previa");
  }

  if (input.requireSession) {
    const openSession = await client.query<{ id: string }>(
      `SELECT id FROM public.cash_sessions
       WHERE opened_by_user_id = $1 AND status = 'open'
       ORDER BY opened_at DESC LIMIT 1`,
      [actorUserId],
    );
    if (!openSession.rows[0]) {
      throw new AppError(409, "CASH_SESSION_REQUIRED", "Abre una caja antes de registrar el cobro");
    }
  }

  const today = await client.query<{ date: string }>(
    `SELECT ((now() AT TIME ZONE 'America/Guatemala')::date)::text AS date`,
  );
  const suggestedStart = input.operation === "renew" && active.rows[0]
    ? (await client.query<{ date: string }>(
      `SELECT GREATEST($1::date + 1, $2::date)::text AS date`,
      [active.rows[0].end_date, today.rows[0]!.date],
    )).rows[0]!.date
    : today.rows[0]!.date;
  const startDate = input.startDate ?? suggestedStart;
  const endDate = input.endDate ?? (await client.query<{ date: string }>(
    `SELECT ($1::date + $2::int)::text AS date`,
    [startDate, plan.duration_days ?? 30],
  )).rows[0]!.date;
  if (endDate <= startDate) {
    throw new AppError(400, "INVALID_DATE_RANGE", "La fecha final debe ser posterior al inicio");
  }

  const amountOriginal = input.amountOriginal ?? Number(plan.price);
  const discountAmount = input.discountAmount;
  const amountPaid = input.amountPaid ?? money(amountOriginal - discountAmount);
  if (amountOriginal <= 0 || discountAmount > amountOriginal || amountPaid <= 0) {
    throw new AppError(400, "INVALID_PAYMENT_AMOUNT", "Los importes del cobro son inválidos");
  }

  if (input.operation === "renew") {
    await client.query(
      `UPDATE public.subscriptions SET status = 'expired'
       WHERE user_id = $1 AND status = 'active'`,
      [input.customerId],
    );
  }

  const subscription = await client.query<{ id: string }>(
    `INSERT INTO public.subscriptions
       (user_id, plan_id, start_date, end_date, status, discount_amount, grace_days)
     VALUES ($1, $2, $3::date, $4::date, 'active', $5::numeric, $6)
     RETURNING id`,
    [input.customerId, input.planId, startDate, endDate, discountAmount, input.graceDays],
  );
  const subscriptionId = subscription.rows[0]!.id;
  const payment = await client.query<{ id: string }>(
    `INSERT INTO public.payments
       (subscription_id, user_id, amount_original, discount_amount, amount_paid,
        method, payment_date, created_by_user_id, status)
     VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric,
             $6::public.payment_method, now(), $7, 'posted')
     RETURNING id`,
    [subscriptionId, input.customerId, amountOriginal, discountAmount,
      amountPaid, input.paymentMethod, actorUserId],
  );
  const paymentId = payment.rows[0]!.id;
  const movement = await client.query<CashMovement>(
    `SELECT id, session_link_status
     FROM public.attach_payment_to_cash($1::uuid, $2::uuid, 'membership', NULL)`,
    [paymentId, actorUserId],
  );
  const attached = movement.rows[0];
  if (!attached || (input.requireSession && attached.session_link_status !== "assigned")) {
    throw new AppError(409, "CASH_SESSION_REQUIRED", "El cobro no quedó asociado a la caja abierta");
  }

  return {
    subscription_id: subscriptionId,
    payment_id: paymentId,
    cash_movement_id: attached.id,
    session_link_status: attached.session_link_status,
    amount_paid: amountPaid,
  };
}

export async function createPaidMembership(actorUserId: string, input: PaidMembershipInput) {
  try {
    return await withUserTransaction(actorUserId,
      (client) => createPaidMembershipInTransaction(client, actorUserId, input));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new AppError(409, "MEMBERSHIP_ALREADY_ACTIVE", "El cliente ya tiene una membresía activa");
    }
    throw error;
  }
}
