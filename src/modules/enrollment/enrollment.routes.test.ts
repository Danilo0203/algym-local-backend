import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test, { before, after } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { app } from "../../app.js";
import { pool } from "../../db/pool.js";

const domain = "@annual-enrollment.test.local";
const password = "SyntheticEnrollment123";
function sql(value: string) {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt"], { input: value, encoding: "utf8" }).trim();
}
let owner: { id: string; cookie: string };
let cashier: { id: string; cookie: string };
let client: { id: string; cookie: string };
let planId: number;
let year: number;
async function user(role: string) {
  const id = randomUUID();
  const email = `${id}${domain}`;
  await pool.query(`INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
    VALUES ($1, $2, $3, '{}'::jsonb, now(), now())`, [id, email, await bcrypt.hash(password, 4)]);
  sql(`INSERT INTO public.profiles (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES ('${id}', 'ZZTEST ENROLLMENT ${role}', '55550000', '1990-01-01', 'male', '${role}', ${Math.floor(Math.random() * 1e8)}, true);`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { id, cookie: login.headers["set-cookie"]![0]! };
}
function api(method: "get" | "post" | "put" | "delete", path: string, actor = owner) {
  return request(app)[method](path).set("Cookie", actor.cookie);
}
async function newCustomer(paid = false, enrollment?: { year: number; fee: number }) {
  const response = await api("post", "/customers").send({
    full_name: "ZZTEST ENROLLMENT CUSTOMER", phone: "55551234", birth_date: "1995-03-05", gender: "female",
    email: `${randomUUID()}${domain}`,
    ...(paid && { paid_membership: { planId, amountOriginal: 150, amountPaid: 150, requireSession: true, enrollment } }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.id as string;
}
before(async () => {
  assert.equal(process.env.DB_NAME, "algym_test");
  sql(`INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p
    WHERE r.slug='employee' AND p.key IN ('cash.operate','customers.manage_membership') ON CONFLICT DO NOTHING`);
  owner = await user("owner"); cashier = await user("employee"); client = await user("client");
  year = Number(sql("SELECT extract(year FROM now() AT TIME ZONE 'America/Guatemala')::int"));
  planId = Number(sql("INSERT INTO public.plans (name, price, duration_days, is_active) VALUES ('ZZTEST ENROLLMENT PLAN',150,31,true) RETURNING id"));
  const registerId = sql("INSERT INTO public.cash_registers (name, is_active) VALUES ('ZZTEST ENROLLMENT REGISTER',true) RETURNING id");
  const opened = await api("post", "/cash/sessions").send({ registerId, openingAmount: 0 });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
});

test("alta Q200, dos conceptos, un cobro; renovación y ausencia mantienen inscripción", async () => {
  const id = await newCustomer(true, { year, fee: 50 });
  assert.equal(sql(`SELECT sum(amount_paid) || ':' || count(DISTINCT collection_id) FROM public.payments WHERE user_id='${id}'`), "200.00:1");
  const state = await api("get", `/enrollment/${id}`);
  assert.equal(state.body.status, "paid"); assert.equal(state.body.amount, 50);
  assert.equal(sql(`SELECT string_agg(category, ',' ORDER BY category) FROM public.cash_movements WHERE customer_id='${id}'`), "enrollment,membership");
  sql(`UPDATE public.subscriptions SET status='expired', start_date=CURRENT_DATE-90, end_date=CURRENT_DATE-60 WHERE user_id='${id}'`);
  assert.equal((await api("get", `/enrollment/${id}`)).body.status, "paid");
  const renewal = await api("post", "/payments/membership").send({ customerId:id, planId, operation:"renew", requireSession:true });
  assert.equal(renewal.status, 201, JSON.stringify(renewal.body));
  assert.equal(renewal.body.total_paid,150); assert.equal(renewal.body.enrollment,null);
  const duplicate = await api("post", "/payments/membership").send({ customerId:id, planId, operation:"renew", requireSession:true, enrollment:{year,fee:50} });
  assert.equal(duplicate.status,409);
  assert.equal(sql(`SELECT count(*) FROM public.subscriptions WHERE user_id='${id}'`),"2");
  const dashboard = await api("get", "/cash/dashboard");
  assert.equal(dashboard.status,200);
  assert.equal(dashboard.body.summary.salesCount,2);
});

test("inscripción posterior independiente y dos solicitudes simultáneas", async () => {
  const id = await newCustomer(true);
  assert.equal((await api("get", `/enrollment/${id}`)).body.status,"pending");
  const before = sql(`SELECT id || ':' || start_date || ':' || end_date FROM public.subscriptions WHERE user_id='${id}'`);
  const results = await Promise.all([0,1].map(() => api("post", `/enrollment/${id}/collect`).send({ year,fee:50,paymentMethod:"cash" })));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal(sql(`SELECT id || ':' || start_date || ':' || end_date FROM public.subscriptions WHERE user_id='${id}'`),before);
  assert.equal(sql(`SELECT count(*) FROM public.payments WHERE user_id='${id}' AND payment_kind='enrollment'`),"1");
});

test("revisión individual reconoce pago anterior sin ingreso; cajero no acredita ni cambia tarifa", async () => {
  const id=await newCustomer();
  sql(`INSERT INTO public.customer_enrollments (customer_id,year,status) VALUES ('${id}',${year},'needs_review')`);
  assert.equal((await api("get",`/enrollment/${id}`)).body.status,"needs_review");
  assert.equal((await api("post",`/enrollment/${id}/collect`).send({year,fee:50,paymentMethod:"cash"})).status,409);
  assert.equal((await api("post",`/enrollment/${id}/review`,cashier).send({year,status:"recognized",reason:"Recibo previo"})).status,403);
  assert.equal((await api("put","/enrollment/settings",cashier).send({fee:70})).status,403);
  const reviewed=await api("post",`/enrollment/${id}/review`).send({year,status:"recognized",reason:"Recibo previo verificado"});
  assert.equal(reviewed.status,200,JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.status,"recognized");
  assert.equal(sql(`SELECT count(*) FROM public.payments WHERE user_id='${id}'`),"0");
  assert.equal((await api("get",`/enrollment/${id}`,client)).status,403);
});

test("tarifa/año desactualizados y caja cerrada no dejan cobros parciales", async () => {
  assert.equal((await api("put","/enrollment/settings").send({fee:60})).status,200);
  const id=await newCustomer();
  for (const quote of [{year,fee:50},{year:year-1,fee:60}]) {
    const result=await api("post","/payments/membership").send({customerId:id,planId,operation:"create",requireSession:true,enrollment:quote});
    assert.equal(result.status,409,JSON.stringify(result.body));
    assert.equal(sql(`SELECT count(*) FROM public.payments WHERE user_id='${id}'`),"0");
    assert.equal(sql(`SELECT count(*) FROM public.subscriptions WHERE user_id='${id}'`),"0");
  }
  const noSession=await api("post",`/enrollment/${id}/collect`,cashier).send({year,fee:60,paymentMethod:"cash"});
  assert.equal(noSession.status,409,JSON.stringify(noSession.body));
  const valid=await api("post","/payments/membership").send({customerId:id,planId,operation:"create",requireSession:true,amountOriginal:300,discountAmount:30,amountPaid:270,enrollment:{year,fee:60}});
  assert.equal(valid.status,201,JSON.stringify(valid.body)); assert.equal(valid.body.total_paid,330);
  assert.equal((await api("get",`/enrollment/${id}`)).body.amount,60);
  await api("put","/enrollment/settings").send({fee:50});
  assert.equal((await api("get",`/enrollment/${id}`)).body.amount,60);
});

test("inscripción del año anterior queda pendiente; corrección conserva año y concepto", async () => {
  const id=await newCustomer();
  sql(`INSERT INTO public.customer_enrollments (customer_id,year,status,recorded_by,reason) VALUES ('${id}',${year-1},'recognized','${owner.id}','Año anterior')`);
  assert.equal((await api("get",`/enrollment/${id}`)).body.status,"pending");
  const paid=await api("post",`/enrollment/${id}/collect`).send({year,fee:50,paymentMethod:"cash"});
  assert.equal(paid.status,201,JSON.stringify(paid.body));
  const corrected=await api("post",`/payments/${paid.body.payment_id}/reverse`).send({amountOriginal:50,discountAmount:0,amountPaid:50,paymentMethod:"transfer",sourceCategory:"membership",reason:"Método corregido"});
  assert.equal(corrected.status,201,JSON.stringify(corrected.body));
  assert.equal((await api("get",`/enrollment/${id}`)).body.status,"paid");
  assert.equal(sql(`SELECT payment_kind || ':' || enrollment_year FROM public.payments WHERE id='${corrected.body.replacement_payment_id}'`),`enrollment:${year}`);
  assert.equal(sql(`SELECT payment_id FROM public.customer_enrollments WHERE customer_id='${id}' AND year=${year}`),corrected.body.replacement_payment_id);
  const detail=await api("get",`/payments/${corrected.body.replacement_payment_id}`);
  assert.equal(detail.body.source_category,"enrollment"); assert.equal(detail.body.plan_name,`Inscripción ${year}`);
});

test("alta pendiente no inscribe hasta cobrar ambos conceptos", async () => {
  const created=await api("post","/customers").send({full_name:"ZZTEST ENROLLMENT PENDING",phone:"55553333",birth_date:"1990-01-01",gender:"male",email:`${randomUUID()}${domain}`,membership:{plan_id:planId,cycles:1}});
  assert.equal(created.status,201,JSON.stringify(created.body)); const id=created.body.id;
  const membershipId=sql(`SELECT id FROM public.subscriptions WHERE user_id='${id}'`);
  assert.equal((await api("get",`/enrollment/${id}`)).body.status,"pending");
  const paid=await api("post",`/payments/membership/pending/${membershipId}/collect`).send({discountAmount:10,paymentMethod:"cash",enrollment:{year,fee:50}});
  assert.equal(paid.status,201,JSON.stringify(paid.body)); assert.equal(paid.body.total_paid,190);
  assert.equal((await api("get",`/enrollment/${id}`)).body.status,"paid");
});

after(async () => {
  sql(`DELETE FROM public.enrollment_audit WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    UPDATE public.enrollment_settings SET fee=50, updated_by=NULL;
    DELETE FROM public.customer_enrollments WHERE customer_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_movements WHERE created_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.routines WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.training_nutrition_snapshots WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.training_profiles WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.body_assessments WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.customer_health_profiles WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.payments WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.subscriptions WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_sessions WHERE opened_by_user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM public.cash_registers WHERE name='ZZTEST ENROLLMENT REGISTER';
    DELETE FROM public.plans WHERE name='ZZTEST ENROLLMENT PLAN';
    DELETE FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${domain}');
    DELETE FROM auth.users WHERE email LIKE '%${domain}';`);
  await pool.end();
});
