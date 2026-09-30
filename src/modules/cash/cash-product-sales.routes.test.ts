import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { pool } from "../../db/pool.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const domain = "@product-sale.test.local";
const password = "ProductSaleTest123";
const productId = randomUUID();
const registerId = randomUUID();

function adminSql(sql: string): string {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], {
    cwd: root, encoding: "utf8",
  }).trim();
}

async function createActor(role: "admin" | "employee" | "client") {
  const id = randomUUID();
  const email = `${id}${domain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`,
    [id, email, hash],
  );
  adminSql(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES ('${id}', 'ZZTEST PRODUCT SALE ${role}', '55540000', DATE '1990-01-01',
      'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

after(async () => {
  adminSql(`DELETE FROM public.cash_movements
    WHERE created_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.inventory_movements WHERE product_id = '${productId}';
    DELETE FROM public.product_sale_items WHERE product_id = '${productId}';
    DELETE FROM public.product_sales
    WHERE sold_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.products WHERE id = '${productId}';
    DELETE FROM public.cash_sessions
    WHERE opened_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_registers WHERE id = '${registerId}';
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');`);
  adminSql(`DELETE FROM public.role_permissions AS rp USING public.roles AS role,
      public.permissions AS permission
    WHERE rp.role_id = role.id AND rp.permission_id = permission.id
      AND ((role.slug = 'employee' AND permission.key = 'inventory.sell')
        OR (role.slug IN ('admin', 'employee') AND permission.key = 'cash.operate'));`);
  await pool.query(`DELETE FROM auth.sessions WHERE user_id IN
    (SELECT id FROM auth.users WHERE email LIKE $1)`, [`%${domain}`]);
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${domain}`]);
  await pool.end();
});

test("venta local vincula inventario y caja; anulación restaura ambos y respeta permisos", async () => {
  adminSql(`INSERT INTO public.permissions (key, description, module, action)
    VALUES ('cash.operate', 'Caja de prueba', 'cash', 'operate'),
           ('inventory.sell', 'Venta de prueba', 'inventory', 'sell')
    ON CONFLICT (key) DO NOTHING;
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT role.id, permission.id
    FROM public.roles AS role CROSS JOIN public.permissions AS permission
    WHERE (role.slug = 'employee' AND permission.key IN ('cash.operate', 'inventory.sell'))
       OR (role.slug = 'admin' AND permission.key = 'cash.operate')
    ON CONFLICT (role_id, permission_id) DO NOTHING;`);
  const seller = await createActor("employee");
  const otherCashier = await createActor("admin");
  const client = await createActor("client");

  assert.equal((await request(app).get("/cash/products/search?search=Prueba")).status, 401);
  assert.equal((await request(app).get("/cash/products/search?search=Prueba")
    .set("Cookie", client.cookie)).status, 403);

  adminSql(`INSERT INTO public.cash_registers (id, name, is_active)
    VALUES ('${registerId}', 'ZZTEST Caja producto', true)`);
  const sellerSession = await request(app).post("/cash/sessions").set("Cookie", seller.cookie)
    .send({ registerId, openingAmount: 10 });
  assert.equal(sellerSession.status, 201);
  const otherSession = await request(app).post("/cash/sessions").set("Cookie", otherCashier.cookie)
    .send({ registerId, openingAmount: 0 });
  assert.equal(otherSession.status, 201);

  adminSql(`INSERT INTO public.products
    (id, name, sku, cost_price, sale_price, is_active, created_by_user_id)
    VALUES ('${productId}', 'ZZTEST PRODUCT SALE', 'ZPS-1', 4, 10, true, '${seller.id}');
    INSERT INTO public.inventory_movements
    (product_id, movement_type, quantity_delta, quantity_before, quantity_after,
     unit_cost, unit_price, created_by_user_id, note)
    VALUES ('${productId}', 'entry', 5, 0, 5, 4, 10, '${seller.id}', 'Existencia de prueba');`);

  const search = await request(app).get("/cash/products/search?search=ZPS-1")
    .set("Cookie", seller.cookie);
  assert.equal(search.status, 200, JSON.stringify(search.body));
  assert.equal(search.body[0]?.id, productId);
  assert.equal(search.body[0]?.stock_quantity, 5);
  assert.equal((await request(app).get("/cash/products/search?search=ZPS-1")
    .set("Cookie", otherCashier.cookie)).status, 403);

  const saleInput = {
    items: [{ productId, quantity: 1 }, { productId, quantity: 2 }],
    paymentMethod: "cash",
  };
  const sale = await request(app).post("/cash/products/sales")
    .set("Cookie", seller.cookie).send(saleInput);
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  assert.equal(Number(sale.body.total_amount), 30);
  assert.ok(sale.body.product_sale_id);
  assert.ok(sale.body.cash_movement_id);
  const persisted = adminSql(`SELECT
    (SELECT count(*) FROM public.product_sale_items WHERE product_sale_id = '${sale.body.product_sale_id}'),
    (SELECT sum(quantity_delta) FROM public.inventory_movements WHERE product_id = '${productId}'),
    (SELECT cash_effect_amount FROM public.cash_movements WHERE id = '${sale.body.cash_movement_id}')`);
  assert.equal(persisted, "1|2.000|30.00");

  const insufficient = await request(app).post("/cash/products/sales")
    .set("Cookie", seller.cookie)
    .send({ items: [{ productId, quantity: 3 }], paymentMethod: "cash" });
  assert.equal(insufficient.status, 409);

  const foreignVoid = await request(app).post(`/cash/products/sales/${sale.body.product_sale_id}/void`)
    .set("Cookie", otherCashier.cookie).send({ note: "Otro cajero" });
  assert.equal(foreignVoid.status, 403);
  const voided = await request(app).post(`/cash/products/sales/${sale.body.product_sale_id}/void`)
    .set("Cookie", seller.cookie).send({ note: "Anulación de prueba" });
  assert.equal(voided.status, 201, JSON.stringify(voided.body));
  assert.equal(voided.body.inventory_movement_count, 1);
  const restored = adminSql(`SELECT
    (SELECT status FROM public.product_sales WHERE id = '${sale.body.product_sale_id}'),
    (SELECT sum(quantity_delta) FROM public.inventory_movements WHERE product_id = '${productId}'),
    (SELECT cash_effect_amount FROM public.cash_movements WHERE id = '${voided.body.cash_movement_id}')`);
  assert.equal(restored, "voided|5.000|-30.00");
  assert.equal((await request(app).post(`/cash/products/sales/${sale.body.product_sale_id}/void`)
    .set("Cookie", seller.cookie).send({})).status, 409);
});
