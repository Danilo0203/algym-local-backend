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

function adminSql(sql: string) {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

async function createUser(role: "admin" | "client", name: string) {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`,
    [userId, email, hash],
  );
  adminSql(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES ('${userId}', '${name}', '55540000', DATE '1990-01-01',
            'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
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
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');`);
  await pool.query(
    "DELETE FROM auth.sessions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE $1)",
    [`%${testEmailDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testEmailDomain}`]);
  await pool.end();
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
