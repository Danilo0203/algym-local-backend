import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../..");
const testEmailDomain = "@customer-routines.test.local";
const testPassword = "PasswordDePrueba123";

type TestUser = { email: string; userId: string };

let authorizedEmployee: TestUser;
let authorizedCookie: string;
let unauthorizedClient: TestUser;
let unauthorizedCookie: string;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

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

async function createUser(role: "client" | "employee"): Promise<TestUser> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);

  await pool.query(
    `INSERT INTO auth.users (
      id, email, encrypted_password, raw_user_meta_data, created_at, updated_at
    ) VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`,
    [userId, email, passwordHash],
  );
  runAdminSql(`
    INSERT INTO public.profiles (
      id, full_name, phone, birth_date, gender, role, biometric_id, is_active
    ) VALUES (
      ${sqlLiteral(userId)}, ${sqlLiteral(`ZZTEST ROUTINES ${role}`)},
      '55550000', DATE '1990-01-01', 'male', ${sqlLiteral(role)},
      ${Math.floor(Math.random() * 1000000) + 2000000}, true
    );
  `);
  return { email, userId };
}

async function login(email: string): Promise<string> {
  const response = await request(app).post("/auth/login").send({
    email,
    password: testPassword,
  });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return cookie;
}

async function cleanup(): Promise<void> {
  runAdminSql(`
    DELETE FROM public.routines
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.training_profiles
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.body_assessments
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
  `);
  await pool.query(
    `DELETE FROM auth.sessions WHERE user_id IN (
      SELECT id FROM auth.users WHERE email LIKE $1
    )`,
    [`%${testEmailDomain}`],
  );
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [
    `%${testEmailDomain}`,
  ]);
}

before(async () => {
  assert.equal(env.DB_NAME, "algym_test");
  await cleanup();
  authorizedEmployee = await createUser("employee");
  authorizedCookie = await login(authorizedEmployee.email);
  unauthorizedClient = await createUser("client");
  unauthorizedCookie = await login(unauthorizedClient.email);
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("GET /customers/:id/routine exige sesión y customers.manage_routine", async () => {
  const noSession = await request(app).get(`/customers/${randomUUID()}/routine`);
  assert.equal(noSession.status, 401);

  const forbidden = await request(app)
    .get(`/customers/${unauthorizedClient.userId}/routine`)
    .set("Cookie", unauthorizedCookie);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, "FORBIDDEN");
});

test("GET /customers/:id/routine devuelve 404 si el cliente no existe", async () => {
  const response = await request(app)
    .get(`/customers/${randomUUID()}/routine`)
    .set("Cookie", authorizedCookie);
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "CUSTOMER_NOT_FOUND");
});

