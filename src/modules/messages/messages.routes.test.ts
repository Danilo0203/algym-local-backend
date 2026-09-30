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
import { withUserTransaction } from "../../db/transaction.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testDomain = "@messages.test.local";
const password = "PasswordDePrueba123";

function adminSql(sql: string): void {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

async function createUser(role: "owner" | "client") {
  const userId = randomUUID();
  const email = `${userId}${testDomain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`,
    [userId, email, hash],
  );
  adminSql(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES ('${userId}', 'ZZTEST MESSAGES ${role}', '55540000', DATE '1990-01-01',
            'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const response = await request(app).post("/auth/login").send({ email, password });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { cookie, userId };
}

after(async () => {
  adminSql(`DELETE FROM public.message_templates WHERE name LIKE 'ZZTEST LOCAL MESSAGE %';
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testDomain}');`);
  await pool.query(
    "DELETE FROM auth.sessions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE $1)",
    [`%${testDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testDomain}`]);
  await pool.end();
});

test("plantillas locales: sesión, permisos, CRUD, filtro y RLS", async () => {
  assert.equal((await request(app).get("/messages")).status, 401);
  const owner = await createUser("owner");
  const client = await createUser("client");

  assert.equal((await request(app).get("/messages").set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).post("/messages").set("Cookie", client.cookie)
    .send({ name: "No autorizado", content: "Texto" })).status, 403);
  assert.equal((await request(app).post("/messages").set("Cookie", owner.cookie)
    .send({ name: "", content: "Texto" })).status, 400);

  const name = `ZZTEST LOCAL MESSAGE ${randomUUID()}`;
  const created = await request(app).post("/messages").set("Cookie", owner.cookie)
    .send({ name, content: "Hola @cliente" });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, name);
  assert.equal(created.body.created_by, owner.userId);
  const id = created.body.id as string;

  const invisibleToClient = await withUserTransaction(client.userId, async (connection) =>
    connection.query("SELECT id FROM public.message_templates WHERE id = $1", [id]));
  assert.equal(invisibleToClient.rowCount, 0);

  const active = await request(app).get("/messages").set("Cookie", owner.cookie);
  assert.equal(active.status, 200);
  assert.ok(active.body.data.some((item: { id: string }) => item.id === id));

  const updated = await request(app).patch(`/messages/${id}`).set("Cookie", owner.cookie)
    .send({ content: "Nuevo texto", is_active: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.content, "Nuevo texto");
  assert.equal(updated.body.is_active, false);
  assert.equal((await request(app).patch(`/messages/${id}`).set("Cookie", client.cookie)
    .send({ content: "Prohibido" })).status, 403);

  const filtered = await request(app).get("/messages").set("Cookie", owner.cookie);
  assert.equal(filtered.body.data.some((item: { id: string }) => item.id === id), false);
  const all = await request(app).get("/messages?include_inactive=true").set("Cookie", owner.cookie);
  assert.ok(all.body.data.some((item: { id: string }) => item.id === id));

  assert.equal((await request(app).delete(`/messages/${id}`).set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).delete(`/messages/${id}`).set("Cookie", owner.cookie)).status, 204);
  assert.equal((await request(app).delete(`/messages/${id}`).set("Cookie", owner.cookie)).status, 404);
});
