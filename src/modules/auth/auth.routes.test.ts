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
import { withUserTransaction } from "../../db/transaction.js";
import type { AuthenticatedUserContext } from "./auth.schemas.js";

const testEmailDomain = "@auth.test.local";
const testPassword = "PasswordDePrueba123";
const currentDirectory = path.dirname(
  fileURLToPath(import.meta.url),
);
const projectRoot = path.resolve(currentDirectory, "../..");

const rolePermissionFixtures = {
  client: [] as string[],
  employee: [
    "customers.view",
    "dashboard.view",
    "profile.update",
    "profile.view",
  ],
  owner: ["roles.view", "users.view", "dashboard.view"],
} satisfies Record<string, string[]>;

function assertNoSensitiveFields(
  payload: AuthenticatedUserContext,
): void {
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

async function cleanupSyntheticUsers(): Promise<void> {
  await pool.query(
    `
      DELETE FROM auth.users
      WHERE email LIKE $1
    `,
    [`%${testEmailDomain}`],
  );
}

function toSqlLiteral(value: string | boolean | number): string {
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

async function createSyntheticUser(options?: {
  role?: keyof typeof rolePermissionFixtures;
  isActive?: boolean;
  fullName?: string;
}): Promise<{
  email: string;
  userId: string;
}> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);
  const role = options?.role ?? "client";
  const isActive = options?.isActive ?? true;
  const fullName = options?.fullName ?? "Usuario de Prueba";

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

  runAdminSql(
    `
      INSERT INTO public.profiles (
        id,
        full_name,
        phone,
        birth_date,
        role,
        biometric_id,
        is_active
      )
      VALUES (
        ${toSqlLiteral(userId)},
        ${toSqlLiteral(fullName)},
        '',
        CURRENT_DATE,
        ${toSqlLiteral(role)},
        ${toSqlLiteral(Math.floor(Math.random() * 1000000))},
        ${toSqlLiteral(isActive)}
      )
    `,
  );

  return { email, userId };
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

test("POST /auth/login devuelve authorization y rechaza datos sensibles", async () => {
  const { email } = await createSyntheticUser({
    role: "client",
  });

  const response = await request(app)
    .post("/auth/login")
    .send({
      email: ` ${email.toUpperCase()} `,
      password: testPassword,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.email, email);
  assert.equal(response.body.user.profile.fullName, "Usuario de Prueba");
  assert.deepEqual(response.body.authorization, {
    roleSlug: "client",
    scope: "client",
    permissions: [],
    isOwner: false,
  });
  assert.match(
    String(response.headers["set-cookie"]?.[0] ?? ""),
    /algym_session=/,
  );
  assertNoSensitiveFields(response.body);
});

test("GET /auth/me devuelve exactamente el mismo contexto que login", async () => {
  const { email } = await createSyntheticUser({
    role: "employee",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const meResponse = await agent.get("/auth/me");

  assert.equal(meResponse.status, 200);
  assert.deepEqual(meResponse.body, loginResponse.body);
  assert.deepEqual(meResponse.body.authorization.permissions, [
    "customers.view",
    "dashboard.view",
    "profile.update",
    "profile.view",
  ]);
  assert.equal(meResponse.body.authorization.scope, "panel");
  assertNoSensitiveFields(meResponse.body);
});

test("POST /auth/login marca owner y usa scope panel para roles internos", async () => {
  const { email } = await createSyntheticUser({
    role: "owner",
    fullName: "Propietario de Prueba",
  });

  const response = await request(app)
    .post("/auth/login")
    .send({
      email,
      password: testPassword,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.profile.role, "owner");
  assert.deepEqual(response.body.authorization, {
    roleSlug: "owner",
    scope: "panel",
    permissions: [
      "dashboard.view",
      "roles.view",
      "users.view",
    ],
    isOwner: true,
  });
});

test("POST /auth/login rechaza credenciales inválidas", async () => {
  const { email } = await createSyntheticUser();

  const response = await request(app)
    .post("/auth/login")
    .send({
      email,
      password: "incorrecta",
    });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_CREDENTIALS",
      message: "Credenciales inválidas",
    },
  });
  assert.equal(response.headers["set-cookie"], undefined);
});

test("GET /auth/me rechaza una sesión cuyo perfil se vuelve inactivo", async () => {
  const { email, userId } = await createSyntheticUser({
    role: "employee",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  await withUserTransaction(userId, (client) =>
    client.query(
      `
        UPDATE public.profiles
        SET is_active = false
        WHERE id = $1
      `,
      [userId],
    ),
  );

  const meResponse = await agent.get("/auth/me");

  assert.equal(meResponse.status, 403);
  assert.deepEqual(meResponse.body, {
    error: {
      code: "PROFILE_INACTIVE",
      message: "Perfil inactivo",
    },
  });
});

test("POST /auth/logout revoca la sesión y responde 204", async () => {
  const { email } = await createSyntheticUser();
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const logoutResponse = await agent.post("/auth/logout").send();

  assert.equal(logoutResponse.status, 204);
  assert.equal(logoutResponse.text, "");

  const meResponse = await agent.get("/auth/me");

  assert.equal(meResponse.status, 401);
});
