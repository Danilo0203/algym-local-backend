import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import bcrypt from "bcryptjs";
import pg from "pg";
import request from "supertest";
import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { normalizeClientPhone } from "./phone.js";
import { activateCustomerPhoneAccess, authenticateUser, getCustomerPhoneAccess } from "./auth.service.js";
import { updateCustomerAccount } from "../customers/customers.service.js";
import type { Request } from "express";

const password = "TelefonoPrueba123";
const ids: string[] = [];
let counter = 71000000;
const admin = new pg.Pool({ host: env.DB_HOST, port: env.DB_PORT, database: "algym_test",
  user: process.env.TEST_DB_ADMIN_USER || "postgres", password: process.env.TEST_DB_ADMIN_PASSWORD });
const mockRequest = { ip: "127.0.0.1", headers: { "user-agent": "phone-access-test" }, get: () => "phone-access-test" } as unknown as Request;

before(() => { assert.equal(env.DB_NAME, "algym_test"); });
after(async () => {
  await admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [ids]);
  await admin.end(); await pool.end();
});

async function customer(options: { phone?: string; email?: boolean; established?: boolean; active?: boolean; role?: string } = {}) {
  const id = randomUUID(); ids.push(id);
  const phone = options.phone ?? String(++counter);
  const email = options.email ? `${id}@phone.test.local` : null;
  await admin.query(`INSERT INTO auth.users (id,email,encrypted_password,customer_password_set_at,created_at,updated_at)
    VALUES ($1,$2,$3,CASE WHEN $4 THEN now() END,now(),now())`,
    [id,email,await bcrypt.hash(password,10),options.established ?? false]);
  await admin.query(`INSERT INTO public.profiles (id,full_name,phone,birth_date,role,biometric_id,is_active)
    VALUES ($1,'Prueba aislada teléfono',$2,'1990-01-01',$3,$4,$5)`,
    [id,phone,options.role ?? "client",++counter,options.active ?? true]);
  return { id, phone, email };
}

test("normaliza teléfonos locales y +502 sin aceptar texto arbitrario", () => {
  for (const value of ["5555-1234", "(5555) 1234", "+502 5555 1234", "50255551234"]) {
    assert.equal(normalizeClientPhone(value), "+50255551234");
  }
  for (const value of ["tel55551234", "123", "+1 55512345", ""]) assert.equal(normalizeClientPhone(value), null);
});

test("primer ingreso sin correo crea contraseña una sola vez y conserva la sesión", async () => {
  const user = await customer();
  assert.deepEqual(await getCustomerPhoneAccess({ phone: user.phone }), { requiresPasswordSetup: true });
  const agent = request.agent(app);
  const response = await agent.post("/auth/first-access").send({ phone: user.phone, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.user.id, user.id);
  assert.equal(response.body.user.email, null);
  assert.equal(response.body.authorization.scope, "client");
  assert.equal(JSON.stringify(response.body).includes(password), false);
  assert.equal((await agent.get("/auth/me")).status, 200);
  assert.deepEqual(await getCustomerPhoneAccess({ phone: user.phone }), { requiresPasswordSetup: false });
  const again = await request(app).post("/auth/first-access").send({ phone: user.phone, password: "OtraClave123" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "FIRST_ACCESS_COMPLETED");
  const change = await agent.post("/auth/change-password").send({ currentPassword: password, newPassword: "OtraClave123" });
  assert.equal(change.status, 403);
  assert.equal(change.body.error.code, "PASSWORD_ADMIN_REQUIRED");
  assert.equal((await request(app).post("/auth/login").send({ phone: `+502 ${user.phone}`, password })).status, 200);
});

test("dos activaciones simultáneas tienen exactamente un ganador", async () => {
  const user = await customer();
  const results = await Promise.allSettled([
    activateCustomerPhoneAccess({ phone: user.phone, password }, mockRequest),
    activateCustomerPhoneAccess({ phone: user.phone, password: "Competidor123" }, mockRequest),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "FIRST_ACCESS_COMPLETED");
  const winner = results[0]!.status === "fulfilled" ? password : "Competidor123";
  assert.equal((await authenticateUser({ phone: user.phone, password: winner }, mockRequest)).context.user.id, user.id);
});

test("protege contraseñas existentes y las asignadas por administrador antes del primer ingreso", async () => {
  for (const options of [{ email: true }, { established: true }]) {
    const user = await customer(options);
    assert.equal((await getCustomerPhoneAccess({ phone: user.phone })).requiresPasswordSetup, false);
    await assert.rejects(activateCustomerPhoneAccess({ phone: user.phone, password: "OtraClave123" }, mockRequest), { code: "FIRST_ACCESS_COMPLETED" });
    assert.equal((await authenticateUser({ phone: user.phone, password }, mockRequest)).context.user.id, user.id);
    if (user.email) assert.equal((await authenticateUser({ email: user.email, password }, mockRequest)).context.user.id, user.id);
  }
});

test("rechaza números duplicados incluso cuando uno está inactivo", async () => {
  const user = await customer();
  await customer({ phone: `+502 ${user.phone}`, active: false });
  await assert.rejects(getCustomerPhoneAccess({ phone: user.phone }), { code: "PHONE_NOT_UNIQUE" });
  await assert.rejects(activateCustomerPhoneAccess({ phone: user.phone, password }, mockRequest), { code: "PHONE_NOT_UNIQUE" });
  await assert.rejects(authenticateUser({ phone: user.phone, password }, mockRequest), { code: "PHONE_NOT_UNIQUE" });
});

test("no activa personal, clientes inactivos ni teléfonos inexistentes", async () => {
  const staff = await customer({ role: "admin", email: true });
  const inactive = await customer({ active: false });
  for (const phone of [staff.phone, inactive.phone, "70000000"]) {
    await assert.rejects(getCustomerPhoneAccess({ phone }), { code: "PHONE_ACCESS_UNAVAILABLE" });
    await assert.rejects(activateCustomerPhoneAccess({ phone, password }, mockRequest), { code: "INVALID_CREDENTIALS" });
  }
});

test("administrador restablece sin correo, cierra sesiones y no reabre primer ingreso", async () => {
  const owner = await customer({ role: "owner", email: true });
  const user = await customer();
  const agent = request.agent(app);
  assert.equal((await agent.post("/auth/first-access").send({ phone: user.phone, password })).status, 200);
  const updated = await updateCustomerAccount(owner.id, user.id, { new_password: "AdminNueva123" });
  assert.equal(updated.account.email, null);
  assert.equal(updated.account.login_enabled, true);
  assert.equal((await agent.get("/auth/me")).status, 401);
  await assert.rejects(authenticateUser({ phone: user.phone, password }, mockRequest), { code: "INVALID_CREDENTIALS" });
  assert.equal((await authenticateUser({ phone: user.phone, password: "AdminNueva123" }, mockRequest)).context.user.id, user.id);
  await assert.rejects(activateCustomerPhoneAccess({ phone: user.phone, password }, mockRequest), { code: "FIRST_ACCESS_COMPLETED" });
  await assert.rejects(updateCustomerAccount(user.id, user.id, { new_password: password }), { code: "FORBIDDEN" });
});

test("API valida teléfono, contraseña y un único identificador", async () => {
  const user = await customer();
  assert.equal((await request(app).post("/auth/first-access").send({ phone: user.phone, password: "corta" })).status, 400);
  assert.equal((await request(app).post("/auth/phone-access").send({ phone: "tel55551234" })).status, 400);
  assert.equal((await request(app).post("/auth/login").send({ phone: user.phone, email: "a@example.com", password })).status, 400);
});
