import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";

const testEmailDomain = "@customers-health.test.local";
const testNamePrefix = "ZZTEST_CUSTOMERS_HEALTH";
const testPassword = "PasswordDePrueba123";
const syntheticUserIds = new Set<string>();
const syntheticCustomerIds = new Set<string>();

type TestUserRole =
  | "admin"
  | "client"
  | "employee"
  | "owner"
  | "trainer";

type SyntheticUser = {
  email: string;
  userId: string;
};

function sqlUuidList(values: Iterable<string>): string {
  return [...values]
    .map((value) => `'${value.replaceAll("'", "''")}'::uuid`)
    .join(", ");
}

function runAdminSql(sql: string): void {
  execFileSync(
    "psql",
    ["-X", "-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { stdio: "ignore" },
  );
}

async function cleanup(): Promise<void> {
  const ids = new Set([...syntheticUserIds, ...syntheticCustomerIds]);

  runAdminSql(`
    DROP TRIGGER IF EXISTS fail_health_profile_update_for_tests
    ON public.customer_health_profiles;
    DROP FUNCTION IF EXISTS public.fail_health_profile_update_for_tests();
  `);

  if (ids.size === 0) return;
  const idList = sqlUuidList(ids);

  runAdminSql(`
    DELETE FROM public.customer_health_profiles
    WHERE user_id IN (${idList});

    DELETE FROM public.body_assessments
    WHERE user_id IN (${idList});

    DELETE FROM public.subscriptions
    WHERE user_id IN (${idList});

    DELETE FROM public.device_commands
    WHERE command LIKE '%${testNamePrefix}%';

    DELETE FROM auth.sessions
    WHERE user_id IN (${idList});

    DELETE FROM public.profiles
    WHERE id IN (${idList});

    DELETE FROM auth.users
    WHERE id IN (${idList});
  `);

  syntheticUserIds.clear();
  syntheticCustomerIds.clear();
}

async function createSyntheticUser(
  role: TestUserRole,
): Promise<SyntheticUser> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);
  syntheticUserIds.add(userId);

  await pool.query(
    `
      INSERT INTO auth.users (
        id,
        email,
        encrypted_password,
        raw_user_meta_data,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, '{}'::jsonb, now(), now())
    `,
    [userId, email, passwordHash],
  );

  runAdminSql(`
    INSERT INTO public.profiles (
      id,
      full_name,
      phone,
      birth_date,
      gender,
      role,
      biometric_id,
      is_active
    )
    VALUES (
      '${userId}',
      '${testNamePrefix} ${role}',
      '55530000',
      DATE '1990-01-01',
      'male',
      '${role}',
      ${Math.floor(Math.random() * 1_000_000)},
      true
    );
  `);

  return { email, userId };
}

async function createCustomer(
  actorUserId: string,
  options?: { email?: string | null },
): Promise<string> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_user_id', $1, true)",
      [actorUserId],
    );
    const result = await client.query<{ customer_id: string }>(
      `
        SELECT public.create_customer_core(
          $1,
          '55540000',
          DATE '1994-04-12',
          'female',
          $2,
          NULL,
          NULL
        ) AS customer_id
      `,
      [
        `${testNamePrefix} Cliente ${randomUUID().slice(0, 8)}`,
        options?.email === undefined
          ? `${randomUUID()}${testEmailDomain}`
          : options.email,
      ],
    );
    await client.query("COMMIT");

    const customerId = result.rows[0]!.customer_id;
    syntheticCustomerIds.add(customerId);
    return customerId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loginAndGetCookie(email: string): Promise<string> {
  const response = await request(app).post("/auth/login").send({
    email,
    password: testPassword,
  });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return cookie;
}

