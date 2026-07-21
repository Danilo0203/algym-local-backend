import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../..");
const testEmailDomain = "@customer-history.test.local";
const testPassword = "PasswordDePrueba123";
const planNamePrefix = "ZZTEST HISTORY PLAN";

type TestUser = {
  email: string;
  userId: string;
  biometricId: number;
};

function sqlLiteral(value: number | string): string {
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function runAdminSql(sql: string): void {
  execFileSync(
    "psql",
    ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { cwd: projectRoot, stdio: "ignore" },
  );
}

function runAdminQuery(sql: string): string {
  return execFileSync(
    "psql",
    ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql],
    { cwd: projectRoot, encoding: "utf8" },
  ).trim();
}

async function createUser(role: "client" | "employee" | "owner"): Promise<TestUser> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const biometricId = Math.floor(Math.random() * 1000000) + 1000000;
  const passwordHash = await bcrypt.hash(testPassword, 10);

  await pool.query(
    `
      INSERT INTO auth.users (
        id, email, encrypted_password, raw_user_meta_data, created_at, updated_at
      )
      VALUES ($1, $2, $3, '{}'::jsonb, now(), now())
    `,
    [userId, email, passwordHash],
  );

  runAdminSql(`
    INSERT INTO public.profiles (
      id, full_name, phone, birth_date, gender, role, biometric_id, is_active,
      injuries, medical_notes
    )
    VALUES (
      ${sqlLiteral(userId)},
      ${sqlLiteral(`ZZTEST HISTORY ${role}`)},
      '55540000', DATE '1990-01-01', 'male', ${sqlLiteral(role)},
      ${biometricId}, true, 'Rodilla', 'Nota de prueba'
    );
  `);

  return { email, userId, biometricId };
}

async function login(email: string): Promise<string> {
  const response = await request(app).post("/auth/login").send({
    email,
    password: testPassword,
  });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return cookie;
}

async function cleanup(): Promise<void> {
  runAdminSql(`
    DELETE FROM public.payments
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.body_assessments
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.subscriptions
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.attendance_logs
    WHERE biometric_id IN (
      SELECT biometric_id FROM public.profiles
      WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}')
    );
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
  `);
  await pool.query(
    `DELETE FROM auth.sessions WHERE user_id IN (
      SELECT id FROM auth.users WHERE email LIKE $1
    )`,
    [`%${testEmailDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [
    `%${testEmailDomain}`,
  ]);
  runAdminSql(`DELETE FROM public.plans WHERE name LIKE '${planNamePrefix}%';`);
}

before(async () => {
  assert.equal(env.DB_NAME, "algym_test");
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("GET /customers/:id/history exige sesión y customers.view", async () => {
  const customerId = randomUUID();
  const noSession = await request(app).get(`/customers/${customerId}/history`);
  assert.equal(noSession.status, 401);

  const client = await createUser("client");
  const cookie = await login(client.email);
  const forbidden = await request(app)
    .get(`/customers/${client.userId}/history`)
    .set("Cookie", cookie);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, "FORBIDDEN");
});

test("GET /customers/:id/history devuelve 404 para un cliente inexistente", async () => {
  const employee = await createUser("employee");
  const cookie = await login(employee.email);
  const response = await request(app)
    .get(`/customers/${randomUUID()}/history`)
    .set("Cookie", cookie);

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "CUSTOMER_NOT_FOUND");
});

test("GET /customers/:id/history agrega el historial visible sin escribir finanzas", async () => {
  const owner = await createUser("owner");
  const customer = await createUser("client");
  const cookie = await login(owner.email);
  const planId = Number(
    runAdminQuery(`
      INSERT INTO public.plans (name, duration_days, price, description, is_active)
      VALUES ('${planNamePrefix} ${randomUUID()}', 30, 125.00, 'Prueba', true)
      RETURNING id;
    `),
  );
  const subscriptionId = runAdminQuery(`
    INSERT INTO public.subscriptions (
      user_id, plan_id, start_date, end_date, status, discount_amount, grace_days
    )
    VALUES (
      '${customer.userId}', ${planId}, DATE '2026-07-01', DATE '2026-07-31',
      'active', 25.00, 3
    )
    RETURNING id;
  `);

  runAdminSql(`
    INSERT INTO public.payments (
      subscription_id, user_id, amount_original, discount_amount, amount_paid,
      method, payment_date, created_by_user_id, status
    )
    VALUES (
      '${subscriptionId}', '${customer.userId}', 125.00, 25.00, 100.00,
      'cash', now(), '${owner.userId}', 'posted'
    );

    INSERT INTO public.body_assessments (
      user_id, date, weight_kg, height_cm, body_fat_percentage, muscle_mass_kg
    )
    VALUES
      ('${customer.userId}', DATE '2026-06-01', 70.00, 170.00, 20.00, 30.00),
      ('${customer.userId}', DATE '2026-07-01', 72.00, 170.00, 19.00, 31.00);

    INSERT INTO public.attendance_logs (
      device_id, biometric_id, punch_time, status1, raw_line
    )
    VALUES
      ('ZZTEST', ${customer.biometricId}, now(), 1, 'ATTLOG clásico'),
      ('ZZTEST', ${customer.biometricId}, now(), 1, 'pin=1 event=denied');
  `);

  const paymentsBefore = runAdminQuery(
    `SELECT count(*) FROM public.payments WHERE user_id = '${customer.userId}';`,
  );
  const response = await request(app)
    .get(`/customers/${customer.userId}/history`)
    .set("Cookie", cookie);
  const paymentsAfter = runAdminQuery(
    `SELECT count(*) FROM public.payments WHERE user_id = '${customer.userId}';`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.profile.id, customer.userId);
  assert.equal(response.body.profile.injuries, "Rodilla");
  assert.equal(response.body.kpis.totalSpent, 100);
  assert.equal(response.body.kpis.totalVisits, 1);
  assert.equal(response.body.kpis.initialWeight, 70);
  assert.equal(response.body.kpis.currentWeight, 72);
  assert.equal(response.body.kpis.weightChange, 2);
  assert.equal(response.body.payment_history.length, 1);
  assert.equal(response.body.subscription_history[0].access_until, "2026-08-03");
  assert.equal(response.body.body_assessments.length, 2);
  assert.deepEqual(
    response.body.access_history.map((entry: { status: string }) => entry.status).sort(),
    ["authorized", "denied"],
  );
  assert.equal(
    Object.values(response.body.heatmap_data).reduce(
      (sum: number, count) => sum + Number(count),
      0,
    ),
    1,
  );
  assert.equal(paymentsAfter, paymentsBefore);
  assert.equal(JSON.stringify(response.body).includes("biometric_id"), false);
});
