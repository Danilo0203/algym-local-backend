import { randomUUID } from "node:crypto";
import test, {
  after,
  before,
  beforeEach,
} from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";

const testEmailDomain = "@auth.test.local";
const testPassword = "PasswordDePrueba123";

async function cleanupSyntheticUsers(): Promise<void> {
  await pool.query(
    `
      DELETE FROM auth.users
      WHERE email LIKE $1
    `,
    [`%${testEmailDomain}`],
  );
}

async function createSyntheticUser(): Promise<{
  email: string;
}> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);

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

  await withUserTransaction(userId, (client) =>
    client.query(
      `
        INSERT INTO public.profiles (
          id,
          full_name,
          phone,
          birth_date,
          role,
          biometric_id
        )
        VALUES ($1, $2, $3, CURRENT_DATE, 'client', $4)
      `,
      [
        userId,
        "Usuario de Prueba",
        "",
        Math.floor(Math.random() * 1000000),
      ],
    ),
  );

  return { email };
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
});

after(async () => {
  await cleanupSyntheticUsers();
  await pool.query("DELETE FROM auth.sessions");
  await pool.end();
});

test("POST /auth/login permite credenciales válidas", async () => {
  const { email } = await createSyntheticUser();

  const response = await request(app)
    .post("/auth/login")
    .send({
      email: ` ${email.toUpperCase()} `,
      password: testPassword,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.user.email, email);
  assert.equal(response.body.user.profile.fullName, "Usuario de Prueba");
  assert.match(
    String(response.headers["set-cookie"]?.[0] ?? ""),
    /algym_session=/,
  );
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

test("GET /auth/me devuelve la sesión válida", async () => {
  const { email } = await createSyntheticUser();
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const meResponse = await agent.get("/auth/me");

  assert.equal(meResponse.status, 200);
  assert.equal(meResponse.body.user.email, email);
  assert.equal(meResponse.body.user.profile.role, "client");
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
