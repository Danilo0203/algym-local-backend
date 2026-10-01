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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testEmailDomain = "@payments.test.local";
const password = "PasswordDePrueba123";
const createdPlanIds: number[] = [];
const createdRoleIds: string[] = [];

function adminSql(sql: string) {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

async function createUser(role: "admin" | "client" | "custom", name: string, panelRoleId?: string) {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`,
    [userId, email, hash],
  );
  adminSql(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, gender, role, biometric_id, is_active, panel_role_id)
    VALUES ('${userId}', '${name}', '55540000', DATE '1990-01-01',
            'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true,
            ${panelRoleId ? `'${panelRoleId}'` : "NULL"})`);
  return { email, userId };
}

async function login(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return cookie;
}

after(async () => {
  adminSql(`DELETE FROM public.payments
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.subscriptions
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');`);
  if (createdPlanIds.length) adminSql(`DELETE FROM public.plans WHERE id IN (${createdPlanIds.join(",")});`);
  await pool.query(
    "DELETE FROM auth.sessions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE $1)",
    [`%${testEmailDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testEmailDomain}`]);
  if (createdRoleIds.length) adminSql(`DELETE FROM public.role_permissions WHERE role_id IN (${createdRoleIds.map((id) => `'${id}'`).join(",")});
    DELETE FROM public.roles WHERE id IN (${createdRoleIds.map((id) => `'${id}'`).join(",")});`);
  await pool.end();
});

test("Pagos conserva reversados y expone detalle a un rol con payments.view", async () => {
  const admin = await createUser("admin", "ZZTEST PAGOS AUDITOR ADMIN");
  const client = await createUser("client", "ZZTEST PAGOS AUDITOR SOCIO");
  const roleId = randomUUID();
  createdRoleIds.push(roleId);
  const planId = Math.floor(900000000000 + Math.random() * 1000000);
  createdPlanIds.push(planId);
  const subscriptionId = randomUUID();
  const reversedId = randomUUID();
  const postedId = randomUUID();
  adminSql(`INSERT INTO public.roles (id, slug, name, scope, is_system)
    VALUES ('${roleId}', 'zz_payments_${roleId.slice(0, 8)}', 'ZZTEST Auditor pagos', 'panel', false);
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT '${roleId}', id FROM public.permissions WHERE key = 'payments.view';
    INSERT INTO public.plans (id, name, duration_days, price, is_active)
    VALUES (${planId}, 'ZZTEST PAGOS PLAN INACTIVO', 30, 300, false);
    INSERT INTO public.subscriptions (id, user_id, plan_id, start_date, end_date, status)
    VALUES ('${subscriptionId}', '${client.userId}', ${planId}, '2026-09-01', '2026-10-01', 'active');
    INSERT INTO public.payments
      (id, subscription_id, user_id, amount_original, discount_amount, amount_paid,
       method, payment_date, created_by_user_id, status, reversed_at, reversal_reason,
       replacement_payment_id)
    VALUES ('${postedId}', '${subscriptionId}', '${client.userId}', 250, 50, 200,
      'card', '2026-09-21T12:00:00Z', '${admin.userId}', 'posted', NULL, NULL, NULL),
      ('${reversedId}', '${subscriptionId}', '${client.userId}', 300, 0, 300,
      'cash', '2026-09-20T12:00:00Z', '${admin.userId}', 'reversed',
      '2026-09-21T12:00:00Z', 'Monto incorrecto', '${postedId}');`);

  const auditor = await createUser("custom", "ZZTEST PAGOS AUDITOR", roleId);
  const cookie = await login(auditor.email);
  const listed = await request(app)
    .get("/payments?user_name=ZZTEST%20PAGOS%20AUDITOR%20SOCIO&sort=status:asc")
    .set("Cookie", cookie);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.total, 2);
  assert.deepEqual(new Set(listed.body.data.map((row: { status: string }) => row.status)),
    new Set(["posted", "reversed"]));
  assert.equal(listed.body.data[0].plan_name, "ZZTEST PAGOS PLAN INACTIVO");
  assert.equal(listed.body.data[0].subscription_id, subscriptionId);

  const reversedOnly = await request(app)
    .get("/payments?status=reversed&user_name=ZZTEST%20PAGOS%20AUDITOR%20SOCIO")
    .set("Cookie", cookie);
  assert.equal(reversedOnly.status, 200);
  assert.equal(reversedOnly.body.total, 1);
  assert.equal(reversedOnly.body.data[0].id, reversedId);

  const detail = await request(app).get(`/payments/${reversedId}`).set("Cookie", cookie);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.user_name, "ZZTEST PAGOS AUDITOR SOCIO");
  assert.equal(detail.body.plan_name, "ZZTEST PAGOS PLAN INACTIVO");
  assert.equal(detail.body.reversal_reason, "Monto incorrecto");
  assert.equal(detail.body.replacement_payment_id, postedId);
  assert.equal((await request(app).get("/customers").set("Cookie", cookie)).status, 403);
  assert.equal((await request(app).post(`/payments/${postedId}/reverse`)
    .set("Cookie", cookie).send({
      amountOriginal: 250, discountAmount: 50, amountPaid: 200,
      paymentMethod: "card", reason: "Intento no autorizado", sourceCategory: "membership",
    })).status, 403);
});

test("GET /payments exige sesión y permiso", async () => {
  assert.equal((await request(app).get("/payments")).status, 401);
  const client = await createUser("client", "ZZTEST PAGOS CLIENTE");
  const cookie = await login(client.email);
  const denied = await request(app).get("/payments").set("Cookie", cookie);
  assert.equal(denied.status, 403);
});

test("GET /payments lista pagos locales con filtros, orden y paginación", async () => {
  const admin = await createUser("admin", "ZZTEST PAGOS ADMIN");
  const client = await createUser("client", "ZZTEST PAGOS SOCIO");
  const cookie = await login(admin.email);
  const cashPaymentId = randomUUID();
  const cardPaymentId = randomUUID();
  adminSql(`INSERT INTO public.payments
    (id, user_id, amount_original, discount_amount, amount_paid, method, payment_date,
     created_by_user_id, status)
    VALUES
    ('${cashPaymentId}', '${client.userId}', 150, 0, 150, 'cash',
     TIMESTAMPTZ '2026-09-15 10:00:00-06', '${admin.userId}', 'posted'),
    ('${cardPaymentId}', '${client.userId}', 200, 0, 200, 'card',
     TIMESTAMPTZ '2026-09-16 10:00:00-06', '${admin.userId}', 'posted')`);

  const response = await request(app)
    .get("/payments?page=1&perPage=1&user_name=ZZTEST%20PAGOS%20SOCIO&sort=amount_paid:desc")
    .set("Cookie", cookie);
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].id, cardPaymentId);
  assert.equal(response.body.data[0].amount_paid, 200);
  assert.equal(response.body.data[0].user_name, "ZZTEST PAGOS SOCIO");

  const filtered = await request(app)
    .get("/payments?user_name=ZZTEST%20PAGOS%20SOCIO&method=cash&payment_date_start=2026-09-15T00%3A00%3A00.000Z&payment_date_end=2026-09-16T00%3A00%3A00.000Z")
    .set("Cookie", cookie);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.data[0].id, cashPaymentId);

  const invalid = await request(app)
    .get("/payments?sort=payment_date:desc;DROP%20TABLE%20payments")
    .set("Cookie", cookie);
  assert.equal(invalid.status, 400);
});
