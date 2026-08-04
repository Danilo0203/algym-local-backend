import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, {
  after,
  before,
} from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";

const currentDirectory = path.dirname(
  fileURLToPath(import.meta.url),
);
const projectRoot = path.resolve(currentDirectory, "../../..");
const testEmailDomain = "@customers.test.local";
const testPassword = "PasswordDePrueba123";
const testNamePrefix = "ZZTEST_CUSTOMERS";

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

function toSqlLiteral(
  value: boolean | number | string | null,
): string {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  return `'${value.replaceAll("'", "''")}'`;
}

function runAdminSql(sql: string): void {
  execFileSync(
    "psql",
    [
      "-d",
      "algym_test",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    {
      cwd: projectRoot,
      stdio: "ignore",
    },
  );
}

async function cleanupSyntheticUsers(): Promise<void> {
  await pool.query(
    `
      DELETE FROM public.device_commands
      WHERE command LIKE $1
    `,
    [`%${testNamePrefix}%`],
  );

  runAdminSql(`
    DELETE FROM public.attendance_logs
    WHERE biometric_id IN (
      SELECT profiles.biometric_id
      FROM public.profiles
      INNER JOIN auth.users ON users.id = profiles.id
      WHERE users.email LIKE '%${testEmailDomain}'
    );

    DELETE FROM public.payments
    WHERE user_id IN (
      SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}'
    );

    DELETE FROM public.body_assessments
    WHERE user_id IN (
      SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}'
    );

    DELETE FROM public.subscriptions
    WHERE user_id IN (
      SELECT id
      FROM auth.users
      WHERE email LIKE '%${testEmailDomain}'
    );

    DELETE FROM public.access_logs
    WHERE user_id IN (
      SELECT id
      FROM auth.users
      WHERE email LIKE '%${testEmailDomain}'
    );

    DELETE FROM public.profiles
    WHERE id IN (
      SELECT id
      FROM auth.users
      WHERE email LIKE '%${testEmailDomain}'
    );

    DELETE FROM public.plans
    WHERE name LIKE '${testNamePrefix}%';
  `);

  await pool.query(
    `
      DELETE FROM auth.sessions
      WHERE user_id IN (
        SELECT id
        FROM auth.users
        WHERE email LIKE $1
      )
    `,
    [`%${testEmailDomain}`],
  );

  await pool.query(
    `
      DELETE FROM auth.users
      WHERE email LIKE $1
    `,
    [`%${testEmailDomain}`],
  );
}

function assertNoSensitiveFields(payload: unknown): void {
  const serializedPayload = JSON.stringify(payload);

  assert.equal(
    serializedPayload.includes("encrypted_password"),
    false,
  );
  assert.equal(serializedPayload.includes("secret_hash"), false);
  assert.equal(serializedPayload.includes('"sessions"'), false);
  assert.equal(serializedPayload.includes('"password":'), false);
  assert.equal(/\$2[aby]\$\d{2}\$/.test(serializedPayload), false);
  assert.equal(serializedPayload.includes("token"), false);
  assert.equal(serializedPayload.includes("cookie"), false);
}

async function createSyntheticUser(options?: {
  fullName?: string;
  isActive?: boolean;
  role?: TestUserRole;
}): Promise<SyntheticUser> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);
  const fullName =
    options?.fullName ?? `${testNamePrefix} Usuario Clientes`;
  const role = options?.role ?? "client";
  const isActive = options?.isActive ?? true;

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
      ${toSqlLiteral(userId)},
      ${toSqlLiteral(fullName)},
      '55510000',
      DATE '1990-01-01',
      'male',
      ${toSqlLiteral(role)},
      ${toSqlLiteral(Math.floor(Math.random() * 1000000))},
      ${toSqlLiteral(isActive)}
    );
  `);

  return {
    email,
    userId,
  };
}

async function loginAndGetCookie(
  email: string,
  password = testPassword,
): Promise<string> {
  const response = await request(app).post("/auth/login").send({
    email,
    password,
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
      `
        SELECT set_config(
          'app.current_user_id',
          $1,
          true
        )
      `,
      [userId],
    );

    const result = await client.query<Row>(sql, values);

    await client.query("ROLLBACK");

    return result.rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Se conserva el error original.
    }

    throw error;
  } finally {
    client.release();
  }
}

async function createCustomerDirect(options?: {
  email?: string | null;
  fullName?: string;
}): Promise<{ id: string; email: string | null }> {
  const email =
      options?.email === undefined
      ? `${randomUUID()}${testEmailDomain}`
      : options.email;
  const owner = await createSyntheticUser({ role: "owner" });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.current_user_id', $1, true)",
      [owner.userId],
    );
    const result = await client.query<{
      customer_id: string;
    }>(
      `
        SELECT public.create_customer_core(
          $1,
          '55520000',
          DATE '1993-06-15',
          'female',
          $2,
          'Rodilla',
          'Nota'
        ) AS customer_id
      `,
      [
        options?.fullName ?? `${testNamePrefix} Cliente Directo`,
        email,
      ],
    );
    await client.query("COMMIT");
    return {
      id: result.rows[0]!.customer_id,
      email,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function buildCustomerPayload(overrides?: Record<string, unknown>) {
  return {
    full_name: `${testNamePrefix} Cliente ${randomUUID().slice(0, 8)}`,
    phone: "55512345",
    birth_date: "1995-02-10",
    gender: "female",
    email: `${randomUUID()}${testEmailDomain}`,
    injuries: "Hombro",
    medical_notes: "Observacion",
    ...overrides,
  };
}

before(async () => {
  if (env.DB_NAME !== "algym_test") {
    throw new Error(
      `DB_NAME debe ser exactamente algym_test y actualmente es ${env.DB_NAME}.`,
    );
  }

  await cleanupSyntheticUsers();
});

after(async () => {
  await cleanupSyntheticUsers();
  await pool.end();
});

test("GET /customers devuelve 401 sin sesion", { concurrency: false }, async () => {
  const response = await request(app).get("/customers");

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_SESSION",
      message: "Sesión inválida",
    },
  });
});

test("GET /customers devuelve 403 sin permiso", { concurrency: false }, async () => {
  const clientUser = await createSyntheticUser({
    role: "client",
  });
  const cookie = await loginAndGetCookie(clientUser.email);

  const response = await request(app)
    .get("/customers")
    .set("Cookie", cookie);

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "FORBIDDEN");
});

test("GET /customers devuelve solo role client y soporta paginacion, busqueda y sort", { concurrency: false }, async () => {
  const listPrefix = `${testNamePrefix} LIST ${randomUUID().slice(0, 8)}`;
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);

  await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(
      buildCustomerPayload({
        full_name: `${listPrefix} Álvaro López`,
        email: `alvaro-${randomUUID()}${testEmailDomain}`,
      }),
    );
  await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(
      buildCustomerPayload({
        full_name: `${listPrefix} Brenda Ruiz`,
        email: `brenda-${randomUUID()}${testEmailDomain}`,
      }),
    );
  await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(
      buildCustomerPayload({
        full_name: `${listPrefix} Carlos Mena`,
        email: `carlos-${randomUUID()}${testEmailDomain}`,
      }),
    );

  const response = await request(app)
    .get("/customers")
    .query({
      search: `${listPrefix} alvaro`,
      sort: "full_name",
      page: "1",
      page_size: "10",
    })
    .set("Cookie", cookie);

  assert.equal(response.status, 200);
  assert.equal(response.body.meta.total, 1);
  assert.equal(
    response.body.data[0]?.full_name,
    `${listPrefix} Álvaro López`,
  );
  assert.ok(
    response.body.data.every(
      (row: { role?: string }) => row.role === undefined,
    ),
  );

  const pageResponse = await request(app)
    .get("/customers")
    .query({
      search: listPrefix,
      sort: "full_name",
      page: "2",
      page_size: "1",
    })
    .set("Cookie", cookie);

  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.body.meta.total, 3);
  assert.equal(pageResponse.body.meta.total_pages, 3);
  assert.equal(pageResponse.body.data.length, 1);
  assert.deepEqual(
    pageResponse.body.data.map(
      (row: { full_name: string }) => row.full_name,
    ),
    [`${listPrefix} Brenda Ruiz`],
  );
  assertNoSensitiveFields(pageResponse.body);
});

test("GET /customers con sort invalido devuelve 400", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);

  const response = await request(app)
    .get("/customers")
    .query({ sort: "role" })
    .set("Cookie", cookie);

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_SORT",
      message: "Parámetro sort inválido",
    },
  });
});

test("GET /customers/:id devuelve ficha basica y 404 si no existe", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);
  const created = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(
      buildCustomerPayload({
        full_name: `${testNamePrefix} Detalle Cliente`,
      }),
    );

  assert.equal(created.status, 201);

  const response = await request(app)
    .get(`/customers/${created.body.id}`)
    .set("Cookie", cookie);

  assert.equal(response.status, 200);
  assert.equal(
    response.body.full_name,
    `${testNamePrefix} Detalle Cliente`,
  );
  assert.equal(response.body.role, "client");
  assert.equal(response.body.current_membership, null);
  assertNoSensitiveFields(response.body);

  const missingResponse = await request(app)
    .get(`/customers/${randomUUID()}`)
    .set("Cookie", cookie);

  assert.equal(missingResponse.status, 404);
  assert.deepEqual(missingResponse.body, {
    error: {
      code: "CUSTOMER_NOT_FOUND",
      message: "Cliente no encontrado",
    },
  });
});

test("POST /customers crea cliente sin email y sin hash usable", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);

  const response = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(
      buildCustomerPayload({
        email: undefined,
      }),
    );

  assert.equal(response.status, 201);
  assert.equal(response.body.email, null);

  const authUser = await pool.query<{
    encrypted_password: string | null;
  }>(
    `
      SELECT encrypted_password
      FROM auth.users
      WHERE id = $1
    `,
    [response.body.id],
  );

  assert.equal(authUser.rows[0]?.encrypted_password, null);
  assertNoSensitiveFields(response.body);
});

test("POST /customers acepta password opcional y permite login sin serializar el hash", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);
  const email = `credential-${randomUUID()}${testEmailDomain}`;
  const password = "PrimeraClaveSegura123";

  const response = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(buildCustomerPayload({ email, password }));

  assert.equal(response.status, 201);
  assert.equal(response.body.account.email, email);
  assert.equal(response.body.account.has_password, true);
  assert.equal(response.body.account.login_enabled, true);
  assertNoSensitiveFields(response.body);

  const loginResponse = await request(app).post("/auth/login").send({
    email: email.toUpperCase(),
    password,
  });
  assert.equal(loginResponse.status, 200);
  assertNoSensitiveFields(response.body);
});

test("POST /customers rechaza password débil y password sin email", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);

  const weak = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(buildCustomerPayload({ password: "corta" }));
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.code, "VALIDATION_ERROR");
  assert.ok(weak.body.error.details.password);

  const withoutEmail = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(buildCustomerPayload({ email: undefined, password: testPassword }));
  assert.equal(withoutEmail.status, 400);
  assert.equal(withoutEmail.body.error.code, "VALIDATION_ERROR");
  assert.ok(withoutEmail.body.error.details.password);
});

test("Cliente creado sin hash usable no puede iniciar sesion", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);
  const email = `login-${randomUUID()}${testEmailDomain}`;

  const createResponse = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(
      buildCustomerPayload({
        email,
      }),
    );

  assert.equal(createResponse.status, 201);

  const loginResponse = await request(app).post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 401);
  assert.deepEqual(loginResponse.body, {
    error: {
      code: "INVALID_CREDENTIALS",
      message: "Credenciales inválidas",
    },
  });
});

test("POST /customers normaliza email vacio a NULL", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);

  const response = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(
      buildCustomerPayload({
        email: "   ",
      }),
    );

  assert.equal(response.status, 201);
  assert.equal(response.body.email, null);

  const authUser = await pool.query<{
    email: string | null;
  }>(
    `
      SELECT email
      FROM auth.users
      WHERE id = $1
    `,
    [response.body.id],
  );

  assert.equal(authUser.rows[0]?.email, null);
});

test("POST /customers crea núcleo y membresía en una sola transacción", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);
  const planId = 900000 + Math.floor(Math.random() * 90000);

  runAdminSql(`
    INSERT INTO public.plans (id, name, price, duration_days, is_active)
    VALUES (${planId}, '${testNamePrefix} Plan atómico', 250, 30, true);
  `);

  const response = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(buildCustomerPayload({
      password: testPassword,
      membership: {
        plan_id: planId,
        cycles: 2,
        start_date: "2026-07-21",
      },
    }));

  assert.equal(response.status, 201);
  assert.equal(response.body.current_membership.plan_name, `${testNamePrefix} Plan atómico`);
  assert.equal(response.body.current_membership.status, "active");
  assert.equal(response.body.current_membership.start_date, "2026-07-21");
  assert.equal(response.body.current_membership.end_date, "2026-09-19");
  assert.equal(response.body.current_membership.grace_days, 3);
  assert.equal(response.body.account.has_password, true);
  assertNoSensitiveFields(response.body);
});

test("POST /customers con membresía exige customers.manage_membership y revierte el núcleo", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);
  const email = `forbidden-membership-${randomUUID()}${testEmailDomain}`;

  runAdminSql(`
    DELETE FROM public.role_permissions AS role_permissions
    USING public.roles AS roles, public.permissions AS permissions
    WHERE role_permissions.role_id = roles.id
      AND role_permissions.permission_id = permissions.id
      AND roles.slug = 'employee'
      AND permissions.key = 'customers.manage_membership';
  `);

  try {
    const response = await request(app)
      .post("/customers")
      .set("Cookie", cookie)
      .send(buildCustomerPayload({
        email,
        membership: {
          plan_id: 1,
          cycles: 1,
        },
      }));

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "FORBIDDEN");

    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth.users WHERE email = $1`,
      [email],
    );
    assert.equal(remaining.rows[0]?.count, "0");
  } finally {
    runAdminSql(`
      INSERT INTO public.role_permissions (role_id, permission_id)
      SELECT roles.id, permissions.id
      FROM public.roles AS roles
      CROSS JOIN public.permissions AS permissions
      WHERE roles.slug = 'employee'
        AND permissions.key = 'customers.manage_membership'
      ON CONFLICT (role_id, permission_id) DO NOTHING;
    `);
  }
});

