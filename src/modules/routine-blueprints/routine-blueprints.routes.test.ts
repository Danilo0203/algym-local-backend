import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import request from "supertest";

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testEmailDomain = "@routine-blueprints.test.local";
const password = "PasswordDePrueba123";

function adminSql(sql: string): string {
  return execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], {
    cwd: projectRoot, encoding: "utf8",
  }).trim();
}

async function createUser(role: "owner" | "client" | "employee") {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(`
    INSERT INTO auth.users
      (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
    VALUES ($1, $2, $3, '{}'::jsonb, now(), now())
  `, [userId, email, hash]);
  adminSql(`
    INSERT INTO public.profiles
      (id, full_name, phone, birth_date, gender, role, biometric_id, is_active)
    VALUES ('${userId}', 'ZZTEST BLUEPRINT ${role}', '55540000', DATE '1990-01-01',
            'male', '${role}', ${Math.floor(Math.random() * 1_000_000) + 4_000_000}, true)
  `);
  const response = await request(app).post("/auth/login").send({ email, password });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { userId, cookie };
}

after(async () => {
  adminSql(`
    DELETE FROM public.routine_blueprint_assignments
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.routine_blueprints
    WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.routines
    WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}');
    DELETE FROM public.exercises WHERE name LIKE 'ZZTEST BLUEPRINT EXERCISE %';
    DELETE FROM public.profiles
    WHERE id IN (SELECT id FROM auth.users WHERE email LIKE '%${testEmailDomain}')
  `);
  await pool.query(`DELETE FROM auth.sessions WHERE user_id IN
    (SELECT id FROM auth.users WHERE email LIKE $1)`, [`%${testEmailDomain}`]);
  await pool.query("DELETE FROM auth.users WHERE email LIKE $1", [`%${testEmailDomain}`]);
  adminSql(`
    DELETE FROM public.role_permissions AS role_permission
    USING public.roles AS role, public.permissions AS permission
    WHERE role_permission.role_id = role.id
      AND role_permission.permission_id = permission.id
      AND role.slug = 'employee'
      AND permission.key IN ('routines.manage_blueprints', 'routines.view');
  `);
  await pool.end();
});

