import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import bcrypt from "bcryptjs";
import { Pool } from "pg";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";

// This suite may only use a separately provisioned, synthetic test cluster.
if (env.DB_NAME !== "algym_test" || env.DB_PORT === 55432 ||
    !["127.0.0.1", "localhost", "::1"].includes(env.DB_HOST) ||
    !process.env.TEST_DB_ADMIN_USER) {
  throw new Error("Configura un clúster aislado algym_test y TEST_DB_ADMIN_USER para esta prueba");
}
const admin = new Pool({
  host: env.DB_HOST, port: env.DB_PORT, database: "algym_test",
  user: process.env.TEST_DB_ADMIN_USER,
  password: process.env.TEST_DB_ADMIN_PASSWORD,
});
const ids: string[] = [];
const pins: number[] = [];
const planIds: number[] = [];
const password = "Role transition test 123";

async function createAccount(role: "owner" | "admin" | "trainer" | "employee" | "client", options?: {
  email?: string | null; password?: string | null; birthDate?: string | null;
}) {
  const id = randomUUID();
  const email = options?.email === undefined ? `${id}@role-transition.test` : options.email;
  const accountPassword = options?.password === undefined ? password : options.password;
  ids.push(id);
  await admin.query(`INSERT INTO auth.users
    (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
    VALUES ($1, $2, $3, jsonb_build_object('role', $4::text, 'preserved', 'value'), now(), now())`,
  [id, email, accountPassword ? await bcrypt.hash(accountPassword, 10) : null, role]);
  const profile = await admin.query(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES ($1, 'ZZTEST ROLE TRANSITION', '55550123', $2::date, 'female', $3::public.user_role,
      CASE WHEN $3::text = 'client' THEN nextval('public.profiles_biometric_id_seq') ELSE NULL END, true)
    RETURNING biometric_id`,
  [id, options?.birthDate === undefined ? "1990-01-01" : options.birthDate, role]);
  if (profile.rows[0].biometric_id !== null) pins.push(profile.rows[0].biometric_id);
  return { id, email, password: accountPassword, biometricId: profile.rows[0].biometric_id as number | null };
}

async function login(account: { email: string | null; password: string | null }) {
  const response = await request(app).post("/auth/login").send({ email: account.email, password: account.password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return cookie;
}

async function snapshot(id: string) {
  return (await admin.query(`SELECT
    jsonb_build_object('email', u.email, 'password', u.encrypted_password, 'deleted_at', u.deleted_at,
      'metadata', u.raw_user_meta_data - 'role') AS account,
    to_jsonb(p) - ARRAY['role', 'panel_role_id', 'is_active', 'updated_at'] AS profile,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.subscriptions s WHERE s.user_id = u.id) AS subscriptions,
    (SELECT jsonb_agg(to_jsonb(pay) ORDER BY pay.id) FROM public.payments pay WHERE pay.user_id = u.id) AS payments,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.routines r WHERE r.user_id = u.id OR r.created_by = u.id) AS routines,
    (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM public.body_assessments b WHERE b.user_id = u.id) AS assessments,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.attendance_logs a WHERE a.biometric_id = p.biometric_id) AS attendance
    FROM auth.users u JOIN public.profiles p ON p.id = u.id WHERE u.id = $1`, [id])).rows[0];
}

after(async () => {
  try {
    await admin.query("DELETE FROM public.payments WHERE user_id = ANY($1::uuid[]) OR created_by_user_id = ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM public.routines WHERE user_id = ANY($1::uuid[]) OR created_by = ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM public.subscriptions WHERE user_id = ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM public.body_assessments WHERE user_id = ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM public.attendance_logs WHERE biometric_id = ANY($1::integer[])", [pins]);
    await admin.query("DELETE FROM public.profiles WHERE id = ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM auth.sessions WHERE user_id = ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [ids]);
    await admin.query("DELETE FROM public.plans WHERE id = ANY($1::bigint[])", [planIds]);
    await admin.query("DELETE FROM public.device_commands WHERE command LIKE '%ZZTEST ROLE TRANSITION%'");
  } finally {
    await Promise.all([admin.end(), pool.end()]);
  }
});

test("cliente y entrenador cambian de rol con la misma cuenta, historial, huella y contraseña", async () => {
  const owner = await createAccount("owner");
  const customer = await createAccount("client");
  const otherCustomer = await createAccount("client");
  const ownerCookie = await login(owner);
  const customerCookie = await login(customer);
  const planId = Number((await admin.query(`INSERT INTO public.plans(name, price, duration_days, is_active)
    VALUES ('ZZTEST ROLE TRANSITION', 100, 30, true) RETURNING id`)).rows[0].id);
  planIds.push(planId);
  const subscriptionId = (await admin.query(`INSERT INTO public.subscriptions(user_id, plan_id, start_date, end_date, status)
    VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 30, 'active') RETURNING id`, [customer.id, planId])).rows[0].id;
  await admin.query(`INSERT INTO public.payments(user_id, subscription_id, amount_original, amount_paid, method)
    VALUES ($1, $2, 100, 100, 'cash')`, [customer.id, subscriptionId]);
  await admin.query(`INSERT INTO public.routines(user_id, created_by, name, status, is_active)
    VALUES ($1, $2, 'Historial conservado', 'active', true), ($2, $1, 'Rutina creada para otro cliente', 'active', true)`,
  [customer.id, otherCustomer.id]);
  await admin.query(`INSERT INTO public.body_assessments(user_id, date, weight_kg, height_cm)
    VALUES ($1, CURRENT_DATE, 70, 170)`, [customer.id]);
  await admin.query(`INSERT INTO public.attendance_logs(device_id, biometric_id, punch_time, status1, raw_line)
    VALUES ('TEST', $1, now(), 0, 'ZZTEST ROLE TRANSITION')`, [customer.biometricId]);
  const before = await snapshot(customer.id);

  const promote = await request(app).post(`/users/${customer.id}/role-transition`).set("Cookie", ownerCookie)
    .send({ role: "trainer", is_active: true });
  assert.equal(promote.status, 200, JSON.stringify(promote.body));
  assert.deepEqual(promote.body, { id: customer.id, role: "trainer", is_active: true, biometric_id: customer.biometricId });
  assert.deepEqual(await snapshot(customer.id), before);
  assert.equal((await request(app).get("/auth/me").set("Cookie", customerCookie)).status, 401);
  assert.equal((await request(app).get(`/customers/${customer.id}`).set("Cookie", ownerCookie)).status, 404);
  const staff = await request(app).get("/users").set("Cookie", ownerCookie);
  assert.equal(staff.body.data.find((row: { id: string }) => row.id === customer.id)?.role, "trainer");
  const trainerCookie = await login(customer);
  const trainerMe = await request(app).get("/auth/me").set("Cookie", trainerCookie);
  assert.equal(trainerMe.body.authorization.scope, "panel");
  assert.equal((await request(app).post(`/users/${customer.id}/role-transition`).set("Cookie", ownerCookie)
    .send({ role: "trainer", is_active: true })).status, 409);

  const demote = await request(app).post(`/users/${customer.id}/role-transition`).set("Cookie", ownerCookie)
    .send({ role: "client", is_active: true });
  assert.equal(demote.status, 200, JSON.stringify(demote.body));
  assert.equal(demote.body.biometric_id, customer.biometricId);
  assert.deepEqual(await snapshot(customer.id), before);
  assert.equal((await request(app).get("/auth/me").set("Cookie", trainerCookie)).status, 401);
  const clientMe = await request(app).get("/auth/me").set("Cookie", await login(customer));
  assert.equal(clientMe.body.authorization.scope, "client");
  assert.equal((await request(app).get(`/customers/${customer.id}`).set("Cookie", ownerCookie)).status, 200);
  assert.equal((await admin.query("SELECT raw_user_meta_data->>'role' AS role FROM auth.users WHERE id = $1", [customer.id])).rows[0].role, "client");
});

test("conversión exige propietario/admin y ambos permisos; rechaza roles ajenos y entradas inválidas", async () => {
  const owner = await createAccount("owner");
  const customer = await createAccount("client");
  const ownerCookie = await login(owner);
  const target = `/users/${customer.id}/role-transition`;
  assert.equal((await request(app).post(target).send({ role: "trainer", is_active: true })).status, 401);
  for (const role of ["client", "trainer", "employee"] as const) {
    const actor = await createAccount(role);
    assert.equal((await request(app).post(target).set("Cookie", await login(actor))
      .send({ role: "trainer", is_active: true })).status, 403, role);
  }
  for (const body of [{ role: "owner", is_active: true }, { role: "trainer" },
    { role: "trainer", is_active: true, password: "short" },
    { role: "client", is_active: true, birth_date: "2026-02-30" }]) {
    assert.equal((await request(app).post(target).set("Cookie", ownerCookie).send(body)).status, 400);
  }
  assert.equal((await request(app).post(`/users/${owner.id}/role-transition`).set("Cookie", ownerCookie)
    .send({ role: "client", is_active: true })).status, 409);
  assert.equal((await request(app).post(`/users/${randomUUID()}/role-transition`).set("Cookie", ownerCookie)
    .send({ role: "trainer", is_active: true })).status, 404);

  const administrator = await createAccount("admin");
  const administratorCookie = await login(administrator);
  const permissionIds = (await admin.query(`SELECT p.id, p.key FROM public.permissions p WHERE p.key IN ('users.update', 'customers.update')`)).rows;
  const roleId = (await admin.query("SELECT id FROM public.roles WHERE slug = 'admin'")).rows[0].id;
  const original = (await admin.query("SELECT permission_id FROM public.role_permissions WHERE role_id = $1", [roleId])).rows;
  try {
    await admin.query("DELETE FROM public.role_permissions WHERE role_id = $1 AND permission_id = ANY($2::uuid[])", [roleId, permissionIds.map((row) => row.id)]);
    assert.equal((await request(app).post(target).set("Cookie", administratorCookie).send({ role: "trainer", is_active: true })).status, 403);
    await admin.query("INSERT INTO public.role_permissions(role_id, permission_id) VALUES ($1, $2)",
      [roleId, permissionIds.find((row) => row.key === "users.update")!.id]);
    assert.equal((await request(app).post(target).set("Cookie", administratorCookie).send({ role: "trainer", is_active: true })).status, 403);
    await admin.query("INSERT INTO public.role_permissions(role_id, permission_id) VALUES ($1, $2)",
      [roleId, permissionIds.find((row) => row.key === "customers.update")!.id]);
    assert.equal((await request(app).post(target).set("Cookie", administratorCookie).send({ role: "trainer", is_active: true })).status, 200);
  } finally {
    await admin.query("DELETE FROM public.role_permissions WHERE role_id = $1 AND permission_id = ANY($2::uuid[])", [roleId, permissionIds.map((row) => row.id)]);
    for (const permission of original.filter((row) => permissionIds.some((item) => item.id === row.permission_id))) {
      await admin.query("INSERT INTO public.role_permissions(role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [roleId, permission.permission_id]);
    }
  }
});

test("entrenador sin fecha ni PIN completa los datos de cliente y conserva el estado elegido", async () => {
  const ownerCookie = await login(await createAccount("owner"));
  const trainer = await createAccount("trainer", { birthDate: null });
  const trainerCookie = await login(trainer);
  const before = await snapshot(trainer.id);
  const target = `/users/${trainer.id}/role-transition`;
  const missing = await request(app).post(target).set("Cookie", ownerCookie).send({ role: "client", is_active: false });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error.code, "CUSTOMER_BIRTH_DATE_REQUIRED");
  assert.deepEqual(await snapshot(trainer.id), before);
  const changed = await request(app).post(target).set("Cookie", ownerCookie)
    .send({ role: "client", is_active: false, birth_date: "1988-02-29" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(changed.body.biometric_id > 0);
  pins.push(changed.body.biometric_id);
  assert.equal(changed.body.is_active, false);
  assert.equal((await snapshot(trainer.id)).profile.birth_date, "1988-02-29");
  assert.equal((await request(app).get("/auth/me").set("Cookie", trainerCookie)).status, 401);
  assert.equal((await request(app).post("/auth/login").send({ email: trainer.email, password })).status, 403);
  const reactivated = await request(app).post(target).set("Cookie", ownerCookie).send({ role: "trainer", is_active: true });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body.biometric_id, changed.body.biometric_id);
  await login(trainer);
});

test("cliente sin credenciales de personal las completa sin duplicar la cuenta ni aceptar correo ocupado", async () => {
  const owner = await createAccount("owner");
  const cookie = await login(owner);
  const customer = await createAccount("client", { email: null, password: null });
  const target = `/users/${customer.id}/role-transition`;
  const before = await snapshot(customer.id);
  const noEmail = await request(app).post(target).set("Cookie", cookie).send({ role: "trainer", is_active: true });
  assert.equal(noEmail.status, 409);
  assert.equal(noEmail.body.error.code, "TRAINER_EMAIL_REQUIRED");
  const email = `${randomUUID()}@role-transition.test`;
  const noPassword = await request(app).post(target).set("Cookie", cookie).send({ role: "trainer", is_active: true, email });
  assert.equal(noPassword.status, 409);
  assert.equal(noPassword.body.error.code, "TRAINER_PASSWORD_REQUIRED");
  const duplicate = await request(app).post(target).set("Cookie", cookie)
    .send({ role: "trainer", is_active: true, email: owner.email, password });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "EMAIL_ALREADY_EXISTS");
  assert.deepEqual(await snapshot(customer.id), before);
  const changed = await request(app).post(target).set("Cookie", cookie)
    .send({ role: "trainer", is_active: true, email: email.toUpperCase(), password });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.id, customer.id);
  const me = await request(app).get("/auth/me").set("Cookie", await login({ email, password }));
  assert.equal(me.body.user.id, customer.id);
  assert.equal(me.body.authorization.roleSlug, "trainer");
});

test("fallo al revocar sesiones revierte el rol y las credenciales dentro de la misma transacción", async () => {
  const cookie = await login(await createAccount("owner"));
  const customer = await createAccount("client");
  const customerCookie = await login(customer);
  const before = await snapshot(customer.id);
  await admin.query(`CREATE FUNCTION auth.fail_role_transition_revoke_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.user_id = '${customer.id}'::uuid THEN RAISE EXCEPTION 'forced transition rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_role_transition_revoke_test BEFORE UPDATE ON auth.sessions
    FOR EACH ROW EXECUTE FUNCTION auth.fail_role_transition_revoke_test()`);
  try {
    const response = await request(app).post(`/users/${customer.id}/role-transition`).set("Cookie", cookie)
      .send({ role: "trainer", is_active: false, password: "Changed password test 123" });
    assert.equal(response.status, 500);
    assert.deepEqual(await snapshot(customer.id), before);
    const profile = (await admin.query("SELECT role, is_active FROM public.profiles WHERE id = $1", [customer.id])).rows[0];
    assert.deepEqual(profile, { role: "client", is_active: true });
  } finally {
    await admin.query("DROP TRIGGER fail_role_transition_revoke_test ON auth.sessions; DROP FUNCTION auth.fail_role_transition_revoke_test()");
  }
  assert.equal((await request(app).get("/auth/me").set("Cookie", customerCookie)).status, 200);
});
