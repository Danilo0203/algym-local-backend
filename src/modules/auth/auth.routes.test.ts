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
    "customers.create",
    "customers.update",
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

test("POST /auth/change-password devuelve 401 sin sesion", async () => {
  const response = await request(app)
    .post("/auth/change-password")
    .send({
      currentPassword: testPassword,
      newPassword: "NuevaClave123",
    });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_SESSION",
      message: "Sesión inválida",
    },
  });
});

test("POST /auth/change-password rechaza body vacio", async () => {
  const { email } = await createSyntheticUser();
  const agent = request.agent(app);

  await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  const response = await agent
    .post("/auth/change-password")
    .send({});

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Solicitud inválida",
      details: {
        currentPassword: [
          "Invalid input: expected string, received undefined",
        ],
        newPassword: [
          "Invalid input: expected string, received undefined",
        ],
      },
    },
  });
});

test("POST /auth/change-password rechaza propiedad desconocida", async () => {
  const { email } = await createSyntheticUser();
  const agent = request.agent(app);

  await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  const response = await agent
    .post("/auth/change-password")
    .send({
      currentPassword: testPassword,
      newPassword: "NuevaClave123",
      role: "owner",
    });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Solicitud inválida",
      details: {},
    },
  });
});

test("POST /auth/change-password rechaza contraseña nueva corta", async () => {
  const { email } = await createSyntheticUser();
  const agent = request.agent(app);

  await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  const response = await agent
    .post("/auth/change-password")
    .send({
      currentPassword: testPassword,
      newPassword: "corta",
    });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Solicitud inválida",
      details: {
        newPassword: [
          "Too small: expected string to have >=8 characters",
        ],
      },
    },
  });
});

test("POST /auth/change-password rechaza contraseña actual incorrecta", async () => {
  const { email } = await createSyntheticUser();
  const agent = request.agent(app);

  await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  const response = await agent
    .post("/auth/change-password")
    .send({
      currentPassword: "incorrecta",
      newPassword: "NuevaClave123",
    });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_CURRENT_PASSWORD",
      message: "La contraseña actual es incorrecta",
    },
  });
});

test("POST /auth/change-password rechaza contraseña nueva igual a la actual", async () => {
  const { email } = await createSyntheticUser();
  const agent = request.agent(app);

  await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  const response = await agent
    .post("/auth/change-password")
    .send({
      currentPassword: testPassword,
      newPassword: testPassword,
    });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "PASSWORD_UNCHANGED",
      message:
        "La nueva contraseña no puede ser igual a la actual",
    },
  });
});

test("POST /auth/change-password actualiza la contraseña, revoca sesiones y limpia cookie", async () => {
  const { email, userId } = await createSyntheticUser();
  const agentA = request.agent(app);
  const agentB = request.agent(app);
  const newPassword = "NuevaClave123";

  const loginA = await agentA.post("/auth/login").send({
    email,
    password: testPassword,
  });
  const loginB = await agentB.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginA.status, 200);
  assert.equal(loginB.status, 200);

  const changeResponse = await agentA
    .post("/auth/change-password")
    .send({
      currentPassword: testPassword,
      newPassword,
    });

  assert.equal(changeResponse.status, 200);
  assert.deepEqual(changeResponse.body, {
    success: true,
    message: "Contraseña actualizada correctamente",
  });
  assert.match(
    String(changeResponse.headers["set-cookie"]?.[0] ?? ""),
    /algym_session=/,
  );
  assert.match(
    String(changeResponse.headers["set-cookie"]?.[0] ?? ""),
    /Expires=Thu, 01 Jan 1970 00:00:00 GMT/,
  );
  assertNoSensitiveFields(changeResponse.body);

  const meAfterChange = await agentA.get("/auth/me");
  const otherSessionAfterChange = await agentB.get("/auth/me");

  assert.equal(meAfterChange.status, 401);
  assert.equal(otherSessionAfterChange.status, 401);

  const sessionsResult = await pool.query<{
    revoked_at: Date | null;
  }>(
    `
      SELECT revoked_at
      FROM auth.sessions
      WHERE user_id = $1
    `,
    [userId],
  );

  assert.equal(sessionsResult.rows.length >= 2, true);
  assert.equal(
    sessionsResult.rows.every((row) => row.revoked_at !== null),
    true,
  );

  const oldPasswordLogin = await request(app)
    .post("/auth/login")
    .send({
      email,
      password: testPassword,
    });

  const newPasswordLogin = await request(app)
    .post("/auth/login")
    .send({
      email,
      password: newPassword,
    });

  assert.equal(oldPasswordLogin.status, 401);
  assert.equal(newPasswordLogin.status, 200);
});

test("POST /auth/change-password no modifica la contraseña de otro usuario", async () => {
  const userA = await createSyntheticUser();
  const userB = await createSyntheticUser();
  const agentB = request.agent(app);
  const newPassword = "ClaveUsuarioB9";

  const loginB = await agentB.post("/auth/login").send({
    email: userB.email,
    password: testPassword,
  });

  assert.equal(loginB.status, 200);

  const changeResponse = await agentB
    .post("/auth/change-password")
    .send({
      currentPassword: testPassword,
      newPassword,
    });

  assert.equal(changeResponse.status, 200);

  const loginAOldPassword = await request(app)
    .post("/auth/login")
    .send({
      email: userA.email,
      password: testPassword,
    });

  const loginANewPassword = await request(app)
    .post("/auth/login")
    .send({
      email: userA.email,
      password: newPassword,
    });

  assert.equal(loginAOldPassword.status, 200);
  assert.equal(loginANewPassword.status, 401);
});
