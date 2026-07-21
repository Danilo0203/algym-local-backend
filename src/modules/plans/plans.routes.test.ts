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

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const testPassword = "PasswordDePrueba123";
const testEmailDomain = "@plans.test.local";

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

async function createUser(role: "client" | "employee") {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const hash = await bcrypt.hash(testPassword, 10);
  await pool.query(
    `INSERT INTO auth.users
      (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`,
    [userId, email, hash],
  );
  runAdminSql(`
    INSERT INTO public.profiles
      (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES
      ('${userId}', 'ZZTEST PLANS ${role}', '55540000', DATE '1990-01-01',
       'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true);
  `);
  return { email, userId };
}

async function login(email: string) {
  const response = await request(app).post("/auth/login").send({
    email,
    password: testPassword,
  });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return cookie;
}

after(async () => {
  runAdminSql(`
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
  `);
  await pool.query(
    `DELETE FROM auth.sessions WHERE user_id IN
      (SELECT id FROM auth.users WHERE email LIKE $1)`,
    [`%${testEmailDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [
    `%${testEmailDomain}`,
  ]);
  runAdminSql("DELETE FROM public.plans WHERE name LIKE 'ZZTEST API PLAN %';");
  await pool.end();
});

test("GET /plans exige sesión", async () => {
  const response = await request(app).get("/plans");
  assert.equal(response.status, 401);
});

test("GET /plans exige plans.view", async () => {
  const client = await createUser("client");
  const cookie = await login(client.email);
  const response = await request(app).get("/plans").set("Cookie", cookie);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN");
});

test("GET /plans y GET /plans/:id devuelven el contrato local", async () => {
  const employee = await createUser("employee");
  const cookie = await login(employee.email);
  const planName = `ZZTEST API PLAN ${randomUUID()}`;
  const planId = Number(
    runAdminQuery(`
      INSERT INTO public.plans (name, duration_days, price, description, is_active)
      VALUES ('${planName}', 30, 150.00, 'Descripción de prueba', true)
      RETURNING id;
    `),
  );

  const listResponse = await request(app)
    .get("/plans")
    .set("Cookie", cookie);
  assert.equal(listResponse.status, 200);
  assert.ok(Array.isArray(listResponse.body.data));
  const listedPlan = listResponse.body.data.find(
    (plan: { id: number }) => Number(plan.id) === planId,
  );
  assert.ok(listedPlan);
  assert.equal(Number(listedPlan.price), 150);
  assert.equal(listedPlan.duration_days, 30);

  const detailResponse = await request(app)
    .get(`/plans/${planId}`)
    .set("Cookie", cookie);
  assert.equal(detailResponse.status, 200);
  assert.equal(Number(detailResponse.body.id), planId);
  assert.equal(detailResponse.body.description, "Descripción de prueba");
});

test("GET /plans/:id valida id y devuelve 404", async () => {
  const employee = await createUser("employee");
  const cookie = await login(employee.email);
  const invalidResponse = await request(app)
    .get("/plans/no-es-id")
    .set("Cookie", cookie);
  assert.equal(invalidResponse.status, 400);

  const missingResponse = await request(app)
    .get("/plans/2147483647")
    .set("Cookie", cookie);
  assert.equal(missingResponse.status, 404);
  assert.equal(missingResponse.body.error.code, "PLAN_NOT_FOUND");
});
