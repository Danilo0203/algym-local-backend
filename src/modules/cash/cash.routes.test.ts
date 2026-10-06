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
import { withUserTransaction } from "../../db/transaction.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const password = "CashTestPassword123";
const domain = "@cash.test.local";
const insertedGrantPairs: string[] = [];

function adminSql(sql: string): string {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], {
    cwd: root, encoding: "utf8",
  }).trim();
}

async function createUser(role: "client" | "employee" | "admin" | "owner") {
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
    VALUES ('${id}', 'ZZTEST CASH ${role}', '55540000', DATE '1990-01-01',
      'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

before(() => {
  const inserted = adminSql(`INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles AS r CROSS JOIN public.permissions AS p
    WHERE r.slug IN ('admin', 'employee') AND p.key IN ('cash.view', 'cash.operate')
    ON CONFLICT (role_id, permission_id) DO NOTHING
    RETURNING role_id::text || ':' || permission_id::text;`);
  insertedGrantPairs.push(...inserted.split("\n").filter(Boolean));
});

after(async () => {
  adminSql(`DELETE FROM public.cash_movements
    WHERE created_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_sessions
    WHERE opened_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_registers WHERE name = 'Caja principal';
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');`);
  if (insertedGrantPairs.length > 0) {
    adminSql(`DELETE FROM public.role_permissions
      WHERE role_id::text || ':' || permission_id::text IN
        (${insertedGrantPairs.map((pair) => `'${pair}'`).join(",")});`);
  }
  await pool.query(`DELETE FROM auth.sessions WHERE user_id IN
    (SELECT id FROM auth.users WHERE email LIKE $1)`, [`%${domain}`]);
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${domain}`]);
  await pool.end();
});

test("caja local exige sesión y permiso", async () => {
  assert.equal((await request(app).get("/cash/dashboard")).status, 401);
  assert.equal((await request(app).post("/cash/registers/default")).status, 401);
  const client = await createUser("client");
  assert.equal((await request(app).get("/cash/dashboard").set("Cookie", client.cookie)).status, 403);
});

test("caja local permite configurar, abrir, leer y cerrar con autorización", async () => {
  const admin = await createUser("admin");
  const employee = await createUser("employee");
  const otherEmployee = await createUser("employee");
  const owner = await createUser("owner");

  const empty = await request(app).get("/cash/dashboard").set("Cookie", employee.cookie);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.register, null);
  assert.equal(empty.body.currentSession, null);

  const forbidden = await request(app).post("/cash/registers/default").set("Cookie", employee.cookie);
  assert.equal(forbidden.status, 403);
  const configured = await request(app).post("/cash/registers/default").set("Cookie", admin.cookie);
  assert.equal(configured.status, 200);
  assert.equal(configured.body.register.name, "Caja principal");
  const registerId = configured.body.register.id;
  const configuredAgain = await request(app).post("/cash/registers/default").set("Cookie", admin.cookie);
  assert.equal(configuredAgain.body.register.id, registerId);

  const invalidOpen = await request(app).post("/cash/sessions").set("Cookie", employee.cookie)
    .send({ registerId, openingAmount: -1 });
  assert.equal(invalidOpen.status, 400);
  const opened = await request(app).post("/cash/sessions").set("Cookie", employee.cookie)
    .send({ registerId, openingAmount: 50, notes: "Inicio" });
  assert.equal(opened.status, 201);
  const sessionId = opened.body.id;
  assert.ok(sessionId);
  const duplicate = await request(app).post("/cash/sessions").set("Cookie", employee.cookie)
    .send({ registerId, openingAmount: 50 });
  assert.equal(duplicate.status, 400);

  assert.equal((await request(app).post(`/cash/sessions/${sessionId}/movements`)
    .send({ movementType: "manual_income", amount: 10, note: "Prueba local" })).status, 401);
  assert.equal((await request(app).post(`/cash/sessions/${sessionId}/movements`)
    .set("Cookie", employee.cookie)
    .send({ movementType: "manual_income", amount: 0, note: "Prueba local" })).status, 400);
  const foreignMovement = await request(app).post(`/cash/sessions/${sessionId}/movements`)
    .set("Cookie", otherEmployee.cookie)
    .send({ movementType: "manual_income", amount: 10, note: "Otro cajero" });
  assert.equal(foreignMovement.status, 400);
  const manualIncome = await request(app).post(`/cash/sessions/${sessionId}/movements`)
    .set("Cookie", employee.cookie)
    .send({ movementType: "manual_income", amount: 10, note: "Prueba local" });
  assert.equal(manualIncome.status, 201, JSON.stringify(manualIncome.body));
  assert.equal(manualIncome.body.cashEffectAmount, 10);

  const dashboard = await request(app).get("/cash/dashboard").set("Cookie", employee.cookie);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.currentSession.id, sessionId);
  assert.equal(dashboard.body.summary.expectedAmount, 60);
  assert.equal(dashboard.body.canOperateSession, true);
  assert.equal(dashboard.body.sessionMovements[0]?.amount, 10);
  assert.equal(dashboard.body.sessionMovements[0]?.created_by_user_id, employee.id);
  const withdrawal = await request(app).post(`/cash/sessions/${sessionId}/movements`)
    .set("Cookie", employee.cookie)
    .send({ movementType: "withdrawal", amount: 3, note: "Retiro de prueba" });
  assert.equal(withdrawal.status, 201, JSON.stringify(withdrawal.body));
  assert.equal(withdrawal.body.cashEffectAmount, -3);
  const otherDashboard = await request(app).get("/cash/dashboard").set("Cookie", otherEmployee.cookie);
  assert.equal(otherDashboard.status, 200);
  assert.equal(otherDashboard.body.currentSession, null);
  assert.deepEqual(otherDashboard.body.sessionMovements, []);
  const ownerDashboard = await request(app).get("/cash/dashboard").set("Cookie", owner.cookie);
  assert.equal(ownerDashboard.status, 200);
  assert.equal(ownerDashboard.body.currentSession, null);
  assert.equal(ownerDashboard.body.supervisedOpenSessions[0]?.id, sessionId);

  const ownHistory = await request(app).get("/cash/sessions?status=open&sort=opened_at:desc")
    .set("Cookie", employee.cookie);
  assert.equal(ownHistory.status, 200);
  assert.equal(ownHistory.body.totalItems, 1);
  assert.equal(ownHistory.body.sessions[0]?.id, sessionId);
  const otherHistory = await request(app).get("/cash/sessions")
    .set("Cookie", otherEmployee.cookie);
  assert.equal(otherHistory.status, 200);
  assert.equal(otherHistory.body.totalItems, 0);
  const ownerHistory = await request(app).get("/cash/sessions?status=open")
    .set("Cookie", owner.cookie);
  assert.equal(ownerHistory.status, 200);
  assert.equal(ownerHistory.body.totalItems, 1);
  assert.equal(ownerHistory.body.availableUsers[0]?.id, employee.id);
  const futureHistory = await request(app).get("/cash/sessions?dateFrom=2099-01-01")
    .set("Cookie", owner.cookie);
  assert.equal(futureHistory.status, 200);
  assert.equal(futureHistory.body.totalItems, 0);
  const invalidSort = await request(app).get("/cash/sessions?sort=invalid:asc")
    .set("Cookie", owner.cookie);
  assert.equal(invalidSort.status, 400);
  const detail = await request(app).get(`/cash/sessions/${sessionId}`)
    .set("Cookie", employee.cookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.summary.expectedAmount, 57);
  assert.equal(detail.body.movements.length, 2);
  const deniedDetail = await request(app).get(`/cash/sessions/${sessionId}`)
    .set("Cookie", otherEmployee.cookie);
  assert.equal(deniedDetail.status, 404);

  const visibility = await withUserTransaction(employee.id, async (db) =>
    db.query<{ count: string }>("SELECT count(*)::text AS count FROM public.cash_sessions"));
  assert.equal(Number(visibility.rows[0]?.count), 1);
  const otherVisibility = await withUserTransaction(otherEmployee.id, async (db) =>
    db.query<{ count: string }>("SELECT count(*)::text AS count FROM public.cash_sessions"));
  assert.equal(Number(otherVisibility.rows[0]?.count), 0);

  const missingPassword = await request(app).post(`/cash/sessions/${sessionId}/close`)
    .set("Cookie", employee.cookie).send({ countedAmount: 50 });
  assert.equal(missingPassword.status, 400);
  const wrongPassword = await request(app).post(`/cash/sessions/${sessionId}/close`)
    .set("Cookie", employee.cookie).send({ countedAmount: 50, adminPassword: "incorrecta" });
  assert.equal(wrongPassword.status, 403);
  const closed = await request(app).post(`/cash/sessions/${sessionId}/close`)
    .set("Cookie", employee.cookie).send({ countedAmount: 57, adminPassword: password });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, "closed");
  const closedBy = adminSql(`SELECT closed_by_user_id FROM public.cash_sessions WHERE id = '${sessionId}'`);
  assert.ok(closedBy === admin.id || closedBy === owner.id);

  const afterClose = await request(app).get("/cash/dashboard").set("Cookie", employee.cookie);
  assert.equal(afterClose.status, 200);
  assert.equal(afterClose.body.currentSession, null);
  assert.equal(afterClose.body.canOpenSession, true);
  const closedDetail = await request(app).get(`/cash/sessions/${sessionId}`)
    .set("Cookie", employee.cookie);
  assert.equal(closedDetail.status, 200);
  assert.equal(closedDetail.body.summary.countedAmount, 57);
  assert.equal(closedDetail.body.summary.differenceAmount, 0);
  const afterCloseMovement = await request(app).post(`/cash/sessions/${sessionId}/movements`)
    .set("Cookie", employee.cookie)
    .send({ movementType: "manual_income", amount: 10, note: "Caja cerrada" });
  assert.equal(afterCloseMovement.status, 400);
});
