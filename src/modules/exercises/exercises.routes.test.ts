import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { pool } from "../../db/pool.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testEmailDomain = "@exercises.test.local";
const password = "PasswordDePrueba123";
const previousMediaRoot = process.env.LOCAL_MEDIA_ROOT;
const mediaRoot = mkdtempSync(path.join(tmpdir(), "algym-exercises-test-"));
process.env.LOCAL_MEDIA_ROOT = mediaRoot;

function adminSql(sql: string) {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

async function createUser(role: "owner" | "client" | "employee") {
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
    VALUES ('${userId}', 'ZZTEST EXERCISES ${role}', '55540000', DATE '1990-01-01',
            'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const response = await request(app).post("/auth/login").send({ email, password });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { cookie, userId };
}

after(async () => {
  if (previousMediaRoot === undefined) delete process.env.LOCAL_MEDIA_ROOT;
  else process.env.LOCAL_MEDIA_ROOT = previousMediaRoot;
  rmSync(mediaRoot, { recursive: true, force: true });
  adminSql(`DELETE FROM public.routine_details
      WHERE exercise_id IN (SELECT id FROM public.exercises WHERE name LIKE 'ZZTEST LOCAL EXERCISE %');
    DELETE FROM public.routines
      WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.exercises WHERE name LIKE 'ZZTEST LOCAL EXERCISE %';
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}')`);
  await pool.query(
    "DELETE FROM auth.sessions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE $1)",
    [`%${testEmailDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testEmailDomain}`]);
  await pool.end();
});

test("catálogo de ejercicios crea y edita datos e imagen sin servicio externo", async () => {
  assert.equal((await request(app).get("/exercises")).status, 401);
  const owner = await createUser("owner");
  const client = await createUser("client");
  const employee = await createUser("employee");
  assert.equal((await request(app).get("/exercises").set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).get("/exercises").set("Cookie", employee.cookie)).status, 200);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await request(app).post("/media/exercises").set("Cookie", owner.cookie)
    .set("Content-Type", "image/png").send(png);
  assert.equal(uploaded.status, 201);

  const name = `ZZTEST LOCAL EXERCISE ${randomUUID()}`;
  const created = await request(app).post("/exercises").set("Cookie", owner.cookie).send({
    name,
    image_url: uploaded.body.url,
    original_file_name: "ejercicio.png",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, name);
  assert.equal(created.body.image_url, uploaded.body.url);
  const id = created.body.id;

  const textOnlyName = `ZZTEST LOCAL EXERCISE SIN ARCHIVO ${randomUUID()}`;
  const textOnly = await request(app).post("/exercises").set("Cookie", owner.cookie).send({
    name: textOnlyName,
    exercise_type: "strength",
    body_parts: ["upper legs"],
    target_muscles: ["quadriceps"],
    equipments: ["dumbbell"],
    instructions: ["Flexiona las rodillas con control."],
    keywords: ["squat"],
  });
  assert.equal(textOnly.status, 201);
  assert.equal(textOnly.body.image_url, null);
  assert.deepEqual(textOnly.body.body_parts, ["upper legs"]);
  assert.deepEqual(textOnly.body.target_muscles, ["quadriceps"]);
  assert.deepEqual(textOnly.body.equipments, ["dumbbell"]);
  assert.deepEqual(textOnly.body.instructions, ["Flexiona las rodillas con control."]);
  const attachedImage = await request(app).patch(`/exercises/${textOnly.body.id}`).set("Cookie", owner.cookie).send({
    imageUrl: uploaded.body.url,
    originalFileName: "imagen-local.png",
    target_muscles: ["quadriceps", "glutes"],
    equipments: [],
  });
  assert.equal(attachedImage.status, 200);
  assert.equal(attachedImage.body.image_url, uploaded.body.url);
  assert.deepEqual(attachedImage.body.target_muscles, ["quadriceps", "glutes"]);
  assert.deepEqual(attachedImage.body.equipments, []);
  const remoteImage = await request(app).patch(`/exercises/${textOnly.body.id}`).set("Cookie", owner.cookie).send({
    imageUrl: "https://example.invalid/exercise.png",
  });
  assert.equal(remoteImage.status, 400);

  const list = await request(app).get("/exercises").set("Cookie", owner.cookie);
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((item: { id: number }) => item.id === id));

  adminSql(`UPDATE public.exercises
    SET image_url = 'https://example.invalid/legacy.png', video_url = 'https://example.invalid/legacy.mp4'
    WHERE id = ${id}`);
  const redacted = await request(app).get("/exercises").set("Cookie", owner.cookie);
  const redactedExercise = redacted.body.data.find((item: { id: number }) => item.id === id);
  assert.equal(redactedExercise.image_url, null);
  assert.equal(redactedExercise.video_url, null);

  const routineId = randomUUID();
  adminSql(`INSERT INTO public.routines
    (id, user_id, created_by, name, status, source)
    VALUES ('${routineId}', '${client.userId}', '${owner.userId}', 'ZZTEST RUTINA EJERCICIO', 'active', 'admin');
    INSERT INTO public.routine_details
    (routine_id, day_of_week, exercise_id, exercise_name_snapshot)
    VALUES ('${routineId}', 1, ${id}, '${name}')`);

  const updatedName = `ZZTEST LOCAL EXERCISE EDITADO ${randomUUID()}`;
  const updated = await request(app).patch(`/exercises/${id}`).set("Cookie", owner.cookie).send({
    displayName: updatedName,
    isFavorite: true,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, updatedName);
  assert.equal(updated.body.is_favorite, true);
  const snapshot = execFileSync(
    "psql",
    ["-d", "algym_test", "-qAt", "-c", `SELECT exercise_name_snapshot FROM public.routine_details WHERE routine_id = '${routineId}'`],
    { cwd: projectRoot, encoding: "utf8" },
  ).trim();
  assert.equal(snapshot, updatedName);

  const denied = await request(app).patch(`/exercises/${id}`).set("Cookie", client.cookie).send({ isFavorite: false });
  assert.equal(denied.status, 403);
  const missingMedia = await request(app).post("/exercises").set("Cookie", owner.cookie).send({
    name: `ZZTEST LOCAL EXERCISE SIN IMAGEN ${randomUUID()}`,
    image_url: `/api/media/exercises/${"0".repeat(64)}.png`,
  });
  assert.equal(missingMedia.status, 404);
});

test("alta y adjunto de imagen coordinan archivo y fila, incluso si falla PostgreSQL", async () => {
  const owner = await createUser("owner");
  const client = await createUser("client");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const gifAlt = Buffer.from(gif);
  gifAlt[13] = 1; // Otro color de la paleta; sigue siendo un GIF de 1 × 1 válido.
  const pngFilename = `${createHash("sha256").update(png).digest("hex")}.png`;
  const gifFilename = `${createHash("sha256").update(gif).digest("hex")}.gif`;
  const gifAltFilename = `${createHash("sha256").update(gifAlt).digest("hex")}.gif`;
  const pngPath = path.join(mediaRoot, "exercises", pngFilename);
  const gifPath = path.join(mediaRoot, "exercises", gifFilename);
  const gifAltPath = path.join(mediaRoot, "exercises", gifAltFilename);
  const name = `ZZTEST LOCAL EXERCISE ATOMICO ${randomUUID()}`;
  const payload = { name, image_base64: gif.toString("base64"), original_file_name: "uno.gif" };

  assert.equal((await request(app).post("/exercises/with-image").send(payload)).status, 401);
  assert.equal((await request(app).post("/exercises/with-image")
    .set("Cookie", client.cookie).send(payload)).status, 403);
  assert.equal(existsSync(gifPath), false);

  const created = await request(app).post("/exercises/with-image")
    .set("Cookie", owner.cookie).send(payload);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.image_url, `/api/media/exercises/${gifFilename}`);
  assert.equal(existsSync(gifPath), true);
  assert.deepEqual((await request(app).get(`/media/exercises/${gifFilename}`)
    .set("Cookie", owner.cookie)).body, gif);

  const rejectedName = "ZZTEST LOCAL EXERCISE RECHAZADO";
  adminSql(`ALTER TABLE public.exercises ADD CONSTRAINT zz_exercise_image_failure
    CHECK (name <> '${rejectedName}')`);
  try {
    const failedNewFile = await request(app).post("/exercises/with-image")
      .set("Cookie", owner.cookie)
      .send({ name: rejectedName, image_base64: gifAlt.toString("base64") });
    assert.equal(failedNewFile.status, 500);
    assert.equal(existsSync(gifAltPath), false);
    const failedReusedFile = await request(app).post("/exercises/with-image")
      .set("Cookie", owner.cookie)
      .send({ name: rejectedName, image_base64: png.toString("base64") });
    assert.equal(failedReusedFile.status, 500);
    assert.equal(existsSync(pngPath), true);
  } finally {
    adminSql("ALTER TABLE public.exercises DROP CONSTRAINT zz_exercise_image_failure");
  }

  const missing = await request(app).post("/exercises/image-attachment")
    .set("Cookie", owner.cookie)
    .send({ exercise_id: 999999999, image_base64: gifAlt.toString("base64") });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(existsSync(gifAltPath), false);
  const attached = await request(app).post("/exercises/image-attachment")
    .set("Cookie", owner.cookie)
    .send({ exercise_id: created.body.id, image_base64: gifAlt.toString("base64") });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  assert.equal(attached.body.image_url, `/api/media/exercises/${gifAltFilename}`);
  assert.equal(existsSync(gifAltPath), true);
  assert.deepEqual((await request(app).get(`/media/exercises/${gifAltFilename}`)
    .set("Cookie", owner.cookie)).body, gifAlt);
});
