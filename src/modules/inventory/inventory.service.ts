import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { lockMediaFilename, readMedia } from "../media/media.service.js";
import type {
  CreateProductInput, InventoryAdjustmentInput, InventoryMovementInput,
  InventoryMovementsQuery, ProductListQuery, UpdateProductInput,
} from "./inventory.schemas.js";

type ProductRow = {
  id: string; name: string; sku: string | null; barcode: string | null;
  image_url: string | null; cost_price: string; sale_price: string;
  stock_quantity: string; is_active: boolean; last_movement_at: Date | null;
  updated_at: Date;
};
type MovementRow = {
  id: string; product_id: string; product_name: string | null;
  movement_type: "entry" | "sale" | "manual_exit" | "adjustment" | "void";
  quantity_delta: string; quantity_before: string | null; quantity_after: string | null;
  unit_cost: string | null; unit_price: string | null;
  source_product_sale_id: string | null; sale_number: string | null;
  created_by_name: string | null; note: string | null; created_at: Date;
};

async function requirePermission(client: PoolClient, permission: string) {
  const result = await client.query<{ permissions: string[] | null; is_owner: boolean }>(
    "SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner",
  );
  const auth = result.rows[0];
  if (!auth?.is_owner && !auth?.permissions?.includes(permission)) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para administrar inventario");
  }
}

function localImage(value: string | null) {
  return /^\/api\/media\/products\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(value ?? "") ? value : null;
}

function mapProduct(row: ProductRow) {
  return {
    ...row,
    image_url: localImage(row.image_url),
    cost_price: Number(row.cost_price),
    sale_price: Number(row.sale_price),
    stock_quantity: Number(row.stock_quantity),
    last_movement_at: row.last_movement_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  };
}

function mapMovement(row: MovementRow) {
  return {
    ...row,
    product_name: row.product_name || "Producto",
    quantity_delta: Number(row.quantity_delta),
    quantity_before: row.quantity_before === null ? null : Number(row.quantity_before),
    quantity_after: row.quantity_after === null ? null : Number(row.quantity_after),
    unit_cost: row.unit_cost === null ? null : Number(row.unit_cost),
    unit_price: row.unit_price === null ? null : Number(row.unit_price),
    created_by_name: row.created_by_name || "Usuario",
    created_at: row.created_at.toISOString(),
  };
}

function databaseError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    throw new AppError(409, "PRODUCT_DUPLICATE", "El SKU o código de barras ya existe");
  }
  throw error;
}

const productColumns = `id, name, sku, barcode, image_url, cost_price, sale_price,
  stock_quantity, is_active, last_movement_at, updated_at`;

