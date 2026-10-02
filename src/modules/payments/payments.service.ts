import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { localAvatarUrl } from "../media/media.service.js";
import type { PaymentsListQuery } from "./payments.schemas.js";

type PaymentRow = {
  id: string;
  payment_date: Date;
  amount_paid: string;
  status: string;
  method: "cash" | "card" | "transfer";
  user_id: string;
  subscription_id: string | null;
  user_name: string | null;
  avatar_url: string | null;
  plan_name: string | null;
  subscription_status: string | null;
  subscription_end_date: string | null;
  subscription_grace_days: number | null;
  subscription_access_until: string | null;
};

const sortableColumns = new Set([
  "payment_date", "user_name", "subscription_status", "plan_name", "method", "amount_paid", "status",
]);

const paymentRowsSql = `WITH payment_rows AS (
  SELECT payment.id, payment.subscription_id, payment.payment_date, payment.amount_paid, payment.method,
         payment.status, payment.user_id, customer.full_name AS user_name,
         customer.avatar_url, plan.name AS plan_name,
         CASE WHEN subscription.status = 'active'::public.sub_status
                   AND public.subscription_access_until(subscription.end_date, subscription.grace_days) < CURRENT_DATE
              THEN 'expired'::public.sub_status ELSE subscription.status END AS subscription_status,
         subscription.end_date AS subscription_end_date,
         subscription.grace_days AS subscription_grace_days,
         public.subscription_access_until(subscription.end_date, subscription.grace_days) AS subscription_access_until
  FROM public.payments AS payment
  LEFT JOIN public.profiles AS customer ON customer.id = payment.user_id
  LEFT JOIN public.subscriptions AS subscription ON subscription.id = payment.subscription_id
  LEFT JOIN public.plans AS plan ON plan.id = subscription.plan_id
)`;

async function requirePaymentsView(client: PoolClient) {
  const authorization = await client.query<{ permissions: string[] | null; is_owner: boolean }>(
    "SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner",
  );
  const auth = authorization.rows[0];
  if (!auth?.is_owner && !auth?.permissions?.includes("payments.view")) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para consultar pagos");
  }
}

export async function listPayments(actorUserId: string, input: PaymentsListQuery) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePaymentsView(client);

    const filters: string[] = [];
    const values: unknown[] = [];
    const add = (fragment: string, value: unknown) => {
      values.push(value);
      filters.push(fragment.replace("?", `$${values.length}`));
    };

    if (input.user_name) add("p.user_name ILIKE ? ESCAPE '\\'", `%${input.user_name.replace(/[\\%_]/g, "\\$&")}%`);
    if (input.method) add("p.method::text = ANY(?::text[])", input.method.split(","));
    if (input.status) add("p.status = ANY(?::text[])", input.status.split(","));
    if (input.subscription_status) add("p.subscription_status::text = ANY(?::text[])", input.subscription_status.split(","));
    if (input.payment_date_start) add("p.payment_date >= ?::timestamptz", input.payment_date_start);
    if (input.payment_date_end) add("p.payment_date <= ?::timestamptz", input.payment_date_end);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const sortParts = (input.sort ?? "payment_date:desc").split(",");
    const order = sortParts.map((part) => {
      const [column, direction] = part.split(":");
      if (!column || !sortableColumns.has(column) || !["asc", "desc"].includes(direction ?? "")) {
        throw new AppError(400, "VALIDATION_ERROR", "Orden inválido");
      }
      return `p.${column} ${direction!.toUpperCase()} NULLS LAST`;
    });
    order.push("p.id DESC");

    const count = await client.query<{ total: string }>(
      `${paymentRowsSql} SELECT count(*)::text AS total FROM payment_rows AS p ${where}`,
      values,
    );
    const rows = await client.query<PaymentRow>(
      `${paymentRowsSql} SELECT p.id, p.subscription_id, p.payment_date, p.amount_paid::text AS amount_paid,
              p.method, p.status, p.user_id, p.user_name, p.avatar_url, p.plan_name,
              p.subscription_status, p.subscription_end_date::text AS subscription_end_date,
              p.subscription_grace_days,
              p.subscription_access_until::text AS subscription_access_until
       FROM payment_rows AS p ${where}
       ORDER BY ${order.join(", ")}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, input.perPage, (input.page - 1) * input.perPage],
    );

    return {
      data: rows.rows.map((row) => ({
        ...row,
        avatar_url: localAvatarUrl(row.avatar_url),
        payment_date: row.payment_date.toISOString(),
        amount_paid: Number(row.amount_paid),
        user_name: row.user_name || "Usuario eliminado",
        plan_name: row.plan_name || "Sin plan",
      })),
      total: Number(count.rows[0]?.total ?? 0),
    };
  });
}

export async function getPaymentDetail(actorUserId: string, paymentId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePaymentsView(client);
    const result = await client.query<{
      id: string; user_id: string | null; subscription_id: string | null;
      payment_date: Date; amount_original: string; discount_amount: string; amount_paid: string;
      method: "cash" | "card" | "transfer"; status: string; notes: string | null;
      created_by_user_id: string | null; reversed_at: Date | null;
      reversed_by_user_id: string | null; replacement_payment_id: string | null;
      reversal_reason: string | null; user_name: string | null; plan_name: string | null;
      subscription_status: string | null; subscription_start_date: string | null;
      subscription_end_date: string | null; source_category: string | null;
    }>(
      `SELECT payment.id, payment.user_id, payment.subscription_id,
              payment.payment_date, payment.amount_original::text AS amount_original,
              payment.discount_amount::text AS discount_amount,
              payment.amount_paid::text AS amount_paid, payment.method, payment.status,
              payment.notes, payment.created_by_user_id, payment.reversed_at,
              payment.reversed_by_user_id, payment.replacement_payment_id,
              payment.reversal_reason, customer.full_name AS user_name,
              plan.name AS plan_name, subscription.status::text AS subscription_status,
              subscription.start_date::text AS subscription_start_date,
              subscription.end_date::text AS subscription_end_date,
              (SELECT movement.category FROM public.cash_movements AS movement
               WHERE movement.source_payment_id = payment.id
               ORDER BY movement.created_at DESC LIMIT 1) AS source_category
       FROM public.payments AS payment
       LEFT JOIN public.profiles AS customer ON customer.id = payment.user_id
       LEFT JOIN public.subscriptions AS subscription ON subscription.id = payment.subscription_id
       LEFT JOIN public.plans AS plan ON plan.id = subscription.plan_id
       WHERE payment.id = $1`,
      [paymentId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(404, "PAYMENT_NOT_FOUND", "Pago no encontrado");
    return {
      ...row,
      payment_date: row.payment_date.toISOString(),
      amount_original: Number(row.amount_original),
      discount_amount: Number(row.discount_amount),
      amount_paid: Number(row.amount_paid),
      reversed_at: row.reversed_at?.toISOString() ?? null,
      user_name: row.user_name || "Usuario eliminado",
      plan_name: row.plan_name || "Sin plan",
    };
  });
}