async function queryAsUser<Row extends Record<string, unknown>>(
  userId: string,
  sql: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_user_id', $1, true)",
      [userId],
    );
    const result = await client.query<Row>(sql, values);
    await client.query("ROLLBACK");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertSanitizedError(
  payload: unknown,
  sensitiveValue?: string,
): void {
  const serialized = JSON.stringify(payload).toLowerCase();
  assert.equal(serialized.includes("stack"), false);
  assert.equal(serialized.includes("select "), false);
  assert.equal(serialized.includes("insert "), false);
  assert.equal(serialized.includes("update "), false);
  assert.equal(serialized.includes("constraint"), false);
  if (sensitiveValue) {
    assert.equal(serialized.includes(sensitiveValue.toLowerCase()), false);
  }
}

before(async () => {
  assert.equal(env.DB_NAME, "algym_test");
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("health-profile cubre 401, 403, 404 y lectura nullable sin perfil", { concurrency: false }, async () => {
  const unauthorized = await request(app)
    .get(`/customers/${randomUUID()}/health-profile`);
  assert.equal(unauthorized.status, 401);

  const clientUser = await createSyntheticUser("client");
  const clientCookie = await loginAndGetCookie(clientUser.email);
  const forbidden = await request(app)
    .get(`/customers/${randomUUID()}/health-profile`)
    .set("Cookie", clientCookie);
  assert.equal(forbidden.status, 403);

  const employee = await createSyntheticUser("employee");
  const employeeCookie = await loginAndGetCookie(employee.email);
  const forbiddenEmployee = await request(app)
    .get(`/customers/${randomUUID()}/health-profile`)
    .set("Cookie", employeeCookie);
  assert.equal(forbiddenEmployee.status, 403);

  const owner = await createSyntheticUser("owner");
  const ownerCookie = await loginAndGetCookie(owner.email);
  const missing = await request(app)
    .get(`/customers/${randomUUID()}/health-profile`)
    .set("Cookie", ownerCookie);
  assert.equal(missing.status, 404);

  const customerId = await createCustomer(owner.userId);
  const empty = await request(app)
    .get(`/customers/${customerId}/health-profile`)
    .set("Cookie", ownerCookie);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.customer_id, customerId);
  assert.equal(empty.body.parq_requires_attention, null);
  assert.equal(empty.body.primary_goal, null);
  assert.equal(empty.body.created_at, null);

  const detail = await request(app)
    .get(`/customers/${customerId}`)
    .set("Cookie", ownerCookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.health_profile_status, "pending");
});

test("PATCH health-profile crea por UPSERT, normaliza y actualiza parcialmente", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId, { email: null });

  const created = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({
      parq_requires_attention: false,
      parq_details: "  Sin observaciones  ",
      primary_goal: "  Fuerza  ",
      focus_areas: [" Espalda ", "", "Espalda", "Piernas"],
      equipment_available: [" Mancuernas ", "  ", "Bandas"],
      days_per_week: 4,
      session_minutes: 75,
      diet_type: "Histórico personalizado",
    });

  assert.equal(created.status, 200);
  assert.equal(created.body.parq_details, "Sin observaciones");
  assert.deepEqual(created.body.focus_areas, ["Espalda", "Piernas"]);
  assert.deepEqual(created.body.equipment_available, ["Mancuernas", "Bandas"]);
  assert.ok(created.body.created_at);

  const updated = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({ secondary_goal: "  Movilidad  ", parq_details: null });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.primary_goal, "Fuerza");
  assert.equal(updated.body.secondary_goal, "Movilidad");
  assert.equal(updated.body.parq_details, null);

  const detail = await request(app)
    .get(`/customers/${customerId}`)
    .set("Cookie", cookie);
  assert.equal(detail.body.health_profile_status, "completed");
});

test("PATCH health-profile rechaza body vacío, propiedades desconocidas y límites", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId);

  for (const body of [
    {},
    { desconocido: "valor" },
    { days_per_week: 0 },
    { days_per_week: 8 },
    { session_minutes: 14 },
    { session_minutes: 481 },
  ]) {
    const response = await request(app)
      .patch(`/customers/${customerId}/health-profile`)
      .set("Cookie", cookie)
      .send(body);
    assert.equal(response.status, 400);
    assertSanitizedError(response.body);
  }
});

