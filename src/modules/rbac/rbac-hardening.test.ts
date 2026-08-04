import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";

const testEmailDomain = "@rbac-hardening.test.local";
const testNamePrefix = "ZZTEST RBAC HARDENING";
const testPermissionMarker = "ZZTEST RBAC HARDENING PERMISSION";
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../../..");
const migrationPath = path.join(
  projectRoot,
  "database/migrations/0010_rbac_hardening.sql",
);

type TestUserRole = "admin" | "client" | "employee" | "owner";

type SyntheticUser = {
  userId: string;
};

type PermissionFixtureDefinition = {
  action: string;
  key: string;
  module: string;
};

type PermissionFixtureState = {
  key: string;
  permissionExisted: boolean;
  permissionId: string;
  roleAssignmentExisted: boolean;
};

type PermissionFixture = {
  permissions: PermissionFixtureState[];
  roleSlug: string;
};

const activePermissionFixtures = new Set<PermissionFixture>();

function runAdminSql(sql: string): void {
  execFileSync(
    "psql",
    [
      "-X",
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

function runAdminQuery(sql: string): string {
  return execFileSync(
    "psql",
    [
      "-X",
      "-d",
      "algym_test",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-F",
      "|",
      "-c",
      sql,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
    },
  ).trim();
}

function applyRbacHardeningMigration(): void {
  execFileSync(
    "psql",
    [
      "-X",
      "-d",
      "algym_test",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      migrationPath,
    ],
    {
      cwd: projectRoot,
      stdio: "ignore",
    },
  );
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createSyntheticUser(role: TestUserRole): SyntheticUser {
  const userId = randomUUID();
  const email = `${userId}${testEmailDomain}`;
  const biometricId =
    Number.parseInt(userId.replaceAll("-", "").slice(0, 7), 16) +
    1_000_000;

  runAdminSql(`
    INSERT INTO auth.users (
      id,
      email,
      encrypted_password,
      raw_user_meta_data,
      created_at,
      updated_at
    )
    VALUES (
      ${sqlLiteral(userId)},
      ${sqlLiteral(email)},
      'rbac-hardening-test-only',
      '{}'::jsonb,
      now(),
      now()
    );

    INSERT INTO public.profiles (
      id,
      full_name,
      phone,
      birth_date,
      gender,
      role,
      biometric_id,
      is_active
    )
    VALUES (
      ${sqlLiteral(userId)},
      ${sqlLiteral(`${testNamePrefix} ${role}`)},
      '55580000',
      DATE '1990-01-01',
      'other',
      ${sqlLiteral(role)},
      ${biometricId},
      true
    );
  `);

  return { userId };
}

function cleanupSyntheticData(): void {
  for (const fixture of [...activePermissionFixtures]) {
    restorePermissionFixture(fixture);
  }

  runAdminSql(`
    DELETE FROM public.role_permissions
    WHERE role_id IN (
      SELECT id
      FROM public.roles
      WHERE slug LIKE 'zz_rbac_hardening_%'
    );

    DELETE FROM public.roles
    WHERE slug LIKE 'zz_rbac_hardening_%';

    DELETE FROM public.role_permissions AS role_permission
    USING public.permissions AS permission
    WHERE role_permission.permission_id = permission.id
      AND permission.description LIKE ${sqlLiteral(`${testPermissionMarker}%`)};

    DELETE FROM public.permissions
    WHERE description LIKE ${sqlLiteral(`${testPermissionMarker}%`)};

    DELETE FROM public.device_commands
    WHERE command LIKE '%${testNamePrefix}%';

    DELETE FROM auth.sessions
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

    DELETE FROM auth.users
    WHERE email LIKE '%${testEmailDomain}';
  `);
}

function grantSyntheticPermissions(
  roleSlug: string,
  definitions: PermissionFixtureDefinition[],
): PermissionFixture {
  const fixture: PermissionFixture = {
    permissions: [],
    roleSlug,
  };
  activePermissionFixtures.add(fixture);

  try {
    for (const definition of definitions) {
      const previousState = runAdminQuery(`
        SELECT
          permission.id::text,
          EXISTS (
            SELECT 1
            FROM public.role_permissions AS role_permission
            JOIN public.roles AS role
              ON role.id = role_permission.role_id
            WHERE role_permission.permission_id = permission.id
              AND role.slug = ${sqlLiteral(roleSlug)}
          )::text
        FROM public.permissions AS permission
        WHERE permission.key = ${sqlLiteral(definition.key)};
      `);
      const [previousPermissionId, previousAssignment] =
        previousState.split("|", 2);
      const permissionExisted = previousPermissionId !== "";
      const roleAssignmentExisted = previousAssignment === "true";

      if (!permissionExisted) {
        runAdminSql(`
          INSERT INTO public.permissions (
            key,
            description,
            module,
            action
          )
          VALUES (
            ${sqlLiteral(definition.key)},
            ${sqlLiteral(`${testPermissionMarker}: ${definition.key}`)},
            ${sqlLiteral(definition.module)},
            ${sqlLiteral(definition.action)}
          );
        `);
      }

      const permissionId = runAdminQuery(`
        SELECT id::text
        FROM public.permissions
        WHERE key = ${sqlLiteral(definition.key)};
      `);
      assert.match(permissionId, /^[0-9a-f-]{36}$/);

      fixture.permissions.push({
        key: definition.key,
        permissionExisted,
        permissionId,
        roleAssignmentExisted,
      });

      runAdminSql(`
        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT role.id, ${sqlLiteral(permissionId)}::uuid
        FROM public.roles AS role
        WHERE role.slug = ${sqlLiteral(roleSlug)}
        ON CONFLICT (role_id, permission_id) DO NOTHING;
      `);
    }

    return fixture;
  } catch (error) {
    restorePermissionFixture(fixture);
    throw error;
  }
}

function restorePermissionFixture(fixture: PermissionFixture): void {
  for (const permission of [...fixture.permissions].reverse()) {
    if (permission.roleAssignmentExisted) {
      runAdminSql(`
        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT role.id, ${sqlLiteral(permission.permissionId)}::uuid
        FROM public.roles AS role
        WHERE role.slug = ${sqlLiteral(fixture.roleSlug)}
        ON CONFLICT (role_id, permission_id) DO NOTHING;
      `);
    } else {
      runAdminSql(`
        DELETE FROM public.role_permissions
        WHERE role_id = (
          SELECT id
          FROM public.roles
          WHERE slug = ${sqlLiteral(fixture.roleSlug)}
        )
          AND permission_id = ${sqlLiteral(permission.permissionId)}::uuid;
      `);
    }

    if (!permission.permissionExisted) {
      runAdminSql(`
        DELETE FROM public.permissions
        WHERE id = ${sqlLiteral(permission.permissionId)}::uuid
          AND key = ${sqlLiteral(permission.key)}
          AND description = ${sqlLiteral(`${testPermissionMarker}: ${permission.key}`)};
      `);
    }
  }

  activePermissionFixtures.delete(fixture);
}

async function assertRlsRejected(
  operation: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      "42501",
      `Se esperaba una denegación RLS y se recibió ${String(error)}`,
    );
    return true;
  });
}

before(() => {
  if (env.DB_NAME !== "algym_test") {
    throw new Error(
      `DB_NAME debe ser exactamente algym_test y actualmente es ${env.DB_NAME}.`,
    );
  }

  cleanupSyntheticData();
});

after(async () => {
  cleanupSyntheticData();
  await pool.end();
});

test("0010 se puede reaplicar sin modificar migraciones historicas", () => {
  applyRbacHardeningMigration();
});

test("las consultas del catalogo RBAC no producen recursion", async () => {
  const admin = createSyntheticUser("admin");
  const client = createSyntheticUser("client");

  const counts = await withUserTransaction(
    admin.userId,
    async (connection) => {
      const roles = await connection.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.roles",
      );
      const permissions = await connection.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.permissions",
      );
      const rolePermissions = await connection.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.role_permissions",
      );

      return {
        permissions: Number(permissions.rows[0]?.count),
        rolePermissions: Number(rolePermissions.rows[0]?.count),
        roles: Number(roles.rows[0]?.count),
      };
    },
  );

  assert.ok(counts.roles > 0);
  assert.ok(counts.permissions > 0);
  assert.ok(counts.rolePermissions > 0);

  const clientVisibleRoles = await withUserTransaction(
    client.userId,
    async (connection) => {
      const result = await connection.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM public.roles",
      );
      return Number(result.rows[0]?.count);
    },
  );

  assert.equal(clientVisibleRoles, 0);
});