test("POST /customers revierte el núcleo cuando falla la membresía", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);
  const email = `rollback-${randomUUID()}${testEmailDomain}`;

  const response = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(buildCustomerPayload({
      email,
      password: testPassword,
      membership: {
        plan_id: 2147483647,
        cycles: 1,
      },
    }));

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "PLAN_NOT_FOUND");

  const remaining = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM auth.users WHERE email = $1`,
    [email],
  );
  assert.equal(remaining.rows[0]?.count, "0");
});

test("POST /customers con email duplicado devuelve 409 sin filas parciales", { concurrency: false }, async () => {
  const duplicateName = `${testNamePrefix} Duplicate ${randomUUID().slice(0, 8)}`;
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);
  const duplicateEmail = `dup-${randomUUID()}${testEmailDomain}`;

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
    [
      randomUUID(),
      duplicateEmail.toLowerCase(),
      await bcrypt.hash(testPassword, 10),
    ],
  );

  const response = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(
      buildCustomerPayload({
        full_name: duplicateName,
        email: `  ${duplicateEmail.toUpperCase()}  `,
      }),
    );

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    error: {
      code: "EMAIL_ALREADY_EXISTS",
      message: "Ya existe un cliente con ese email",
    },
  });

  const profileCount = await pool.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM public.profiles
      WHERE full_name = $1
    `,
    [duplicateName],
  );

  assert.equal(profileCount.rows[0]?.count, "0");
});