test("GET /customers/:id/routine devuelve perfil, contexto, rutinas y detalles locales", async () => {
  const customer = await createUser("client");

  runAdminSql(`
    INSERT INTO public.body_assessments (
      user_id, date, weight_kg, height_cm, body_type, diet_type, activity_level
    ) VALUES (
      '${customer.userId}', CURRENT_DATE, 72.00, 170.00,
      'mesomorph', 'normocalorica', '3_5_dias'
    );

    INSERT INTO public.training_profiles (
      user_id, primary_goal, focus_areas, experience_level, days_per_week,
      session_minutes, training_location, equipment_available, activity_level,
      cardio_preference, restricted_movements, parq_requires_attention, is_complete
    ) VALUES (
      '${customer.userId}', 'strength', ARRAY['upper_body'], 'intermediate', 4,
      60, 'gym', ARRAY['full_gym'], '3_5_dias', 'moderate', ARRAY[]::text[],
      false, true
    );
  `);
  const activeRoutineId = runAdminQuery(`
    INSERT INTO public.routines (
      user_id, created_by, name, status, source, is_active, primary_goal
    ) VALUES (
      '${customer.userId}', '${authorizedEmployee.userId}', 'Rutina activa local',
      'active', 'admin', true, 'strength'
    ) RETURNING id;
  `);
  const draftRoutineId = runAdminQuery(`
    INSERT INTO public.routines (
      user_id, created_by, name, status, source, is_active, primary_goal
    ) VALUES (
      '${customer.userId}', '${authorizedEmployee.userId}', 'Borrador local',
      'draft', 'system', false, 'strength'
    ) RETURNING id;
  `);
  runAdminSql(`
    INSERT INTO public.routine_details (
      routine_id, day_of_week, exercise_order, block_type, sets, reps,
      rest_seconds, target_rir, exercise_name_snapshot
    ) VALUES
      ('${activeRoutineId}', 1, 1, 'strength', 4, '8', 90, 2, 'Sentadilla'),
      ('${draftRoutineId}', 1, 1, 'warmup', 1, '10', 30, NULL, 'Movilidad');
  `);

  const response = await request(app)
    .get(`/customers/${customer.userId}/routine`)
    .set("Cookie", authorizedCookie);

  assert.equal(response.status, 200);
  assert.equal(response.body.trainingProfile.user_id, customer.userId);
  assert.equal(response.body.trainingProfileStatus, "complete");
  assert.deepEqual(response.body.missingRequirements, []);
  assert.equal(response.body.nutritionContext.weightKg, 72);
  assert.equal(response.body.activeRoutine.id, activeRoutineId);
  assert.equal(response.body.draftRoutine.id, draftRoutineId);
  assert.equal(response.body.activeDetails[0].exercise_name_snapshot, "Sentadilla");
  assert.equal(response.body.activeDetails[0].target_rir, 2);
  assert.equal(response.body.draftDetails[0].block_type, "warmup");
  assert.equal(JSON.stringify(response.body).includes("encrypted_password"), false);
});

test("las cinco mutaciones de Rutinas exigen sesión", async () => {
  const customerId = randomUUID();
  const routineId = randomUUID();
  const detailId = 999999;
  const responses = await Promise.all([
    request(app)
      .post(`/customers/${customerId}/routines`)
      .send({ name: "Sin sesión" }),
    request(app)
      .patch(`/customers/${customerId}/routines/${routineId}`)
      .send({ name: "Sin sesión" }),
    request(app)
      .post(`/customers/${customerId}/routines/${routineId}/details`)
      .send({ day_of_week: 1 }),
    request(app)
      .patch(`/customers/${customerId}/routines/${routineId}/details/${detailId}`)
      .send({ sets: 3 }),
    request(app).delete(
      `/customers/${customerId}/routines/${routineId}/details/${detailId}`,
    ),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status),
    [401, 401, 401, 401, 401],
  );
});

test("las cinco mutaciones rechazan usuarios sin customers.manage_routine", async () => {
  const customer = await createUser("client");
  const routineId = runAdminQuery(`
    INSERT INTO public.routines (
      user_id, created_by, name, status, source, is_active
    ) VALUES (
      '${customer.userId}', '${authorizedEmployee.userId}',
      'Rutina protegida HTTP', 'draft', 'admin', false
    ) RETURNING id;
  `);
  const detailId = Number(runAdminQuery(`
    INSERT INTO public.routine_details (
      routine_id, day_of_week, exercise_order, block_type, sets,
      exercise_name_snapshot
    ) VALUES ('${routineId}', 1, 1, 'strength', 3, 'Detalle protegido HTTP')
    RETURNING id;
  `));

  const responses = await Promise.all([
    request(app)
      .post(`/customers/${customer.userId}/routines`)
      .set("Cookie", unauthorizedCookie)
      .send({ name: "No autorizado" }),
    request(app)
      .patch(`/customers/${customer.userId}/routines/${routineId}`)
      .set("Cookie", unauthorizedCookie)
      .send({ name: "No autorizado" }),
    request(app)
      .post(`/customers/${customer.userId}/routines/${routineId}/details`)
      .set("Cookie", unauthorizedCookie)
      .send({ day_of_week: 1 }),
    request(app)
      .patch(`/customers/${customer.userId}/routines/${routineId}/details/${detailId}`)
      .set("Cookie", unauthorizedCookie)
      .send({ sets: 4 }),
    request(app)
      .delete(`/customers/${customer.userId}/routines/${routineId}/details/${detailId}`)
      .set("Cookie", unauthorizedCookie),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status),
    [403, 403, 403, 403, 403],
  );
  for (const response of responses) {
    assert.equal(response.body.error.code, "FORBIDDEN");
  }
});