export async function listProducts(actorUserId: string, query: ProductListQuery) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "products.view");
    const search = query.name ?? "";
    const active = query.isActive?.split(",").map((value) => value === "true") ?? null;
    const where = `($1 = '' OR strpos(lower(name), lower($1)) > 0
      OR strpos(lower(coalesce(sku, '')), lower($1)) > 0
      OR strpos(lower(coalesce(barcode, '')), lower($1)) > 0)
      AND ($2::boolean[] IS NULL OR is_active = ANY($2::boolean[]))`;
    const count = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM public.product_inventory_overview WHERE ${where}`,
      [search, active],
    );
    const rows = await client.query<ProductRow>(
      `SELECT ${productColumns} FROM public.product_inventory_overview
       WHERE ${where} ORDER BY name, id LIMIT $3 OFFSET $4`,
      [search, active, query.perPage, (query.page - 1) * query.perPage],
    );
    return { data: rows.rows.map(mapProduct), total: Number(count.rows[0]?.total ?? 0) };
  });
}

async function assertMediaExists(client: PoolClient, imageUrl: string | null | undefined) {
  if (imageUrl) {
    const filename = imageUrl.split("/").at(-1)!;
    await lockMediaFilename(client, "products", filename);
    await readMedia("products", filename);
  }
}

export async function createProduct(actorUserId: string, input: CreateProductInput) {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      await requirePermission(client, "products.create");
      if (input.initialQuantity > 0) await requirePermission(client, "inventory.adjust");
      await assertMediaExists(client, input.imageUrl);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.products
          (name, sku, barcode, cost_price, sale_price, is_active, image_url,
           created_by_user_id, updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
        [input.name, input.sku ?? null, input.barcode ?? null, input.costPrice,
          input.salePrice, input.isActive, input.imageUrl ?? null, actorUserId],
      );
      const id = inserted.rows[0]!.id;
      if (input.initialQuantity > 0) {
        await client.query(
          `INSERT INTO public.inventory_movements
             (product_id, movement_type, quantity_delta, quantity_before, quantity_after,
              unit_cost, created_by_user_id, note)
           VALUES ($1, 'entry', $2, 0, $2, $3, $4, 'Stock inicial')`,
          [id, input.initialQuantity, input.costPrice, actorUserId],
        );
      }
      return { id };
    });
  } catch (error) { databaseError(error); }
}

export async function updateProduct(actorUserId: string, id: string, input: UpdateProductInput) {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      await requirePermission(client, "products.update");
      await assertMediaExists(client, input.imageUrl);
      const updated = await client.query<{ id: string }>(
        `UPDATE public.products SET
           name=$2, sku=$3, barcode=$4, cost_price=$5, sale_price=$6,
           is_active=$7, image_url=CASE WHEN $8::boolean THEN $9 ELSE image_url END,
           updated_by_user_id=$10
         WHERE id=$1 RETURNING id`,
        [id, input.name, input.sku ?? null, input.barcode ?? null,
          input.costPrice, input.salePrice, input.isActive,
          Object.hasOwn(input, "imageUrl"), input.imageUrl ?? null, actorUserId],
      );
      if (!updated.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "Producto no encontrado");
      return updated.rows[0];
    });
  } catch (error) { databaseError(error); }
}

export async function deactivateProduct(actorUserId: string, id: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "products.delete");
    const updated = await client.query<{ id: string }>(
      `UPDATE public.products SET is_active=false, updated_by_user_id=$2
       WHERE id=$1 RETURNING id`,
      [id, actorUserId],
    );
    if (!updated.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "Producto no encontrado");
    return updated.rows[0];
  });
}

async function lockedProduct(client: PoolClient, id: string) {
  const rows = await client.query<{ id: string; cost_price: string; sale_price: string }>(
    "SELECT id, cost_price, sale_price FROM public.lock_inventory_product_for_adjustment($1::uuid)",
    [id],
  );
  if (!rows.rows[0]) throw new AppError(404, "PRODUCT_NOT_FOUND", "Producto no encontrado");
  return rows.rows[0];
}

async function stockForProduct(client: PoolClient, id: string) {
  const result = await client.query<{ quantity: string }>(
    `SELECT COALESCE(sum(quantity_delta), 0)::text AS quantity
     FROM public.inventory_movements WHERE product_id=$1`,
    [id],
  );
  return Number(result.rows[0]?.quantity ?? 0);
}

export async function recordMovement(actorUserId: string, id: string, input: InventoryMovementInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "inventory.adjust");
    const product = await lockedProduct(client, id);
    const before = await stockForProduct(client, id);
    const delta = input.movementType === "entry" ? input.quantity : -input.quantity;
    if (before + delta < -1e-9) {
      throw new AppError(409, "INSUFFICIENT_STOCK", "No hay existencias suficientes para la salida");
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.inventory_movements
        (product_id, movement_type, quantity_delta, quantity_before, quantity_after,
         unit_cost, created_by_user_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [id, input.movementType, delta, before, before + delta,
        input.unitCost ?? Number(product.cost_price), actorUserId, input.note ?? null],
    );
    return inserted.rows[0]!;
  });
}

export async function adjustStock(actorUserId: string, id: string, input: InventoryAdjustmentInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "inventory.adjust");
    const product = await lockedProduct(client, id);
    const before = await stockForProduct(client, id);
    const delta = input.countedQuantity - before;
    if (Math.abs(delta) < 1e-9) return { id: null };
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.inventory_movements
        (product_id, movement_type, quantity_delta, quantity_before, quantity_after,
         unit_cost, created_by_user_id, note)
       VALUES ($1,'adjustment',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [id, delta, before, input.countedQuantity, Number(product.cost_price),
        actorUserId, input.note ?? null],
    );
    return inserted.rows[0]!;
  });
}

export async function listMovements(actorUserId: string, query: InventoryMovementsQuery) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "inventory.view");
    const search = query.productName ?? "";
    const types = query.movementType?.split(",") ?? null;
    const from = `FROM public.inventory_movements AS movement
      LEFT JOIN public.products AS product ON product.id=movement.product_id
      LEFT JOIN public.profiles AS creator ON creator.id=movement.created_by_user_id
      LEFT JOIN public.product_sales AS sale ON sale.id=movement.source_product_sale_id
      WHERE ($1 = '' OR strpos(lower(coalesce(product.name, '')), lower($1)) > 0
        OR strpos(lower(coalesce(product.sku, '')), lower($1)) > 0
        OR strpos(lower(coalesce(product.barcode, '')), lower($1)) > 0)
        AND ($2::text[] IS NULL OR movement.movement_type = ANY($2::text[]))`;
    const count = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total ${from}`, [search, types],
    );
    const rows = await client.query<MovementRow>(
      `SELECT movement.id, movement.product_id, product.name AS product_name,
         movement.movement_type, movement.quantity_delta, movement.quantity_before,
         movement.quantity_after, movement.unit_cost, movement.unit_price,
         movement.source_product_sale_id, sale.sale_number,
         creator.full_name AS created_by_name, movement.note, movement.created_at
       ${from} ORDER BY movement.created_at DESC, movement.id DESC
       LIMIT $3 OFFSET $4`,
      [search, types, query.perPage, (query.page - 1) * query.perPage],
    );
    return { data: rows.rows.map(mapMovement), total: Number(count.rows[0]?.total ?? 0) };
  });
}
