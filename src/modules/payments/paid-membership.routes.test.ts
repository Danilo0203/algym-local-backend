import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { pool } from "../../db/pool.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const domain = "@paid-membership.test.local";
const password = "PaidMembershipTest123";
const registerName = "ZZTEST PAID MEMBERSHIP REGISTER";
const planName = "ZZTEST PAID MEMBERSHIP PLAN";

function adminSql(sql: string): string {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], {
    cwd: root, encoding: "utf8",
  }).trim();
}

async function createUser(role: "owner" | "admin" | "employee" | "client") {
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
    VALUES ('${id}', 'ZZTEST PAID MEMBERSHIP ${role}', '55550000', DATE '1990-01-01',
      'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

before(() => {
  adminSql(`INSERT INTO public.permissions (key, description, module, action)
    VALUES ('cash.operate', 'Prueba de cobro local', 'cash', 'operate'),
           ('cash.reverse_payment', 'Prueba de reverso local', 'cash', 'reverse_payment')
    ON CONFLICT (key) DO NOTHING;
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
    WHERE (r.slug = 'employee' AND p.key = 'cash.operate')
       OR (r.slug = 'admin' AND p.key IN
         ('cash.operate', 'cash.reverse_payment', 'customers.manage_membership'))
    ON CONFLICT (role_id, permission_id) DO NOTHING;`);
});

after(async () => {
  adminSql(`DELETE FROM public.cash_movements
    WHERE customer_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.payments
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.subscriptions
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_sessions
    WHERE opened_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_registers WHERE name = '${registerName}';
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.plans WHERE name = '${planName}';`);
  await pool.query(`DELETE FROM auth.sessions WHERE user_id IN
    (SELECT id FROM auth.users WHERE email LIKE $1)`, [`%${domain}`]);
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${domain}`]);
  await pool.end();
});

test("cobro local exige autorización y guarda membresía, pago y caja juntos", async () => {
  const owner = await createUser("owner");
  const employee = await createUser("employee");
  const customer = await createUser("client");
  const planId = Number(adminSql(`INSERT INTO public.plans
    (name, duration_days, price, description, is_active)
    VALUES ('${planName}', 30, 125, 'Plan sintético', true) RETURNING id`));
  const input = {
    customerId: customer.id, planId, operation: "create", startDate: "2026-10-01",
    endDate: "2026-10-31", amountOriginal: 125, discountAmount: 5,
    amountPaid: 120, paymentMethod: "cash", requireSession: true,
  };

  assert.equal((await request(app).post("/payments/membership").send(input)).status, 401);
  assert.equal((await request(app).post("/payments/membership")
    .set("Cookie", customer.cookie).send(input)).status, 403);

  const noSession = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send(input);
  assert.equal(noSession.status, 409, JSON.stringify(noSession.body));
  assert.equal(noSession.body.error.code, "CASH_SESSION_REQUIRED");
  assert.equal(adminSql(`SELECT count(*) FROM public.subscriptions WHERE user_id = '${customer.id}'`), "0");
  assert.equal(adminSql(`SELECT count(*) FROM public.payments WHERE user_id = '${customer.id}'`), "0");

  const registerId = adminSql(`INSERT INTO public.cash_registers (name, is_active)
    VALUES ('${registerName}', true) RETURNING id`);
  const opened = await request(app).post("/cash/sessions").set("Cookie", employee.cookie)
    .send({ registerId, openingAmount: 50 });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));

  const created = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send(input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.amount_paid, 120);
  assert.equal(created.body.session_link_status, "assigned");
  assert.equal(adminSql(`SELECT count(*) FROM public.subscriptions WHERE user_id = '${customer.id}'`), "1");
  assert.equal(adminSql(`SELECT amount_paid::text FROM public.payments WHERE id = '${created.body.payment_id}'`), "120.00");
  assert.equal(adminSql(`SELECT cash_effect_amount::text FROM public.cash_movements
    WHERE id = '${created.body.cash_movement_id}'`), "120.00");

  const dashboard = await request(app).get("/cash/dashboard").set("Cookie", employee.cookie);
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
  assert.equal(dashboard.body.summary.expectedAmount, 170);
  const duplicate = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send(input);
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));

  const renewal = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send({
      customerId: customer.id, planId, operation: "renew", paymentMethod: "card",
      requireSession: true,
    });
  assert.equal(renewal.status, 201, JSON.stringify(renewal.body));
  assert.equal(adminSql(`SELECT status::text FROM public.subscriptions
    WHERE id = '${created.body.subscription_id}'`), "expired");
  assert.equal(adminSql(`SELECT start_date::text FROM public.subscriptions
    WHERE id = '${renewal.body.subscription_id}'`), "2026-11-01");
  assert.equal(adminSql(`SELECT cash_effect_amount::text FROM public.cash_movements
    WHERE id = '${renewal.body.cash_movement_id}'`), "0.00");
  const afterRenewal = await request(app).get("/cash/dashboard").set("Cookie", employee.cookie);
  assert.equal(afterRenewal.body.summary.expectedAmount, 170);
  assert.equal(adminSql(`SELECT count(*) FROM public.payments WHERE user_id = '${customer.id}'`), "2");

  const ownerView = await request(app).get("/cash/sessions?status=open")
    .set("Cookie", owner.cookie);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.body.sessions.some((session: { id: string }) => session.id === opened.body.id), true);

  const secondCustomer = await createUser("client");
  const ownerPayment = await request(app).post("/payments/membership")
    .set("Cookie", owner.cookie).send({
      customerId: secondCustomer.id, planId, operation: "create", requireSession: false,
    });
  assert.equal(ownerPayment.status, 201, JSON.stringify(ownerPayment.body));
  assert.equal(ownerPayment.body.session_link_status, "out_of_session");

  const ownerSession = await request(app).post("/cash/sessions").set("Cookie", owner.cookie)
    .send({ registerId, openingAmount: 20 });
  assert.equal(ownerSession.status, 201, JSON.stringify(ownerSession.body));
  const correctionCustomer = await createUser("client");
  const original = await request(app).post("/payments/membership")
    .set("Cookie", owner.cookie).send({
      customerId: correctionCustomer.id, planId, operation: "create", requireSession: true,
    });
  assert.equal(original.status, 201, JSON.stringify(original.body));
  const paymentId = original.body.payment_id as string;

  assert.equal((await request(app).get(`/payments/${paymentId}/reversal-context`)).status, 401);
  const context = await request(app).get(`/payments/${paymentId}/reversal-context`)
    .set("Cookie", owner.cookie);
  assert.equal(context.status, 200, JSON.stringify(context.body));
  assert.equal(context.body.amount_original, 125);
  assert.equal(context.body.status, "posted");
  const correctionInput = {
    amountOriginal: 125, discountAmount: 5, amountPaid: 100,
    paymentMethod: "cash", reason: "Corrección de precio", sourceCategory: "membership",
    note: "Descuento autorizado",
  };
  assert.equal((await request(app).post(`/payments/${paymentId}/reverse`)
    .set("Cookie", employee.cookie).send(correctionInput)).status, 403);
  const corrected = await request(app).post(`/payments/${paymentId}/reverse`)
    .set("Cookie", owner.cookie).send(correctionInput);
  assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
  assert.equal(adminSql(`SELECT status FROM public.payments WHERE id = '${paymentId}'`), "reversed");
  assert.equal(adminSql(`SELECT amount_paid::text FROM public.payments
    WHERE id = '${corrected.body.replacement_payment_id}'`), "100.00");
  assert.equal(adminSql(`SELECT count(*) FROM public.cash_movements
    WHERE customer_id = '${correctionCustomer.id}'`), "3");
  assert.equal(adminSql(`SELECT cash_effect_amount::text FROM public.cash_movements
    WHERE id = '${corrected.body.reversal_movement_id}'`), "-125.00");
  const ownerAfterCorrection = await request(app).get("/cash/dashboard").set("Cookie", owner.cookie);
  assert.equal(ownerAfterCorrection.status, 200);
  assert.equal(ownerAfterCorrection.body.summary.expectedAmount, 120);
  const repeatedCorrection = await request(app).post(`/payments/${paymentId}/reverse`)
    .set("Cookie", owner.cookie).send(correctionInput);
  assert.equal(repeatedCorrection.status, 409, JSON.stringify(repeatedCorrection.body));
  assert.equal(adminSql(`SELECT count(*) FROM public.payments
    WHERE user_id = '${correctionCustomer.id}'`), "2");

  const admin = await createUser("admin");
  const adminCustomer = await createUser("client");
  const adminSession = await request(app).post("/cash/sessions").set("Cookie", admin.cookie)
    .send({ registerId, openingAmount: 0 });
  assert.equal(adminSession.status, 201, JSON.stringify(adminSession.body));
  const adminOriginal = await request(app).post("/payments/membership")
    .set("Cookie", admin.cookie).send({
      customerId: adminCustomer.id, planId, operation: "create", requireSession: true,
    });
  assert.equal(adminOriginal.status, 201, JSON.stringify(adminOriginal.body));
  const adminCorrection = await request(app).post(`/payments/${adminOriginal.body.payment_id}/reverse`)
    .set("Cookie", admin.cookie).send(correctionInput);
  assert.equal(adminCorrection.status, 201, JSON.stringify(adminCorrection.body));
  const adminDashboard = await request(app).get("/cash/dashboard").set("Cookie", admin.cookie);
  assert.equal(adminDashboard.body.summary.expectedAmount, 100);
});