test("Alta concurrente genera biometric_id seguro por secuencia", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);
  const payloads = Array.from({ length: 5 }, (_, index) =>
    buildCustomerPayload({
      full_name: `${testNamePrefix} Cliente Concurrente ${index + 1}`,
      email: `concurrente-${index + 1}-${randomUUID()}${testEmailDomain}`,
    }),
  );

  const responses = await Promise.all(
    payloads.map((payload) =>
      request(app)
        .post("/customers")
        .set("Cookie", cookie)
        .send(payload),
    ),
  );

  for (const response of responses) {
    assert.equal(response.status, 201);
  }

  const biometrics = await queryAsUser<{
    id: string;
    biometric_id: number;
  }>(
    employee.userId,
    `
      SELECT profiles.id, profiles.biometric_id
      FROM public.profiles AS profiles
      WHERE profiles.id = ANY($1::uuid[])
    `,
    [responses.map((response) => response.body.id)],
  );

  assert.equal(biometrics.length, 5);
  assert.equal(
    new Set(
      biometrics.map((row) => row.biometric_id),
    ).size,
    5,
  );
});

test("Rollback completo ante fallo interno y sin usuarios fantasma", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);
  const email = `rollback-${randomUUID()}${testEmailDomain}`;

  runAdminSql(`
    CREATE OR REPLACE FUNCTION public.fail_customer_profile_insert_for_tests()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'forced failure for tests';
    END;
    $$;

    DROP TRIGGER IF EXISTS fail_customer_profile_insert_for_tests
    ON public.profiles;

    CREATE TRIGGER fail_customer_profile_insert_for_tests
    BEFORE INSERT ON public.profiles
    FOR EACH ROW
    WHEN (NEW.full_name = '${testNamePrefix} Cliente Rollback')
    EXECUTE FUNCTION public.fail_customer_profile_insert_for_tests();
  `);

  try {
    const response = await request(app)
      .post("/customers")
      .set("Cookie", cookie)
      .send(
        buildCustomerPayload({
          full_name: `${testNamePrefix} Cliente Rollback`,
          email,
        }),
      );

    assert.equal(response.status, 500);
    assert.equal(
      response.body.error.code,
      "INTERNAL_SERVER_ERROR",
    );

    const authUsers = await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM auth.users
        WHERE email = $1
      `,
      [email],
    );
    const profiles = await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM public.profiles
      WHERE full_name = '${testNamePrefix} Cliente Rollback'
      `,
    );

    assert.equal(authUsers.rows[0]?.count, "0");
    assert.equal(profiles.rows[0]?.count, "0");
  } finally {
    runAdminSql(`
      DROP TRIGGER IF EXISTS fail_customer_profile_insert_for_tests
      ON public.profiles;
      DROP FUNCTION IF EXISTS public.fail_customer_profile_insert_for_tests();
    `);
  }
});

test("El trigger ZKTeco produce un solo device_command real esperado", { concurrency: false }, async () => {
  const admin = await createSyntheticUser({
    role: "admin",
  });
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);
  const payload = buildCustomerPayload({
    full_name: `${testNamePrefix} Cliente ZKTeco`,
  });

  const response = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(payload);

  assert.equal(response.status, 201);

  const profileResult = await queryAsUser<{
    biometric_id: number;
  }>(
    employee.userId,
    `
      SELECT profiles.biometric_id
      FROM public.profiles AS profiles
      WHERE profiles.id = $1
    `,
    [response.body.id],
  );
  const biometricId = profileResult[0]?.biometric_id;
  assert.ok(biometricId);

  const commands = await queryAsUser<{
    command: string;
    executed: boolean | null;
  }>(
    admin.userId,
    `
      SELECT command, executed
      FROM public.device_commands
      WHERE command LIKE $1
    `,
    [`%PIN=${biometricId} %`],
  );

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.executed, false);
  assert.match(commands[0]?.command ?? "", /PIN=\d+/);
  assert.match(
    commands[0]?.command ?? "",
    new RegExp(`Name=${testNamePrefix} Cliente ZKTeco`),
  );
});

