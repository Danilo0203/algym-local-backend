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
const domain = "@roles.test.local";
const password = "PasswordDePrueba123";
const roleSlug = `zz_local_${randomUUID().slice(0, 8)}`;
const actorIds: string[] = [];

function adminSql(sql: string) {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot, stdio: "ignore",
  });
}

async function createActor(role: "owner" | "client") {
  const id = randomUUID();
  actorIds.push(id);
  const email = `${id}${domain}`;
  await pool.query(
    `INSERT INTO auth.users (id,email,encrypted_password,created_at,updated_at)
     VALUES ($1,$2,$3,now(),now())`,
    [id, email, await bcrypt.hash(password, 10)],
  );
  adminSql(`INSERT INTO public.profiles
    (id,full_name,phone,birth_date,role,biometric_id,is_active)
    VALUES ('${id}', 'ZZTEST LOCAL ROLES ${role}', '', DATE '1990-01-01',
            '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

after(async () => {
  adminSql(`DELETE FROM public.role_permissions WHERE role_id IN
      (SELECT id FROM public.roles WHERE slug = '${roleSlug}');
    DELETE FROM public.roles WHERE slug = '${roleSlug}';
    DELETE FROM public.profiles WHERE id IN (${actorIds.map((id) => `'${id}'`).join(",") || "NULL"});
    DELETE FROM auth.sessions WHERE user_id IN (${actorIds.map((id) => `'${id}'`).join(",") || "NULL"});
    DELETE FROM auth.users WHERE id IN (${actorIds.map((id) => `'${id}'`).join(",") || "NULL"});
    DELETE FROM public.device_commands WHERE command LIKE '%ZZTEST LOCAL ROLES%';`);
  await pool.end();
});

test("roles locales: permisos, CRUD atómico, protección del sistema y RLS", async () => {
  assert.equal((await request(app).get("/roles")).status, 401);
  const owner = await createActor("owner");
  const client = await createActor("client");
  assert.equal((await request(app).get("/roles").set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).get("/roles/permissions").set("Cookie", client.cookie)).status, 403);
  const invisible = await withUserTransaction(client.id, (connection) =>
    connection.query("SELECT id FROM public.roles"));
  assert.equal(invisible.rowCount, 0);

  const roles = await request(app).get("/roles").set("Cookie", owner.cookie);
  assert.equal(roles.status, 200);
  const ownerRole = roles.body.data.find((role: { slug: string }) => role.slug === "owner");
  assert.ok(ownerRole?.id);
  assert.ok(ownerRole.user_count >= 1);
  const permissions = await request(app).get("/roles/permissions").set("Cookie", owner.cookie);
  assert.equal(permissions.status, 200);
  const permissionId = permissions.body.data.find((item: { key: string }) => item.key === "users.view")?.id;
  assert.ok(permissionId);

  assert.equal((await request(app).post("/roles").set("Cookie", client.cookie).send({
    name: "Denegado", slug: "denegado", permissionIds: [],
  })).status, 403);
  assert.equal((await request(app).post("/roles").set("Cookie", owner.cookie).send({
    name: "No válido", slug: roleSlug, permissionIds: [randomUUID()],
  })).status, 400);
  const created = await request(app).post("/roles").set("Cookie", owner.cookie).send({
    name: "Rol Local", slug: roleSlug, permissionIds: [permissionId],
  });
  assert.equal(created.status, 201);
  const roleId = created.body.id as string;
  assert.ok(roleId);
  assert.equal((await request(app).post("/roles").set("Cookie", owner.cookie).send({
    name: "Duplicado", slug: roleSlug, permissionIds: [],
  })).status, 409);

  const assigned = await request(app).get(`/roles/${roleId}/permissions`).set("Cookie", owner.cookie);
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.body.data, [permissionId]);
  const changed = await request(app).patch(`/roles/${roleId}`).set("Cookie", owner.cookie).send({
    name: "Rol Local Editado", permissionIds: [],
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.name, "Rol Local Editado");
  assert.deepEqual((await request(app).get(`/roles/${roleId}/permissions`)
    .set("Cookie", owner.cookie)).body.data, []);

  assert.equal((await request(app).delete(`/roles/${ownerRole.id}`)
    .set("Cookie", owner.cookie)).status, 403);
  assert.equal((await request(app).delete(`/roles/${roleId}`)
    .set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).delete(`/roles/${roleId}`)
    .set("Cookie", owner.cookie)).status, 204);
  assert.equal((await request(app).get(`/roles/${roleId}/permissions`)
    .set("Cookie", owner.cookie)).status, 404);
});
