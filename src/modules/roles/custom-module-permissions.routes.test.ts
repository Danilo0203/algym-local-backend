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
import { withUserTransaction } from "../../db/transaction.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testDomain = "@rbac-modules.test.local";
const password = "PasswordDePrueba123";
const roleSlugs: string[] = [];
const actorIds: string[] = [];
const planIds: number[] = [];
const messageIds: string[] = [];

function adminSql(sql: string): void {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

async function createActor(permissionKeys: string[]) {
  const slug = `zz_local_rbac_${randomUUID().slice(0, 8)}`;
  roleSlugs.push(slug);
  const keys = permissionKeys.map((key) => `'${key}'`).join(", ");
  adminSql(`
    INSERT INTO public.roles (slug, name, scope, is_system, is_protected)
    VALUES ('${slug}', 'Prueba permisos locales', 'panel', false, false);
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT role.id, permission.id
    FROM public.roles AS role CROSS JOIN public.permissions AS permission
    WHERE role.slug = '${slug}' AND permission.key IN (${keys});
  `);

  const id = randomUUID();
  actorIds.push(id);
  const email = `${id}${testDomain}`;
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [id, email, await bcrypt.hash(password, 10)],
  );
  adminSql(`
    INSERT INTO public.profiles
      (id, full_name, phone, birth_date, role, panel_role_id, biometric_id, is_active)
    VALUES ('${id}', 'ZZTEST LOCAL RBAC', '', DATE '1990-01-01', 'custom',
      (SELECT id FROM public.roles WHERE slug = '${slug}'),
      ${Math.floor(Math.random() * 1000000)}, true);
  `);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

after(async () => {
  if (messageIds.length > 0) {
    adminSql(`DELETE FROM public.message_templates WHERE id IN (${messageIds.map((id) => `'${id}'`).join(",")});`);
  }
  if (planIds.length > 0) {
    adminSql(`DELETE FROM public.plans WHERE id IN (${planIds.join(",")});`);
  }
  if (actorIds.length > 0) {
    const ids = actorIds.map((id) => `'${id}'`).join(",");
    adminSql(`DELETE FROM public.profiles WHERE id IN (${ids});
      DELETE FROM auth.sessions WHERE user_id IN (${ids});
      DELETE FROM auth.users WHERE id IN (${ids});`);
  }
  if (roleSlugs.length > 0) {
    adminSql(`DELETE FROM public.roles WHERE slug IN (${roleSlugs.map((slug) => `'${slug}'`).join(",")});`);
  }
  await pool.end();
});

test("roles personalizados separan lectura y escritura de planes y mensajes en API y RLS", async () => {
  const reader = await createActor(["plans.view", "messages.view"]);
  const manager = await createActor([
    "plans.view", "plans.create", "plans.update", "plans.delete",
    "messages.view", "messages.create", "messages.update", "messages.delete",
  ]);

  assert.equal((await request(app).get("/plans").set("Cookie", reader.cookie)).status, 200);
  assert.equal((await request(app).get("/messages").set("Cookie", reader.cookie)).status, 200);
  const planInput = { name: `ZZTEST LOCAL RBAC PLAN ${randomUUID()}`, price: 100, duration_days: 30 };
  const messageInput = { name: `ZZTEST LOCAL RBAC MESSAGE ${randomUUID()}`, content: "Hola cliente" };
  assert.equal((await request(app).post("/plans").set("Cookie", reader.cookie).send(planInput)).status, 403);
  assert.equal((await request(app).post("/messages").set("Cookie", reader.cookie).send(messageInput)).status, 403);

  const plan = await request(app).post("/plans").set("Cookie", manager.cookie).send(planInput);
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  planIds.push(Number(plan.body.id));
  const message = await request(app).post("/messages").set("Cookie", manager.cookie).send(messageInput);
  assert.equal(message.status, 201, JSON.stringify(message.body));
  messageIds.push(message.body.id as string);

  const deniedPlanUpdate = await withUserTransaction(reader.id, (client) =>
    client.query("UPDATE public.plans SET price = 101 WHERE id = $1", [plan.body.id]));
  assert.equal(deniedPlanUpdate.rowCount, 0);
  const deniedMessageUpdate = await withUserTransaction(reader.id, (client) =>
    client.query("UPDATE public.message_templates SET content = 'Prohibido' WHERE id = $1", [message.body.id]));
  assert.equal(deniedMessageUpdate.rowCount, 0);

  assert.equal((await request(app).put(`/plans/${plan.body.id}`).set("Cookie", reader.cookie)
    .send({ price: 101 })).status, 403);
  assert.equal((await request(app).patch(`/messages/${message.body.id}`).set("Cookie", reader.cookie)
    .send({ content: "Prohibido" })).status, 403);
  assert.equal((await request(app).put(`/plans/${plan.body.id}`).set("Cookie", manager.cookie)
    .send({ price: 125 })).status, 200);
  assert.equal((await request(app).patch(`/messages/${message.body.id}`).set("Cookie", manager.cookie)
    .send({ content: "Texto nuevo" })).status, 200);
  assert.equal((await request(app).delete(`/plans/${plan.body.id}`).set("Cookie", manager.cookie)).status, 200);
  assert.equal((await request(app).delete(`/messages/${message.body.id}`).set("Cookie", manager.cookie)).status, 204);
  messageIds.pop();
});