test("PATCH /customers/:id actualiza ficha basica y rechaza campos protegidos", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);
  const payload = buildCustomerPayload();
  const created = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(payload);

  assert.equal(created.status, 201);
  const customerId = created.body.id as string;

  const updateResponse = await request(app)
    .patch(`/customers/${customerId}`)
    .set("Cookie", cookie)
    .send({
      full_name: "Cliente Editado",
      injuries: "Espalda",
      medical_notes: "Seguimiento",
    });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.full_name, "Cliente Editado");
  assert.equal(updateResponse.body.injuries, "Espalda");
  assert.equal(updateResponse.body.medical_notes, "Seguimiento");

  const protectedResponse = await request(app)
    .patch(`/customers/${customerId}`)
    .set("Cookie", cookie)
    .send({
      email: "otro@correo.com",
    });

  assert.equal(protectedResponse.status, 400);
  assert.equal(
    protectedResponse.body.error.code,
    "VALIDATION_ERROR",
  );
});

test("PATCH /customers/:id/status solo cambia profiles.is_active", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({
    role: "employee",
  });
  const cookie = await loginAndGetCookie(employee.email);
  const payload = buildCustomerPayload({
    full_name: `${testNamePrefix} Cliente Estado`,
  });
  const created = await request(app)
    .post("/customers")
    .set("Cookie", cookie)
    .send(payload);

  assert.equal(created.status, 201);
  const customerId = created.body.id as string;

  const before = await queryAsUser<{
    full_name: string;
    is_active: boolean;
    command_count: string;
  }>(
    employee.userId,
    `
      SELECT
        profiles.full_name,
        profiles.is_active,
        (
          SELECT count(*)::text
          FROM public.device_commands
          WHERE command LIKE '%${testNamePrefix} Cliente Estado%'
        ) AS command_count
      FROM public.profiles AS profiles
      WHERE profiles.id = $1
    `,
    [customerId],
  );

  const response = await request(app)
    .patch(`/customers/${customerId}/status`)
    .set("Cookie", cookie)
    .send({
      is_active: false,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.is_active, false);

  const afterStatus = await queryAsUser<{
    full_name: string;
    is_active: boolean;
    command_count: string;
  }>(
    employee.userId,
    `
      SELECT
        profiles.full_name,
        profiles.is_active,
        (
          SELECT count(*)::text
          FROM public.device_commands
          WHERE command LIKE '%${testNamePrefix} Cliente Estado%'
        ) AS command_count
      FROM public.profiles AS profiles
      WHERE profiles.id = $1
    `,
    [customerId],
  );

  assert.equal(before[0]?.full_name, afterStatus[0]?.full_name);
  assert.equal(before[0]?.is_active, true);
  assert.equal(afterStatus[0]?.is_active, false);
  assert.equal(
    before[0]?.command_count,
    afterStatus[0]?.command_count,
  );
  assertNoSensitiveFields(response.body);
});

test("GET /customers expone filtros combinados, estados, último ingreso y todos los sort permitidos", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);
  const planId = 700000 + Math.floor(Math.random() * 10000);

  runAdminSql(`
    INSERT INTO public.plans (id, name, price, duration_days, is_active)
    VALUES (${planId}, '${testNamePrefix} Plan lectura', 100, 30, true);
  `);

  const fixtures = [
    { label: "active", status: "active", end: "CURRENT_DATE + 30", grace: 3, active: true },
    { label: "expiring", status: "active", end: "CURRENT_DATE + 2", grace: 3, active: true },
    { label: "grace", status: "active", end: "CURRENT_DATE - 1", grace: 3, active: true },
    { label: "expired", status: "active", end: "CURRENT_DATE - 10", grace: 3, active: true },
    { label: "cancelled", status: "cancelled", end: "CURRENT_DATE + 30", grace: 3, active: false },
  ];
  const customerIds: Record<string, string> = {};

  for (const fixture of fixtures) {
    const customer = await createCustomerDirect({
      fullName: `${testNamePrefix} FILTER ${fixture.label}`,
    });
    customerIds[fixture.label] = customer.id;
    runAdminSql(`
      UPDATE public.profiles
      SET is_active = ${fixture.active}
      WHERE id = '${customer.id}';
      INSERT INTO public.subscriptions (
        user_id, plan_id, start_date, end_date, status, grace_days
      ) VALUES (
        '${customer.id}', ${planId}, CURRENT_DATE - 10,
        ${fixture.end}, '${fixture.status}', ${fixture.grace}
      );
    `);
  }

  const noMembership = await createCustomerDirect({
    fullName: `${testNamePrefix} FILTER none`,
  });
  customerIds.none = noMembership.id;
  const pendingMembership = await createCustomerDirect({
    fullName: `${testNamePrefix} FILTER pending legacy`,
  });
  runAdminSql(`
    INSERT INTO public.subscriptions (
      user_id, plan_id, start_date, end_date, status, grace_days
    ) VALUES (
      '${pendingMembership.id}', ${planId}, CURRENT_DATE,
      CURRENT_DATE + 30, 'pending', 3
    );
  `);
  const activeBiometric = await queryAsUser<{ biometric_id: number }>(
    employee.userId,
    "SELECT biometric_id FROM public.profiles WHERE id = $1",
    [customerIds.active],
  );
  runAdminSql(`
    INSERT INTO public.attendance_logs (
      device_id, biometric_id, punch_time, status1, raw_line
    ) VALUES (
      'TEST', ${activeBiometric[0]!.biometric_id},
      TIMESTAMPTZ '2026-07-20 12:00:00+00', 0,
      'PIN=${activeBiometric[0]!.biometric_id} EVENT=1'
    );
  `);

  for (const status of ["active", "expiring", "grace", "expired", "cancelled", "none"]) {
    const response = await request(app)
      .get("/customers")
      .query({
        search: `${testNamePrefix} FILTER`,
        membership_status: status,
        page_size: 100,
      })
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    assert.ok(response.body.data.some((row: { id: string }) => row.id === customerIds[status]!));
  }

  const pendingResponse = await request(app)
    .get("/customers")
    .query({ search: `${testNamePrefix} FILTER pending legacy` })
    .set("Cookie", cookie);
  assert.equal(pendingResponse.status, 200);
  assert.equal(pendingResponse.body.data[0].membership_status, "none");
  assert.equal(pendingResponse.body.data[0].current_membership.status, "pending");

  const combined = await request(app)
    .get("/customers")
    .query({
      search: `${testNamePrefix} FILTER active`,
      is_active: "true",
      plan_id: planId,
      membership_status: "active",
    })
    .set("Cookie", cookie);
  assert.equal(combined.status, 200);
  assert.equal(combined.body.meta.total, 1);
  assert.equal(combined.body.data[0].id, customerIds.active);
  assert.equal(combined.body.data[0].membership_status, "active");
  assert.equal(combined.body.data[0].current_membership.plan_id, planId);
  assert.equal(combined.body.data[0].last_check_in, "2026-07-20T12:00:00.000Z");
  assert.equal(typeof combined.body.data[0].biometric_id, "number");

  for (const sort of [
    "full_name", "-full_name", "created_at", "-created_at",
    "updated_at", "-updated_at", "last_check_in", "-last_check_in",
    "membership_status", "-membership_status",
  ]) {
    const response = await request(app)
      .get("/customers")
      .query({ search: `${testNamePrefix} FILTER`, sort, page_size: 2 })
      .set("Cookie", cookie);
    assert.equal(response.status, 200, sort);
    assert.equal(response.body.data.length, 2, sort);
  }
});

