import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { pool } from "../../db/pool.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const domain = "@inventory.test.local";
const password = "InventoryTest123";
const mediaRoot = mkdtempSync(path.join(tmpdir(), "algym-inventory-test-"));
const previousMediaRoot = process.env.LOCAL_MEDIA_ROOT;
process.env.LOCAL_MEDIA_ROOT = mediaRoot;
let productId: string | null = null;

function adminSql(sql: string): string {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], {
    cwd: root, encoding: "utf8",
  }).trim();
}

async function createActor(role: "owner" | "employee" | "client") {
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
    VALUES ('${id}', 'ZZTEST INVENTORY ${role}', '55540000', DATE '1990-01-01',
      'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

after(async () => {
  if (productId) adminSql(`DELETE FROM public.inventory_movements WHERE product_id = '${productId}';
    DELETE FROM public.products WHERE id = '${productId}';`);
  adminSql(`DELETE FROM public.role_permissions AS rp USING public.roles AS role,
      public.permissions AS permission
    WHERE rp.role_id = role.id AND rp.permission_id = permission.id
      AND role.slug = 'employee'
      AND permission.key IN ('products.view', 'products.update', 'inventory.view', 'inventory.adjust');
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');`);
  await pool.query(`DELETE FROM auth.sessions WHERE user_id IN
    (SELECT id FROM auth.users WHERE email LIKE $1)`, [`%${domain}`]);
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${domain}`]);
  await pool.end();
  if (previousMediaRoot === undefined) delete process.env.LOCAL_MEDIA_ROOT;
  else process.env.LOCAL_MEDIA_ROOT = previousMediaRoot;
  rmSync(mediaRoot, { recursive: true, force: true });
});

test("inventario local guarda imagen, producto y stock; empleados ajustan sin editar catálogo", async () => {
  adminSql(`INSERT INTO public.permissions (key, description, module, action)
    VALUES ('products.view','Prueba inventario','products','view'),
           ('products.update','Prueba inventario','products','update'),
           ('inventory.view','Prueba inventario','inventory','view'),
           ('inventory.adjust','Prueba inventario','inventory','adjust')
    ON CONFLICT (key) DO NOTHING;
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT role.id, permission.id
    FROM public.roles AS role CROSS JOIN public.permissions AS permission
    WHERE role.slug = 'employee'
      AND permission.key IN ('products.view', 'inventory.view', 'inventory.adjust')
    ON CONFLICT (role_id, permission_id) DO NOTHING;`);
  const owner = await createActor("owner");
  const employee = await createActor("employee");
  const client = await createActor("client");
  assert.equal((await request(app).get("/inventory/products")).status, 401);
  assert.equal((await request(app).get("/inventory/products").set("Cookie", client.cookie)).status, 403);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await request(app).post("/media/products").set("Cookie", owner.cookie)
    .set("Content-Type", "image/png").send(png);
  assert.equal(uploaded.status, 201);

  const input = {
    name: "ZZTEST PRODUCTO LOCAL", sku: "ZINV-1", barcode: null,
    costPrice: 4, salePrice: 10, isActive: true,
    imageUrl: uploaded.body.url, initialQuantity: 5,
  };
  const created = await request(app).post("/inventory/products")
    .set("Cookie", owner.cookie).send(input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  productId = created.body.id;
  assert.ok(productId);

  const listed = await request(app).get("/inventory/products?name=ZINV-1")
    .set("Cookie", employee.cookie);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.data[0].stock_quantity, 5);
  assert.equal(listed.body.data[0].image_url, uploaded.body.url);
  const { initialQuantity: _initialQuantity, ...updateInput } = input;
  assert.equal((await request(app).put(`/inventory/products/${productId}`)
    .set("Cookie", employee.cookie).send(updateInput)).status, 403);

  adminSql(`INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT role.id, permission.id FROM public.roles AS role CROSS JOIN public.permissions AS permission
    WHERE role.slug='employee' AND permission.key='products.update'
    ON CONFLICT (role_id, permission_id) DO NOTHING`);
  const staffEdit = await request(app).put(`/inventory/products/${productId}`)
    .set("Cookie", employee.cookie).send({ ...updateInput, salePrice: 11 });
  assert.equal(staffEdit.status, 200, JSON.stringify(staffEdit.body));

  const tooMuch = await request(app).post(`/inventory/products/${productId}/movements`)
    .set("Cookie", employee.cookie)
    .send({ movementType: "manual_exit", quantity: 6 });
  assert.equal(tooMuch.status, 409);
  const adjusted = await request(app).post(`/inventory/products/${productId}/adjust`)
    .set("Cookie", employee.cookie).send({ countedQuantity: 2, note: "Conteo" });
  assert.equal(adjusted.status, 201, JSON.stringify(adjusted.body));
  const received = await request(app).post(`/inventory/products/${productId}/movements`)
    .set("Cookie", employee.cookie).send({ movementType: "entry", quantity: 3 });
  assert.equal(received.status, 201, JSON.stringify(received.body));
  const left = await request(app).post(`/inventory/products/${productId}/movements`)
    .set("Cookie", employee.cookie).send({ movementType: "manual_exit", quantity: 1 });
  assert.equal(left.status, 201, JSON.stringify(left.body));

  const movements = await request(app).get("/inventory/movements?productName=ZINV-1")
    .set("Cookie", employee.cookie);
  assert.equal(movements.status, 200, JSON.stringify(movements.body));
  assert.equal(movements.body.total, 4);
  assert.equal(movements.body.data[0].product_name, input.name);
  const final = await request(app).get("/inventory/products?name=ZINV-1")
    .set("Cookie", owner.cookie);
  assert.equal(final.body.data[0].stock_quantity, 4);
  assert.equal(adminSql(`SELECT sum(quantity_delta) FROM public.inventory_movements WHERE product_id='${productId}'`), "4.000");

  const changed = await request(app).put(`/inventory/products/${productId}`)
    .set("Cookie", owner.cookie)
    .send({ ...updateInput, name: "ZZTEST PRODUCTO EDITADO" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const deactivated = await request(app).delete(`/inventory/products/${productId}`)
    .set("Cookie", owner.cookie);
  assert.equal(deactivated.status, 200);
  const inactive = await request(app).get("/inventory/products?isActive=false&name=ZINV-1")
    .set("Cookie", owner.cookie);
  assert.equal(inactive.body.total, 1);
});
