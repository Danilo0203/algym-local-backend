import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const domain = "@paid-membership.test.local";
const password = "PaidMembershipTest123";
const registerName = "ZZTEST PAID MEMBERSHIP REGISTER";
const planName = "ZZTEST PAID MEMBERSHIP PLAN";
const customRegisterName = "ZZTEST PAID MEMBERSHIP CUSTOM REGISTER";
const customPlanName = "ZZTEST PAID MEMBERSHIP CUSTOM PLAN";
const customRoleIds: string[] = [];

function adminSql(sql: string): string {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], {
    cwd: root, encoding: "utf8",
  }).trim();
}

async function createUser(role: "owner" | "admin" | "employee" | "client" | "custom", panelRoleId?: string) {
  const id = randomUUID();
  const email = `${id}${domain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`,
    [id, email, hash],
  );
  adminSql(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, gender, role, biometric_id, is_active, panel_role_id)
    VALUES ('${id}', 'ZZTEST PAID MEMBERSHIP ${role}', '55550000', DATE '1990-01-01',
      'male', '${role}', ${Math.floor(Math.random() * 1000000)}, true,
      ${panelRoleId ? `'${panelRoleId}'` : "NULL"})`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

before(() => {
  adminSql(`INSERT INTO public.permissions (key, description, module, action)
    VALUES ('cash.operate', 'Prueba de cobro local', 'cash', 'operate'),
           ('cash.reverse_payment', 'Prueba de reverso local', 'cash', 'reverse_payment')
    ON CONFLICT (key) DO NOTHING;
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
    WHERE (r.slug = 'employee' AND p.key = 'cash.operate')
       OR (r.slug = 'admin' AND p.key IN
         ('cash.operate', 'cash.reverse_payment', 'customers.manage_membership'))
    ON CONFLICT (role_id, permission_id) DO NOTHING;`);
});

after(async () => {
  adminSql(`DELETE FROM public.cash_movements
    WHERE customer_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}')
       OR created_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.routines
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.training_nutrition_snapshots
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.training_profiles
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.body_assessments
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.customer_health_profiles
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.payments
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.subscriptions
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_sessions
    WHERE opened_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_registers WHERE name IN ('${registerName}', '${customRegisterName}');
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.plans WHERE name IN ('${planName}', '${customPlanName}');
    DELETE FROM public.role_permissions WHERE role_id IN
      (SELECT id FROM public.roles WHERE id IN (${customRoleIds.length
        ? customRoleIds.map((id) => `'${id}'`).join(",") : "NULL"}));
    DELETE FROM public.roles WHERE id IN (${customRoleIds.length
      ? customRoleIds.map((id) => `'${id}'`).join(",") : "NULL"});`);
  await pool.query(`DELETE FROM auth.sessions WHERE user_id IN
    (SELECT id FROM auth.users WHERE email LIKE $1)`, [`%${domain}`]);
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${domain}`]);
  await pool.end();
});