test("GET /customers/sidebar devuelve lectura compacta con límite", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);
  await createCustomerDirect({ fullName: `${testNamePrefix} SIDEBAR Uno` });
  await createCustomerDirect({ fullName: `${testNamePrefix} SIDEBAR Dos` });

  const response = await request(app)
    .get("/customers/sidebar")
    .query({ search: `${testNamePrefix} SIDEBAR`, limit: 1 })
    .set("Cookie", cookie);

  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.deepEqual(
    Object.keys(response.body.data[0]).sort(),
    ["avatar_url", "biometric_id", "full_name", "id", "is_active", "membership_status", "plan_name"].sort(),
  );
});

test("GET /customers/:id devuelve cuenta segura y capacidades por permiso", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);
  const customer = await createCustomerDirect({
    fullName: `${testNamePrefix} DETAIL ACCOUNT`,
  });

  const response = await request(app)
    .get(`/customers/${customer.id}`)
    .set("Cookie", cookie);

  assert.equal(response.status, 200);
  assert.equal(response.body.account.email, customer.email);
  assert.equal(response.body.account.has_password, false);
  assert.equal(response.body.account.login_enabled, false);
  assert.deepEqual(response.body.capabilities, {
    update_customer: true,
    manage_account: false,
    manage_membership: true,
    view_payments: true,
    view_health_profile: false,
    manage_health_profile: false,
    view_body_assessments: false,
    manage_body_assessments: false,
  });
  assert.equal(response.body.training_profile, undefined);
  assert.equal(response.body.routine, undefined);
  assertNoSensitiveFields(response.body);
});

test("RBAC de Clientes permite lectura y cuenta a admin sin ampliar otros roles", { concurrency: false }, async () => {
  const customer = await createCustomerDirect({
    fullName: `${testNamePrefix} ADMIN RBAC`,
  });
  const admin = await createSyntheticUser({ role: "admin" });
  const adminAgent = request.agent(app);
  const adminLogin = await adminAgent.post("/auth/login").send({
    email: admin.email,
    password: testPassword,
  });

  assert.equal(adminLogin.status, 200);
  assert.deepEqual(adminLogin.body.authorization.permissions, [
    "body_assessments.manage",
    "body_assessments.view",
    "customer_health_profiles.manage",
    "customer_health_profiles.view",
    "customers.manage_account",
    "customers.view",
  ]);

  const adminList = await adminAgent.get("/customers");
  assert.equal(adminList.status, 200);

  const adminDetail = await adminAgent.get(`/customers/${customer.id}`);
  assert.equal(adminDetail.status, 200);
  assert.equal(adminDetail.body.capabilities.manage_account, true);
  assert.deepEqual(
    {
      view_health_profile:
        adminDetail.body.capabilities.view_health_profile,
      manage_health_profile:
        adminDetail.body.capabilities.manage_health_profile,
      view_body_assessments:
        adminDetail.body.capabilities.view_body_assessments,
      manage_body_assessments:
        adminDetail.body.capabilities.manage_body_assessments,
    },
    {
      view_health_profile: true,
      manage_health_profile: true,
      view_body_assessments: true,
      manage_body_assessments: true,
    },
  );

  const updatedEmail = `admin-rbac-${randomUUID()}${testEmailDomain}`;
  const adminPatch = await adminAgent
    .patch(`/customers/${customer.id}/account`)
    .send({ email: updatedEmail });
  assert.equal(adminPatch.status, 200);
  assert.equal(adminPatch.body.account.email, updatedEmail);

  const employee = await createSyntheticUser({ role: "employee" });
  const employeeAgent = request.agent(app);
  const employeeLogin = await employeeAgent.post("/auth/login").send({
    email: employee.email,
    password: testPassword,
  });
  assert.equal(employeeLogin.status, 200);
  assert.equal(
    employeeLogin.body.authorization.permissions.includes(
      "customers.manage_account",
    ),
    false,
  );

  for (const role of ["trainer", "client"] as const) {
    const user = await createSyntheticUser({ role });
    const cookie = await loginAndGetCookie(user.email);
    const list = await request(app)
      .get("/customers")
      .set("Cookie", cookie);
    const detail = await request(app)
      .get(`/customers/${customer.id}`)
      .set("Cookie", cookie);

    assert.equal(list.status, 403, role);
    assert.equal(detail.status, 403, role);
  }

  const owner = await createSyntheticUser({ role: "owner" });
  const ownerCookie = await loginAndGetCookie(owner.email);
  const ownerList = await request(app)
    .get("/customers")
    .set("Cookie", ownerCookie);
  const ownerDetail = await request(app)
    .get(`/customers/${customer.id}`)
    .set("Cookie", ownerCookie);

  assert.equal(ownerList.status, 200);
  assert.equal(ownerDetail.status, 200);
});

test("PATCH /customers/:id/account cubre 401, 403, 404 y cuerpo vacío", { concurrency: false }, async () => {
  const customer = await createCustomerDirect();

  const unauthorized = await request(app)
    .patch(`/customers/${customer.id}/account`)
    .send({ email: `unauthorized-${randomUUID()}${testEmailDomain}` });
  assert.equal(unauthorized.status, 401);

  const clientUser = await createSyntheticUser({ role: "client" });
  const clientCookie = await loginAndGetCookie(clientUser.email);
  const forbidden = await request(app)
    .patch(`/customers/${customer.id}/account`)
    .set("Cookie", clientCookie)
    .send({ email: `forbidden-${randomUUID()}${testEmailDomain}` });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, "FORBIDDEN");

  const admin = await createSyntheticUser({ role: "admin" });
  const adminCookie = await loginAndGetCookie(admin.email);
  const missing = await request(app)
    .patch(`/customers/${randomUUID()}/account`)
    .set("Cookie", adminCookie)
    .send({ email: `missing-${randomUUID()}${testEmailDomain}` });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "CUSTOMER_NOT_FOUND");

  const empty = await request(app)
    .patch(`/customers/${customer.id}/account`)
    .set("Cookie", adminCookie)
    .send({});
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, "VALIDATION_ERROR");
});