test("PATCH health-profile rechaza vacíos sin cambio y permite limpiar datos", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId);

  const initialNoop = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({ primary_goal: "   ", focus_areas: ["  "] });
  assert.equal(initialNoop.status, 400);
  assert.equal(initialNoop.body.error.code, "NO_HEALTH_PROFILE_CHANGES");

  const created = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({ primary_goal: "Fuerza" });
  assert.equal(created.status, 200);

  const cleared = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({ primary_goal: "   " });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.primary_goal, null);

  const repeatedClear = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({ primary_goal: null, focus_areas: [] });
  assert.equal(repeatedClear.status, 400);
  assert.equal(repeatedClear.body.error.code, "NO_HEALTH_PROFILE_CHANGES");

  const pending = await request(app)
    .get(`/customers/${customerId}`)
    .set("Cookie", cookie);
  assert.equal(pending.body.health_profile_status, "pending");

  const answered = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({ parq_requires_attention: false });
  assert.equal(answered.status, 200);

  const completed = await request(app)
    .get(`/customers/${customerId}`)
    .set("Cookie", cookie);
  assert.equal(completed.body.health_profile_status, "completed");
});

test("requires_attention se refleja sin exponer texto médico en el resumen", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId);
  const sensitiveText = "Lesión privada no resumible";

  const patched = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({
      parq_requires_attention: true,
      injuries_or_pain: sensitiveText,
      medications: "Dato médico privado",
    });
  assert.equal(patched.status, 200);

  const detail = await request(app)
    .get(`/customers/${customerId}`)
    .set("Cookie", cookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.health_profile_status, "requires_attention");
  assert.equal(JSON.stringify(detail.body).includes(sensitiveText), false);
  assert.equal("medications" in detail.body, false);
});

test("health-profile revierte la transacción y sanitiza errores de persistencia", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId);
  const sensitiveText = "DATO_MEDICO_SENSIBLE_ROLLBACK";

  const initial = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({ primary_goal: "Inicial", parq_details: "Conservar" });
  assert.equal(initial.status, 200);

  runAdminSql(`
    CREATE OR REPLACE FUNCTION public.fail_health_profile_update_for_tests()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'fallo controlado con dato %', NEW.parq_details;
    END;
    $$;

    CREATE TRIGGER fail_health_profile_update_for_tests
    BEFORE UPDATE ON public.customer_health_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.fail_health_profile_update_for_tests();
  `);

  try {
    const failed = await request(app)
      .patch(`/customers/${customerId}/health-profile`)
      .set("Cookie", cookie)
      .send({ primary_goal: "No persistir", parq_details: sensitiveText });
    assert.equal(failed.status, 500);
    assert.equal(failed.body.error.code, "HEALTH_DATA_PERSISTENCE_ERROR");
    assertSanitizedError(failed.body, sensitiveText);

    const rows = await queryAsUser<{
      parq_details: string;
      primary_goal: string;
    }>(
      owner.userId,
      `
        SELECT parq_details, primary_goal
        FROM public.customer_health_profiles
        WHERE user_id = $1
      `,
      [customerId],
    );
    assert.deepEqual(rows, [{
      parq_details: "Conservar",
      primary_goal: "Inicial",
    }]);
  } finally {
    runAdminSql(`
      DROP TRIGGER IF EXISTS fail_health_profile_update_for_tests
      ON public.customer_health_profiles;
      DROP FUNCTION IF EXISTS public.fail_health_profile_update_for_tests();
    `);
  }
});

