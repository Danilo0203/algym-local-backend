import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { PaymentsListQuery } from "./payments.schemas.js";

type PaymentRow = {
  id: string;
  payment_date: Date;
  amount_paid: string;
  method: "cash" | "card" | "transfer";
  user_id: string;
  user_name: string | null;
  avatar_url: string | null;
  plan_name: string | null;
  subscription_status: string | null;
  subscription_end_date: string | null;
  subscription_grace_days: number | null;
  subscription_access_until: string | null;
};

const sortableColumns = new Set([
  "payment_date", "user_name", "subscription_status", "plan_name", "method", "amount_paid",
]);

export async function listPayments(actorUserId: string, input: PaymentsListQuery) {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await client.query<{ permissions: string[] | null; is_owner: boolean }>(
      "SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner",
    );
    const auth = authorization.rows[0];
    if (!auth?.is_owner && !auth?.permissions?.includes("payments.view")) {
      throw new AppError(403, "FORBIDDEN", "No autorizado para consultar pagos");
    }

    const filters: string[] = [];
    const values: unknown[] = [];
    const add = (fragment: string, value: unknown) => {
      values.push(value);
      filters.push(fragment.replace("?", `$${values.length}`));
    };

    if (input.user_name) add("p.user_name ILIKE ? ESCAPE '\\'", `%${input.user_name.replace(/[\\%_]/g, "\\$&")}%`);
    if (input.method) add("p.method::text = ANY(?::text[])", input.method.split(","));
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
      `SELECT count(*)::text AS total FROM public.payments_overview AS p ${where}`,
      values,
    );
    const rows = await client.query<PaymentRow>(
      `SELECT p.id, p.payment_date, p.amount_paid::text AS amount_paid,
              p.method, p.user_id, p.user_name, p.avatar_url, p.plan_name,
              p.subscription_status, p.subscription_end_date::text AS subscription_end_date,
              p.subscription_grace_days,
              p.subscription_access_until::text AS subscription_access_until
       FROM public.payments_overview AS p ${where}
       ORDER BY ${order.join(", ")}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, input.perPage, (input.page - 1) * input.perPage],
    );

    return {
      data: rows.rows.map((row) => ({
        ...row,
        payment_date: row.payment_date.toISOString(),
        amount_paid: Number(row.amount_paid),
        user_name: row.user_name || "Usuario eliminado",
        plan_name: row.plan_name || "Sin plan",
      })),
      total: Number(count.rows[0]?.total ?? 0),
    };
  });
}