test("las mutaciones validan bodies estrictos y fechas", async () => {
  const customer = await createUser("client");
  const routineId = runAdminQuery(`
    INSERT INTO public.routines (
      user_id, created_by, name, start_date, status, source, is_active
    ) VALUES (
      '${customer.userId}', '${authorizedEmployee.userId}',
      'Rutina validación', DATE '2026-07-10', 'draft', 'admin', false
    ) RETURNING id;
  `);
  const detailId = Number(runAdminQuery(`
    INSERT INTO public.routine_details (
      routine_id, day_of_week, exercise_order, block_type, sets,
      exercise_name_snapshot
    ) VALUES ('${routineId}', 1, 1, 'strength', 3, 'Detalle validación')
    RETURNING id;
  `));

  const invalidCreate = await request(app)
    .post(`/customers/${customer.userId}/routines`)
    .set("Cookie", authorizedCookie)
    .send({
      name: "Fechas inválidas",
      start_date: "2026-07-20",
      end_date: "2026-07-19",
      user_id: customer.userId,
    });
  const emptyPatch = await request(app)
    .patch(`/customers/${customer.userId}/routines/${routineId}`)
    .set("Cookie", authorizedCookie)
    .send({});
  const invalidDetail = await request(app)
    .post(`/customers/${customer.userId}/routines/${routineId}/details`)
    .set("Cookie", authorizedCookie)
    .send({ day_of_week: 8, sets: 0 });
  const protectedDetailField = await request(app)
    .patch(`/customers/${customer.userId}/routines/${routineId}/details/${detailId}`)
    .set("Cookie", authorizedCookie)
    .send({ routine_id: randomUUID() });
  const invalidMergedDates = await request(app)
    .patch(`/customers/${customer.userId}/routines/${routineId}`)
    .set("Cookie", authorizedCookie)
    .send({ end_date: "2026-07-09" });

  assert.deepEqual(
    [invalidCreate, emptyPatch, invalidDetail, protectedDetailField].map(
      (response) => response.status,
    ),
    [400, 400, 400, 400],
  );
  assert.equal(invalidMergedDates.status, 422);
  assert.equal(invalidMergedDates.body.error.code, "INVALID_ROUTINE_DATES");
});

test("las mutaciones devuelven 404 para cliente, rutina o detalle fuera de la cadena", async () => {
  const customer = await createUser("client");
  const otherCustomer = await createUser("client");
  const routineId = runAdminQuery(`
    INSERT INTO public.routines (
      user_id, created_by, name, status, source, is_active
    ) VALUES (
      '${customer.userId}', '${authorizedEmployee.userId}',
      'Rutina lookup', 'draft', 'admin', false
    ) RETURNING id;
  `);

  const missingCustomer = await request(app)
    .post(`/customers/${randomUUID()}/routines`)
    .set("Cookie", authorizedCookie)
    .send({ name: "Cliente inexistente" });
  const missingRoutine = await request(app)
    .patch(`/customers/${customer.userId}/routines/${randomUUID()}`)
    .set("Cookie", authorizedCookie)
    .send({ name: "Rutina inexistente" });
  const mismatchedRoutine = await request(app)
    .post(`/customers/${otherCustomer.userId}/routines/${routineId}/details`)
    .set("Cookie", authorizedCookie)
    .send({ day_of_week: 1 });
  const missingDetail = await request(app)
    .patch(`/customers/${customer.userId}/routines/${routineId}/details/99999999`)
    .set("Cookie", authorizedCookie)
    .send({ sets: 4 });

  assert.equal(missingCustomer.status, 404);
  assert.equal(missingCustomer.body.error.code, "CUSTOMER_NOT_FOUND");
  assert.equal(missingRoutine.status, 404);
  assert.equal(missingRoutine.body.error.code, "ROUTINE_NOT_FOUND");
  assert.equal(mismatchedRoutine.status, 404);
  assert.equal(mismatchedRoutine.body.error.code, "ROUTINE_NOT_FOUND");
  assert.equal(missingDetail.status, 404);
  assert.equal(missingDetail.body.error.code, "ROUTINE_DETAIL_NOT_FOUND");
});