test("PATCH /customers/:id/account rechaza roles sin customers.manage_account", { concurrency: false }, async () => {
  const customer = await createCustomerDirect();

  for (const role of ["employee", "trainer", "client"] as const) {
    const user = await createSyntheticUser({ role });
    const cookie = await loginAndGetCookie(user.email);
    const response = await request(app)
      .patch(`/customers/${customer.id}/account`)
      .set("Cookie", cookie)
      .send({
        email: `denied-${role}-${randomUUID()}${testEmailDomain}`,
      });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "FORBIDDEN");
  }
});

test("PATCH /customers/:id/account valida email único case-insensitive", { concurrency: false }, async () => {
  const admin = await createSyntheticUser({ role: "admin" });
  const cookie = await loginAndGetCookie(admin.email);
  const first = await createCustomerDirect();
  const second = await createCustomerDirect();

  const response = await request(app)
    .patch(`/customers/${second.id}/account`)
    .set("Cookie", cookie)
    .send({ email: first.email!.toUpperCase() });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "EMAIL_ALREADY_EXISTS");
  const unchanged = await pool.query<{ email: string | null }>(
    "SELECT email FROM auth.users WHERE id = $1",
    [second.id],
  );
  assert.equal(unchanged.rows[0]?.email, second.email);
});

test("PATCH /customers/:id/account establece primera contraseña y exige email", { concurrency: false }, async () => {
  const admin = await createSyntheticUser({ role: "admin" });
  const cookie = await loginAndGetCookie(admin.email);
  const withoutEmail = await createCustomerDirect({ email: null });
  const newEmail = `first-password-${randomUUID()}${testEmailDomain}`;
  const newPassword = "PrimeraClaveLocal123";

  const rejected = await request(app)
    .patch(`/customers/${withoutEmail.id}/account`)
    .set("Cookie", cookie)
    .send({ new_password: newPassword });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, "PASSWORD_REQUIRES_EMAIL");

  const response = await request(app)
    .patch(`/customers/${withoutEmail.id}/account`)
    .set("Cookie", cookie)
    .send({ email: newEmail.toUpperCase(), new_password: newPassword });
  assert.equal(response.status, 200);
  assert.equal(response.body.account.email, newEmail);
  assert.equal(response.body.account.has_password, true);
  assert.equal(response.body.account.login_enabled, true);
  assert.equal(response.body.capabilities.manage_account, true);
  assertNoSensitiveFields(response.body);

  const loginResponse = await request(app).post("/auth/login").send({
    email: newEmail,
    password: newPassword,
  });
  assert.equal(loginResponse.status, 200);
});

test("PATCH /customers/:id/account cambia contraseña, revoca todas las sesiones y habilita el nuevo login", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const employeeCookie = await loginAndGetCookie(employee.email);
  const admin = await createSyntheticUser({ role: "admin" });
  const adminCookie = await loginAndGetCookie(admin.email);
  const email = `session-revoke-${randomUUID()}${testEmailDomain}`;
  const initialPassword = "ClaveInicialLocal123";
  const newPassword = "ClaveNuevaLocal456";
  const created = await request(app)
    .post("/customers")
    .set("Cookie", employeeCookie)
    .send(buildCustomerPayload({ email, password: initialPassword }));
  assert.equal(created.status, 201);

  const firstSession = await loginAndGetCookie(email, initialPassword);
  const secondSession = await loginAndGetCookie(email, initialPassword);
  const response = await request(app)
    .patch(`/customers/${created.body.id}/account`)
    .set("Cookie", adminCookie)
    .send({ new_password: newPassword });
  assert.equal(response.status, 200);
  assertNoSensitiveFields(response.body);

  for (const sessionCookie of [firstSession, secondSession]) {
    const me = await request(app)
      .get("/auth/me")
      .set("Cookie", sessionCookie);
    assert.equal(me.status, 401);
  }

  const oldLogin = await request(app).post("/auth/login").send({
    email,
    password: initialPassword,
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await request(app).post("/auth/login").send({
    email,
    password: newPassword,
  });
  assert.equal(newLogin.status, 200);

  const sessions = await pool.query<{ active: string }>(
    `
      SELECT count(*) FILTER (WHERE revoked_at IS NULL)::text AS active
      FROM auth.sessions
      WHERE user_id = $1
        AND id NOT IN (
          SELECT id FROM auth.sessions
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        )
    `,
    [created.body.id],
  );
  assert.equal(sessions.rows[0]?.active, "0");
});

test("PATCH /customers/:id/account cambia solo email y revoca las sesiones", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const employeeCookie = await loginAndGetCookie(employee.email);
  const owner = await createSyntheticUser({ role: "owner" });
  const ownerCookie = await loginAndGetCookie(owner.email);
  const email = `email-change-${randomUUID()}${testEmailDomain}`;
  const nextEmail = `email-changed-${randomUUID()}${testEmailDomain}`;
  const password = "ClaveEmailLocal123";
  const created = await request(app)
    .post("/customers")
    .set("Cookie", employeeCookie)
    .send(buildCustomerPayload({ email, password }));
  assert.equal(created.status, 201);

  const customerSession = await loginAndGetCookie(email, password);
  const response = await request(app)
    .patch(`/customers/${created.body.id}/account`)
    .set("Cookie", ownerCookie)
    .send({ email: nextEmail.toUpperCase() });
  assert.equal(response.status, 200);
  assert.equal(response.body.account.email, nextEmail);
  assertNoSensitiveFields(response.body);

  const me = await request(app)
    .get("/auth/me")
    .set("Cookie", customerSession);
  assert.equal(me.status, 401);

  const oldEmailLogin = await request(app).post("/auth/login").send({
    email,
    password,
  });
  assert.equal(oldEmailLogin.status, 401);
  const newEmailLogin = await request(app).post("/auth/login").send({
    email: nextEmail,
    password,
  });
  assert.equal(newEmailLogin.status, 200);
});

