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
const testEmailDomain = "@memberships.test.local";
const testPassword = "PasswordDePrueba123";

type SyntheticUser = {
  email: string;
  userId: string;
};

function sqlLiteral(value: boolean | number | string): string {
  if (typeof value === "boolean") return value ? "true" : "false";
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

async function createUser(options?: {
  isActive?: boolean;
  role?: "client" | "employee" | "owner";
}): Promise<SyntheticUser> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);
  const role = options?.role ?? "client";
  const isActive = options?.isActive ?? true;

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
      id, full_name, phone, birth_date, gender, role, biometric_id, is_active
    )
    VALUES (
      ${sqlLiteral(userId)},
      ${sqlLiteral(`ZZTEST MEMBERSHIPS ${role}`)},
      '55530000',
      DATE '1990-01-01',
      'male',
      ${sqlLiteral(role)},
      ${Math.floor(Math.random() * 1000000)},
      ${sqlLiteral(isActive)}
    );
  `);

  return { email, userId };
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

async function createPlan(options?: { isActive?: boolean }): Promise<number> {
  const name = `ZZTEST PLAN ${randomUUID()}`;
  return Number(
    runAdminQuery(`
      INSERT INTO public.plans (name, duration_days, price, description, is_active)
      VALUES (
        ${sqlLiteral(name)}, 30, 125.00, 'Plan sintético',
        ${sqlLiteral(options?.isActive ?? true)}
      )
      RETURNING id;
    `),
  );
}

async function cleanup(): Promise<void> {
  runAdminSql(`
    DELETE FROM public.subscriptions
    WHERE user_id IN (
      SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}'
    );
    DELETE FROM public.profiles
    WHERE id IN (
      SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}'
    );
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
  runAdminSql("DELETE FROM public.plans WHERE name LIKE 'ZZTEST PLAN %';");
}

before(async () => {
  assert.equal(env.DB_NAME, "algym_test");
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("las rutas de membresía exigen sesión", async () => {
  const response = await request(app).get(
    `/customers/${randomUUID()}/membership`,
  );
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, "INVALID_SESSION");
});

test("GET exige customers.view", async () => {
  const client = await createUser();
  const cookie = await login(client.email);
  const response = await request(app)
    .get(`/customers/${client.userId}/membership`)
    .set("Cookie", cookie);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN");
});

test("POST crea una membresía local con cycles y grace_days fijo", async () => {
  const employee = await createUser({ role: "employee" });
  const customer = await createUser();
  const planId = await createPlan();
  const cookie = await login(employee.email);
  const paymentsBefore = runAdminQuery(
    `SELECT count(*) FROM public.payments WHERE user_id = '${customer.userId}';`,
  );

  const response = await request(app)
    .post(`/customers/${customer.userId}/membership`)
    .set("Cookie", cookie)
    .send({ plan_id: planId, cycles: 2, start_date: "2026-08-01" });

  assert.equal(response.status, 201);
  assert.equal(response.body.customer_id, customer.userId);
  assert.equal(response.body.membership.cycles, 2);
  assert.equal(response.body.membership.grace_days, 3);
  assert.equal(response.body.membership.status, "active");
  assert.equal(response.body.membership.start_date, "2026-08-01");
  assert.equal(response.body.membership.end_date, "2026-09-30");
  assert.equal(Number(response.body.membership.price), 250);

  const paymentsAfter = runAdminQuery(
    `SELECT count(*) FROM public.payments WHERE user_id = '${customer.userId}';`,
  );
  assert.equal(paymentsAfter, paymentsBefore);

  const getResponse = await request(app)
    .get(`/customers/${customer.userId}/membership`)
    .set("Cookie", cookie);
  assert.equal(getResponse.status, 200);
  assert.deepEqual(Object.keys(getResponse.body).sort(), [
    "current_membership",
    "customer_id",
  ]);
  assert.equal(getResponse.body.current_membership.id, response.body.membership.id);
});

test("POST rechaza cliente inactivo y plan inactivo", async () => {
  const employee = await createUser({ role: "employee" });
  const inactiveCustomer = await createUser({ isActive: false });
  const activeCustomer = await createUser();
  const activePlanId = await createPlan();
  const inactivePlanId = await createPlan({ isActive: false });
  const cookie = await login(employee.email);

  const inactiveCustomerResponse = await request(app)
    .post(`/customers/${inactiveCustomer.userId}/membership`)
    .set("Cookie", cookie)
    .send({ plan_id: activePlanId, cycles: 1 });
  assert.equal(inactiveCustomerResponse.status, 409);
  assert.equal(inactiveCustomerResponse.body.error.code, "CUSTOMER_INACTIVE");

  const inactivePlanResponse = await request(app)
    .post(`/customers/${activeCustomer.userId}/membership`)
    .set("Cookie", cookie)
    .send({ plan_id: inactivePlanId, cycles: 1 });
  assert.equal(inactivePlanResponse.status, 422);
  assert.equal(inactivePlanResponse.body.error.code, "PLAN_INACTIVE");
});

test("POST concurrente deja una sola membresía activa", async () => {
  const employee = await createUser({ role: "employee" });
  const customer = await createUser();
  const planId = await createPlan();
  const cookie = await login(employee.email);
  const requestMembership = () =>
    request(app)
      .post(`/customers/${customer.userId}/membership`)
      .set("Cookie", cookie)
      .send({ plan_id: planId, cycles: 1 });

  const responses = await Promise.all([requestMembership(), requestMembership()]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409],
  );
  assert.equal(
    responses.find((response) => response.status === 409)?.body.error.code,
    "MEMBERSHIP_ALREADY_ACTIVE",
  );

  const activeCount = runAdminQuery(
    `SELECT count(*) FROM public.subscriptions
     WHERE user_id = '${customer.userId}' AND status = 'active';`,
  );
  assert.equal(activeCount, "1");
});