test("crea y actualiza rutinas y ejecuta el ciclo transaccional de routine_details", async () => {
  const customer = await createUser("client");

  const created = await request(app)
    .post(`/customers/${customer.userId}/routines`)
    .set("Cookie", authorizedCookie)
    .send({
      name: "Rutina API local",
      start_date: "2026-07-21",
      end_date: "2026-08-21",
      status: "draft",
      source: "admin",
      primary_goal: "strength",
    });

  assert.equal(created.status, 201);
  assert.equal(created.body.customer_id, customer.userId);
  assert.equal(created.body.routine.user_id, customer.userId);
  assert.equal(created.body.routine.created_by, authorizedEmployee.userId);
  assert.equal(created.body.routine.status, "draft");
  assert.equal(created.body.routine.is_active, false);
  const routineId = created.body.routine.id as string;

  const updated = await request(app)
    .patch(`/customers/${customer.userId}/routines/${routineId}`)
    .set("Cookie", authorizedCookie)
    .send({ name: "Rutina API actualizada", goal: "Fuerza" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.routine.name, "Rutina API actualizada");
  assert.equal(updated.body.routine.goal, "Fuerza");

  const detailCreated = await request(app)
    .post(`/customers/${customer.userId}/routines/${routineId}/details`)
    .set("Cookie", authorizedCookie)
    .send({
      day_of_week: 1,
      exercise_order: 1,
      block_type: "strength",
      sets: 3,
      reps: "10",
      exercise_name_snapshot: "Sentadilla local",
    });
  assert.equal(detailCreated.status, 201);
  assert.equal(detailCreated.body.detail.sets, 3);
  const detailId = detailCreated.body.detail.id as number;

  const detailUpdated = await request(app)
    .patch(`/customers/${customer.userId}/routines/${routineId}/details/${detailId}`)
    .set("Cookie", authorizedCookie)
    .send({ sets: 4, target_rir: 2.5, notes: "Progresión local" });
  assert.equal(detailUpdated.status, 200);
  assert.equal(detailUpdated.body.detail.sets, 4);
  assert.equal(detailUpdated.body.detail.target_rir, 2.5);
  assert.equal(detailUpdated.body.detail.notes, "Progresión local");

  const detailDeleted = await request(app)
    .delete(`/customers/${customer.userId}/routines/${routineId}/details/${detailId}`)
    .set("Cookie", authorizedCookie);
  assert.equal(detailDeleted.status, 204);
  assert.equal(
    runAdminQuery(`SELECT count(*) FROM public.routine_details WHERE id = ${detailId};`),
    "0",
  );

  const creatorOwnedRoutineId = runAdminQuery(`
    INSERT INTO public.routines (
      user_id, created_by, name, status, source, is_active
    ) VALUES (
      '${customer.userId}', '${unauthorizedClient.userId}',
      'Rutina del creador', 'draft', 'admin', false
    ) RETURNING id;
  `);
  const creatorUpdate = await request(app)
    .patch(`/customers/${customer.userId}/routines/${creatorOwnedRoutineId}`)
    .set("Cookie", unauthorizedCookie)
    .send({ name: "Actualizada por created_by" });
  assert.equal(creatorUpdate.status, 200);
  assert.equal(creatorUpdate.body.routine.name, "Actualizada por created_by");
});

test("activar una rutina archiva la anterior y una validación fallida no deja cambios parciales", async () => {
  const customer = await createUser("client");
  const active = await request(app)
    .post(`/customers/${customer.userId}/routines`)
    .set("Cookie", authorizedCookie)
    .send({ name: "Activa inicial", status: "active" });
  const draft = await request(app)
    .post(`/customers/${customer.userId}/routines`)
    .set("Cookie", authorizedCookie)
    .send({ name: "Borrador a activar", status: "draft" });
  assert.equal(active.status, 201);
  assert.equal(draft.status, 201);

  const activated = await request(app)
    .patch(`/customers/${customer.userId}/routines/${draft.body.routine.id}`)
    .set("Cookie", authorizedCookie)
    .send({ status: "active" });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.routine.status, "active");
  assert.equal(activated.body.routine.is_active, true);
  assert.equal(activated.body.routine.reviewed_by, authorizedEmployee.userId);
  assert.equal(
    runAdminQuery(`SELECT status FROM public.routines WHERE id = '${active.body.routine.id}';`),
    "archived",
  );

  const nextDraft = await request(app)
    .post(`/customers/${customer.userId}/routines`)
    .set("Cookie", authorizedCookie)
    .send({ name: "Borrador rollback", status: "draft" });
  const failedActivation = await request(app)
    .patch(`/customers/${customer.userId}/routines/${nextDraft.body.routine.id}`)
    .set("Cookie", authorizedCookie)
    .send({ status: "active", training_profile_id: randomUUID() });
  assert.equal(failedActivation.status, 404);
  assert.equal(
    failedActivation.body.error.code,
    "TRAINING_PROFILE_NOT_FOUND",
  );
  assert.equal(
    runAdminQuery(`SELECT status FROM public.routines WHERE id = '${draft.body.routine.id}';`),
    "active",
  );
  assert.equal(
    runAdminQuery(`SELECT status FROM public.routines WHERE id = '${nextDraft.body.routine.id}';`),
    "draft",
  );
});

