import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, {
  after,
  before,
  beforeEach,
} from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";

const testEmailDomain = "@profile.test.local";
const testPassword = "PasswordDePrueba123";
const currentDirectory = path.dirname(
  fileURLToPath(import.meta.url),
);
const projectRoot = path.resolve(currentDirectory, "../..");

type TestUserRole = "client" | "employee" | "owner";

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
  assert.equal(
    serializedPayload.includes("PasswordDePrueba123"),
    false,
  );
}

async function createSyntheticUser(options?: {
  avatarUrl?: string | null;
  birthDate?: string;
  fullName?: string;
  gender?: "male" | "female" | "other";
  isActive?: boolean;
  phone?: string;
  role?: TestUserRole;
}): Promise<SyntheticUser> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);
  const role = options?.role ?? "client";
  const isActive = options?.isActive ?? true;
  const fullName = options?.fullName ?? "Usuario Perfil";
  const phone = options?.phone ?? "55510000";
  const birthDate = options?.birthDate ?? "1990-01-01";
  const gender = options?.gender ?? "male";
  const avatarUrl = options?.avatarUrl ?? null;

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
      avatar_url,
      role,
      biometric_id,
      is_active
    )
    VALUES (
      ${toSqlLiteral(userId)},
      ${toSqlLiteral(fullName)},
      ${toSqlLiteral(phone)},
      DATE ${toSqlLiteral(birthDate)},
      ${toSqlLiteral(gender)},
      ${toSqlLiteral(avatarUrl)},
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

before(async () => {
  if (env.DB_NAME !== "algym_test") {
    throw new Error(
      `DB_NAME debe ser exactamente algym_test y actualmente es ${env.DB_NAME}.`,
    );
  }

  await cleanupSyntheticUsers();
});

beforeEach(async () => {
  await cleanupSyntheticUsers();
  await pool.query("DELETE FROM auth.sessions");
});

after(async () => {
  await pool.query("DELETE FROM auth.sessions");
  await cleanupSyntheticUsers();
  await pool.end();
});

test("GET /profile devuelve 401 sin sesion", async () => {
  const response = await request(app).get("/profile");

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_SESSION",
      message: "Sesión inválida",
    },
  });
});

test("PATCH /profile devuelve 401 sin sesion", async () => {
  const response = await request(app)
    .patch("/profile")
    .send({
      full_name: "Nuevo Nombre",
    });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_SESSION",
      message: "Sesión inválida",
    },
  });
});

test("GET /profile devuelve el perfil propio", async () => {
  const { email, userId } = await createSyntheticUser({
    role: "client",
    fullName: "Cliente Perfil",
    phone: "55512345",
    birthDate: "1992-08-15",
    gender: "female",
    avatarUrl: "https://example.com/avatar.png",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent.get("/profile");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    id: userId,
    email,
    full_name: "Cliente Perfil",
    phone: "55512345",
    birth_date: "1992-08-15",
    gender: "female",
    avatar_url: "https://example.com/avatar.png",
    role: "client",
    created_at: response.body.created_at,
    updated_at: response.body.updated_at,
  });
  assert.match(response.body.created_at, /T/);
  assert.match(response.body.updated_at, /T/);
  assert.equal(response.body.birth_date, "1992-08-15");
  assertNoSensitiveFields(response.body);
});

test("PATCH /profile devuelve 403 para usuario sin profile.update y sin owner", async () => {
  const { email } = await createSyntheticUser({
    role: "client",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent.patch("/profile").send({
    full_name: "Nombre Denegado",
  });

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, {
    error: {
      code: "FORBIDDEN",
      message: "No autorizado para editar el perfil",
    },
  });
});

test("PATCH /profile permite actualizar para owner", async () => {
  const { email } = await createSyntheticUser({
    role: "owner",
    fullName: "Owner Perfil",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent.patch("/profile").send({
    full_name: "Owner Actualizado",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.full_name, "Owner Actualizado");
  assertNoSensitiveFields(response.body);
});

test("PATCH /profile permite actualizar para rol con profile.update y conserva campos omitidos", async () => {
  const { email } = await createSyntheticUser({
    role: "employee",
    fullName: "Empleado Perfil",
    phone: "55500011",
    birthDate: "1994-03-20",
    gender: "male",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent.patch("/profile").send({
    phone: "55588899",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.full_name, "Empleado Perfil");
  assert.equal(response.body.phone, "55588899");
  assert.equal(response.body.birth_date, "1994-03-20");
  assert.equal(response.body.gender, "male");
});

test("PATCH /profile rechaza body vacio", async () => {
  const { email } = await createSyntheticUser({
    role: "employee",
  });
  const agent = request.agent(app);

  await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  const response = await agent.patch("/profile").send({});

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Solicitud inválida",
      details: {
        body: ["Debes enviar al menos un campo para actualizar"],
      },
    },
  });
});

test("PATCH /profile rechaza fecha imposible", async () => {
  const { email } = await createSyntheticUser({
    role: "employee",
  });
  const agent = request.agent(app);

  await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  const response = await agent.patch("/profile").send({
    birth_date: "2026-02-31",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Solicitud inválida",
      details: {
        birth_date: [
          "La fecha debe tener formato YYYY-MM-DD y ser válida",
        ],
      },
    },
  });
});

test("PATCH /profile rechaza propiedad desconocida y protege role, is_active, email e id", async () => {
  const target = await createSyntheticUser({
    role: "employee",
    fullName: "Perfil Original",
    phone: "55522222",
  });
  const otherUser = await createSyntheticUser({
    role: "client",
    fullName: "Otra Persona",
  });
  const agent = request.agent(app);

  await agent.post("/auth/login").send({
    email: target.email,
    password: testPassword,
  });

  const response = await agent.patch("/profile").send({
    id: otherUser.userId,
    role: "owner",
    is_active: false,
    email: "cambio@example.com",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Solicitud inválida",
      details: {},
    },
  });

  const profileResponse = await agent.get("/profile");

  assert.equal(profileResponse.status, 200);
  assert.equal(profileResponse.body.id, target.userId);
  assert.equal(profileResponse.body.role, "employee");
  assert.equal(profileResponse.body.email, target.email);
});

test("GET /profile devuelve 404 si el perfil falta", async () => {
  const { email, userId } = await createSyntheticUser({
    role: "employee",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  runAdminSql(`
    DELETE FROM public.profiles
    WHERE id = ${toSqlLiteral(userId)};
  `);

  const response = await agent.get("/profile");

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    error: {
      code: "PROFILE_NOT_FOUND",
      message: "Perfil no encontrado",
    },
  });
});