test("un usuario no autenticado no consulta ni modifica el catalogo", async () => {
  for (const tableName of [
    "permissions",
    "role_permissions",
    "roles",
  ]) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.${tableName}`,
    );
    assert.equal(Number(result.rows[0]?.count), 0);
  }

  await assertRlsRejected(() =>
    pool.query(`
      INSERT INTO public.roles (slug, name, scope)
      VALUES (
        'zz_rbac_hardening_unauthenticated',
        'No autorizado',
        'panel'
      )
    `),
  );

  for (const databaseRole of [
    "anon",
    "authenticated",
    "service_role",
  ]) {
    for (const tableName of [
      "permissions",
      "role_permissions",
      "roles",
    ]) {
      const privilege = await pool.query<{ allowed: boolean }>(
        `
          SELECT pg_catalog.has_table_privilege(
            $1,
            $2,
            'SELECT'
          ) AS allowed
        `,
        [databaseRole, `public.${tableName}`],
      );
      assert.equal(privilege.rows[0]?.allowed, false);
    }
  }
});

test("un usuario sin permisos no puede elevar privilegios", async () => {
  const employee = createSyntheticUser("employee");

  await assertRlsRejected(() =>
    withUserTransaction(employee.userId, (connection) =>
      connection.query(`
        INSERT INTO public.roles (slug, name, scope)
        VALUES (
          'zz_rbac_hardening_employee',
          'Escalacion empleado',
          'panel'
        )
      `),
    ),
  );

  await assertRlsRejected(() =>
    withUserTransaction(employee.userId, (connection) =>
      connection.query(`
        INSERT INTO public.role_permissions (role_id, permission_id)
        SELECT role.id, permission.id
        FROM public.roles AS role
        CROSS JOIN public.permissions AS permission
        WHERE role.slug = 'employee'
          AND permission.key = 'roles.view'
      `),
    ),
  );

  await assertRlsRejected(() =>
    withUserTransaction(employee.userId, (connection) =>
      connection.query(
        `
          UPDATE public.profiles
          SET role = 'owner'
          WHERE id = $1
        `,
        [employee.userId],
      ),
    ),
  );

  const role = await withUserTransaction(
    employee.userId,
    async (connection) =>
      connection.query<{ role: string }>(
        "SELECT role::text AS role FROM public.profiles WHERE id = $1",
        [employee.userId],
      ),
  );
  assert.equal(role.rows[0]?.role, "employee");
});

test("un administrador autorizado administra roles y asignaciones", async () => {
  const permissionFixture = grantSyntheticPermissions("admin", [
    { action: "create", key: "roles.create", module: "roles" },
    { action: "delete", key: "roles.delete", module: "roles" },
    { action: "update", key: "roles.update", module: "roles" },
  ]);
  const admin = createSyntheticUser("admin");
  const slug = `zz_rbac_hardening_admin_${randomUUID()}`;

  try {
    await withUserTransaction(admin.userId, async (connection) => {
      const role = await connection.query<{ id: string }>(
        `
          INSERT INTO public.roles (slug, name, scope)
          VALUES ($1, 'Rol de prueba admin', 'panel')
          RETURNING id
        `,
        [slug],
      );
      const roleId = role.rows[0]?.id;
      assert.ok(roleId);

      const permission = await connection.query<{ id: string }>(
        `
          SELECT id
          FROM public.permissions
          WHERE key = 'roles.view'
        `,
      );
      const permissionId = permission.rows[0]?.id;
      assert.ok(permissionId);

      const assignment = await connection.query(
        `
          INSERT INTO public.role_permissions (role_id, permission_id)
          VALUES ($1, $2)
        `,
        [roleId, permissionId],
      );
      assert.equal(assignment.rowCount, 1);

      const update = await connection.query(
        `
          UPDATE public.roles
          SET name = 'Rol de prueba admin actualizado'
          WHERE id = $1
        `,
        [roleId],
      );
      assert.equal(update.rowCount, 1);

      const removeAssignment = await connection.query(
        `
          DELETE FROM public.role_permissions
          WHERE role_id = $1
            AND permission_id = $2
        `,
        [roleId, permissionId],
      );
      assert.equal(removeAssignment.rowCount, 1);

      const removeRole = await connection.query(
        "DELETE FROM public.roles WHERE id = $1",
        [roleId],
      );
      assert.equal(removeRole.rowCount, 1);
    });
  } finally {
    restorePermissionFixture(permissionFixture);
  }
});

test("el owner conserva las capacidades previstas", async () => {
  const owner = createSyntheticUser("owner");
  const slug = `zz_rbac_hardening_owner_${randomUUID()}`;

  await withUserTransaction(owner.userId, async (connection) => {
    const role = await connection.query<{ id: string }>(
      `
        INSERT INTO public.roles (slug, name, scope)
        VALUES ($1, 'Rol de prueba owner', 'panel')
        RETURNING id
      `,
      [slug],
    );
    const roleId = role.rows[0]?.id;
    assert.ok(roleId);

    const permission = await connection.query<{ id: string }>(
      `
        SELECT id
        FROM public.permissions
        WHERE key = 'roles.view'
      `,
    );
    const permissionId = permission.rows[0]?.id;
    assert.ok(permissionId);

    await connection.query(
      `
        INSERT INTO public.role_permissions (role_id, permission_id)
        VALUES ($1, $2)
      `,
      [roleId, permissionId],
    );
    await connection.query(
      "UPDATE public.roles SET name = 'Rol owner actualizado' WHERE id = $1",
      [roleId],
    );
    await connection.query(
      "DELETE FROM public.role_permissions WHERE role_id = $1",
      [roleId],
    );
    const removeRole = await connection.query(
      "DELETE FROM public.roles WHERE id = $1",
      [roleId],
    );

    assert.equal(removeRole.rowCount, 1);
    assert.equal(
      (await connection.query<{ isOwner: boolean }>(
        "SELECT public.is_owner() AS \"isOwner\"",
      )).rows[0]?.isOwner,
      true,
    );
  });
});

test("las funciones privilegiadas no conservan ACL accidental", async () => {
  const functions = await pool.query<{
    functionName: string;
    functionOid: number;
    ownerName: string;
    securityDefiner: boolean;
    settings: string[] | null;
  }>(`
    SELECT
      namespace.nspname || '.' || procedure.proname AS "functionName",
      procedure.oid AS "functionOid",
      owner.rolname AS "ownerName",
      procedure.prosecdef AS "securityDefiner",
      procedure.proconfig AS settings
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_roles AS owner
      ON owner.oid = procedure.proowner
    WHERE (
      namespace.nspname = 'public'
      AND procedure.proname IN (
        'check_is_admin',
        'get_current_permissions',
        'get_current_role_slug',
        'get_my_role',
        'get_profile_role',
        'has_permission',
        'is_owner',
        'require_cash_operator'
      )
    ) OR (
      namespace.nspname = 'private'
      AND procedure.proname IN (
        'current_actor_has_permission',
        'rbac_catalog_visible'
      )
    )
    ORDER BY 1
  `);

  assert.equal(functions.rowCount, 10);
  for (const entry of functions.rows) {
    assert.equal(entry.ownerName, "algym_migrator");
    assert.equal(entry.securityDefiner, true);
    assert.deepEqual(
      entry.settings,
      ['search_path=""'],
      `${entry.functionName} debe usar search_path vacío`,
    );
  }

  const accidentalAcl = await pool.query<{
    functionName: string;
    grantee: string;
  }>(`
    SELECT
      namespace.nspname || '.' || procedure.proname AS "functionName",
      CASE
        WHEN privilege.grantee = 0 THEN 'PUBLIC'
        ELSE grantee.rolname
      END AS grantee
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE (
      (
        namespace.nspname = 'public'
        AND procedure.proname IN (
          'check_is_admin',
          'get_current_permissions',
          'get_current_role_slug',
          'get_my_role',
          'get_profile_role',
          'has_permission',
          'is_owner',
          'require_cash_operator'
        )
      ) OR (
        namespace.nspname = 'private'
        AND procedure.proname IN (
          'current_actor_has_permission',
          'rbac_catalog_visible'
        )
      )
    )
      AND privilege.privilege_type = 'EXECUTE'
      AND (
        privilege.grantee = 0
        OR grantee.rolname IN ('anon', 'authenticated', 'service_role')
      )
  `);

  assert.deepEqual(accidentalAcl.rows, []);

  const databaseRoles = [
    "algym_app",
    "algym_migrator",
    "anon",
    "authenticated",
    "service_role",
  ];
  const effectiveFunctionPrivileges = await pool.query<{
    allowed: boolean;
    functionOid: number;
    roleName: string;
  }>(`
    SELECT
      role_name AS "roleName",
      function_oid AS "functionOid",
      pg_catalog.has_function_privilege(
        role_name,
        function_oid,
        'EXECUTE'
      ) AS allowed
    FROM unnest($1::text[]) AS runtime_role(role_name)
    CROSS JOIN unnest($2::oid[]) AS function_entry(function_oid)
  `, [
    databaseRoles,
    functions.rows.map((entry) => entry.functionOid),
  ]);

  for (const privilege of effectiveFunctionPrivileges.rows) {
    assert.equal(
      privilege.allowed,
      privilege.roleName === "algym_app" ||
        privilege.roleName === "algym_migrator",
      `${privilege.roleName} tiene EXECUTE efectivo inesperado sobre ${privilege.functionOid}`,
    );
  }

  const privateSchema = await pool.query<{
    ownerName: string;
  }>(`
    SELECT owner.rolname AS "ownerName"
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner
      ON owner.oid = namespace.nspowner
    WHERE namespace.nspname = 'private'
  `);
  assert.equal(privateSchema.rows[0]?.ownerName, "algym_migrator");

  const effectiveSchemaPrivileges = await pool.query<{
    canCreate: boolean;
    canUse: boolean;
    roleName: string;
    schemaName: string;
  }>(`
    SELECT
      role_name AS "roleName",
      schema_name AS "schemaName",
      pg_catalog.has_schema_privilege(
        role_name,
        schema_name,
        'USAGE'
      ) AS "canUse",
      pg_catalog.has_schema_privilege(
        role_name,
        schema_name,
        'CREATE'
      ) AS "canCreate"
    FROM unnest($1::text[]) AS runtime_role(role_name)
    CROSS JOIN unnest($2::text[]) AS protected_schema(schema_name)
  `, [databaseRoles, ["auth", "private", "public"]]);

  for (const privilege of effectiveSchemaPrivileges.rows) {
    const expectedUsage =
      privilege.schemaName === "private"
        ? privilege.roleName === "algym_app" ||
          privilege.roleName === "algym_migrator"
        : true;
    assert.equal(
      privilege.canUse,
      expectedUsage,
    );
    assert.equal(
      privilege.canCreate,
      privilege.roleName === "algym_migrator",
    );
  }

  const publicCreateSchemaAcl = await pool.query(`
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        namespace.nspacl,
        pg_catalog.acldefault('n', namespace.nspowner)
      )
    ) AS privilege
    WHERE namespace.nspname IN ('auth', 'private', 'public')
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'CREATE'
  `);
  assert.deepEqual(publicCreateSchemaAcl.rows, []);

  const catalogTables = [
    "permissions",
    "role_permissions",
    "roles",
  ];
  const effectiveTablePrivileges = await pool.query<{
    canDelete: boolean;
    canInsert: boolean;
    canSelect: boolean;
    canUpdate: boolean;
    roleName: string;
    tableName: string;
  }>(`
    SELECT
      role_name AS "roleName",
      table_name AS "tableName",
      pg_catalog.has_table_privilege(
        role_name,
        pg_catalog.format('public.%I', table_name),
        'SELECT'
      ) AS "canSelect",
      pg_catalog.has_table_privilege(
        role_name,
        pg_catalog.format('public.%I', table_name),
        'INSERT'
      ) AS "canInsert",
      pg_catalog.has_table_privilege(
        role_name,
        pg_catalog.format('public.%I', table_name),
        'UPDATE'
      ) AS "canUpdate",
      pg_catalog.has_table_privilege(
        role_name,
        pg_catalog.format('public.%I', table_name),
        'DELETE'
      ) AS "canDelete"
    FROM unnest($1::text[]) AS runtime_role(role_name)
    CROSS JOIN unnest($2::text[]) AS catalog_table(table_name)
  `, [databaseRoles, catalogTables]);

  for (const privilege of effectiveTablePrivileges.rows) {
    const migrator = privilege.roleName === "algym_migrator";
    const application = privilege.roleName === "algym_app";
    const applicationCanWrite =
      privilege.tableName === "roles" ||
      privilege.tableName === "role_permissions";

    assert.equal(privilege.canSelect, migrator || application);
    assert.equal(
      privilege.canInsert,
      migrator || (application && applicationCanWrite),
    );
    assert.equal(
      privilege.canUpdate,
      migrator || (application && privilege.tableName === "roles"),
    );
    assert.equal(
      privilege.canDelete,
      migrator || (application && applicationCanWrite),
    );
  }

  const publicCatalogTableAcl = await pool.query(`
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS privilege
    WHERE namespace.nspname = 'public'
      AND relation.relname IN ('permissions', 'role_permissions', 'roles')
      AND privilege.grantee = 0
  `);
  assert.deepEqual(publicCatalogTableAcl.rows, []);
});

test("las politicas usan exclusivamente helpers privados", async () => {
  const policies = await pool.query<{
    checkExpression: string | null;
    policyExpression: string | null;
    roles: string;
  }>(`
    SELECT
      qual AS "policyExpression",
      with_check AS "checkExpression",
      roles
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('permissions', 'role_permissions', 'roles')
  `);

  assert.equal(policies.rowCount, 8);
  for (const policy of policies.rows) {
    assert.equal(policy.roles, "{algym_app}");
    const expressions = [
      policy.policyExpression,
      policy.checkExpression,
    ].filter((value): value is string => value !== null);

    assert.ok(expressions.length > 0);
    for (const expression of expressions) {
      assert.match(expression, /private\./);
      assert.doesNotMatch(
        expression,
        /\b(?:roles|permissions|role_permissions)\b\s+(?:AS\s+)?[a-z]/i,
      );
    }
  }
});

test("claims irrelevantes no sustituyen app.current_user_id", async () => {
  const employee = createSyntheticUser("employee");
  const unrelatedUser = createSyntheticUser("owner");

  // app.current_user_id es la identidad efectiva de auth.uid(). algym_app es
  // una frontera de confianza porque puede configurar ese GUC. El backend
  // evita que el navegador lo controle al pasar a withUserTransaction solo el
  // userId obtenido por validateSessionToken; los userId de body, query o
  // headers no sustituyen ese argumento de identidad validada.

  await assertRlsRejected(() =>
    withUserTransaction(employee.userId, async (connection) => {
      const identityBefore = await connection.query<{ userId: string }>(
        "SELECT auth.uid()::text AS \"userId\"",
      );
      assert.equal(identityBefore.rows[0]?.userId, employee.userId);

      await connection.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true)",
        [unrelatedUser.userId],
      );
      await connection.query(
        "SELECT set_config('request.jwt.claim.role', 'owner', true)",
      );
      await connection.query(
        "SELECT set_config('app.permissions', 'roles.create', true)",
      );

      const identityAfter = await connection.query<{ userId: string }>(
        "SELECT auth.uid()::text AS \"userId\"",
      );
      assert.equal(identityAfter.rows[0]?.userId, employee.userId);

      await connection.query(`
        INSERT INTO public.roles (slug, name, scope)
        VALUES (
          'zz_rbac_hardening_browser_claim',
          'Claim controlado por navegador',
          'panel'
        )
      `);
    }),
  );
});

test("require_cash_operator usa la identidad efectiva del actor", async () => {
  const permissionFixture = grantSyntheticPermissions("employee", [
    { action: "operate", key: "cash.operate", module: "cash" },
  ]);
  const owner = createSyntheticUser("owner");
  const cashOperator = createSyntheticUser("employee");

  try {
    const ownerRole = await withUserTransaction(
      owner.userId,
      async (connection) => {
        const result = await connection.query<{ role: string }>(
          "SELECT public.require_cash_operator($1) AS role",
          [owner.userId],
        );
        return result.rows[0]?.role;
      },
    );
    assert.equal(ownerRole, "owner");

    const operatorRole = await withUserTransaction(
      cashOperator.userId,
      async (connection) => {
        const result = await connection.query<{ role: string }>(
          "SELECT public.require_cash_operator($1) AS role",
          [cashOperator.userId],
        );
        return result.rows[0]?.role;
      },
    );
    assert.equal(operatorRole, "employee");

    await assert.rejects(
      () =>
        withUserTransaction(owner.userId, (connection) =>
          connection.query(
            "SELECT public.require_cash_operator($1)",
            [cashOperator.userId],
          ),
        ),
      /Identidad de usuario no autorizada/,
    );
  } finally {
    restorePermissionFixture(permissionFixture);
  }
});
