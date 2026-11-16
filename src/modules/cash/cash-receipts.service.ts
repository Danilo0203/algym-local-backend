import type { PoolClient } from "pg";
import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { SaleReceipt } from "./receipt.js";

export async function requireCashDeviceAccess(client: PoolClient) {
  const { rows } = await client.query<{ owner: boolean; permissions: string[] }>(
    "SELECT public.is_owner() AS owner, public.get_current_permissions() AS permissions",
  );
  if (!rows[0]?.owner && !rows[0]?.permissions?.includes("cash.operate")) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para consultar ventas de caja");
  }
}

// Posted membership/enrollment lines form one collection. Reversed lines remain
// individually consultable; a corrected payment method gets its own receipt.
const saleRows = `SELECT m.id, m.created_at, m.amount, m.payment_method, m.note,
    COALESCE(pay.payment_kind, m.category) AS category, pay.enrollment_year,
    m.source_product_sale_id, m.source_payment_id,
    COALESCE(sale.sale_number, 'P-' || m.source_payment_id::text, m.id::text) AS reference,
    COALESCE(sale.status, pay.status::text, CASE WHEN m.voided_at IS NULL THEN 'posted' ELSE 'voided' END) AS status,
    COALESCE(customer.full_name, m.deleted_customer_name, 'Público general') AS customer,
    COALESCE(cashier.full_name, 'Usuario') AS cashier,
    pay.amount_original, pay.discount_amount, COALESCE(plan.name, pay.deleted_plan_name) AS plan_name,
    CASE WHEN pay.status = 'posted' AND m.voided_at IS NULL
      THEN 'collection:' || pay.collection_id::text || ':' || m.payment_method::text
      ELSE 'movement:' || m.id::text END AS group_key,
    CASE WHEN pay.payment_kind = 'enrollment' THEN 1 ELSE 0 END AS line_order
  FROM public.cash_movements m
  LEFT JOIN public.profiles customer ON customer.id = m.customer_id
  LEFT JOIN public.profiles cashier ON cashier.id = m.created_by_user_id
  LEFT JOIN public.product_sales sale ON sale.id = m.source_product_sale_id
  LEFT JOIN public.payments pay ON pay.id = m.source_payment_id
  LEFT JOIN public.subscriptions sub ON sub.id = pay.subscription_id
  LEFT JOIN public.plans plan ON plan.id = sub.plan_id
  WHERE m.movement_type = 'sale'`;

type ReceiptRow = {
  id: string; created_at: Date; amount: string; payment_method: string;
  customer: string; cashier: string; note: string | null;
  source_product_sale_id: string | null; source_payment_id: string | null;
  reference: string; status: string; amount_original: string | null;
  discount_amount: string | null; plan_name: string | null; category: string;
  enrollment_year: number | null;
};

export async function readSaleReceipt(client: PoolClient, movementId: string): Promise<SaleReceipt> {
  await requireCashDeviceAccess(client);
  const { rows } = await client.query<ReceiptRow>(`WITH sales AS (${saleRows})
    SELECT * FROM sales WHERE group_key = (SELECT group_key FROM sales WHERE id = $1)
    ORDER BY line_order, created_at, id`, [movementId]);
  const row = rows[0];
  if (!row) throw new AppError(404, "SALE_NOT_FOUND", "Venta no encontrada");
  let items: SaleReceipt["items"];
  if (row.source_product_sale_id) {
    const products = await client.query<{ name: string; quantity: string; unit_price: string; line_total: string }>(
      `SELECT product_name AS name, quantity::text, unit_price::text, line_total::text
       FROM public.product_sale_items WHERE product_sale_id = $1 ORDER BY created_at, id`,
      [row.source_product_sale_id],
    );
    items = products.rows.map(item => ({ name: item.name, quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price), total: Number(item.line_total) }));
  } else {
    items = rows.map(line => ({
      name: line.category === "enrollment" ? `Inscripción ${line.enrollment_year}`
        : line.plan_name ? "Membresía: " + line.plan_name : "Cobro de gimnasio",
      quantity: 1, unitPrice: Number(line.amount_original ?? line.amount),
      total: Number(line.amount_original ?? line.amount),
    }));
  }
  const money = (amount: number) => Math.round(amount * 100) / 100;
  return { movementId: row.id, reference: row.reference,
    date: new Date(Math.max(...rows.map(line => line.created_at.getTime()))).toISOString(),
    customer: row.customer, cashier: row.cashier, method: row.payment_method, status: row.status,
    note: [...new Set(rows.map(line => line.note).filter(Boolean))].join("; ") || null,
    items, subtotal: money(items.reduce((sum, item) => sum + item.total, 0)),
    discount: money(rows.reduce((sum, line) => sum + Number(line.discount_amount ?? 0), 0)),
    total: money(rows.reduce((sum, line) => sum + Number(line.amount), 0)) };
}