test("RLS permite al staff autorizado crear y modificar datos de Rutinas, pero no borrar routines", async () => {
  const employee = await createUser("employee");
  const customer = await createUser("client");

  const result = await withUserTransaction(employee.userId, async (client) => {
    const trainingProfile = await client.query<{ id: string }>(
      `
        INSERT INTO public.training_profiles (
          user_id, primary_goal, focus_areas, experience_level, days_per_week,
          session_minutes, training_location, equipment_available, activity_level,
          cardio_preference, restricted_movements, parq_requires_attention, is_complete
        ) VALUES (
          $1, 'strength', ARRAY['upper_body'], 'intermediate', 4,
          60, 'gym', ARRAY['full_gym'], '3_5_dias', 'moderate',
          ARRAY[]::text[], false, true
        )
        RETURNING id
      `,
      [customer.userId],
    );
    const routine = await client.query<{ id: string }>(
      `
        INSERT INTO public.routines (
          user_id, created_by, name, status, source, is_active, primary_goal
        ) VALUES ($1, $2, 'Rutina RLS', 'draft', 'admin', false, 'strength')
        RETURNING id
      `,
      [customer.userId, employee.userId],
    );
    const routineId = routine.rows[0]?.id;
    assert.ok(routineId);

    const detail = await client.query<{ id: number }>(
      `
        INSERT INTO public.routine_details (
          routine_id, day_of_week, exercise_order, block_type, sets, reps,
          exercise_name_snapshot
        ) VALUES ($1, 1, 1, 'strength', 3, '10', 'Prensa RLS')
        RETURNING id
      `,
      [routineId],
    );
    const detailId = detail.rows[0]?.id;
    assert.ok(detailId);

    const profileUpdate = await client.query(
      `UPDATE public.training_profiles
       SET days_per_week = 5
       WHERE user_id = $1
       RETURNING id`,
      [customer.userId],
    );
    const routineUpdate = await client.query(
      `UPDATE public.routines
       SET name = 'Rutina RLS actualizada'
       WHERE id = $1
       RETURNING id`,
      [routineId],
    );
    const detailUpdate = await client.query(
      `UPDATE public.routine_details
       SET sets = 4
       WHERE id = $1
       RETURNING id`,
      [detailId],
    );
    const detailDelete = await client.query(
      `DELETE FROM public.routine_details
       WHERE id = $1
       RETURNING id`,
      [detailId],
    );
    const routineDelete = await client.query(
      `DELETE FROM public.routines
       WHERE id = $1
       RETURNING id`,
      [routineId],
    );

    return {
      trainingProfileRows: trainingProfile.rowCount,
      routineRows: routine.rowCount,
      detailRows: detail.rowCount,
      profileUpdateRows: profileUpdate.rowCount,
      routineUpdateRows: routineUpdate.rowCount,
      detailUpdateRows: detailUpdate.rowCount,
      detailDeleteRows: detailDelete.rowCount,
      routineDeleteRows: routineDelete.rowCount,
    };
  });

  assert.deepEqual(result, {
    trainingProfileRows: 1,
    routineRows: 1,
    detailRows: 1,
    profileUpdateRows: 1,
    routineUpdateRows: 1,
    detailUpdateRows: 1,
    detailDeleteRows: 1,
    routineDeleteRows: 0,
  });
});

