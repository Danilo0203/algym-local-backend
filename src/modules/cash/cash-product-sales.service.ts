import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { CashProductSaleInput, CashProductSaleVoidInput } from "./cash.schemas.js";

type Authorization = { permissions: string[] | null; is_owner: boolean };
type Product = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  image_url: string | null;
  sale_price: string;
  stock_quantity: string;
  is_active: boolean;
};

async function requireCashProductAccess(client: PoolClient, canSell: boolean) {
  const authorization = await client.query<Authorization>(
    `SELECT public.get_current_permissions() AS permissions,
            public.is_owner() AS is_owner`,
  );
  const auth = authorization.rows[0];
  const permissions = auth?.permissions ?? [];
  if (!auth?.is_owner && (!permissions.includes("cash.operate") ||
      (canSell && !permissions.includes("inventory.sell")))) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para vender productos en caja");
  }
}

async function requireOwnOpenSession(client: PoolClient, actorUserId: string) {
  const session = await client.query<{ id: string }>(
    `SELECT id FROM public.find_open_cash_session_for_user($1::uuid)`,
    [actorUserId],
  );
  if (!session.rows[0]) {
    throw new AppError(409, "CASH_SESSION_REQUIRED", "Abre una caja antes de vender o anular productos");
  }
}

function localProductImage(value: string | null) {
  return value?.startsWith("/api/media/products/") ? value : null;
}

export async function searchCashProducts(actorUserId: string, search: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireCashProductAccess(client, true);
    await requireOwnOpenSession(client, actorUserId);
    const result = await client.query<Product>(
      `SELECT id, name, sku, barcode, image_url, sale_price,
              stock_quantity, is_active
       FROM public.product_inventory_overview
       WHERE is_active = true
         AND ($1 = '' OR strpos(lower(name), lower($1)) > 0
              OR strpos(lower(coalesce(sku, '')), lower($1)) > 0
              OR strpos(lower(coalesce(barcode, '')), lower($1)) > 0)
       ORDER BY name, id LIMIT 12`,
      [search],
    );
    return result.rows.map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      image_url: localProductImage(product.image_url),
      sale_price: Number(product.sale_price),
      stock_quantity: Number(product.stock_quantity),
      is_active: product.is_active,
    }));
  });
}

export async function sellCashProducts(actorUserId: string, input: CashProductSaleInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireCashProductAccess(client, true);
    await requireOwnOpenSession(client, actorUserId);

    // El bloqueo sigue vigente durante la comprobación y la venta atómica.
    const quantities = new Map<string, number>();
    for (const item of input.items) {
      quantities.set(item.productId,
        (quantities.get(item.productId) ?? 0) + Math.round(item.quantity * 1_000));
    }
    const ids = [...quantities.keys()].sort();
    const products = await client.query<{ id: string; name: string; is_active: boolean }>(
      `SELECT id, name, is_active FROM public.lock_cash_sale_products($1::uuid[])`,
      [ids],
    );
    if (products.rows.length !== ids.length) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Producto no encontrado");
    }
    const stock = await client.query<{ product_id: string; quantity: string }>(
      `SELECT product_id, COALESCE(sum(quantity_delta), 0)::text AS quantity
       FROM public.inventory_movements
       WHERE product_id = ANY($1::uuid[]) GROUP BY product_id`,
      [ids],
    );
    const stockById = new Map(stock.rows.map((row) => [row.product_id, Number(row.quantity)]));
    for (const product of products.rows) {
      if (!product.is_active) {
        throw new AppError(409, "PRODUCT_INACTIVE", `El producto ${product.name} está inactivo`);
      }
      const requested = (quantities.get(product.id) ?? 0) / 1_000;
      if ((stockById.get(product.id) ?? 0) + 1e-9 < requested) {
        throw new AppError(409, "INSUFFICIENT_STOCK", `No hay existencias suficientes de ${product.name}`);
      }
    }

    const items = ids.map((productId) => ({
      product_id: productId,
      quantity: (quantities.get(productId) ?? 0) / 1_000,
    }));
    const result = await client.query<{ sale: {
      product_sale_id: string;
      sale_number: string;
      cash_movement_id: string;
      total_amount: number;
    } }>(
      `SELECT public.sell_products_from_cash_session($1::jsonb, $2::text, $3::text) AS sale`,
      [JSON.stringify(items), input.paymentMethod, input.note ?? null],
    );
    return result.rows[0]!.sale;
  });
}

export async function voidCashProductSale(
  actorUserId: string, saleId: string, input: CashProductSaleVoidInput,
) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireCashProductAccess(client, false);
    await requireOwnOpenSession(client, actorUserId);
    const existing = await client.query<{
      status: string;
      sold_by_user_id: string;
      is_owner: boolean;
    }>(
      `SELECT sale.status, sale.sold_by_user_id, public.is_owner() AS is_owner
       FROM public.product_sales AS sale WHERE sale.id = $1 FOR UPDATE`,
      [saleId],
    );
    const sale = existing.rows[0];
    if (!sale) throw new AppError(404, "SALE_NOT_FOUND", "Venta no encontrada");
    if (!sale.is_owner && sale.sold_by_user_id !== actorUserId) {
      throw new AppError(403, "FORBIDDEN", "No autorizado para anular una venta de otro cajero");
    }
    if (sale.status !== "posted") {
      throw new AppError(409, "SALE_ALREADY_VOIDED", "La venta ya está anulada");
    }
    const result = await client.query<{ sale: {
      product_sale_id: string;
      cash_movement_id: string;
      inventory_movement_count: number;
    } }>(
      `SELECT public.void_product_sale_from_cash_session($1::uuid, $2::text) AS sale`,
      [saleId, input.note ?? null],
    );
    return result.rows[0]!.sale;
  });
}
