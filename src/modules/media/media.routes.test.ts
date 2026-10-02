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
import { saveMedia } from "./media.service.js";

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

function adminValue(sql: string) {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", sql], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

async function createUser(role: "owner" | "admin" | "employee" | "client") {
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
  return { userId, cookie };
}

after(async () => {
  if (previousMediaRoot === undefined) delete process.env.LOCAL_MEDIA_ROOT;
  else process.env.LOCAL_MEDIA_ROOT = previousMediaRoot;
  rmSync(mediaRoot, { recursive: true, force: true });
  adminSql(`DELETE FROM public.routine_details WHERE routine_id IN
    (SELECT id FROM public.routines WHERE name LIKE 'ZZTEST MEDIA%')`);
  adminSql("DELETE FROM public.routines WHERE name LIKE 'ZZTEST MEDIA%'");
  adminSql("DELETE FROM public.products WHERE name LIKE 'ZZTEST MEDIA%'");
  adminSql("DELETE FROM public.exercises WHERE name LIKE 'ZZTEST MEDIA%'");
  adminSql(`DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}')`);
  await pool.query(
    "DELETE FROM auth.sessions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE $1)",
    [`%${testEmailDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testEmailDomain}`]);
  await pool.end();
});

test("imágenes locales exigen vínculo y permiso de lectura, y conservan bytes", async () => {
  const owner = await createUser("owner");
  const admin = await createUser("admin");
  const employee = await createUser("employee");
  const client = await createUser("client");
  const otherClient = await createUser("client");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );

  const exerciseInput = { name: "ZZTEST MEDIA ejercicio", image_base64: png.toString("base64") };
  const anonymous = await request(app).post("/exercises/with-image").send(exerciseInput);
  assert.equal(anonymous.status, 401);
  const denied = await request(app).post("/exercises/with-image")
    .set("Cookie", client.cookie).send(exerciseInput);
  assert.equal(denied.status, 403);

  const stored = await saveMedia("exercises", png);
  assert.match(stored.url, /^\/api\/media\/exercises\/[a-f0-9]{64}\.png$/);
  assert.equal(stored.bytes, png.length);

  const filename = stored.url.split("/").at(-1);
  assert.ok(filename);
  const withoutSession = await request(app).get(`/media/exercises/${filename}`);
  assert.equal(withoutSession.status, 401);
  assert.equal((await request(app).get(`/media/exercises/${filename}`).set("Cookie", owner.cookie)).status, 404);
  assert.equal((await request(app).get(`/media/exercises/${filename}`).set("Cookie", client.cookie)).status, 403);

  const uploaded = await request(app).post("/exercises/with-image")
    .set("Cookie", owner.cookie).send(exerciseInput);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const exerciseId = Number(uploaded.body.id);
  assert.ok(Number.isInteger(exerciseId) && exerciseId > 0);
  assert.equal(uploaded.body.image_url, stored.url);
  const image = await request(app).get(`/media/exercises/${filename}`).set("Cookie", owner.cookie);
  assert.equal(image.status, 200);
  assert.match(String(image.headers["content-type"]), /^image\/png/);
  assert.deepEqual(image.body, png);
  assert.equal((await request(app).get(`/media/exercises/${filename}`).set("Cookie", employee.cookie)).status, 200);
  assert.equal((await request(app).get(`/media/exercises/${filename}`).set("Cookie", admin.cookie)).status, 403);
  assert.equal((await request(app).get(`/media/exercises/${filename}`).set("Cookie", client.cookie)).status, 403);

  const routineId = adminValue(`INSERT INTO public.routines (user_id, created_by, name, status, is_active)
    VALUES ('${client.userId}', '${owner.userId}', 'ZZTEST MEDIA rutina', 'active', true) RETURNING id`);
  adminSql(`INSERT INTO public.routine_details (routine_id, day_of_week, exercise_id)
    VALUES ('${routineId}', 1, ${exerciseId})`);
  const ownImage = await request(app).get(`/media/exercises/${filename}`).set("Cookie", client.cookie);
  assert.equal(ownImage.status, 200);
  assert.deepEqual(ownImage.body, png);
  assert.equal((await request(app).get(`/media/exercises/${filename}`).set("Cookie", otherClient.cookie)).status, 403);

  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const uploadedAnimation = await saveMedia("exercises", gif);
  const animationFilename = uploadedAnimation.url.split("/").at(-1);
  assert.ok(animationFilename);
  assert.equal((await request(app).get(`/media/exercises/${animationFilename}`)
    .set("Cookie", owner.cookie)).status, 404);
  adminSql(`UPDATE public.exercises SET animation_url = '${uploadedAnimation.url}' WHERE id = ${exerciseId}`);
  const ownAnimation = await request(app).get(`/media/exercises/${animationFilename}`)
    .set("Cookie", client.cookie);
  assert.equal(ownAnimation.status, 200);
  assert.match(String(ownAnimation.headers["content-type"]), /^image\/gif/);
  assert.deepEqual(ownAnimation.body, gif);
  assert.equal((await request(app).get(`/media/exercises/${animationFilename}`)
    .set("Cookie", owner.cookie)).status, 200);
  assert.equal((await request(app).get(`/media/exercises/${animationFilename}`)
    .set("Cookie", otherClient.cookie)).status, 403);

  const uploadedProduct = await saveMedia("products", png);
  const productFilename = uploadedProduct.url.split("/").at(-1);
  assert.equal((await request(app).get(`/media/products/${productFilename}`).set("Cookie", owner.cookie)).status, 404);
  const createdProduct = await request(app).post("/inventory/products/with-image")
    .set("Cookie", owner.cookie).send({
      name: "ZZTEST MEDIA producto", sku: null, barcode: null, costPrice: 0,
      salePrice: 10, isActive: true, initialQuantity: 0,
      image_base64: png.toString("base64"),
    });
  assert.equal(createdProduct.status, 201, JSON.stringify(createdProduct.body));
  assert.equal((await request(app).get(`/media/products/${productFilename}`).set("Cookie", owner.cookie)).status, 200);
  assert.equal((await request(app).get(`/media/products/${productFilename}`).set("Cookie", admin.cookie)).status, 403);
  assert.equal((await request(app).get(`/media/products/${productFilename}`).set("Cookie", employee.cookie)).status, 403);
  assert.equal((await request(app).get(`/media/products/${productFilename}`).set("Cookie", client.cookie)).status, 403);

  assert.equal((await request(app).post("/media/exercises")
    .set("Cookie", owner.cookie).set("Content-Type", "image/png").send(png)).status, 405);
  const invalid = await request(app).post("/exercises/with-image")
    .set("Cookie", owner.cookie)
    .send({ name: "ZZTEST MEDIA invalido", image_base64: Buffer.from("no es imagen").toString("base64") });
  assert.equal(invalid.status, 400);
  const wrongName = await request(app).get("/media/exercises/archivo.png").set("Cookie", owner.cookie);
  assert.equal(wrongName.status, 400);
});