test("PATCH /customers/:id/account revierte credenciales si falla la revocación", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const employeeCookie = await loginAndGetCookie(employee.email);
  const admin = await createSyntheticUser({ role: "admin" });
  const adminCookie = await loginAndGetCookie(admin.email);
  const email = `account-rollback-${randomUUID()}${testEmailDomain}`;
  const initialPassword = "ClaveRollbackInicial123";
  const created = await request(app)
    .post("/customers")
    .set("Cookie", employeeCookie)
    .send(buildCustomerPayload({ email, password: initialPassword }));
  assert.equal(created.status, 201);
  await loginAndGetCookie(email, initialPassword);
  const nextEmail = `account-next-${randomUUID()}${testEmailDomain}`;

  runAdminSql(`
    CREATE OR REPLACE FUNCTION auth.fail_customer_session_revoke_for_tests()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.user_id = '${created.body.id}'::uuid THEN
        RAISE EXCEPTION 'forced account rollback';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS fail_customer_session_revoke_for_tests
    ON auth.sessions;
    CREATE TRIGGER fail_customer_session_revoke_for_tests
    BEFORE UPDATE ON auth.sessions
    FOR EACH ROW
    EXECUTE FUNCTION auth.fail_customer_session_revoke_for_tests();
  `);

  try {
    const response = await request(app)
      .patch(`/customers/${created.body.id}/account`)
      .set("Cookie", adminCookie)
      .send({ email: nextEmail, new_password: "ClaveRollbackNueva456" });
    assert.equal(response.status, 500);

    const user = await pool.query<{
      email: string;
      encrypted_password: string;
    }>(
      "SELECT email, encrypted_password FROM auth.users WHERE id = $1",
      [created.body.id],
    );
    assert.equal(user.rows[0]?.email, email);
    assert.equal(
      await bcrypt.compare(initialPassword, user.rows[0]!.encrypted_password),
      true,
    );
  } finally {
    runAdminSql(`
      DROP TRIGGER IF EXISTS fail_customer_session_revoke_for_tests
      ON auth.sessions;
      DROP FUNCTION IF EXISTS auth.fail_customer_session_revoke_for_tests();
    `);
  }
});

test("GET /customers/:id/history pagina y oculta pagos o evaluaciones sin permiso", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const employeeCookie = await loginAndGetCookie(employee.email);
  const owner = await createSyntheticUser({ role: "owner" });
  const cookie = await loginAndGetCookie(owner.email);
  const customer = await createCustomerDirect({
    fullName: `${testNamePrefix} HISTORY`,
  });
  const planId = 710000 + Math.floor(Math.random() * 10000);
  const biometric = await queryAsUser<{ biometric_id: number }>(
    owner.userId,
    "SELECT biometric_id FROM public.profiles WHERE id = $1",
    [customer.id],
  );

  runAdminSql(`
    INSERT INTO public.plans (id, name, price, duration_days, is_active)
    VALUES (${planId}, '${testNamePrefix} History Plan', 100, 30, true);

    WITH membership AS (
      INSERT INTO public.subscriptions (
        user_id, plan_id, start_date, end_date, status, grace_days
      ) VALUES (
        '${customer.id}', ${planId}, CURRENT_DATE - 30,
        CURRENT_DATE + 30, 'active', 3
      ) RETURNING id
    )
    INSERT INTO public.payments (
      subscription_id, user_id, amount_original, discount_amount,
      amount_paid, method, payment_date, status
    )
    SELECT id, '${customer.id}', 100, 10, 90, 'cash', now(), 'posted'
    FROM membership;

    INSERT INTO public.subscriptions (
      user_id, plan_id, start_date, end_date, status, grace_days
    ) VALUES (
      '${customer.id}', ${planId}, CURRENT_DATE - 90,
      CURRENT_DATE - 60, 'cancelled', 3
    );

    INSERT INTO public.payments (
      user_id, amount_original, discount_amount, amount_paid,
      method, payment_date, status
    ) VALUES
      ('${customer.id}', 100, 10, 90, 'card', now() - interval '1 day', 'posted'),
      ('${customer.id}', 100, 0, 100, 'cash', now() - interval '2 days', 'reversed');

    INSERT INTO public.attendance_logs (
      device_id, biometric_id, punch_time, status1, raw_line
    )
    SELECT
      'TEST', ${biometric[0]!.biometric_id},
      now() - (g || ' hours')::interval, 0,
      'PIN=${biometric[0]!.biometric_id} EVENT=1'
    FROM generate_series(1, 55) AS g;

    INSERT INTO public.attendance_logs (
      device_id, biometric_id, punch_time, status1, raw_line
    ) VALUES (
      'TEST-TZ', ${biometric[0]!.biometric_id},
      CURRENT_DATE::timestamp AT TIME ZONE 'UTC' + interval '30 minutes',
      0, 'PIN=${biometric[0]!.biometric_id} EVENT=1'
    );

    INSERT INTO public.body_assessments (
      user_id, date, weight_kg, height_cm
    ) VALUES
      ('${customer.id}', CURRENT_DATE - 20, 80, 175),
      ('${customer.id}', CURRENT_DATE - 10, 78, 175),
      ('${customer.id}', CURRENT_DATE, 76, 175);
  `);

  const response = await request(app)
    .get(`/customers/${customer.id}/history`)
    .query({
      memberships_page_size: 1,
      payments_page_size: 1,
      assessments_page_size: 1,
    })
    .set("Cookie", cookie);

  assert.equal(response.status, 200);
  assert.equal(response.body.attendance.data.length, 50);
  assert.equal(response.body.attendance.limit, 50);
  assert.equal(response.body.attendance.total, 56);
  assert.equal(response.body.heatmap.timezone, "America/Guatemala");
  assert.equal(response.body.heatmap.days, 365);
  const expectedLocalDate = await pool.query<{ local_date: string }>(
    `SELECT to_char(
      (CURRENT_DATE::timestamp AT TIME ZONE 'UTC' + interval '30 minutes')
        AT TIME ZONE 'America/Guatemala',
      'YYYY-MM-DD'
    ) AS local_date`,
  );
  assert.ok(response.body.heatmap.data.some(
    (row: { date: string }) => row.date === expectedLocalDate.rows[0]!.local_date,
  ));
  assert.equal(response.body.memberships.data.length, 1);
  assert.equal(response.body.memberships.meta.total, 2);
  assert.equal(response.body.payments.data.length, 1);
  assert.equal(response.body.payments.meta.total, 2);
  assert.equal(response.body.assessments.data.length, 1);
  assert.equal(response.body.assessments.meta.total, 3);
  assert.equal(response.body.kpis.total_visits, 56);
  assert.equal(response.body.kpis.total_spent, 180);
  assert.equal(response.body.kpis.initial_weight, 80);
  assert.equal(response.body.kpis.current_weight, 76);
  assert.equal(response.body.kpis.weight_change, -4);
  assertNoSensitiveFields(response.body);

  const emptyPage = await request(app)
    .get(`/customers/${customer.id}/history`)
    .query({
      memberships_page: 99,
      payments_page: 99,
      assessments_page: 99,
    })
    .set("Cookie", cookie);
  assert.equal(emptyPage.status, 200);
  assert.equal(emptyPage.body.memberships.data.length, 0);
  assert.equal(emptyPage.body.memberships.meta.total, 2);
  assert.equal(emptyPage.body.payments.data.length, 0);
  assert.equal(emptyPage.body.payments.meta.total, 2);
  assert.equal(emptyPage.body.assessments.data.length, 0);
  assert.equal(emptyPage.body.assessments.meta.total, 3);

  runAdminSql(`
    DELETE FROM public.role_permissions AS role_permissions
    USING public.roles AS roles, public.permissions AS permissions
    WHERE role_permissions.role_id = roles.id
      AND role_permissions.permission_id = permissions.id
      AND roles.slug = 'employee'
      AND permissions.key = 'payments.view';
  `);

  try {
    const withoutPayments = await request(app)
      .get(`/customers/${customer.id}/history`)
      .query({ attendance_limit: 5, heatmap_days: 30 })
      .set("Cookie", employeeCookie);
    assert.equal(withoutPayments.status, 200);
    assert.equal(withoutPayments.body.payments, null);
    assert.equal(withoutPayments.body.kpis.total_spent, null);
    assert.equal(withoutPayments.body.attendance.data.length, 5);
    assert.equal(withoutPayments.body.memberships.meta.total, 2);
    assert.equal(withoutPayments.body.assessments, null);
    assert.equal(withoutPayments.body.kpis.initial_weight, null);
    assert.equal(withoutPayments.body.kpis.current_weight, null);
    assert.equal(withoutPayments.body.kpis.weight_change, null);
  } finally {
    runAdminSql(`
      INSERT INTO public.role_permissions (role_id, permission_id)
      SELECT roles.id, permissions.id
      FROM public.roles AS roles
      CROSS JOIN public.permissions AS permissions
      WHERE roles.slug = 'employee' AND permissions.key = 'payments.view'
      ON CONFLICT (role_id, permission_id) DO NOTHING;
    `);
  }

  const invalidLimit = await request(app)
    .get(`/customers/${customer.id}/history`)
    .query({ attendance_limit: 51, heatmap_days: 366 })
    .set("Cookie", cookie);
  assert.equal(invalidLimit.status, 400);
});

