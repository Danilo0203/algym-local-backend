import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import type { Request } from "express";
import request from "supertest";

import { app } from "../../app.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";
import { authenticateUser } from "../auth/auth.service.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testDomain = "@users.test.local";
const password = "PasswordDePrueba123";
const createdIds: string[] = [];

function adminSql(sql: string): void {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

async function createActor(role: "owner" | "client") {
  const id = randomUUID();
  createdIds.push(id);
  const email = `${id}${testDomain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [id, email, hash],
  );
  adminSql(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, role, biometric_id, is_active)
    VALUES ('${id}', 'ZZTEST LOCAL USERS ${role}', '', DATE '1990-01-01',
            '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

after(async () => {
  if (createdIds.length > 0) {
    adminSql(`DELETE FROM public.profiles WHERE id IN (${createdIds.map((id) => `'${id}'`).join(",")});
      DELETE FROM auth.sessions WHERE user_id IN (${createdIds.map((id) => `'${id}'`).join(",")});
      DELETE FROM auth.users WHERE id IN (${createdIds.map((id) => `'${id}'`).join(",")});
      DELETE FROM public.device_commands WHERE command LIKE '%ZZTEST LOCAL USERS%';`);
  }
  await pool.end();
});

test("usuarios internos: permisos, alta, cambio de contraseña y rol, baja lógica", async () => {
  assert.equal((await request(app).get("/users")).status, 401);
  const owner = await createActor("owner");
  const client = await createActor("client");
  assert.equal((await request(app).get("/users").set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).get("/users/roles").set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).post("/users").set("Cookie", client.cookie).send({
    email: `denegado${testDomain}`, full_name: "Denegado", role: "admin", password,
  })).status, 403);

  const roles = await request(app).get("/users/roles").set("Cookie", owner.cookie);
  assert.equal(roles.status, 200);
  assert.ok(roles.body.data.some((role: { slug: string }) => role.slug === "employee"));

  const email = `${randomUUID()}${testDomain}`;
  const invalid = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email, full_name: "Usuario Nuevo", role: "employee", password: "corta",
  });
  assert.equal(invalid.status, 400);

  const created = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email: email.toUpperCase(), full_name: "Usuario Nuevo", role: "employee", password,
  });
  assert.equal(created.status, 201);
  const userId = created.body.id as string;
  createdIds.push(userId);
  assert.ok(userId);
  assert.equal((await request(app).post("/users").set("Cookie", owner.cookie).send({
    email, full_name: "Duplicado", role: "employee", password,
  })).status, 409);

  const row = await withUserTransaction(owner.id, (connection) => connection.query<{
    email: string; encrypted_password: string; birth_date: string | null;
    biometric_id: number | null; role: string;
  }>(`SELECT users.email, users.encrypted_password, profiles.birth_date,
             profiles.biometric_id, profiles.role::text AS role
      FROM auth.users AS users JOIN public.profiles AS profiles ON profiles.id = users.id
      WHERE users.id = $1`, [userId]));
  assert.equal(row.rows[0]?.email, email);
  assert.equal(row.rows[0]?.role, "employee");
  assert.equal(row.rows[0]?.birth_date, null);
  assert.equal(row.rows[0]?.biometric_id, null);
  assert.ok(await bcrypt.compare(password, row.rows[0]!.encrypted_password));

  const listed = await request(app).get("/users").set("Cookie", owner.cookie);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.some((user: { id: string }) => user.id === userId));
  assert.equal(JSON.stringify(listed.body).includes("encrypted_password"), false);
  assert.equal(JSON.stringify(listed.body).includes(password), false);
  const invisible = await withUserTransaction(client.id, async (connection) =>
    connection.query("SELECT id FROM public.profiles WHERE id = $1", [userId]));
  assert.equal(invisible.rowCount, 0);

  const employee = await request(app).post("/auth/login").send({ email, password });
  assert.equal(employee.status, 200);
  const employeeCookie = employee.headers["set-cookie"]?.[0];
  assert.ok(employeeCookie);

  const newPassword = "NuevaClaveSegura123";
  const updated = await request(app).patch(`/users/${userId}`).set("Cookie", owner.cookie).send({
    full_name: "Usuario Actualizado", role: "trainer", password: newPassword,
  });
  assert.equal(updated.status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", employeeCookie)).status, 401);
  const renewedLogin = await request(app).post("/auth/login").send({ email, password: newPassword });
  assert.equal(renewedLogin.status, 200);
  const renewedCookie = renewedLogin.headers["set-cookie"]?.[0];
  assert.ok(renewedCookie);

  assert.equal((await request(app).patch(`/users/${userId}`).set("Cookie", owner.cookie)
    .send({ is_active: false })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", renewedCookie)).status, 401);
  assert.equal((await request(app).post("/auth/login").send({ email, password: newPassword })).status, 403);
  assert.equal((await request(app).patch(`/users/${userId}`).set("Cookie", owner.cookie)
    .send({ is_active: true })).status, 200);
  const reactivated = await request(app).get("/users").set("Cookie", owner.cookie);
  assert.equal(reactivated.body.data.find((user: { id: string }) => user.id === userId)?.is_active, true);

  assert.equal((await request(app).delete(`/users/${owner.id}`).set("Cookie", owner.cookie)).status, 409);
  assert.equal((await request(app).patch(`/users/${owner.id}`).set("Cookie", owner.cookie)
    .send({ is_active: false })).status, 409);
  assert.equal((await request(app).patch(`/users/${owner.id}`).set("Cookie", owner.cookie)
    .send({ role: "employee" })).status, 409);
  assert.equal((await request(app).delete(`/users/${userId}`).set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).delete(`/users/${userId}`).set("Cookie", owner.cookie)).status, 204);
  const deleted = await withUserTransaction(owner.id, (connection) => connection.query<{ deleted_at: Date | null; is_active: boolean }>(
    `SELECT users.deleted_at, profiles.is_active FROM auth.users AS users
     JOIN public.profiles AS profiles ON profiles.id = users.id WHERE users.id = $1`, [userId]));
  assert.ok(deleted.rows[0]?.deleted_at);
  assert.equal(deleted.rows[0]?.is_active, false);

  const replacement = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email, full_name: "Usuario Reemplazo", role: "employee", password: newPassword,
  });
  assert.equal(replacement.status, 201);
  createdIds.push(replacement.body.id as string);
  const replacementLogin = await authenticateUser(
    { email, password: newPassword },
    { get: () => undefined, ip: "127.0.0.1" } as unknown as Request,
  );
  assert.equal(replacementLogin.context.user.id, replacement.body.id);
});