test("cobro local exige autorización y guarda membresía, pago y caja juntos", async () => {
  const owner = await createUser("owner");
  const employee = await createUser("employee");
  const customer = await createUser("client");
  const planId = Number(adminSql(`INSERT INTO public.plans
    (name, duration_days, price, description, is_active)
    VALUES ('${planName}', 30, 125, 'Plan sintético', true) RETURNING id`));
  const input = {
    customerId: customer.id, planId, operation: "create", startDate: "2026-10-01",
    endDate: "2026-10-31", amountOriginal: 125, discountAmount: 5,
    amountPaid: 120, paymentMethod: "cash", requireSession: true,
  };

  assert.equal((await request(app).post("/payments/membership").send(input)).status, 401);
  assert.equal((await request(app).post("/payments/membership")
    .set("Cookie", customer.cookie).send(input)).status, 403);

  const noSession = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send(input);
  assert.equal(noSession.status, 409, JSON.stringify(noSession.body));
  assert.equal(noSession.body.error.code, "CASH_SESSION_REQUIRED");
  assert.equal(adminSql(`SELECT count(*) FROM public.subscriptions WHERE user_id = '${customer.id}'`), "0");
  assert.equal(adminSql(`SELECT count(*) FROM public.payments WHERE user_id = '${customer.id}'`), "0");
  assert.equal(adminSql(`SELECT count(*) FROM public.routines WHERE user_id = '${customer.id}'`), "0");

  const newCustomerEmail = `paid-${randomUUID()}${domain}`;
  const paidCustomerInput = {
    full_name: "ZZTEST PAID NEW CUSTOMER", phone: "55551234",
    birth_date: "1995-03-05", gender: "female", email: newCustomerEmail,
    paid_membership: {
      planId, amountOriginal: 125, discountAmount: 5, amountPaid: 120,
      paymentMethod: "cash", requireSession: true,
    },
    intake: {
      health_profile: {
        parq_requires_attention: true,
        injuries_or_pain: "Molestia de rodilla",
        diet_type: "normocalorica",
      },
      body_assessment: {
        weight_kg: 72,
        height_cm: 170,
        nutrition_snapshot: {
          body_type: "mesomorph", diet_type: "normocalorica", activity_level: "1_3_dias",
        },
      },
      training_profile: {
        primary_goal: "strength",
        focus_areas: ["lower_body"],
        days_per_week: 3,
        training_location: "gym",
      },
    },
  };
  const newCustomerWithoutSession = await request(app).post("/customers")
    .set("Cookie", employee.cookie).send(paidCustomerInput);
  assert.equal(newCustomerWithoutSession.status, 409, JSON.stringify(newCustomerWithoutSession.body));
  assert.equal(adminSql(`SELECT count(*) FROM auth.users WHERE email = '${newCustomerEmail}'`), "0");

  const registerId = adminSql(`INSERT INTO public.cash_registers (name, is_active)
    VALUES ('${registerName}', true) RETURNING id`);
  const opened = await request(app).post("/cash/sessions").set("Cookie", employee.cookie)
    .send({ registerId, openingAmount: 50 });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));

  const created = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send(input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.amount_paid, 120);
  assert.equal(created.body.session_link_status, "assigned");
  assert.equal(adminSql(`SELECT count(*) FROM public.subscriptions WHERE user_id = '${customer.id}'`), "1");
  assert.equal(adminSql(`SELECT amount_paid::text FROM public.payments WHERE id = '${created.body.payment_id}'`), "120.00");
  assert.equal(adminSql(`SELECT cash_effect_amount::text FROM public.cash_movements
    WHERE id = '${created.body.cash_movement_id}'`), "120.00");
  assert.equal(adminSql(`SELECT count(*) FROM public.routines WHERE user_id = '${customer.id}'
    AND status = 'pending_profile' AND source = 'system' AND created_by = '${employee.id}'`), "1");
  await assert.rejects(
    withUserTransaction(customer.id, (client) => client.query(
      `SELECT private.create_pending_routine_for_cash_payment($1::uuid)`,
      [created.body.payment_id],
    )),
    /No autorizado para preparar la rutina del cobro/,
  );
  await assert.rejects(
    withUserTransaction(employee.id, (client) => client.query(
      `SELECT private.create_pending_routine_for_cash_payment($1::uuid)`,
      [randomUUID()],
    )),
    /No se encontró un cobro en caja válido/,
  );

  const dashboard = await request(app).get("/cash/dashboard").set("Cookie", employee.cookie);
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
  assert.equal(dashboard.body.summary.expectedAmount, 170);
  const duplicate = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send(input);
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));

  const renewal = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send({
      customerId: customer.id, planId, operation: "renew", paymentMethod: "card",
      requireSession: true,
    });
  assert.equal(renewal.status, 201, JSON.stringify(renewal.body));
  assert.equal(adminSql(`SELECT status::text FROM public.subscriptions
    WHERE id = '${created.body.subscription_id}'`), "expired");
  assert.equal(adminSql(`SELECT start_date::text FROM public.subscriptions
    WHERE id = '${renewal.body.subscription_id}'`), "2026-11-01");
  assert.equal(adminSql(`SELECT cash_effect_amount::text FROM public.cash_movements
    WHERE id = '${renewal.body.cash_movement_id}'`), "0.00");
  const afterRenewal = await request(app).get("/cash/dashboard").set("Cookie", employee.cookie);
  assert.equal(afterRenewal.body.summary.expectedAmount, 170);
  assert.equal(adminSql(`SELECT count(*) FROM public.payments WHERE user_id = '${customer.id}'`), "2");
  assert.equal(adminSql(`SELECT count(*) FROM public.routines WHERE user_id = '${customer.id}'
    AND status = 'pending_profile'`), "1");
  assert.equal(adminSql(`SELECT count(*) FROM public.routines WHERE user_id = '${customer.id}'
    AND status = 'archived'`), "1");

  const paidCustomer = await request(app).post("/customers")
    .set("Cookie", employee.cookie).send(paidCustomerInput);
  assert.equal(paidCustomer.status, 201, JSON.stringify(paidCustomer.body));
  assert.equal(paidCustomer.body.current_membership.plan_id, planId);
  assert.equal(adminSql(`SELECT count(*) FROM public.payments
    WHERE user_id = '${paidCustomer.body.id}' AND status = 'posted'`), "1");
  assert.equal(adminSql(`SELECT count(*) FROM public.cash_movements
    WHERE customer_id = '${paidCustomer.body.id}' AND cash_session_id = '${opened.body.id}'`), "1");
  assert.equal(adminSql(`SELECT count(*) FROM public.routines WHERE user_id = '${paidCustomer.body.id}'
    AND status = 'pending_profile' AND created_by = '${employee.id}'`), "1");
  assert.equal(adminSql(`SELECT injuries_or_pain FROM public.customer_health_profiles
    WHERE user_id = '${paidCustomer.body.id}'`), "Molestia de rodilla");
  assert.equal(adminSql(`SELECT weight_kg FROM public.body_assessments
    WHERE user_id = '${paidCustomer.body.id}'`), "72.00");
  assert.equal(adminSql(`SELECT primary_goal FROM public.training_profiles
    WHERE user_id = '${paidCustomer.body.id}'`), "strength");
  assert.equal(adminSql(`SELECT is_complete::text FROM public.training_profiles
    WHERE user_id = '${paidCustomer.body.id}'`), "false");
  assert.equal(adminSql(`SELECT training_profile_status FROM public.profiles
    WHERE id = '${paidCustomer.body.id}'`), "pending");
  assert.equal(adminSql(`SELECT count(*) FROM public.training_nutrition_snapshots AS snapshot
    JOIN public.body_assessments AS assessment ON assessment.user_id = snapshot.user_id
    JOIN public.subscriptions AS subscription ON subscription.id = snapshot.subscription_id
    WHERE snapshot.user_id = '${paidCustomer.body.id}' AND snapshot.source_event = 'signup'
      AND snapshot.daily_calories = assessment.daily_calories
      AND snapshot.protein_grams = assessment.protein_grams
      AND subscription.plan_id = ${planId}`), "1");
  const readyCustomer = await request(app).post("/customers")
    .set("Cookie", employee.cookie).send({
      ...paidCustomerInput,
      email: `ready-${randomUUID()}${domain}`,
      phone: "55551235",
      intake: {
        ...paidCustomerInput.intake,
        training_profile: {
          ...paidCustomerInput.intake.training_profile,
          parq_requires_attention: false,
          experience_level: "intermediate",
          session_minutes: 60,
          activity_level: "3_5_dias",
          cardio_preference: "moderate",
        },
      },
    });
  assert.equal(readyCustomer.status, 201, JSON.stringify(readyCustomer.body));
  assert.equal(adminSql(`SELECT is_complete::text FROM public.training_profiles
    WHERE user_id = '${readyCustomer.body.id}'`), "true");
  assert.equal(adminSql(`SELECT training_profile_status FROM public.profiles
    WHERE id = '${readyCustomer.body.id}'`), "complete");
  await assert.rejects(
    withUserTransaction(employee.id, (client) => client.query(
      `INSERT INTO public.customer_health_profiles (user_id, injuries_or_pain)
       VALUES ($1, 'No autorizado')`,
      [customer.id],
    )),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "42501"),
  );
  const paidCustomerRenewal = await request(app).post("/payments/membership")
    .set("Cookie", employee.cookie).send({
      customerId: paidCustomer.body.id,
      planId,
      operation: "renew",
      amountOriginal: 125,
      amountPaid: 125,
      paymentMethod: "card",
      requireSession: true,
      intake: {
        profile_update: { injuries: "Rodilla sensible", medical_notes: "Sin restricción médica" },
        health_profile: { injuries_or_pain: "Molestia leve de rodilla" },
        body_assessment: {
          weight_kg: 71,
          height_cm: 170,
          nutrition_snapshot: {
            body_type: "mesomorph", diet_type: "normocalorica", activity_level: "1_3_dias",
          },
        },
        training_profile: { primary_goal: "general_fitness", days_per_week: 4 },
      },
    });
  assert.equal(paidCustomerRenewal.status, 201, JSON.stringify(paidCustomerRenewal.body));
  assert.equal(adminSql(`SELECT injuries FROM public.profiles
    WHERE id = '${paidCustomer.body.id}'`), "Rodilla sensible");
  assert.equal(adminSql(`SELECT injuries_or_pain FROM public.customer_health_profiles
    WHERE user_id = '${paidCustomer.body.id}'`), "Molestia leve de rodilla");
  assert.equal(adminSql(`SELECT primary_goal FROM public.training_profiles
    WHERE user_id = '${paidCustomer.body.id}'`), "general_fitness");
  assert.equal(adminSql(`SELECT count(*) FROM public.training_nutrition_snapshots
    WHERE user_id = '${paidCustomer.body.id}' AND source_event = 'renewal'
      AND subscription_id = '${paidCustomerRenewal.body.subscription_id}'`), "1");
  const unauthorizedUpdate = await withUserTransaction(employee.id, (client) => client.query(
    `UPDATE public.customer_health_profiles
     SET injuries_or_pain = 'No autorizado' WHERE user_id = $1`,
    [paidCustomer.body.id],
  ));
  assert.equal(unauthorizedUpdate.rowCount, 0);
  const failedEmail = `failed-${randomUUID()}${domain}`;
  const failedPayment = await request(app).post("/customers")
    .set("Cookie", employee.cookie).send({
      ...paidCustomerInput,
      email: failedEmail,
      paid_membership: { ...paidCustomerInput.paid_membership, amountPaid: 0 },
    });
  assert.equal(failedPayment.status, 400, JSON.stringify(failedPayment.body));
  assert.equal(adminSql(`SELECT count(*) FROM auth.users WHERE email = '${failedEmail}'`), "0");

  const ownerView = await request(app).get("/cash/sessions?status=open")
    .set("Cookie", owner.cookie);
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.body.sessions.some((session: { id: string }) => session.id === opened.body.id), true);

  const secondCustomer = await createUser("client");
  const ownerPayment = await request(app).post("/payments/membership")
    .set("Cookie", owner.cookie).send({
      customerId: secondCustomer.id, planId, operation: "create", requireSession: false,
    });
  assert.equal(ownerPayment.status, 201, JSON.stringify(ownerPayment.body));
  assert.equal(ownerPayment.body.session_link_status, "out_of_session");

  const ownerSession = await request(app).post("/cash/sessions").set("Cookie", owner.cookie)
    .send({ registerId, openingAmount: 20 });
  assert.equal(ownerSession.status, 201, JSON.stringify(ownerSession.body));
  const correctionCustomer = await createUser("client");
  const original = await request(app).post("/payments/membership")
    .set("Cookie", owner.cookie).send({
      customerId: correctionCustomer.id, planId, operation: "create", requireSession: true,
    });
  assert.equal(original.status, 201, JSON.stringify(original.body));
  const paymentId = original.body.payment_id as string;

  assert.equal((await request(app).get(`/payments/${paymentId}/reversal-context`)).status, 401);
  const context = await request(app).get(`/payments/${paymentId}/reversal-context`)
    .set("Cookie", owner.cookie);
  assert.equal(context.status, 200, JSON.stringify(context.body));
  assert.equal(context.body.amount_original, 125);
  assert.equal(context.body.status, "posted");
  const correctionInput = {
    amountOriginal: 125, discountAmount: 5, amountPaid: 100,
    paymentMethod: "cash", reason: "Corrección de precio", sourceCategory: "membership",
    note: "Descuento autorizado",
  };
  assert.equal((await request(app).post(`/payments/${paymentId}/reverse`)
    .set("Cookie", employee.cookie).send(correctionInput)).status, 403);
  const corrected = await request(app).post(`/payments/${paymentId}/reverse`)
    .set("Cookie", owner.cookie).send(correctionInput);
  assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
  assert.equal(adminSql(`SELECT status FROM public.payments WHERE id = '${paymentId}'`), "reversed");
  assert.equal(adminSql(`SELECT amount_paid::text FROM public.payments
    WHERE id = '${corrected.body.replacement_payment_id}'`), "100.00");
  assert.equal(adminSql(`SELECT count(*) FROM public.cash_movements
    WHERE customer_id = '${correctionCustomer.id}'`), "3");
  assert.equal(adminSql(`SELECT cash_effect_amount::text FROM public.cash_movements
    WHERE id = '${corrected.body.reversal_movement_id}'`), "-125.00");
  const ownerAfterCorrection = await request(app).get("/cash/dashboard").set("Cookie", owner.cookie);
  assert.equal(ownerAfterCorrection.status, 200);
  assert.equal(ownerAfterCorrection.body.summary.expectedAmount, 120);
  const repeatedCorrection = await request(app).post(`/payments/${paymentId}/reverse`)
    .set("Cookie", owner.cookie).send(correctionInput);
  assert.equal(repeatedCorrection.status, 409, JSON.stringify(repeatedCorrection.body));
  assert.equal(adminSql(`SELECT count(*) FROM public.payments
    WHERE user_id = '${correctionCustomer.id}'`), "2");

  const admin = await createUser("admin");
  const adminCustomer = await createUser("client");
  const adminSession = await request(app).post("/cash/sessions").set("Cookie", admin.cookie)
    .send({ registerId, openingAmount: 0 });
  assert.equal(adminSession.status, 201, JSON.stringify(adminSession.body));
  const adminOriginal = await request(app).post("/payments/membership")
    .set("Cookie", admin.cookie).send({
      customerId: adminCustomer.id, planId, operation: "create", requireSession: true,
    });
  assert.equal(adminOriginal.status, 201, JSON.stringify(adminOriginal.body));
  const adminCorrection = await request(app).post(`/payments/${adminOriginal.body.payment_id}/reverse`)
    .set("Cookie", admin.cookie).send(correctionInput);
  assert.equal(adminCorrection.status, 201, JSON.stringify(adminCorrection.body));
  const adminDashboard = await request(app).get("/cash/dashboard").set("Cookie", admin.cookie);
  assert.equal(adminDashboard.body.summary.expectedAmount, 100);
});