test("renew exige una membresía previa", async () => {
  const employee = await createUser({ role: "employee" });
  const customer = await createUser();
  const planId = await createPlan();
  const cookie = await login(employee.email);
  const response = await request(app)
    .post(`/customers/${customer.userId}/membership/renew`)
    .set("Cookie", cookie)
    .send({ plan_id: planId, cycles: 1 });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "NO_MEMBERSHIP_TO_RENEW");
});

test("renew reemplaza la activa transaccionalmente y conserva una sola activa", async () => {
  const employee = await createUser({ role: "employee" });
  const customer = await createUser();
  const planId = await createPlan();
  const cookie = await login(employee.email);
  const created = await request(app)
    .post(`/customers/${customer.userId}/membership`)
    .set("Cookie", cookie)
    .send({ plan_id: planId, cycles: 1, start_date: "2026-08-01" });
  assert.equal(created.status, 201);

  const renewed = await request(app)
    .post(`/customers/${customer.userId}/membership/renew`)
    .set("Cookie", cookie)
    .send({ plan_id: planId, cycles: 2 });
  assert.equal(renewed.status, 201);
  assert.equal(renewed.body.previous_membership_id, created.body.membership.id);
  assert.equal(renewed.body.membership.start_date, "2026-09-01");
  assert.equal(renewed.body.membership.cycles, 2);

  const statuses = runAdminQuery(
    `SELECT string_agg(status::text, ',' ORDER BY created_at ASC)
     FROM public.subscriptions WHERE user_id = '${customer.userId}';`,
  );
  assert.deepEqual(statuses.split(",").sort(), ["active", "expired"]);
});

test("status solo acepta cancelled", async () => {
  const employee = await createUser({ role: "employee" });
  const customer = await createUser();
  const planId = await createPlan();
  const cookie = await login(employee.email);
  await request(app)
    .post(`/customers/${customer.userId}/membership`)
    .set("Cookie", cookie)
    .send({ plan_id: planId, cycles: 1 });

  const invalidResponse = await request(app)
    .patch(`/customers/${customer.userId}/membership/status`)
    .set("Cookie", cookie)
    .send({ status: "active" });
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidResponse.body.error.code, "VALIDATION_ERROR");

  const response = await request(app)
    .patch(`/customers/${customer.userId}/membership/status`)
    .set("Cookie", cookie)
    .send({ status: "cancelled" });
  assert.equal(response.status, 200);
  assert.equal(response.body.membership.status, "cancelled");
  assert.equal(response.body.membership.display_status, "cancelled");
});
