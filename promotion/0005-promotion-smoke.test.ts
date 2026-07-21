import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { pool } from "../src/db/pool.js";

const targetDatabaseName = "algym_preprod";
const testPassword = "PasswordDePromocion123";
const runId = randomUUID();
const fixturePrefix = `ZZPROMO_0005_${runId}`;
const fixtureEmailDomain = `@promotion-${runId}.test.local`;
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..");

type PersistentCounts = {
  authSessions: number;
  authUsers: number;
  cashMovements: number;
  cashSessions: number;
  deviceCommands: number;
  payments: number;
  plans: number;
  profiles: number;
  subscriptions: number;
};

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runAdminSql(sql: string): void {
  execFileSync(
    "psql",
    ["-X", "-d", targetDatabaseName, "-v", "ON_ERROR_STOP=1", "-c", sql],
    { cwd: projectRoot, stdio: "ignore" },
  );
}

function runAdminQuery(sql: string): string {
  return execFileSync(
    "psql",
    [
      "-X",
      "-d",
      targetDatabaseName,
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-c",
      sql,
    ],
    { cwd: projectRoot, encoding: "utf8" },
  ).trim();
}

function readPersistentCounts(): PersistentCounts {
  const values = runAdminQuery(`
    SELECT concat_ws(
      '|',
      (SELECT count(*) FROM auth.sessions),
      (SELECT count(*) FROM auth.users),
      (SELECT count(*) FROM public.cash_movements),
      (SELECT count(*) FROM public.cash_sessions),
      (SELECT count(*) FROM public.device_commands),
      (SELECT count(*) FROM public.payments),
      (SELECT count(*) FROM public.plans),
      (SELECT count(*) FROM public.profiles),
      (SELECT count(*) FROM public.subscriptions)
    );
  `)
    .split("|")
    .map(Number);

  assert.equal(values.length, 9);

  return {
    authSessions: values[0]!,
    authUsers: values[1]!,
    cashMovements: values[2]!,
    cashSessions: values[3]!,
    deviceCommands: values[4]!,
    payments: values[5]!,
    plans: values[6]!,
    profiles: values[7]!,
    subscriptions: values[8]!,
  };
}

function cleanupFixtures(): void {
  runAdminSql(`
    BEGIN;

    DELETE FROM public.subscriptions
    WHERE user_id IN (
      SELECT id
      FROM auth.users
      WHERE email LIKE ${sqlLiteral(`%${fixtureEmailDomain}`)}
    );

    DELETE FROM public.access_logs
    WHERE user_id IN (
      SELECT id
      FROM auth.users
      WHERE email LIKE ${sqlLiteral(`%${fixtureEmailDomain}`)}
    );

    DELETE FROM auth.sessions
    WHERE user_id IN (
      SELECT id
      FROM auth.users
      WHERE email LIKE ${sqlLiteral(`%${fixtureEmailDomain}`)}
    );

    DELETE FROM public.profiles
    WHERE id IN (
      SELECT id
      FROM auth.users
      WHERE email LIKE ${sqlLiteral(`%${fixtureEmailDomain}`)}
    );

    DELETE FROM auth.users
    WHERE email LIKE ${sqlLiteral(`%${fixtureEmailDomain}`)};

    DELETE FROM public.device_commands
    WHERE command LIKE ${sqlLiteral(`%${fixturePrefix}%`)};

    DELETE FROM public.plans
    WHERE name LIKE ${sqlLiteral(`${fixturePrefix}%`)};

    COMMIT;
  `);
}