test("rol personalizado opera su caja y cobra solo con ambos permisos", async () => {
  const roleId = randomUUID();
  customRoleIds.push(roleId);
  adminSql(`INSERT INTO public.roles (id, slug, name, scope, is_system)
    VALUES ('${roleId}', 'zz_cash_${roleId.slice(0, 8)}', 'ZZTEST Cajero limitado', 'panel', false);
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT '${roleId}', id FROM public.permissions WHERE key = 'cash.operate';`);
  const cashier = await createUser("custom", roleId);
  const customer = await createUser("client");
  const registerId = adminSql(`INSERT INTO public.cash_registers (name, is_active)
    VALUES ('${customRegisterName}', true) RETURNING id`);
  const planId = Number(adminSql(`INSERT INTO public.plans
    (name, duration_days, price, is_active)
    VALUES ('${customPlanName}', 30, 125, true) RETURNING id`));
  const input = {
    customerId: customer.id, planId, operation: "create", startDate: "2026-10-01",
    endDate: "2026-10-31", amountOriginal: 125, discountAmount: 5,
    amountPaid: 120, paymentMethod: "cash", requireSession: true,
  };

  assert.equal((await request(app).get("/customers").set("Cookie", cashier.cookie)).status, 403);
  assert.equal((await request(app).get("/payments").set("Cookie", cashier.cookie)).status, 403);
  assert.equal((await request(app).post("/cash/registers/default")
    .set("Cookie", cashier.cookie)).status, 403);
  const opened = await request(app).post("/cash/sessions")
    .set("Cookie", cashier.cookie).send({ registerId, openingAmount: 20 });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const movement = await request(app).post(`/cash/sessions/${opened.body.id}/movements`)
    .set("Cookie", cashier.cookie)
    .send({ movementType: "manual_income", amount: 3, note: "Ingreso de prueba" });
  assert.equal(movement.status, 201, JSON.stringify(movement.body));
  const denied = await request(app).post("/payments/membership")
    .set("Cookie", cashier.cookie).send(input);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(adminSql(`SELECT count(*) FROM public.payments WHERE user_id = '${customer.id}'`), "0");

  adminSql(`INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT '${roleId}', id FROM public.permissions
    WHERE key = 'customers.manage_membership';`);
  const newLogin = await request(app).post("/auth/login")
    .send({ email: `${cashier.id}${domain}`, password });
  assert.equal(newLogin.status, 200);
  const authorizedCookie = newLogin.headers["set-cookie"]?.[0];
  assert.ok(authorizedCookie);
  const paid = await request(app).post("/payments/membership")
    .set("Cookie", authorizedCookie).send(input);
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal(adminSql(`SELECT amount_paid::text FROM public.payments
    WHERE id = '${paid.body.payment_id}'`), "120.00");
  assert.equal(adminSql(`SELECT cash_effect_amount::text FROM public.cash_movements
    WHERE id = '${paid.body.cash_movement_id}'`), "120.00");
  assert.equal((await request(app).get("/customers")
    .set("Cookie", authorizedCookie)).status, 403);
  assert.equal((await request(app).get("/payments")
    .set("Cookie", authorizedCookie)).status, 403);
  assert.equal((await request(app).post(`/payments/${paid.body.payment_id}/reverse`)
    .set("Cookie", authorizedCookie).send({
      amountOriginal: 125, discountAmount: 5, amountPaid: 120,
      paymentMethod: "cash", reason: "Sin permiso", sourceCategory: "membership",
    })).status, 403);
});