test("RLS rechaza mutaciones de Rutinas para un usuario sin customers.manage_routine", async () => {
  const employee = await createUser("employee");
  const customer = await createUser("client");
  const unauthorizedClient = await createUser("client");

  const seeded = await withUserTransaction(employee.userId, async (client) => {
    await client.query(
      `INSERT INTO public.training_profiles (
        user_id, primary_goal, focus_areas, equipment_available,
        restricted_movements, is_complete
      ) VALUES ($1, 'strength', ARRAY[]::text[], ARRAY['full_gym'], ARRAY[]::text[], false)`,
      [customer.userId],
    );
    const routine = await client.query<{ id: string }>(
      `INSERT INTO public.routines (
        user_id, created_by, name, status, source, is_active
      ) VALUES ($1, $2, 'Rutina protegida', 'draft', 'admin', false)
      RETURNING id`,
      [customer.userId, employee.userId],
    );
    const routineId = routine.rows[0]?.id;
    assert.ok(routineId);
    const detail = await client.query<{ id: number }>(
      `INSERT INTO public.routine_details (
        routine_id, day_of_week, exercise_order, block_type, sets, reps,
        exercise_name_snapshot
      ) VALUES ($1, 1, 1, 'strength', 3, '10', 'Detalle protegido')
      RETURNING id`,
      [routineId],
    );
    const detailId = detail.rows[0]?.id;
    assert.ok(detailId);
    return { routineId, detailId };
  });

  const hiddenUpdates = await withUserTransaction(unauthorizedClient.userId, async (client) => {
    const profileUpdate = await client.query(
      `UPDATE public.training_profiles SET days_per_week = 7 WHERE user_id = $1 RETURNING id`,
      [customer.userId],
    );
    const routineUpdate = await client.query(
      `UPDATE public.routines SET name = 'No autorizado' WHERE id = $1 RETURNING id`,
      [seeded.routineId],
    );
    const detailUpdate = await client.query(
      `UPDATE public.routine_details SET sets = 99 WHERE id = $1 RETURNING id`,
      [seeded.detailId],
    );

    return [profileUpdate.rowCount, routineUpdate.rowCount, detailUpdate.rowCount];
  });

  assert.deepEqual(hiddenUpdates, [0, 0, 0]);

  await assert.rejects(
    withUserTransaction(unauthorizedClient.userId, (client) =>
      client.query(
        `INSERT INTO public.routines (
          user_id, created_by, name, status, source, is_active
        ) VALUES ($1, $2, 'Inserción no autorizada', 'draft', 'admin', false)`,
        [customer.userId, unauthorizedClient.userId],
      ),
    ),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "42501",
      ),
  );
});