test("Historial conserva membresías legacy sin pago", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const cookie = await loginAndGetCookie(employee.email);
  const customer = await createCustomerDirect({ fullName: `${testNamePrefix} LEGACY` });
  const planId = 720000 + Math.floor(Math.random() * 10000);
  runAdminSql(`
    INSERT INTO public.plans (id, name, price, duration_days, is_active)
    VALUES (${planId}, '${testNamePrefix} Legacy Plan', 100, 30, true);
    INSERT INTO public.subscriptions (
      user_id, plan_id, start_date, end_date, status, grace_days
    ) VALUES (
      '${customer.id}', ${planId}, CURRENT_DATE - 60,
      CURRENT_DATE - 30, 'expired', 3
    );
  `);

  const response = await request(app)
    .get(`/customers/${customer.id}/history`)
    .set("Cookie", cookie);
  assert.equal(response.status, 200);
  assert.equal(response.body.memberships.meta.total, 1);
  assert.equal(response.body.payments.meta.total, 0);
  assert.equal(response.body.kpis.total_spent, 0);
});

test("Historial cubre 401, 403 y 404", { concurrency: false }, async () => {
  const unauthorized = await request(app)
    .get(`/customers/${randomUUID()}/history`);
  assert.equal(unauthorized.status, 401);

  const clientUser = await createSyntheticUser({ role: "client" });
  const clientCookie = await loginAndGetCookie(clientUser.email);
  const forbidden = await request(app)
    .get(`/customers/${randomUUID()}/history`)
    .set("Cookie", clientCookie);
  assert.equal(forbidden.status, 403);

  const employee = await createSyntheticUser({ role: "employee" });
  const employeeCookie = await loginAndGetCookie(employee.email);
  const missing = await request(app)
    .get(`/customers/${randomUUID()}/history`)
    .set("Cookie", employeeCookie);
  assert.equal(missing.status, 404);
});

test("Permisos no recursan RLS y el historial mantiene un presupuesto fijo de consultas", { concurrency: false }, async () => {
  const employee = await createSyntheticUser({ role: "employee" });
  const permissions = await queryAsUser<{
    permissions: string[];
    can_view: boolean;
  }>(employee.userId, `
    SELECT
      public.get_current_permissions() AS permissions,
      public.has_permission('customers.view') AS can_view
  `);
  assert.equal(permissions[0]?.can_view, true);
  assert.ok(permissions[0]?.permissions.includes("customers.view"));

  const source = readFileSync(
    path.join(projectRoot, "src/modules/customers/customers-history.service.ts"),
    "utf8",
  );
  assert.equal((source.match(/client\.query</g) ?? []).length, 11);
  assert.equal(/\.map\([\s\S]{0,500}await client\.query/.test(source), false);
  assert.equal(/for \([\s\S]{0,500}await client\.query/.test(source), false);
});

test("0006 es idempotente", { concurrency: false }, () => {
  const migrationPath = path.join(
    projectRoot,
    "database/migrations/0006_customers_read_history.sql",
  );
  const latestCustomersMigrationPath = path.join(
    projectRoot,
    "database/migrations/0009_customers_health_assessments.sql",
  );

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      execFileSync(
        "psql",
        ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-f", migrationPath],
        { cwd: projectRoot, stdio: "ignore" },
      );
    }
  } finally {
    execFileSync(
      "psql",
      [
        "-d",
        "algym_test",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        latestCustomersMigrationPath,
      ],
      { cwd: projectRoot, stdio: "ignore" },
    );
  }
});

test("0007 de cuentas de clientes es idempotente", { concurrency: false }, () => {
  const migrationPath = path.join(
    projectRoot,
    "database/migrations/0007_customers_account_local.sql",
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    execFileSync(
      "psql",
      ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-f", migrationPath],
      { cwd: projectRoot, stdio: "ignore" },
    );
  }
});

test("0008 asigna una sola relación admin/customers.view y es idempotente", { concurrency: false }, () => {
  const migrationPath = path.join(
    projectRoot,
    "database/migrations/0008_admin_customers_view.sql",
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    execFileSync(
      "psql",
      ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-f", migrationPath],
      { cwd: projectRoot, stdio: "ignore" },
    );
  }

  const relationCount = execFileSync(
    "psql",
    [
      "-d",
      "algym_test",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-c",
      `
        SELECT count(*)
        FROM public.role_permissions
        INNER JOIN public.roles
          ON roles.id = role_permissions.role_id
        INNER JOIN public.permissions
          ON permissions.id = role_permissions.permission_id
        WHERE roles.slug = 'admin'
          AND permissions.key = 'customers.view';
      `,
    ],
    { cwd: projectRoot, encoding: "utf8" },
  ).trim();

  assert.equal(relationCount, "1");
});
