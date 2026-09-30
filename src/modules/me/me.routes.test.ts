import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testDomain = "@me-portal.test.local";
const password = "PasswordDePrueba123";

function adminSql(sql: string): string {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

async function createClient(label: string) {
  const id = randomUUID();
  const email = `${id}${testDomain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`,
    [id, email, hash],
  );
  adminSql(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES ('${id}', 'ZZTEST PORTAL ${label}', '55560000', DATE '1990-01-01',
            'male', 'client', ${Math.floor(Math.random() * 1000000) + 3000000}, true)`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, email, cookie };
}

after(async () => {
  adminSql(`DELETE FROM public.routines
      WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testDomain}');
    DELETE FROM public.subscriptions
      WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testDomain}');
    DELETE FROM public.plans WHERE name LIKE 'ZZTEST PORTAL %';
    DELETE FROM public.profiles
      WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testDomain}')`);
  await pool.query(
    "DELETE FROM auth.sessions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE $1)",
    [`%${testDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testDomain}`]);
  await pool.end();
});

test("portal local exige sesión y solo devuelve datos del propio socio", async () => {
  assert.equal(env.DB_NAME, "algym_test");
  for (const route of ["/me/profile", "/me/membership", "/me/routine"]) {
    assert.equal((await request(app).get(route)).status, 401);
  }

  const first = await createClient("PRIMERO");
  const second = await createClient("SEGUNDO");
  adminSql(`UPDATE public.profiles SET avatar_url = 'https://example.invalid/legacy-avatar.png'
    WHERE id = '${first.id}'`);
  const planId = Number(adminSql(`INSERT INTO public.plans (name, duration_days, price, is_active)
    VALUES ('ZZTEST PORTAL PLAN ANTIGUO', 30, 250.00, false) RETURNING id`));
  adminSql(`INSERT INTO public.subscriptions
    (user_id, plan_id, start_date, end_date, status, discount_amount)
    VALUES ('${first.id}', ${planId}, DATE '2026-01-01', DATE '2026-01-30', 'expired', 25.00);
    INSERT INTO public.routines (user_id, created_by, name, status, source, is_active)
    VALUES ('${first.id}', '${first.id}', 'Rutina privada del primero', 'active', 'system', true),
           ('${second.id}', '${second.id}', 'Rutina privada del segundo', 'active', 'system', true)`);

  const firstProfile = await request(app).get("/me/profile").set("Cookie", first.cookie);
  assert.equal(firstProfile.status, 200);
  assert.equal(firstProfile.body.id, first.id);
  assert.equal(firstProfile.body.overview.full_name, "ZZTEST PORTAL PRIMERO");
  assert.equal(firstProfile.body.avatar_url, null);
  assert.equal(firstProfile.body.overview.avatar_url, null);
  assert.equal(JSON.stringify(firstProfile.body).includes(second.email), false);

  const firstMembership = await request(app).get("/me/membership").set("Cookie", first.cookie);
  assert.equal(firstMembership.status, 200);
  assert.equal(firstMembership.body.subscriptions.length, 1);
  assert.equal(firstMembership.body.subscriptions[0].plan_name, "ZZTEST PORTAL PLAN ANTIGUO");
  assert.equal(firstMembership.body.subscriptions[0].price, 250);
  assert.equal(firstMembership.body.subscriptions[0].discount_amount, 25);

  const secondMembership = await request(app).get("/me/membership").set("Cookie", second.cookie);
  assert.equal(secondMembership.status, 200);
  assert.deepEqual(secondMembership.body.subscriptions, []);

  const firstRoutine = await request(app).get("/me/routine").set("Cookie", first.cookie);
  assert.equal(firstRoutine.status, 200);
  assert.equal(firstRoutine.body.workspace.activeRoutine.name, "Rutina privada del primero");
  assert.equal(JSON.stringify(firstRoutine.body).includes("Rutina privada del segundo"), false);

  const secondRoutine = await request(app).get("/me/routine").set("Cookie", second.cookie);
  assert.equal(secondRoutine.status, 200);
  assert.equal(secondRoutine.body.workspace.activeRoutine.name, "Rutina privada del segundo");
  assert.equal((await request(app).get(`/customers/${first.id}/routine`).set("Cookie", first.cookie)).status, 403);
});