test("RBAC de salud y evaluaciones alinea servicio y RLS para los cinco roles", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const ownerCookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId);

  const seededProfile = await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", ownerCookie)
    .send({ primary_goal: "Perfil para matriz RBAC" });
  assert.equal(seededProfile.status, 200);

  const seededAssessment = await request(app)
    .post(`/customers/${customerId}/body-assessments`)
    .set("Cookie", ownerCookie)
    .send({ weight_kg: 70 });
  assert.equal(seededAssessment.status, 201);

  const actors: Array<{
    role: TestUserRole;
    user: SyntheticUser;
    cookie: string;
    viewHealth: boolean;
    manageHealth: boolean;
    viewAssessments: boolean;
    manageAssessments: boolean;
  }> = [{
    role: "owner",
    user: owner,
    cookie: ownerCookie,
    viewHealth: true,
    manageHealth: true,
    viewAssessments: true,
    manageAssessments: true,
  }];

  for (const expected of [
    ["admin", true, true, true, true],
    ["trainer", true, false, true, true],
    ["employee", false, false, false, false],
    ["client", false, false, false, false],
  ] as const) {
    const [role, viewHealth, manageHealth, viewAssessments, manageAssessments] =
      expected;
    const user = await createSyntheticUser(role);
    actors.push({
      role,
      user,
      cookie: await loginAndGetCookie(user.email),
      viewHealth,
      manageHealth,
      viewAssessments,
      manageAssessments,
    });
  }

  for (const actor of actors) {
    const healthGet = await request(app)
      .get(`/customers/${customerId}/health-profile`)
      .set("Cookie", actor.cookie);
    assert.equal(healthGet.status, actor.viewHealth ? 200 : 403, actor.role);

    const healthPatch = await request(app)
      .patch(`/customers/${customerId}/health-profile`)
      .set("Cookie", actor.cookie)
      .send({ primary_goal: `Actualizado por ${actor.role}` });
    assert.equal(healthPatch.status, actor.manageHealth ? 200 : 403, actor.role);

    const assessmentsGet = await request(app)
      .get(`/customers/${customerId}/body-assessments`)
      .set("Cookie", actor.cookie);
    assert.equal(
      assessmentsGet.status,
      actor.viewAssessments ? 200 : 403,
      actor.role,
    );

    const assessmentsPost = await request(app)
      .post(`/customers/${customerId}/body-assessments`)
      .set("Cookie", actor.cookie)
      .send({ notes: `Evaluación de ${actor.role}` });
    assert.equal(
      assessmentsPost.status,
      actor.manageAssessments ? 201 : 403,
      actor.role,
    );

    const healthRows = await queryAsUser<{ user_id: string }>(
      actor.user.userId,
      `SELECT user_id FROM public.customer_health_profiles WHERE user_id = $1`,
      [customerId],
    );
    assert.equal(healthRows.length, actor.viewHealth ? 1 : 0, actor.role);

    const healthUpdates = await queryAsUser<{ user_id: string }>(
      actor.user.userId,
      `
        UPDATE public.customer_health_profiles
        SET primary_goal = primary_goal
        WHERE user_id = $1
        RETURNING user_id
      `,
      [customerId],
    );
    assert.equal(healthUpdates.length, actor.manageHealth ? 1 : 0, actor.role);

    const assessmentRows = await queryAsUser<{ id: string }>(
      actor.user.userId,
      `SELECT id FROM public.body_assessments WHERE user_id = $1`,
      [customerId],
    );
    assert.equal(
      assessmentRows.length > 0,
      actor.viewAssessments,
      actor.role,
    );

    const assessmentUpdates = await queryAsUser<{ id: string }>(
      actor.user.userId,
      `
        UPDATE public.body_assessments
        SET notes = notes
        WHERE id = $1
        RETURNING id
      `,
      [seededAssessment.body.id],
    );
    assert.equal(
      assessmentUpdates.length,
      actor.manageAssessments ? 1 : 0,
      actor.role,
    );
  }
});

