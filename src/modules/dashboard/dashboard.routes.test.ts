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
import type { DashboardOverviewResponse } from "./dashboard.types.js";

const testEmailDomain = "@dashboard.test.local";
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

type ClientFixture = SyntheticUser & {
  fullName: string;
  avatarUrl: string | null;
  phone: string;
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

async function cleanupSyntheticData(): Promise<void> {
  runAdminSql(`
    DELETE FROM public.payments
    WHERE user_id IN (
      SELECT id
      FROM auth.users
      WHERE email LIKE '%${testEmailDomain}'
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
  fullName?: string;
  isActive?: boolean;
  phone?: string;
  role?: TestUserRole;
}): Promise<SyntheticUser> {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const passwordHash = await bcrypt.hash(testPassword, 10);
  const role = options?.role ?? "client";
  const isActive = options?.isActive ?? true;
  const fullName = options?.fullName ?? "Usuario Sintetico";
  const avatarUrl = options?.avatarUrl ?? null;
  const phone = options?.phone ?? "";

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
      avatar_url,
      birth_date,
      role,
      biometric_id,
      is_active
    )
    VALUES (
      ${toSqlLiteral(userId)},
      ${toSqlLiteral(fullName)},
      ${toSqlLiteral(phone)},
      ${toSqlLiteral(avatarUrl)},
      DATE '1990-01-01',
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

async function createClientFixture(options: {
  avatarUrl?: string | null;
  fullName: string;
  phone?: string;
}): Promise<ClientFixture> {
  const user = await createSyntheticUser({
    role: "client",
    fullName: options.fullName,
    avatarUrl: options.avatarUrl ?? null,
    phone: options.phone ?? "",
  });

  return {
    ...user,
    fullName: options.fullName,
    avatarUrl: options.avatarUrl ?? null,
    phone: options.phone ?? "",
  };
}

function seedDashboardData(fixtures: {
  basicPlanId: number;
  premiumPlanId: number;
  employeeUserId: string;
  expiringClient: ClientFixture;
  inactiveClient: ClientFixture;
  recentClient: ClientFixture;
  transferClient: ClientFixture;
}): void {
  runAdminSql(`
    INSERT INTO public.plans (
      id,
      name,
      duration_days,
      price,
      description,
      is_active
    )
    VALUES
      (${fixtures.basicPlanId}, 'Plan Basico', 30, 150.00, 'Plan sintetico', true),
      (${fixtures.premiumPlanId}, 'Plan Premium', 30, 220.00, 'Plan sintetico', true);

    INSERT INTO public.subscriptions (
      id,
      user_id,
      plan_id,
      start_date,
      end_date,
      status,
      created_at,
      discount_amount,
      grace_days
    )
    VALUES
      (
        '11111111-1111-4111-8111-111111111111',
        ${toSqlLiteral(fixtures.expiringClient.userId)},
        ${fixtures.premiumPlanId},
        DATE '2026-06-01',
        DATE '2026-06-27',
        'active',
        TIMESTAMPTZ '2026-06-01 09:00:00-06',
        0,
        0
      ),
      (
        '22222222-2222-4222-8222-222222222222',
        ${toSqlLiteral(fixtures.inactiveClient.userId)},
        ${fixtures.basicPlanId},
        DATE '2026-05-01',
        DATE '2026-06-10',
        'expired',
        TIMESTAMPTZ '2026-05-01 08:00:00-06',
        0,
        0
      ),
      (
        '33333333-3333-4333-8333-333333333333',
        ${toSqlLiteral(fixtures.recentClient.userId)},
        ${fixtures.basicPlanId},
        DATE '2026-06-01',
        DATE '2026-07-01',
        'active',
        TIMESTAMPTZ '2026-06-05 10:00:00-06',
        0,
        0
      ),
      (
        '44444444-4444-4444-8444-444444444444',
        ${toSqlLiteral(fixtures.transferClient.userId)},
        ${fixtures.basicPlanId},
        DATE '2026-04-15',
        DATE '2026-05-30',
        'cancelled',
        TIMESTAMPTZ '2026-04-15 10:00:00-06',
        0,
        0
      );

    INSERT INTO public.payments (
      id,
      subscription_id,
      user_id,
      amount_original,
      discount_amount,
      amount_paid,
      method,
      payment_date,
      notes,
      created_by_user_id,
      status
    )
    VALUES
      (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '11111111-1111-4111-8111-111111111111',
        ${toSqlLiteral(fixtures.expiringClient.userId)},
        220.00,
        0,
        220.00,
        'card',
        TIMESTAMPTZ '2026-06-20 14:30:00-06',
        'Pago sintetico',
        ${toSqlLiteral(fixtures.employeeUserId)},
        'posted'
      ),
      (
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '33333333-3333-4333-8333-333333333333',
        ${toSqlLiteral(fixtures.recentClient.userId)},
        150.00,
        0,
        150.00,
        'cash',
        TIMESTAMPTZ '2026-06-15 09:00:00-06',
        'Pago sintetico',
        ${toSqlLiteral(fixtures.employeeUserId)},
        'posted'
      ),
      (
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        '22222222-2222-4222-8222-222222222222',
        ${toSqlLiteral(fixtures.inactiveClient.userId)},
        150.00,
        0,
        100.00,
        'transfer',
        TIMESTAMPTZ '2026-05-25 18:00:00-06',
        'Pago sintetico',
        ${toSqlLiteral(fixtures.employeeUserId)},
        'posted'
      ),
      (
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        '44444444-4444-4444-8444-444444444444',
        ${toSqlLiteral(fixtures.transferClient.userId)},
        150.00,
        0,
        80.00,
        'cash',
        TIMESTAMPTZ '2026-05-10 11:00:00-06',
        'Pago sintetico',
        ${toSqlLiteral(fixtures.employeeUserId)},
        'posted'
      );
  `);
}

function getGuatemalaTodayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala",
  }).format(new Date());
}

function diffCalendarDays(
  fromDateIso: string,
  toDateIso: string,
): number {
  const fromDate = new Date(`${fromDateIso}T00:00:00.000Z`);
  const toDate = new Date(`${toDateIso}T00:00:00.000Z`);

  return Math.round(
    (toDate.getTime() - fromDate.getTime()) / 86_400_000,
  );
}

function assertOverviewShape(
  payload: DashboardOverviewResponse,
): void {
  assert.equal(typeof payload.kpis.totalRevenue, "number");
  assert.equal(Array.isArray(payload.revenueByMonth), true);
  assert.equal(Array.isArray(payload.planDistribution), true);
  assert.equal(
    Array.isArray(payload.subscriptionsFlow),
    true,
  );
  assert.equal(
    Array.isArray(payload.paymentMethodDistribution),
    true,
  );
  assert.equal(Array.isArray(payload.recentPayments), true);
  assert.equal(
    Array.isArray(payload.expiringSubscriptions),
    true,
  );
  assert.equal(
    Array.isArray(payload.inactiveCustomers),
    true,
  );
}

before(async () => {
  if (env.DB_NAME !== "algym_test") {
    throw new Error(
      `DB_NAME debe ser exactamente algym_test y actualmente es ${env.DB_NAME}.`,
    );
  }

  await cleanupSyntheticData();
});

beforeEach(async () => {
  await cleanupSyntheticData();
  await pool.query("DELETE FROM auth.sessions");
});

after(async () => {
  await pool.query("DELETE FROM auth.sessions");
  await cleanupSyntheticData();
  await pool.end();
});

test("GET /dashboard/overview devuelve 401 sin sesion", async () => {
  const response = await request(app).get("/dashboard/overview");

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      code: "INVALID_SESSION",
      message: "Sesión inválida",
    },
  });
});

test("GET /dashboard/overview devuelve 403 para cliente sin permiso", async () => {
  const { email } = await createSyntheticUser({
    role: "client",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent.get("/dashboard/overview");

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, {
    error: {
      code: "FORBIDDEN",
      message: "No autorizado para consultar el dashboard",
    },
  });
});

test("GET /dashboard/overview devuelve contrato completo con cero y arreglos vacios en base sin datos", async () => {
  const { email } = await createSyntheticUser({
    role: "owner",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent.get("/dashboard/overview");

  assert.equal(response.status, 200);
  assertOverviewShape(response.body);
  assert.deepEqual(response.body.kpis, {
    totalRevenue: 0,
    revenueChange: 0,
    activeMembers: 0,
    inactiveMembers: 0,
    churnRate: 0,
    avgTicket: 0,
    cashAmount: 0,
    cardAmount: 0,
    transferAmount: 0,
  });
  assert.equal(response.body.revenueByMonth.length, 6);
  assert.equal(response.body.subscriptionsFlow.length, 6);
  assert.equal(
    response.body.revenueByMonth.every(
      (item: { revenue: number }) => item.revenue === 0,
    ),
    true,
  );
  assert.equal(
    response.body.subscriptionsFlow.every(
      (item: {
        cancelled: number;
        newSubs: number;
      }) =>
        item.newSubs === 0 && item.cancelled === 0,
    ),
    true,
  );
  assert.deepEqual(response.body.planDistribution, []);
  assert.deepEqual(
    response.body.paymentMethodDistribution,
    [],
  );
  assert.deepEqual(response.body.recentPayments, []);
  assert.deepEqual(response.body.expiringSubscriptions, []);
  assert.deepEqual(response.body.inactiveCustomers, []);
  assertNoSensitiveFields(response.body);
});

test("GET /dashboard/overview calcula las ocho secciones con datos sinteticos", async () => {
  const owner = await createSyntheticUser({
    role: "owner",
    fullName: "Dueno Panel",
  });
  const employee = await createSyntheticUser({
    role: "employee",
    fullName: "Empleado Caja",
  });
  const expiringClient = await createClientFixture({
    fullName: "Cliente Vigente",
    avatarUrl: "https://example.com/avatar-1.png",
    phone: "55510001",
  });
  const inactiveClient = await createClientFixture({
    fullName: "Cliente Inactivo",
    phone: "55510002",
  });
  const recentClient = await createClientFixture({
    fullName: "Cliente Efectivo",
    phone: "55510003",
  });
  const transferClient = await createClientFixture({
    fullName: "Cliente Transferencia",
    phone: "55510004",
  });

  seedDashboardData({
    basicPlanId: 91001,
    premiumPlanId: 91002,
    employeeUserId: employee.userId,
    expiringClient,
    inactiveClient,
    recentClient,
    transferClient,
  });

  const agent = request.agent(app);
  const loginResponse = await agent.post("/auth/login").send({
    email: owner.email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent
    .get("/dashboard/overview")
    .query({
      from: "2026-06-01",
      to: "2026-06-30",
    });

  assert.equal(response.status, 200);
  assertOverviewShape(response.body);
  assert.deepEqual(response.body.kpis, {
    totalRevenue: 370,
    revenueChange: 105.6,
    activeMembers: 2,
    inactiveMembers: 2,
    churnRate: 33.3,
    avgTicket: 185,
    cashAmount: 150,
    cardAmount: 220,
    transferAmount: 0,
  });
  assert.deepEqual(response.body.revenueByMonth, [
    { month: "ene", revenue: 0 },
    { month: "feb", revenue: 0 },
    { month: "mar", revenue: 0 },
    { month: "abr", revenue: 0 },
    { month: "may", revenue: 180 },
    { month: "jun", revenue: 370 },
  ]);
  assert.deepEqual(response.body.planDistribution, [
    {
      name: "Plan Basico",
      count: 1,
      percentage: 50,
      color: "var(--chart-1)",
    },
    {
      name: "Plan Premium",
      count: 1,
      percentage: 50,
      color: "var(--chart-2)",
    },
  ]);
  assert.deepEqual(response.body.subscriptionsFlow, [
    { month: "ene", newSubs: 0, cancelled: 0 },
    { month: "feb", newSubs: 0, cancelled: 0 },
    { month: "mar", newSubs: 0, cancelled: 0 },
    { month: "abr", newSubs: 1, cancelled: 0 },
    { month: "may", newSubs: 1, cancelled: 1 },
    { month: "jun", newSubs: 2, cancelled: 1 },
  ]);
  assert.deepEqual(response.body.paymentMethodDistribution, [
    {
      method: "Efectivo",
      amount: 150,
      count: 1,
      color: "var(--success)",
    },
    {
      method: "Tarjeta",
      amount: 220,
      count: 1,
      color: "var(--chart-1)",
    },
  ]);
  assert.deepEqual(response.body.recentPayments, [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      user_id: expiringClient.userId,
      user_name: "Cliente Vigente",
      avatar_url: "https://example.com/avatar-1.png",
      plan_name: "Plan Premium",
      amount: 220,
      method: "card",
      date: "2026-06-20T20:30:00.000Z",
    },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      user_id: recentClient.userId,
      user_name: "Cliente Efectivo",
      avatar_url: null,
      plan_name: "Plan Basico",
      amount: 150,
      method: "cash",
      date: "2026-06-15T15:00:00.000Z",
    },
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      user_id: inactiveClient.userId,
      user_name: "Cliente Inactivo",
      avatar_url: null,
      plan_name: "Plan Basico",
      amount: 100,
      method: "transfer",
      date: "2026-05-26T00:00:00.000Z",
    },
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      user_id: transferClient.userId,
      user_name: "Cliente Transferencia",
      avatar_url: null,
      plan_name: "Plan Basico",
      amount: 80,
      method: "cash",
      date: "2026-05-10T17:00:00.000Z",
    },
  ]);
  const guatemalaToday = getGuatemalaTodayIso();
  const expectedExpiringSubscriptions = [
    {
      user_id: expiringClient.userId,
      user_name: "Cliente Vigente",
      avatar_url: "https://example.com/avatar-1.png",
      phone: "55510001",
      plan_name: "Plan Premium",
      end_date: "2026-06-27",
    },
    {
      user_id: recentClient.userId,
      user_name: "Cliente Efectivo",
      avatar_url: null,
      phone: "55510003",
      plan_name: "Plan Basico",
      end_date: "2026-07-01",
    },
  ]
    .map((item) => ({
      ...item,
      days_left: diffCalendarDays(guatemalaToday, item.end_date),
    }))
    .filter(
      (item) => item.days_left >= 0 && item.days_left <= 5,
    )
    .sort(
      (left, right) =>
        left.end_date.localeCompare(right.end_date) ||
        left.user_id.localeCompare(right.user_id),
    );

  const expectedInactiveCustomers = [
    {
      user_id: inactiveClient.userId,
      user_name: "Cliente Inactivo",
      avatar_url: null,
      phone: "55510002",
      last_plan: "Plan Basico",
      expired_date: "2026-06-10",
    },
    {
      user_id: transferClient.userId,
      user_name: "Cliente Transferencia",
      avatar_url: null,
      phone: "55510004",
      last_plan: "Plan Basico",
      expired_date: "2026-05-30",
    },
  ]
    .map((item) => ({
      ...item,
      days_inactive: diffCalendarDays(
        item.expired_date,
        guatemalaToday,
      ),
    }))
    .filter((item) => item.days_inactive > 0)
    .sort(
      (left, right) =>
        right.expired_date.localeCompare(left.expired_date) ||
        left.user_id.localeCompare(right.user_id),
    );

  assert.deepEqual(
    response.body.expiringSubscriptions,
    expectedExpiringSubscriptions,
  );
  assert.deepEqual(
    response.body.inactiveCustomers,
    expectedInactiveCustomers,
  );
  assert.equal(typeof response.body.recentPayments[0].id, "string");
  assertNoSensitiveFields(response.body);
});

test("GET /dashboard/overview valida from y to como par requerido", async () => {
  const { email } = await createSyntheticUser({
    role: "owner",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent.get("/dashboard/overview").query({
    from: "2026-06-01",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Solicitud inválida",
      details: {
        to: ["from y to deben enviarse juntos"],
      },
    },
  });
});

test("GET /dashboard/overview valida que from no sea mayor que to", async () => {
  const { email } = await createSyntheticUser({
    role: "owner",
  });
  const agent = request.agent(app);

  const loginResponse = await agent.post("/auth/login").send({
    email,
    password: testPassword,
  });

  assert.equal(loginResponse.status, 200);

  const response = await agent.get("/dashboard/overview").query({
    from: "2026-06-30",
    to: "2026-06-01",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "VALIDATION_ERROR",
      message: "Solicitud inválida",
      details: {
        from: ["from no puede ser mayor que to"],
      },
    },
  });
});
