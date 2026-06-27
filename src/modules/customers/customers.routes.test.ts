import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const projectRoot = path.resolve(currentDirectory, "../..");
const testEmailDomain = "@customers.test.local";
const testPassword = "PasswordDePrueba123";
const testNamePrefix = "ZZTEST_CUSTOMERS";

type TestUserRole =
  | "admin"
  | "client"
  | "employee"
  | "owner";

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
): Promise<string> {
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
  const result = await pool.query<{
    customer_id: string;
    email: string | null;
  }>(
    `
      WITH actor AS (
        SELECT set_config('app.current_user_id', $1, true)
      ),
      created AS (
        SELECT public.create_customer_core(
          $2,
          '55520000',
          DATE '1993-06-15',
          'female',
          $3,
          'Rodilla',
          'Nota'
        ) AS customer_id
      )
      SELECT created.customer_id, users.email
      FROM created
      INNER JOIN auth.users AS users
        ON users.id = created.customer_id
    `,
    [
      (await createSyntheticUser({ role: "owner" })).userId,
      options?.fullName ?? `${testNamePrefix} Cliente Directo`,
      email,
    ],
  );

  return {
    id: result.rows[0]!.customer_id,
    email: result.rows[0]!.email,
  };
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
