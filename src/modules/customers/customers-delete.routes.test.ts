import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { runPsqlSql } from "../../test/psql.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testEmailDomain = "@customers-delete.test.local";
const password = "PasswordDePrueba123";
const namePrefix = "ZZTEST DELETE";

function adminSql(sql: string): string {
  return runPsqlSql(
    ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt"],
    sql,
    { cwd: projectRoot, output: "capture" },
  ).trim();
}

async function createUser(role: "owner" | "client" | "employee", fullName: string) {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(`
    INSERT INTO auth.users
      (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
    VALUES ($1, $2, $3, '{}'::jsonb, now(), now())
  `, [userId, email, hash]);
  const biometricId = Math.floor(Math.random() * 1_000_000) + 6_000_000;
  adminSql(`
    INSERT INTO public.profiles
      (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES ('${userId}', '${fullName}', '55540000', DATE '1990-01-01',
            'male', '${role}', ${biometricId}, true)
  `);
  const login = await request(app).post("/auth/login").send({ email, password });
  return { userId, biometricId, cookie: role === "client" ? "" : login.headers["set-cookie"]?.[0] ?? "" };
}

after(async () => {
  adminSql(`
    DELETE FROM public.cash_movements WHERE note LIKE '${namePrefix}%';
    DELETE FROM public.payments
    WHERE deleted_customer_name LIKE '${namePrefix}%'
       OR user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.subscriptions
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.routines
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.access_logs
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.cash_sessions WHERE session_number LIKE 'ZZTEST-DEL-%';
    DELETE FROM public.cash_registers WHERE name = '${namePrefix} REGISTER';
    DELETE FROM public.plans WHERE name = '${namePrefix} PLAN';
    DELETE FROM public.role_permissions AS rp
    USING public.roles AS role, public.permissions AS permission
    WHERE rp.role_id = role.id AND rp.permission_id = permission.id
      AND role.slug = 'employee' AND permission.key = 'customers.delete';
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
  `);
  await pool.query("DELETE FROM auth.sessions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE $1)",
    [`%${testEmailDomain}`]);
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testEmailDomain}`]);
  await pool.end();
});

test("eliminación permanente de clientes: permisos y conservación de pagos y caja", async () => {
  assert.equal(env.DB_NAME, "algym_test");
  const owner = await createUser("owner", `${namePrefix} OWNER`);
  const employee = await createUser("employee", `${namePrefix} EMPLOYEE`);
  const customer = await createUser("client", `${namePrefix} Cliente José`);
  const other = await createUser("client", `${namePrefix} Cliente Otro`);

  // Sesión y permisos.
  assert.equal((await request(app).delete(`/customers/${customer.userId}`)).status, 401);
  assert.equal((await request(app).delete(`/customers/${customer.userId}`)
    .set("Cookie", employee.cookie)).status, 403);
  assert.equal(adminSql(`SELECT count(*) FROM public.profiles WHERE id = '${customer.userId}'`), "1");
  assert.equal((await request(app).delete(`/customers/${randomUUID()}`)
    .set("Cookie", owner.cookie)).status, 404);
  assert.equal((await request(app).delete("/customers/no-es-uuid")
    .set("Cookie", owner.cookie)).status, 400);
  const notCustomer = await request(app).delete(`/customers/${employee.userId}`).set("Cookie", owner.cookie);
  assert.equal(notCustomer.status, 409, JSON.stringify(notCustomer.body));
  assert.equal(adminSql(`SELECT count(*) FROM public.profiles WHERE id = '${employee.userId}'`), "1");

  // Historial del cliente: membresía pagada en una caja ya cerrada, asistencia y rutina.
  const planId = adminSql(`INSERT INTO public.plans (name, duration_days, price, is_active)
    VALUES ('${namePrefix} PLAN', 30, 150, true) RETURNING id`);
  const subscriptionId = adminSql(`INSERT INTO public.subscriptions
      (user_id, plan_id, start_date, end_date, status, grace_days)
    VALUES ('${customer.userId}', ${planId}, CURRENT_DATE - 5, CURRENT_DATE + 25, 'active', 3)
    RETURNING id`);
  const paymentId = adminSql(`INSERT INTO public.payments
      (subscription_id, user_id, amount_original, discount_amount, amount_paid, method, payment_date, status)
    VALUES ('${subscriptionId}', '${customer.userId}', 150, 10, 140, 'cash', now(), 'posted')
    RETURNING id`);
  const registerId = adminSql(`INSERT INTO public.cash_registers (name, is_active)
    VALUES ('${namePrefix} REGISTER', true) RETURNING id`);
  const sessionId = adminSql(`INSERT INTO public.cash_sessions
      (session_number, cash_register_id, opened_by_user_id, opening_amount, status)
    VALUES ('ZZTEST-DEL-${randomUUID()}', '${registerId}', '${owner.userId}', 0, 'open')
    RETURNING id`);
  const movementId = adminSql(`INSERT INTO public.cash_movements
      (cash_session_id, movement_type, category, payment_method, amount, cash_effect_amount,
       session_link_status, origin, source_payment_id, source_subscription_id, customer_id,
       created_by_user_id, note)
    VALUES ('${sessionId}', 'sale', 'membership', 'cash', 140, 140, 'assigned', 'system',
            '${paymentId}', '${subscriptionId}', '${customer.userId}', '${owner.userId}',
            '${namePrefix} cobro')
    RETURNING id`);
  adminSql(`UPDATE public.cash_sessions SET status = 'closed' WHERE id = '${sessionId}'`);
  adminSql(`INSERT INTO public.access_logs (user_id, status) VALUES ('${customer.userId}', 'granted')`);
  const routineId = adminSql(`INSERT INTO public.routines
      (user_id, created_by, name, status, source, is_active, primary_goal)
    VALUES ('${customer.userId}', '${owner.userId}', '${namePrefix} rutina', 'active', 'admin', true, 'strength')
    RETURNING id`);
  adminSql(`INSERT INTO public.routine_details
      (routine_id, day_of_week, exercise_order, block_type, sets, reps, rest_seconds, target_rir, exercise_name_snapshot)
    VALUES ('${routineId}', 1, 1, 'strength', 3, '10', 60, 2, 'Sentadilla')`);

  const deleted = await request(app).delete(`/customers/${customer.userId}`).set("Cookie", owner.cookie);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, {
    id: customer.userId,
    full_name: `${namePrefix} Cliente José`,
    biometric_id: customer.biometricId,
  });

  // El cliente y sus datos propios ya no existen.
  for (const sql of [
    `SELECT count(*) FROM auth.users WHERE id = '${customer.userId}'`,
    `SELECT count(*) FROM public.profiles WHERE id = '${customer.userId}'`,
    `SELECT count(*) FROM public.subscriptions WHERE id = '${subscriptionId}'`,
    `SELECT count(*) FROM public.routines WHERE id = '${routineId}'`,
    `SELECT count(*) FROM public.routine_details WHERE routine_id = '${routineId}'`,
    `SELECT count(*) FROM public.access_logs WHERE user_id = '${customer.userId}'`,
  ]) {
    assert.equal(adminSql(sql), "0", sql);
  }

  // El pago y el movimiento de caja se conservan, con montos intactos y el nombre del cliente.
  assert.equal(adminSql(`SELECT concat_ws('|', user_id, subscription_id, amount_paid::text, status,
      deleted_customer_name, deleted_plan_name) FROM public.payments WHERE id = '${paymentId}'`),
  `140.00|posted|${namePrefix} Cliente José|${namePrefix} PLAN`);
  assert.equal(adminSql(`SELECT concat_ws('|', customer_id, source_subscription_id, source_payment_id,
      amount::text, deleted_customer_name) FROM public.cash_movements WHERE id = '${movementId}'`),
  `${paymentId}|140.00|${namePrefix} Cliente José`);
  assert.equal(adminSql(`SELECT user_name || '|' || plan_name FROM public.payments_overview
      WHERE id = '${paymentId}'`), `${namePrefix} Cliente José|${namePrefix} PLAN`);
  const listed = await request(app).get(`/payments/${paymentId}`).set("Cookie", owner.cookie);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.user_name, `${namePrefix} Cliente José`);

  // Un rol con customers.delete también puede eliminar.
  adminSql(`INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT role.id, permission.id FROM public.roles AS role
    JOIN public.permissions AS permission ON permission.key = 'customers.delete'
    WHERE role.slug = 'employee' ON CONFLICT DO NOTHING`);
  const byEmployee = await request(app).delete(`/customers/${other.userId}`).set("Cookie", employee.cookie);
  assert.equal(byEmployee.status, 200, JSON.stringify(byEmployee.body));
  assert.equal(adminSql(`SELECT count(*) FROM public.profiles WHERE id = '${other.userId}'`), "0");
});