test("body-assessments cubre 401, 403 y 404", { concurrency: false }, async () => {
  const unauthorized = await request(app)
    .get(`/customers/${randomUUID()}/body-assessments`);
  assert.equal(unauthorized.status, 401);

  const employee = await createSyntheticUser("employee");
  const employeeCookie = await loginAndGetCookie(employee.email);
  const forbiddenGet = await request(app)
    .get(`/customers/${randomUUID()}/body-assessments`)
    .set("Cookie", employeeCookie);
  assert.equal(forbiddenGet.status, 403);
  const forbiddenPost = await request(app)
    .post(`/customers/${randomUUID()}/body-assessments`)
    .set("Cookie", employeeCookie)
    .send({ weight_kg: 70 });
  assert.equal(forbiddenPost.status, 403);

  const owner = await createSyntheticUser("owner");
  const ownerCookie = await loginAndGetCookie(owner.email);
  const missingGet = await request(app)
    .get(`/customers/${randomUUID()}/body-assessments`)
    .set("Cookie", ownerCookie);
  assert.equal(missingGet.status, 404);
  const missingPost = await request(app)
    .post(`/customers/${randomUUID()}/body-assessments`)
    .set("Cookie", ownerCookie)
    .send({ weight_kg: 70 });
  assert.equal(missingPost.status, 404);
});

test("POST body-assessments admite creación parcial y completa", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId);

  const partial = await request(app)
    .post(`/customers/${customerId}/body-assessments`)
    .set("Cookie", cookie)
    .send({ weight_kg: 72.5 });
  assert.equal(partial.status, 201);
  assert.equal(partial.body.weight_kg, 72.5);
  assert.equal(partial.body.height_cm, null);
  assert.equal(partial.body.assessment_date.length, 10);

  const complete = await request(app)
    .post(`/customers/${customerId}/body-assessments`)
    .set("Cookie", cookie)
    .send({
      assessment_date: "2026-07-20",
      weight_kg: 71.25,
      height_cm: 168,
      body_fat_percentage: 22.5,
      muscle_mass_kg: 48.5,
      chest: 92,
      waist: 78,
      hip: 98,
      arm_right: 31,
      arm_left: 30.5,
      leg_right: 55,
      leg_left: 54.5,
      notes: "  Medición completa  ",
      nutrition_snapshot: {
        body_type: "Personalizado histórico",
        activity_level: "Actividad mixta",
        water_liters_goal: 2.5,
        daily_calories: 2200,
        protein_grams: 130,
        carbs_grams: 240,
        fat_grams: 70,
        diet_type: "Sin catálogo cerrado",
      },
    });
  assert.equal(complete.status, 201);
  assert.equal(complete.body.notes, "Medición completa");
  assert.equal(complete.body.leg_right, 55);
  assert.equal(complete.body.nutrition_snapshot.diet_type, "Sin catálogo cerrado");
  assert.ok(complete.body.created_at);
  assert.ok(complete.body.updated_at);
});

test("body-assessments rechaza fechas, negativos e imposibles sin filtrar salud", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId);
  const sensitiveNote = "NOTA_MEDICA_QUE_NO_DEBE_APARECER";

  for (const body of [
    {},
    { assessment_date: "2026-07-20" },
    { notes: "   " },
    { nutrition_snapshot: {} },
    { nutrition_snapshot: { diet_type: null } },
    { assessment_date: "2026-02-30", notes: sensitiveNote },
    { weight_kg: -1, notes: sensitiveNote },
    { weight_kg: 701, notes: sensitiveNote },
    { height_cm: 301, notes: sensitiveNote },
    { body_fat_percentage: 101, notes: sensitiveNote },
    { waist: 0, notes: sensitiveNote },
  ]) {
    const response = await request(app)
      .post(`/customers/${customerId}/body-assessments`)
      .set("Cookie", cookie)
      .send(body);
    assert.equal(response.status, 400);
    assertSanitizedError(response.body, sensitiveNote);
  }
});

