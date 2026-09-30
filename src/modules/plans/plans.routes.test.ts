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

async function createUser(role: "client" | "employee" | "admin") {
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

test("POST /plans impide escrituras sin sesión o permiso", async () => {
  const payload = { name: "ZZTEST API PLAN SIN PERMISO", price: 100, duration_days: 30 };
  const anonymous = await request(app).post("/plans").send(payload);
  assert.equal(anonymous.status, 401);

  const employee = await createUser("employee");
  const cookie = await login(employee.email);
  const denied = await request(app).post("/plans").set("Cookie", cookie).send(payload);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
});

test("administrador crea, edita y desactiva un plan sin perder historial", async () => {
  const admin = await createUser("admin");
  const cookie = await login(admin.email);
  const name = `ZZTEST API PLAN ${randomUUID()}`;

  const created = await request(app).post("/plans").set("Cookie", cookie).send({
    name,
    description: "Inicial",
    price: 150.5,
    duration_days: 30,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, name);
  assert.equal(created.body.price, 150.5);
  assert.equal(created.body.is_active, true);
  const planId = Number(created.body.id);

  const updated = await request(app).put(`/plans/${planId}`).set("Cookie", cookie).send({
    description: null,
    price: 175,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.description, null);
  assert.equal(updated.body.price, 175);
  assert.equal(updated.body.duration_days, 30);

  const deactivated = await request(app).delete(`/plans/${planId}`).set("Cookie", cookie);
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.is_active, false);

  const historical = await request(app).get(`/plans/${planId}`).set("Cookie", cookie);
  assert.equal(historical.status, 200);
  assert.equal(historical.body.is_active, false);
});

test("escrituras de planes validan payload e identificador", async () => {
  const admin = await createUser("admin");
  const cookie = await login(admin.email);
  const invalidCreate = await request(app).post("/plans").set("Cookie", cookie).send({
    name: "X",
    price: -1,
    duration_days: 0,
  });
  assert.equal(invalidCreate.status, 400);

  const emptyUpdate = await request(app).put("/plans/1").set("Cookie", cookie).send({});
  assert.equal(emptyUpdate.status, 400);

  const invalidId = await request(app).delete("/plans/not-a-number").set("Cookie", cookie);
  assert.equal(invalidId.status, 400);
});
