import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import bcrypt from "bcryptjs";
import type { Request } from "express";
import request from "supertest";

import { app } from "../../app.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";
import { authenticateUser } from "../auth/auth.service.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testDomain = "@users.test.local";
const password = "PasswordDePrueba123";
const createdIds: string[] = [];
const createdRoleIds: string[] = [];
const createdExerciseIds: number[] = [];
const createdProductIds: string[] = [];
const createdBlueprintIds: string[] = [];

function adminSql(sql: string): void {
  execFileSync("psql", ["-d", "algym_test", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

async function createActor(role: "owner" | "client") {
  const id = randomUUID();
  createdIds.push(id);
  const email = `${id}${testDomain}`;
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO auth.users (id, email, encrypted_password, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())`,
    [id, email, hash],
  );
  adminSql(`INSERT INTO public.profiles
    (id, full_name, phone, birth_date, role, biometric_id, is_active)
    VALUES ('${id}', 'ZZTEST LOCAL USERS ${role}', '', DATE '1990-01-01',
            '${role}', ${Math.floor(Math.random() * 1000000)}, true)`);
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);
  return { id, cookie };
}

after(async () => {
  if (createdBlueprintIds.length > 0) {
    adminSql(`DELETE FROM public.routine_blueprints WHERE id IN (${createdBlueprintIds.map((id) => `'${id}'`).join(",")});`);
  }
  if (createdProductIds.length > 0) {
    adminSql(`DELETE FROM public.inventory_movements WHERE product_id IN (${createdProductIds.map((id) => `'${id}'`).join(",")});
      DELETE FROM public.products WHERE id IN (${createdProductIds.map((id) => `'${id}'`).join(",")});`);
  }
  if (createdExerciseIds.length > 0) {
    adminSql(`DELETE FROM public.exercises WHERE id IN (${createdExerciseIds.join(",")});`);
  }
  if (createdIds.length > 0) {
    adminSql(`DELETE FROM public.profiles WHERE id IN (${createdIds.map((id) => `'${id}'`).join(",")});
      DELETE FROM auth.sessions WHERE user_id IN (${createdIds.map((id) => `'${id}'`).join(",")});
      DELETE FROM auth.users WHERE id IN (${createdIds.map((id) => `'${id}'`).join(",")});
      DELETE FROM public.device_commands WHERE command LIKE '%ZZTEST LOCAL USERS%';`);
  }
  if (createdRoleIds.length > 0) {
    adminSql(`DELETE FROM public.role_permissions WHERE role_id IN (${createdRoleIds.map((id) => `'${id}'`).join(",")});
      DELETE FROM public.roles WHERE id IN (${createdRoleIds.map((id) => `'${id}'`).join(",")});`);
  }
  await pool.end();
});

test("un rol personalizado sin permisos no hereda accesos de empleado", async () => {
  const owner = await createActor("owner");
  try {
  const roleSlug = `zz_local_${randomUUID().slice(0, 8)}`;
  const role = await request(app).post("/roles").set("Cookie", owner.cookie).send({
    name: "Rol de prueba sin permisos", slug: roleSlug, permissionIds: [],
  });
  assert.equal(role.status, 201);
  createdRoleIds.push(role.body.id as string);

  const email = `${randomUUID()}${testDomain}`;
  const created = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email, full_name: "ZZTEST LOCAL USERS custom", role: roleSlug, password,
  });
  assert.equal(created.status, 201);
  createdIds.push(created.body.id as string);
  const storedRole = await withUserTransaction(owner.id, (connection) => connection.query(
    `SELECT p.role::text AS base_role, p.panel_role_id,
            public.get_profile_role(p.id) AS role_slug
     FROM public.profiles AS p WHERE p.id = $1`, [created.body.id]));
  assert.equal(storedRole.rows[0]?.role_slug, roleSlug, JSON.stringify(storedRole.rows[0]));
  assert.throws(() => adminSql(`UPDATE public.profiles
    SET panel_role_id = (SELECT id FROM public.roles WHERE slug = 'owner')
    WHERE id = '${created.body.id}'`));
  const login = await request(app).post("/auth/login").send({ email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.authorization.roleSlug, roleSlug);
  assert.equal(login.body.authorization.scope, "panel");
  assert.deepEqual(login.body.authorization.permissions, []);
  const cookie = login.headers["set-cookie"]?.[0];
  assert.ok(cookie);

  for (const route of ["/users", "/roles", "/payments", "/inventory/products", "/customers"]) {
    assert.equal((await request(app).get(route).set("Cookie", cookie)).status, 403, route);
  }
  const hiddenOwner = await withUserTransaction(created.body.id as string, (connection) =>
    connection.query("SELECT id FROM public.profiles WHERE id = $1", [owner.id]));
  assert.equal(hiddenOwner.rowCount, 0);

  const roles = await request(app).get("/users/roles").set("Cookie", owner.cookie);
  assert.ok(roles.body.data.some((item: { slug: string }) => item.slug === roleSlug));
  const listed = await request(app).get("/users").set("Cookie", owner.cookie);
  assert.equal(listed.body.data.find((item: { id: string }) => item.id === created.body.id)?.role, roleSlug);

  const permissions = await request(app).get("/roles/permissions").set("Cookie", owner.cookie);
  assert.equal(permissions.status, 200);
  const customerViewId = permissions.body.data.find((item: { key: string }) => item.key === "customers.view")?.id;
  assert.ok(customerViewId);
  const granted = await request(app).patch(`/roles/${role.body.id}`)
    .set("Cookie", owner.cookie).send({ permissionIds: [customerViewId] });
  assert.equal(granted.status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", cookie)).status, 401);
  const loginWithPermission = await request(app).post("/auth/login").send({ email, password });
  assert.equal(loginWithPermission.status, 200);
  assert.deepEqual(loginWithPermission.body.authorization.permissions, ["customers.view"]);
  const grantedCookie = loginWithPermission.headers["set-cookie"]?.[0];
  assert.ok(grantedCookie);
  assert.equal((await request(app).get("/customers").set("Cookie", grantedCookie)).status, 200);
  assert.equal((await request(app).get("/users").set("Cookie", grantedCookie)).status, 403);
  const revoked = await request(app).patch(`/roles/${role.body.id}`)
    .set("Cookie", owner.cookie).send({ permissionIds: [] });
  assert.equal(revoked.status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", grantedCookie)).status, 401);

  const viewKeys = [
    "cash.operate", "customers.manage_routine", "customers.view", "dashboard.view",
    "inventory.view", "payments.view", "plans.view", "products.view",
    "profile.view", "roles.view", "users.view",
  ];
  const viewPermissionIds = viewKeys.map((key) => {
    const id = permissions.body.data.find((item: { key: string }) => item.key === key)?.id;
    assert.ok(id, key);
    return id as string;
  });
  assert.equal((await request(app).patch(`/roles/${role.body.id}`)
    .set("Cookie", owner.cookie).send({ permissionIds: viewPermissionIds })).status, 200);
  const broadLogin = await request(app).post("/auth/login").send({ email, password });
  assert.equal(broadLogin.status, 200);
  const broadCookie = broadLogin.headers["set-cookie"]?.[0];
  assert.ok(broadCookie);
  for (const route of [
    "/cash/dashboard", "/customers", "/dashboard/overview", "/inventory/products",
    "/inventory/movements", "/payments", "/plans", "/profile", "/roles", "/users", "/exercises",
  ]) {
    const routeResponse: { status: number; body: unknown } = await request(app).get(route).set("Cookie", broadCookie);
    assert.equal(routeResponse.status, 200, `${route}: ${JSON.stringify(routeResponse.body)}`);
  }
  assert.equal((await request(app).patch(`/roles/${role.body.id}`)
    .set("Cookie", owner.cookie).send({ permissionIds: [] })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", broadCookie)).status, 401);

  const writeEmail = `${randomUUID()}${testDomain}`;
  const writeUser = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email: writeEmail, full_name: "ZZTEST LOCAL USERS writer", role: roleSlug, password,
  });
  assert.equal(writeUser.status, 201);
  createdIds.push(writeUser.body.id as string);
  adminSql(`INSERT INTO public.permissions (key, description, module, action)
    VALUES ('exercises.create', 'Prueba ejercicio', 'exercises', 'create'),
           ('products.create', 'Prueba producto', 'products', 'create')
    ON CONFLICT (key) DO NOTHING`);
  const writePermissions = await request(app).get("/roles/permissions").set("Cookie", owner.cookie);
  assert.equal(writePermissions.status, 200);
  const exerciseCreateId = writePermissions.body.data.find((item: { key: string }) => item.key === "exercises.create")?.id;
  const productCreateId = writePermissions.body.data.find((item: { key: string }) => item.key === "products.create")?.id;
  const productViewId = writePermissions.body.data.find((item: { key: string }) => item.key === "products.view")?.id;
  assert.ok(exerciseCreateId && productCreateId && productViewId);
  assert.equal((await request(app).patch(`/roles/${role.body.id}`).set("Cookie", owner.cookie)
    .send({ permissionIds: [exerciseCreateId] })).status, 200);
  const exerciseLogin = await request(app).post("/auth/login").send({ email: writeEmail, password });
  assert.equal(exerciseLogin.status, 200);
  const exerciseCookie = exerciseLogin.headers["set-cookie"]?.[0];
  assert.ok(exerciseCookie);
  assert.equal((await request(app).post("/inventory/products").set("Cookie", exerciseCookie).send({
    name: `ZZTEST LOCAL USERS PRODUCT ${randomUUID()}`, costPrice: 1,
    salePrice: 2, isActive: true, initialQuantity: 0,
  })).status, 403);
  const exercise = await request(app).post("/exercises").set("Cookie", exerciseCookie).send({
    name: `ZZTEST LOCAL USERS EXERCISE ${randomUUID()}`,
  });
  assert.equal(exercise.status, 201, JSON.stringify(exercise.body));
  createdExerciseIds.push(exercise.body.id as number);
  assert.equal((await request(app).post("/exercises").set("Cookie", exerciseCookie).send({
    name: `ZZTEST LOCAL USERS EXERCISE ${randomUUID()}`,
    image_url: "https://example.invalid/remote.png",
  })).status, 400);
  assert.equal((await request(app).get("/auth/me").set("Cookie", exerciseCookie)).status, 200);
  assert.equal((await request(app).patch(`/roles/${role.body.id}`).set("Cookie", owner.cookie)
    .send({ permissionIds: [productCreateId, productViewId] })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", exerciseCookie)).status, 401);
  const productLogin = await request(app).post("/auth/login").send({ email: writeEmail, password });
  assert.equal(productLogin.status, 200);
  const productCookie = productLogin.headers["set-cookie"]?.[0];
  assert.ok(productCookie);
  assert.equal((await request(app).post("/exercises").set("Cookie", productCookie).send({
    name: `ZZTEST LOCAL USERS EXERCISE ${randomUUID()}`,
  })).status, 403);
  const productName = `ZZTEST LOCAL USERS PRODUCT ${randomUUID()}`;
  const product = await request(app).post("/inventory/products").set("Cookie", productCookie).send({
    name: productName, costPrice: 1,
    salePrice: 2, isActive: true, initialQuantity: 0,
  });
  assert.equal(product.status, 201, JSON.stringify(product.body));
  createdProductIds.push(product.body.id as string);
  const visibleProduct = await request(app).get("/inventory/products")
    .query({ name: productName }).set("Cookie", productCookie);
  assert.equal(visibleProduct.status, 200);
  assert.equal(visibleProduct.body.data[0]?.id, product.body.id);
  assert.equal((await request(app).post(`/inventory/products/${product.body.id}/adjust`)
    .set("Cookie", productCookie).send({ countedQuantity: 1 })).status, 403);
  adminSql(`INSERT INTO public.permissions (key, description, module, action)
    VALUES ('inventory.view', 'Prueba inventario', 'inventory', 'view'),
           ('inventory.adjust', 'Prueba ajuste', 'inventory', 'adjust')
    ON CONFLICT (key) DO NOTHING`);
  const inventoryPermissions = await request(app).get("/roles/permissions").set("Cookie", owner.cookie);
  assert.equal(inventoryPermissions.status, 200);
  const inventoryViewId = inventoryPermissions.body.data.find((item: { key: string }) => item.key === "inventory.view")?.id;
  const inventoryAdjustId = inventoryPermissions.body.data.find((item: { key: string }) => item.key === "inventory.adjust")?.id;
  assert.ok(inventoryViewId && inventoryAdjustId);
  assert.equal((await request(app).patch(`/roles/${role.body.id}`).set("Cookie", owner.cookie)
    .send({ permissionIds: [productViewId, inventoryViewId, inventoryAdjustId] })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", productCookie)).status, 401);
  const inventoryLogin = await request(app).post("/auth/login").send({ email: writeEmail, password });
  assert.equal(inventoryLogin.status, 200);
  const inventoryCookie = inventoryLogin.headers["set-cookie"]?.[0];
  assert.ok(inventoryCookie);
  assert.equal((await request(app).post("/inventory/products").set("Cookie", inventoryCookie).send({
    name: `ZZTEST LOCAL USERS PRODUCT ${randomUUID()}`, costPrice: 1,
    salePrice: 2, isActive: true, initialQuantity: 0,
  })).status, 403);
  const adjusted = await request(app).post(`/inventory/products/${product.body.id}/adjust`)
    .set("Cookie", inventoryCookie).send({ countedQuantity: 1 });
  assert.equal(adjusted.status, 201, JSON.stringify(adjusted.body));
  const movements = await request(app).get("/inventory/movements")
    .query({ productName }).set("Cookie", inventoryCookie);
  assert.equal(movements.status, 200, JSON.stringify(movements.body));
  assert.equal(movements.body.data[0]?.product_id, product.body.id);
  const customerInput = {
    full_name: `ZZTEST LOCAL USERS CUSTOMER ${randomUUID()}`,
    phone: "55540000", birth_date: "1990-01-01", gender: "other",
    email: `${randomUUID()}${testDomain}`,
  };
  assert.equal((await request(app).post("/customers").set("Cookie", inventoryCookie)
    .send(customerInput)).status, 403);
  const customerCreateId = inventoryPermissions.body.data.find((item: { key: string }) => item.key === "customers.create")?.id;
  const customerViewIdForWrite = inventoryPermissions.body.data.find((item: { key: string }) => item.key === "customers.view")?.id;
  assert.ok(customerCreateId && customerViewIdForWrite);
  assert.equal((await request(app).patch(`/roles/${role.body.id}`).set("Cookie", owner.cookie)
    .send({ permissionIds: [customerCreateId, customerViewIdForWrite] })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", inventoryCookie)).status, 401);
  const customerLogin = await request(app).post("/auth/login").send({ email: writeEmail, password });
  assert.equal(customerLogin.status, 200);
  const customerCookie = customerLogin.headers["set-cookie"]?.[0];
  assert.ok(customerCookie);
  assert.equal((await request(app).post("/exercises").set("Cookie", customerCookie).send({
    name: `ZZTEST LOCAL USERS EXERCISE ${randomUUID()}`,
  })).status, 403);
  const customer = await request(app).post("/customers").set("Cookie", customerCookie).send(customerInput);
  assert.equal(customer.status, 201, JSON.stringify(customer.body));
  createdIds.push(customer.body.id as string);
  const visibleCustomers = await request(app).get("/customers").set("Cookie", customerCookie);
  assert.equal(visibleCustomers.status, 200);
  assert.ok(visibleCustomers.body.data.some((item: { id: string }) => item.id === customer.body.id));
  assert.equal((await request(app).patch(`/roles/${role.body.id}`).set("Cookie", owner.cookie)
    .send({ permissionIds: [] })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", customerCookie)).status, 401);

  adminSql(`INSERT INTO public.permissions (key, description, module, action)
    VALUES ('routines.view', 'Prueba plantillas', 'routines', 'view')
    ON CONFLICT (key) DO NOTHING`);
  const routinePermissions = await request(app).get("/roles/permissions").set("Cookie", owner.cookie);
  assert.equal(routinePermissions.status, 200);
  const routineViewId = routinePermissions.body.data.find((item: { key: string }) => item.key === "routines.view")?.id;
  assert.ok(routineViewId);
  assert.equal((await request(app).patch(`/roles/${role.body.id}`).set("Cookie", owner.cookie)
    .send({ permissionIds: [routineViewId] })).status, 200);
  const routineLogin = await request(app).post("/auth/login").send({ email: writeEmail, password });
  assert.equal(routineLogin.status, 200);
  const routineCookie = routineLogin.headers["set-cookie"]?.[0];
  assert.ok(routineCookie);
  const blueprint = await request(app).post("/routine-blueprints").set("Cookie", routineCookie).send({
    title: `ZZTEST LOCAL USERS BLUEPRINT ${randomUUID()}`,
    primary_goal: "strength", secondary_goal: null,
    days: [{ exercises: [{
      exercise_id: exercise.body.id, block_type: "strength", sets: 3,
      reps: "8-10", rest_seconds: 90, duration_minutes: null, target_rir: 2,
    }] }],
  });
  assert.equal(blueprint.status, 201, JSON.stringify(blueprint.body));
  createdBlueprintIds.push(blueprint.body.blueprintId as string);
  const visibleBlueprints = await request(app).get("/routine-blueprints").set("Cookie", routineCookie);
  assert.equal(visibleBlueprints.status, 200);
  assert.ok(visibleBlueprints.body.data.some((item: { id: string }) => item.id === blueprint.body.blueprintId));
  assert.equal((await request(app).patch(`/roles/${role.body.id}`).set("Cookie", owner.cookie)
    .send({ permissionIds: [] })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", routineCookie)).status, 401);

  assert.equal((await request(app).post("/users").set("Cookie", owner.cookie).send({
    email: `${randomUUID()}${testDomain}`, full_name: "Usuario Inválido", role: "client", password,
  })).status, 400);

  const archivedUser = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email: `${randomUUID()}${testDomain}`, full_name: "ZZTEST LOCAL USERS archived",
    role: roleSlug, password,
  });
  assert.equal(archivedUser.status, 201);
  createdIds.push(archivedUser.body.id as string);
  assert.equal((await request(app).delete(`/users/${archivedUser.body.id}`)
    .set("Cookie", owner.cookie)).status, 204);

  const reassignedEmail = `${randomUUID()}${testDomain}`;
  const reassignedUser = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email: reassignedEmail, full_name: "ZZTEST LOCAL USERS reassigned",
    role: "employee", password,
  });
  assert.equal(reassignedUser.status, 201);
  createdIds.push(reassignedUser.body.id as string);
  const employeeLogin = await request(app).post("/auth/login")
    .send({ email: reassignedEmail, password });
  assert.equal(employeeLogin.status, 200);
  const oldEmployeeCookie = employeeLogin.headers["set-cookie"]?.[0];
  assert.ok(oldEmployeeCookie);
  assert.equal((await request(app).patch(`/users/${reassignedUser.body.id}`)
    .set("Cookie", owner.cookie).send({ role: roleSlug })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", oldEmployeeCookie)).status, 401);
  const reassignedRole = await withUserTransaction(owner.id, (connection) =>
    connection.query<{ role_slug: string }>(
      "SELECT public.get_profile_role(id) AS role_slug FROM public.profiles WHERE id = $1",
      [reassignedUser.body.id]));
  assert.equal(reassignedRole.rows[0]?.role_slug, roleSlug);

  const deletedWithoutReplacement = await request(app).delete(`/roles/${role.body.id}`)
    .set("Cookie", owner.cookie).send({});
  assert.equal(deletedWithoutReplacement.status, 409);

  const secondSlug = `zz_local_${randomUUID().slice(0, 8)}`;
  const secondRole = await request(app).post("/roles").set("Cookie", owner.cookie).send({
    name: "Segundo rol de prueba", slug: secondSlug, permissionIds: [],
  });
  assert.equal(secondRole.status, 201);
  createdRoleIds.push(secondRole.body.id as string);
  const replacementWithCustom = await request(app).delete(`/roles/${role.body.id}`)
    .set("Cookie", owner.cookie).send({ replacementRoleSlug: secondSlug });
  assert.equal(replacementWithCustom.status, 204);
  createdRoleIds.splice(createdRoleIds.indexOf(role.body.id as string), 1);
  const customAfter = await request(app).get("/users").set("Cookie", owner.cookie);
  assert.equal(customAfter.body.data.find((item: { id: string }) => item.id === created.body.id)?.role, secondSlug);
  assert.equal(customAfter.body.data.find((item: { id: string }) => item.id === reassignedUser.body.id)?.role, secondSlug);
  const archivedCustom = await withUserTransaction(owner.id, (connection) =>
    connection.query<{ role_slug: string }>(
      "SELECT public.get_profile_role(id) AS role_slug FROM public.profiles WHERE id = $1",
      [archivedUser.body.id]));
  assert.equal(archivedCustom.rows[0]?.role_slug, secondSlug);
  const replacement = await request(app).delete(`/roles/${secondRole.body.id}`)
    .set("Cookie", owner.cookie).send({ replacementRoleSlug: "employee" });
  assert.equal(replacement.status, 204);
  createdRoleIds.pop();
  assert.equal((await request(app).get("/auth/me").set("Cookie", cookie)).status, 401);
  const after = await request(app).get("/users").set("Cookie", owner.cookie);
  assert.equal(after.body.data.find((item: { id: string }) => item.id === created.body.id)?.role, "employee");
  assert.equal(after.body.data.find((item: { id: string }) => item.id === reassignedUser.body.id)?.role, "employee");
  const archivedAfter = await withUserTransaction(owner.id, (connection) =>
    connection.query<{ role_slug: string }>(
      "SELECT public.get_profile_role(id) AS role_slug FROM public.profiles WHERE id = $1",
      [archivedUser.body.id]));
  assert.equal(archivedAfter.rows[0]?.role_slug, "employee");
  } finally {
    adminSql(`DELETE FROM public.profiles WHERE id = '${owner.id}';
      DELETE FROM auth.sessions WHERE user_id = '${owner.id}';
      DELETE FROM auth.users WHERE id = '${owner.id}';`);
    createdIds.splice(createdIds.indexOf(owner.id), 1);
  }
});

test("usuarios internos: permisos, alta, cambio de contraseña y rol, baja lógica", async () => {
  assert.equal((await request(app).get("/users")).status, 401);
  const owner = await createActor("owner");
  const client = await createActor("client");
  assert.equal((await request(app).get("/users").set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).get("/users/roles").set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).post("/users").set("Cookie", client.cookie).send({
    email: `denegado${testDomain}`, full_name: "Denegado", role: "admin", password,
  })).status, 403);

  const roles = await request(app).get("/users/roles").set("Cookie", owner.cookie);
  assert.equal(roles.status, 200);
  assert.ok(roles.body.data.some((role: { slug: string }) => role.slug === "employee"));

  const email = `${randomUUID()}${testDomain}`;
  const invalid = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email, full_name: "Usuario Nuevo", role: "employee", password: "corta",
  });
  assert.equal(invalid.status, 400);

  const created = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email: email.toUpperCase(), full_name: "Usuario Nuevo", role: "employee", password,
  });
  assert.equal(created.status, 201);
  const userId = created.body.id as string;
  createdIds.push(userId);
  assert.ok(userId);
  assert.equal((await request(app).post("/users").set("Cookie", owner.cookie).send({
    email, full_name: "Duplicado", role: "employee", password,
  })).status, 409);

  const row = await withUserTransaction(owner.id, (connection) => connection.query<{
    email: string; encrypted_password: string; birth_date: string | null;
    biometric_id: number | null; role: string;
  }>(`SELECT users.email, users.encrypted_password, profiles.birth_date,
             profiles.biometric_id, profiles.role::text AS role
      FROM auth.users AS users JOIN public.profiles AS profiles ON profiles.id = users.id
      WHERE users.id = $1`, [userId]));
  assert.equal(row.rows[0]?.email, email);
  assert.equal(row.rows[0]?.role, "employee");
  assert.equal(row.rows[0]?.birth_date, null);
  assert.equal(row.rows[0]?.biometric_id, null);
  assert.ok(await bcrypt.compare(password, row.rows[0]!.encrypted_password));

  const listed = await request(app).get("/users").set("Cookie", owner.cookie);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.some((user: { id: string }) => user.id === userId));
  assert.equal(JSON.stringify(listed.body).includes("encrypted_password"), false);
  assert.equal(JSON.stringify(listed.body).includes(password), false);
  const invisible = await withUserTransaction(client.id, async (connection) =>
    connection.query("SELECT id FROM public.profiles WHERE id = $1", [userId]));
  assert.equal(invisible.rowCount, 0);

  const employee = await request(app).post("/auth/login").send({ email, password });
  assert.equal(employee.status, 200);
  const employeeCookie = employee.headers["set-cookie"]?.[0];
  assert.ok(employeeCookie);

  const newPassword = "NuevaClaveSegura123";
  const updated = await request(app).patch(`/users/${userId}`).set("Cookie", owner.cookie).send({
    full_name: "Usuario Actualizado", role: "trainer", password: newPassword,
  });
  assert.equal(updated.status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", employeeCookie)).status, 401);
  const renewedLogin = await request(app).post("/auth/login").send({ email, password: newPassword });
  assert.equal(renewedLogin.status, 200);
  const renewedCookie = renewedLogin.headers["set-cookie"]?.[0];
  assert.ok(renewedCookie);

  assert.equal((await request(app).patch(`/users/${userId}`).set("Cookie", owner.cookie)
    .send({ is_active: false })).status, 200);
  assert.equal((await request(app).get("/auth/me").set("Cookie", renewedCookie)).status, 401);
  assert.equal((await request(app).post("/auth/login").send({ email, password: newPassword })).status, 403);
  assert.equal((await request(app).patch(`/users/${userId}`).set("Cookie", owner.cookie)
    .send({ is_active: true })).status, 200);
  const reactivated = await request(app).get("/users").set("Cookie", owner.cookie);
  assert.equal(reactivated.body.data.find((user: { id: string }) => user.id === userId)?.is_active, true);

  assert.equal((await request(app).delete(`/users/${owner.id}`).set("Cookie", owner.cookie)).status, 409);
  assert.equal((await request(app).patch(`/users/${owner.id}`).set("Cookie", owner.cookie)
    .send({ is_active: false })).status, 409);
  assert.equal((await request(app).patch(`/users/${owner.id}`).set("Cookie", owner.cookie)
    .send({ role: "employee" })).status, 409);
  assert.equal((await request(app).delete(`/users/${userId}`).set("Cookie", client.cookie)).status, 403);
  assert.equal((await request(app).delete(`/users/${userId}`).set("Cookie", owner.cookie)).status, 204);
  const deleted = await withUserTransaction(owner.id, (connection) => connection.query<{ deleted_at: Date | null; is_active: boolean }>(
    `SELECT users.deleted_at, profiles.is_active FROM auth.users AS users
     JOIN public.profiles AS profiles ON profiles.id = users.id WHERE users.id = $1`, [userId]));
  assert.ok(deleted.rows[0]?.deleted_at);
  assert.equal(deleted.rows[0]?.is_active, false);

  const replacement = await request(app).post("/users").set("Cookie", owner.cookie).send({
    email, full_name: "Usuario Reemplazo", role: "employee", password: newPassword,
  });
  assert.equal(replacement.status, 201);
  createdIds.push(replacement.body.id as string);
  const replacementLogin = await authenticateUser(
    { email, password: newPassword },
    { get: () => undefined, ip: "127.0.0.1" } as unknown as Request,
  );
  assert.equal(replacementLogin.context.user.id, replacement.body.id);
});