test("GET body-assessments pagina y ordena por fecha con desempate estable", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId);

  for (const [assessmentDate, weight] of [
    ["2026-07-18", 73],
    ["2026-07-20", 71],
    ["2026-07-19", 72],
  ] as const) {
    const created = await request(app)
      .post(`/customers/${customerId}/body-assessments`)
      .set("Cookie", cookie)
      .send({ assessment_date: assessmentDate, weight_kg: weight });
    assert.equal(created.status, 201);
  }

  const pageOne = await request(app)
    .get(`/customers/${customerId}/body-assessments`)
    .query({ page: 1, page_size: 2 })
    .set("Cookie", cookie);
  assert.equal(pageOne.status, 200);
  assert.deepEqual(
    pageOne.body.data.map((row: { assessment_date: string }) => row.assessment_date),
    ["2026-07-20", "2026-07-19"],
  );
  assert.deepEqual(pageOne.body.meta, {
    page: 1,
    page_size: 2,
    total: 3,
    total_pages: 2,
  });

  const pageTwo = await request(app)
    .get(`/customers/${customerId}/body-assessments`)
    .query({ page: 2, page_size: 2 })
    .set("Cookie", cookie);
  assert.equal(pageTwo.body.data.length, 1);
  assert.equal(pageTwo.body.data[0].assessment_date, "2026-07-18");

  const invalidPage = await request(app)
    .get(`/customers/${customerId}/body-assessments`)
    .query({ page_size: 101 })
    .set("Cookie", cookie);
  assert.equal(invalidPage.status, 400);
});

test("PATCH body-assessments es parcial y garantiza pertenencia al cliente", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const firstCustomerId = await createCustomer(owner.userId);
  const secondCustomerId = await createCustomer(owner.userId);
  const created = await request(app)
    .post(`/customers/${firstCustomerId}/body-assessments`)
    .set("Cookie", cookie)
    .send({ weight_kg: 75, height_cm: 170, notes: "Inicial" });
  assert.equal(created.status, 201);

  const updated = await request(app)
    .patch(
      `/customers/${firstCustomerId}/body-assessments/${created.body.id}`,
    )
    .set("Cookie", cookie)
    .send({ weight_kg: 74.25, notes: null });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.weight_kg, 74.25);
  assert.equal(updated.body.height_cm, 170);
  assert.equal(updated.body.notes, null);

  const empty = await request(app)
    .patch(
      `/customers/${firstCustomerId}/body-assessments/${created.body.id}`,
    )
    .set("Cookie", cookie)
    .send({});
  assert.equal(empty.status, 400);

  const mismatch = await request(app)
    .patch(
      `/customers/${secondCustomerId}/body-assessments/${created.body.id}`,
    )
    .set("Cookie", cookie)
    .send({ weight_kg: 70 });
  assert.equal(mismatch.status, 404);
  assert.equal(mismatch.body.error.code, "BODY_ASSESSMENT_NOT_FOUND");

  const missingAssessment = await request(app)
    .patch(
      `/customers/${firstCustomerId}/body-assessments/${randomUUID()}`,
    )
    .set("Cookie", cookie)
    .send({ weight_kg: 70 });
  assert.equal(missingAssessment.status, 404);

  const missingCustomer = await request(app)
    .patch(`/customers/${randomUUID()}/body-assessments/${created.body.id}`)
    .set("Cookie", cookie)
    .send({ weight_kg: 70 });
  assert.equal(missingCustomer.status, 404);
  assert.equal(missingCustomer.body.error.code, "CUSTOMER_NOT_FOUND");
});

test("salud y evaluaciones no generan comandos ZKTeco adicionales", { concurrency: false }, async () => {
  const owner = await createSyntheticUser("owner");
  const cookie = await loginAndGetCookie(owner.email);
  const customerId = await createCustomer(owner.userId, { email: null });
  const beforeRows = await queryAsUser<{ total: string }>(
    owner.userId,
    `
      SELECT count(*)::text AS total
      FROM public.device_commands
      WHERE command LIKE $1
    `,
    [`%${testNamePrefix}%`],
  );

  await request(app)
    .patch(`/customers/${customerId}/health-profile`)
    .set("Cookie", cookie)
    .send({ primary_goal: "Movilidad" });
  await request(app)
    .post(`/customers/${customerId}/body-assessments`)
    .set("Cookie", cookie)
    .send({ weight_kg: 70 });

  const afterRows = await queryAsUser<{ total: string }>(
    owner.userId,
    `
      SELECT count(*)::text AS total
      FROM public.device_commands
      WHERE command LIKE $1
    `,
    [`%${testNamePrefix}%`],
  );
  assert.equal(afterRows[0]?.total, beforeRows[0]?.total);
});