test("plantillas locales: permisos, creación, asignación atómica y consulta", async () => {
  assert.equal(env.DB_NAME, "algym_test");
  assert.equal((await request(app).get("/routine-blueprints")).status, 401);
  const owner = await createUser("owner");
  const customer = await createUser("client");
  assert.equal((await request(app).get("/routine-blueprints").set("Cookie", customer.cookie)).status, 403);
  adminSql(`
    INSERT INTO public.permissions (key, description, module, action)
    VALUES ('routines.view', 'Ver y administrar plantillas', 'routines', 'view')
    ON CONFLICT (key) DO NOTHING;
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT role.id, permission.id FROM public.roles AS role
    JOIN public.permissions AS permission ON permission.key = 'routines.view'
    WHERE role.slug = 'employee'
    ON CONFLICT DO NOTHING
  `);
  const employee = await createUser("employee");

  const exerciseId = Number(adminSql(`
    INSERT INTO public.exercises (slug, name, provider, is_active)
    VALUES ('zztest-blueprint-${randomUUID()}', 'ZZTEST BLUEPRINT EXERCISE ${randomUUID()}',
            'custom_local', true) RETURNING id
  `));
  assert.ok(exerciseId > 0);
  const body = {
    title: "ZZTEST PLANTILLA LOCAL", primary_goal: "strength", secondary_goal: null,
    days: [{ exercises: [{
      exercise_id: exerciseId, block_type: "strength", sets: 3, reps: "8-10",
      rest_seconds: 90, duration_minutes: null, target_rir: 2,
    }] }],
  };

  const invalid = await request(app).post("/routine-blueprints").set("Cookie", owner.cookie)
    .send({ ...body, days: [{ exercises: [{ ...body.days[0]!.exercises[0]!, exercise_id: 999999999 }] }] });
  assert.ok(invalid.status >= 400);
  assert.equal(adminSql(`SELECT count(*) FROM public.routine_blueprints WHERE name = 'ZZTEST PLANTILLA LOCAL'`), "0");

  const created = await request(app).post("/routine-blueprints").set("Cookie", owner.cookie).send(body);
  assert.equal(created.status, 201);
  const blueprintId = created.body.blueprintId as string;
  assert.ok(blueprintId);
  const list = await request(app).get("/routine-blueprints").set("Cookie", owner.cookie);
  assert.equal(list.status, 200);
  const listed = list.body.data.find((item: { id: string }) => item.id === blueprintId);
  assert.equal(listed.day_count, 1);
  assert.equal(listed.exercise_count, 1);
  assert.equal((await request(app).get("/routine-blueprints").set("Cookie", employee.cookie)).status, 200);
  assert.equal((await request(app).get(`/routine-blueprints/${blueprintId}`)
    .set("Cookie", employee.cookie)).status, 200);
  assert.equal((await request(app).get("/routine-blueprints/clients?query=ZZTEST")
    .set("Cookie", employee.cookie)).status, 403);
  assert.equal((await request(app).post("/routine-blueprints")
    .set("Cookie", employee.cookie).send(body)).status, 403);
  assert.equal((await request(app).patch(`/routine-blueprints/${blueprintId}`)
    .set("Cookie", employee.cookie).send({ name: "No autorizado" })).status, 403);
  assert.equal((await request(app).put(`/routine-blueprints/${blueprintId}`).send(body)).status, 401);
  assert.equal((await request(app).put(`/routine-blueprints/${blueprintId}`)
    .set("Cookie", customer.cookie).send(body)).status, 403);
  assert.equal((await request(app).put(`/routine-blueprints/${blueprintId}`)
    .set("Cookie", employee.cookie).send(body)).status, 403);
  assert.equal((await request(app).post(`/routine-blueprints/${blueprintId}/assign`)
    .set("Cookie", employee.cookie).send({ userId: customer.userId })).status, 403);
  const directWrite = await withUserTransaction(employee.userId, (client) =>
    client.query("UPDATE public.routine_blueprints SET name = $2 WHERE id = $1", [blueprintId, "No autorizado"]),
  );
  assert.equal(directWrite.rowCount, 0);
  adminSql(`
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT role.id, permission.id FROM public.roles AS role
    JOIN public.permissions AS permission ON permission.key = 'routines.manage_blueprints'
    WHERE role.slug = 'employee'
    ON CONFLICT DO NOTHING
  `);

  const first = await request(app).post(`/routine-blueprints/${blueprintId}/assign`)
    .set("Cookie", employee.cookie).send({ userId: customer.userId });
  assert.equal(first.status, 201);
  const firstRoutineId = first.body.routineId as string;
  const second = await request(app).post(`/routine-blueprints/${blueprintId}/assign`)
    .set("Cookie", owner.cookie).send({ userId: customer.userId });
  assert.equal(second.status, 201);
  assert.equal(adminSql(`SELECT status FROM public.routines WHERE id = '${firstRoutineId}'`), "archived");
  assert.equal(adminSql(`SELECT count(*) FROM public.routine_details WHERE routine_id = '${second.body.routineId}'`), "1");

  const renamed = await request(app).patch(`/routine-blueprints/${blueprintId}`)
    .set("Cookie", owner.cookie).send({ name: "ZZTEST PLANTILLA RENOMBRADA" });
  assert.equal(renamed.status, 200);
  const detail = await request(app).get(`/routine-blueprints/${blueprintId}`).set("Cookie", owner.cookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.blueprint.name, "ZZTEST PLANTILLA RENOMBRADA");
  assert.equal(detail.body.details[0].exercise_id, exerciseId);
  assert.equal(detail.body.assignments.length, 1);

  const replacementId = Number(adminSql(`
    INSERT INTO public.exercises (slug, name, provider, is_active)
    VALUES ('zztest-blueprint-${randomUUID()}', 'ZZTEST BLUEPRINT EXERCISE ${randomUUID()}',
            'custom_local', true) RETURNING id
  `));
  const originalRoutine = adminSql(`SELECT row_to_json(r)::text FROM public.routines r WHERE id = '${second.body.routineId}'`);
  const originalDetails = adminSql(`SELECT json_agg(d ORDER BY d.id)::text FROM public.routine_details d WHERE routine_id = '${second.body.routineId}'`);
  const updatedExercise = { ...body.days[0]!.exercises[0]!, exercise_id: replacementId,
    sets: 4, reps: "12-15", rest_seconds: 0, duration_minutes: 0, target_rir: 0, notes: "Conservar técnica" };
  const updatedBody = { ...body, title: "ZZTEST PLANTILLA EDITADA", secondary_goal: "mobility",
    days: [{ exercises: [updatedExercise, body.days[0]!.exercises[0]!] }, { exercises: [updatedExercise] }] };
  const updated = await request(app).put(`/routine-blueprints/${blueprintId}`)
    .set("Cookie", employee.cookie).send(updatedBody);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.blueprintId, blueprintId);
  const afterEdit = await request(app).get(`/routine-blueprints/${blueprintId}`).set("Cookie", owner.cookie);
  assert.equal(afterEdit.body.blueprint.name, updatedBody.title);
  assert.equal(afterEdit.body.blueprint.secondary_goal, "mobility");
  assert.equal(afterEdit.body.blueprint.created_by, detail.body.blueprint.created_by);
  assert.equal(afterEdit.body.blueprint.created_at, detail.body.blueprint.created_at);
  assert.deepEqual(afterEdit.body.details.map((d: { day_of_week: number; exercise_order: number; exercise_id: number }) =>
    [d.day_of_week, d.exercise_order, d.exercise_id]), [[1, 1, replacementId], [1, 2, exerciseId], [2, 1, replacementId]]);
  for (const key of ["sets", "reps", "rest_seconds", "duration_minutes", "target_rir", "notes"] as const) {
    assert.equal(afterEdit.body.details[0][key], updatedExercise[key]);
  }
  assert.deepEqual(afterEdit.body.assignments, detail.body.assignments);
  assert.equal(adminSql(`SELECT row_to_json(r)::text FROM public.routines r WHERE id = '${second.body.routineId}'`), originalRoutine);
  assert.equal(adminSql(`SELECT json_agg(d ORDER BY d.id)::text FROM public.routine_details d WHERE routine_id = '${second.body.routineId}'`), originalDetails);
  const updatedList = await request(app).get("/routine-blueprints").set("Cookie", owner.cookie);
  const updatedStats = updatedList.body.data.find((item: { id: string }) => item.id === blueprintId);
  assert.equal(updatedStats.day_count, 2);
  assert.equal(updatedStats.exercise_count, 3);
  assert.equal(updatedStats.assignment_count, 1);

  // A failure after deleting the old rows and inserting one new row must roll back everything.
  const invalidEdit = await request(app).put(`/routine-blueprints/${blueprintId}`)
    .set("Cookie", owner.cookie).send({ ...updatedBody, title: "No debe guardarse",
      days: [{ exercises: [updatedExercise, { ...updatedExercise, exercise_id: 999999999 }] }] });
  assert.ok(invalidEdit.status >= 400);
  for (const days of [[], [{ exercises: [] }], [{ exercises: [{ ...updatedExercise, sets: -1 }] }]]) {
    const invalidMetrics = await request(app).put(`/routine-blueprints/${blueprintId}`)
      .set("Cookie", owner.cookie).send({ ...updatedBody, days });
    assert.equal(invalidMetrics.status, 400);
  }
  const afterFailedEdit = await request(app).get(`/routine-blueprints/${blueprintId}`).set("Cookie", owner.cookie);
  assert.deepEqual(afterFailedEdit.body, afterEdit.body);
  assert.equal((await request(app).put(`/routine-blueprints/${randomUUID()}`)
    .set("Cookie", owner.cookie).send(body)).status, 404);

  // Remove a day and an exercise; later assignments receive the saved content.
  assert.equal((await request(app).put(`/routine-blueprints/${blueprintId}`)
    .set("Cookie", owner.cookie).send({ ...updatedBody, days: [{ exercises: [updatedExercise] }] })).status, 200);
  const afterDelete = await request(app).get(`/routine-blueprints/${blueprintId}`).set("Cookie", owner.cookie);
  assert.equal(afterDelete.body.details.length, 1);
  assert.equal(afterDelete.body.details[0].day_of_week, 1);
  assert.equal(afterDelete.body.details[0].exercise_order, 1);
  const newCustomer = await createUser("client");
  const newAssignment = await request(app).post(`/routine-blueprints/${blueprintId}/assign`)
    .set("Cookie", owner.cookie).send({ userId: newCustomer.userId });
  assert.equal(newAssignment.status, 201);
  assert.equal(adminSql(`SELECT exercise_id || ':' || sets || ':' || reps || ':' || rest_seconds
    FROM public.routine_details WHERE routine_id = '${newAssignment.body.routineId}'`), `${replacementId}:4:12-15:0`);

  const saved = await request(app).post(`/routine-blueprints/from-routine/${second.body.routineId}`)
    .set("Cookie", owner.cookie);
  assert.equal(saved.status, 201);
  const savedAgain = await request(app).post(`/routine-blueprints/from-routine/${second.body.routineId}`)
    .set("Cookie", owner.cookie);
  assert.equal(savedAgain.status, 201);
  assert.equal(savedAgain.body.blueprintId, saved.body.blueprintId);

  const removed = await request(app)
    .delete(`/routine-blueprints/${blueprintId}/assign/${customer.userId}`)
    .set("Cookie", owner.cookie);
  assert.equal(removed.status, 200);
  assert.equal(adminSql(`SELECT status FROM public.routines WHERE id = '${second.body.routineId}'`), "active");
  const afterRemoval = await request(app).get(`/routine-blueprints/${blueprintId}`).set("Cookie", owner.cookie);
  assert.equal(afterRemoval.body.assignments.length, 1);
  assert.equal(afterRemoval.body.assignments[0].user_id, newCustomer.userId);
});