export function getSaleReceipt(actorUserId: string, movementId: string) {
  return withUserTransaction(actorUserId, client => readSaleReceipt(client, movementId));
}

export function getSalesHistory(actorUserId: string, input: { page: number; search: string; dateFrom?: string; dateTo?: string }) {
  return withUserTransaction(actorUserId, async client => {
    await requireCashDeviceAccess(client);
    const params = [input.search, input.dateFrom || null, input.dateTo || null];
    const grouped = `WITH sales AS (${saleRows}), collections AS (
      SELECT (array_agg(id ORDER BY line_order, created_at, id))[1] AS id,
        max(created_at) AS date,
        (array_agg(reference ORDER BY line_order, created_at, id))[1] AS reference,
        (array_agg(customer ORDER BY line_order, created_at, id))[1] AS customer,
        (array_agg(cashier ORDER BY line_order, created_at, id))[1] AS cashier,
        min(payment_method::text) AS method, sum(amount)::text AS total, min(status) AS status,
        CASE WHEN count(*) > 1 AND bool_or(category = 'enrollment') THEN 'membership_enrollment'
          ELSE min(category) END AS category,
        string_agg(customer || ' ' || reference || ' ' || coalesce(note, ''), ' ') AS search_text
      FROM sales GROUP BY group_key
    )`;
    const filter = `FROM collections
      WHERE ($1 = '' OR strpos(lower(search_text), lower($1)) > 0)
        AND ($2::date IS NULL OR date >= ($2::date::timestamp AT TIME ZONE 'America/Guatemala'))
        AND ($3::date IS NULL OR date < (($3::date + 1)::timestamp AT TIME ZONE 'America/Guatemala'))`;
    const count = await client.query<{ total: number }>(grouped + " SELECT count(*)::int AS total " + filter, params);
    const result = await client.query<{
      id: string; date: Date; reference: string; customer: string; cashier: string;
      method: string; total: string; status: string; category: string;
    }>(grouped + " SELECT id, date, reference, customer, cashier, method, total, status, category "
      + filter + " ORDER BY date DESC, id DESC LIMIT 20 OFFSET $4", [...params, (input.page - 1) * 20]);
    return { data: result.rows.map(row => ({ ...row, total: Number(row.total), date: row.date.toISOString() })),
      total: count.rows[0]?.total ?? 0, page: input.page, pageSize: 20 };
  });
}

export function getPaymentReceipt(actorUserId: string, paymentId: string) {
  return withUserTransaction(actorUserId, async client => {
    await requireCashDeviceAccess(client);
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM public.cash_movements WHERE source_payment_id = $1 AND movement_type = 'sale' ORDER BY created_at LIMIT 1", [paymentId]);
    if (!rows[0]) throw new AppError(404, "SALE_NOT_FOUND", "Este pago no tiene un movimiento de venta asociado");
    return readSaleReceipt(client, rows[0].id);
  });
}