async function createOwnerActor(): Promise<string> {
  const userId = randomUUID();
  const email = `owner${fixtureEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);

  runAdminSql(`
    INSERT INTO auth.users (
      id,
      email,
      encrypted_password,
      raw_user_meta_data,
      created_at,
      updated_at
    )
    VALUES (
      ${sqlLiteral(userId)},
      ${sqlLiteral(email)},
      ${sqlLiteral(passwordHash)},
      '{}'::jsonb,
      now(),
      now()
    );

    INSERT INTO public.profiles (
      id,
      full_name,
      phone,
      birth_date,
      gender,
      role,
      is_active
    )
    VALUES (
      ${sqlLiteral(userId)},
      ${sqlLiteral(`${fixturePrefix} OWNER`)},
      '55550001',
      DATE '1990-01-01',
      'other',
      'owner',
      true
    );
  `);

  const loginResponse = await request(app).post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return cookie;
}

function createPlan(nameSuffix: string, isActive: boolean): number {
  return Number(
    runAdminQuery(`
      INSERT INTO public.plans (
        name,
        price,
        duration_days,
        description,
        is_active
      )
      VALUES (
        ${sqlLiteral(`${fixturePrefix} ${nameSuffix}`)},
        150,
        30,
        'Fixture temporal de promoción 0005',
        ${isActive}
      )
      RETURNING id;
    `),
  );
}

function customerPayload(nameSuffix: string, overrides?: Record<string, unknown>) {
  const emailPrefix = nameSuffix.toLowerCase().replaceAll(" ", "-");

  return {
    full_name: `${fixturePrefix} ${nameSuffix}`,
    phone: "55550002",
    birth_date: "1995-02-10",
    gender: "female",
    email: `${emailPrefix}${fixtureEmailDomain}`,
    injuries: "",
    medical_notes: "",
    ...overrides,
  };
}

function countUserByEmail(email: string): number {
  return Number(
    runAdminQuery(
      `SELECT count(*) FROM auth.users WHERE email = ${sqlLiteral(email)};`,
    ),
  );
}

test("smoke de promoción 0005 sobre una copia con datos persistentes", async (context) => {
  assert.equal(env.DB_NAME, targetDatabaseName);

  cleanupFixtures();
  const countsBefore = readPersistentCounts();

  try {
    const cookie = await createOwnerActor();
    const activePlanId = createPlan("PLAN ACTIVO", true);
    const inactivePlanId = createPlan("PLAN INACTIVO", false);

    await context.test("cliente sin membresía", async () => {
      const response = await request(app)
        .post("/customers")
        .set("Cookie", cookie)
        .send(customerPayload("SIN MEMBRESIA"));

      assert.equal(response.status, 201);
      assert.equal(response.body.current_membership, null);
    });

    let customerWithMembershipId = "";

    await context.test("cliente con membresía válida", async () => {
      const response = await request(app)
        .post("/customers")
        .set("Cookie", cookie)
        .send(
          customerPayload("CON MEMBRESIA", {
            membership: {
              plan_id: activePlanId,
              cycles: 1,
              start_date: "2026-08-01",
            },
          }),
        );

      assert.equal(response.status, 201);
      assert.equal(response.body.current_membership.status, "active");
      customerWithMembershipId = response.body.id;
    });

    await context.test("plan inválido revierte todo el cliente", async () => {
      const payload = customerPayload("PLAN INVALIDO", {
        membership: {
          plan_id: 2_147_483_647,
          cycles: 1,
        },
      });
      const response = await request(app)
        .post("/customers")
        .set("Cookie", cookie)
        .send(payload);

      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, "PLAN_NOT_FOUND");
      assert.equal(countUserByEmail(payload.email), 0);
    });

    await context.test("plan inactivo revierte todo el cliente", async () => {
      const payload = customerPayload("PLAN INACTIVO", {
        membership: {
          plan_id: inactivePlanId,
          cycles: 1,
        },
      });
      const response = await request(app)
        .post("/customers")
        .set("Cookie", cookie)
        .send(payload);

      assert.equal(response.status, 422);
      assert.equal(response.body.error.code, "PLAN_INACTIVE");
      assert.equal(countUserByEmail(payload.email), 0);
    });

    let inactiveCustomerId = "";

    await context.test("cliente inactivo no recibe membresía", async () => {
      const created = await request(app)
        .post("/customers")
        .set("Cookie", cookie)
        .send(customerPayload("CLIENTE INACTIVO"));

      assert.equal(created.status, 201);
      inactiveCustomerId = created.body.id;
      runAdminSql(
        `UPDATE public.profiles
         SET is_active = false
         WHERE id = ${sqlLiteral(inactiveCustomerId)};`,
      );

      const response = await request(app)
        .post(`/customers/${inactiveCustomerId}/membership`)
        .set("Cookie", cookie)
        .send({ plan_id: activePlanId, cycles: 1 });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "CUSTOMER_INACTIVE");
    });

    await context.test("segunda membresía activa es rechazada", async () => {
      const response = await request(app)
        .post(`/customers/${customerWithMembershipId}/membership`)
        .set("Cookie", cookie)
        .send({ plan_id: activePlanId, cycles: 1 });

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "MEMBERSHIP_ALREADY_ACTIVE");
    });

    await context.test("renovación y cancelación", async () => {
      const renewed = await request(app)
        .post(`/customers/${customerWithMembershipId}/membership/renew`)
        .set("Cookie", cookie)
        .send({ plan_id: activePlanId, cycles: 2 });

      assert.equal(renewed.status, 201);
      assert.equal(renewed.body.membership.status, "active");

      const cancelled = await request(app)
        .patch(`/customers/${customerWithMembershipId}/membership/status`)
        .set("Cookie", cookie)
        .send({ status: "cancelled" });

      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.membership.status, "cancelled");
    });

    await context.test("no existen escrituras financieras", () => {
      const countsDuringSmoke = readPersistentCounts();
      assert.equal(countsDuringSmoke.payments, countsBefore.payments);
      assert.equal(countsDuringSmoke.cashMovements, countsBefore.cashMovements);
      assert.equal(countsDuringSmoke.cashSessions, countsBefore.cashSessions);
    });

    await context.test("el siguiente plans.id es mayor que MAX(plans.id)", () => {
      const [maxPlanId, nextPlanId] = runAdminQuery(`
        WITH maximum AS (
          SELECT max(id)::bigint AS max_id
          FROM public.plans
        )
        SELECT maximum.max_id, nextval(
          pg_get_serial_sequence('public.plans', 'id')
        )
        FROM maximum;
      `).split("|").map(Number);

      assert.ok(maxPlanId !== undefined);
      assert.ok(nextPlanId !== undefined);
      assert.equal(nextPlanId > maxPlanId, true);
    });
  } finally {
    cleanupFixtures();
    const countsAfter = readPersistentCounts();
    await pool.end();
    assert.deepEqual(countsAfter, countsBefore);
  }
});
