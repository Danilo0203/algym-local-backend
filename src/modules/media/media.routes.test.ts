import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { pool } from "../../db/pool.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testEmailDomain = "@media.test.local";
const password = "PasswordDePrueba123";
const previousMediaRoot = process.env.LOCAL_MEDIA_ROOT;
const mediaRoot = mkdtempSync(path.join(tmpdir(), "algym-media-test-"));
process.env.LOCAL_MEDIA_ROOT = mediaRoot;

function adminSql(sql: string) {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

async function createUser(role: "owner" | "client") {
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
    VALUES ('${userId}', 'ZZTEST MEDIA ${role}', '55540000', DATE '1990-01-01',
            'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const response = await request(app).post("/auth/login").send({ email, password });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return cookie;
}

after(async () => {
  if (previousMediaRoot === undefined) delete process.env.LOCAL_MEDIA_ROOT;
  else process.env.LOCAL_MEDIA_ROOT = previousMediaRoot;
  rmSync(mediaRoot, { recursive: true, force: true });
  adminSql(`DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}')`);
  await pool.query(
    "DELETE FROM auth.sessions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE $1)",
    [`%${testEmailDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testEmailDomain}`]);
  await pool.end();
});

test("imágenes locales exigen sesión y permiso para subir, y conservan bytes", async () => {
  const ownerCookie = await createUser("owner");
  const clientCookie = await createUser("client");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );

  const anonymous = await request(app).post("/media/exercises").set("Content-Type", "image/png").send(png);
  assert.equal(anonymous.status, 401);
  const denied = await request(app).post("/media/exercises").set("Cookie", clientCookie).set("Content-Type", "image/png").send(png);
  assert.equal(denied.status, 403);

  const uploaded = await request(app).post("/media/exercises").set("Cookie", ownerCookie).set("Content-Type", "image/png").send(png);
  assert.equal(uploaded.status, 201);
  assert.match(uploaded.body.url, /^\/api\/media\/exercises\/[a-f0-9]{64}\.png$/);
  assert.equal(uploaded.body.bytes, png.length);

  const filename = uploaded.body.url.split("/").at(-1);
  assert.ok(filename);
  const withoutSession = await request(app).get(`/media/exercises/${filename}`);
  assert.equal(withoutSession.status, 401);
  const image = await request(app).get(`/media/exercises/${filename}`).set("Cookie", clientCookie);
  assert.equal(image.status, 200);
  assert.match(String(image.headers["content-type"]), /^image\/png/);
  assert.deepEqual(image.body, png);

  const invalid = await request(app).post("/media/exercises").set("Cookie", ownerCookie).set("Content-Type", "image/png").send(Buffer.from("no es imagen"));
  assert.equal(invalid.status, 400);
  const wrongName = await request(app).get("/media/exercises/archivo.png").set("Cookie", ownerCookie);
  assert.equal(wrongName.status, 400);
});
