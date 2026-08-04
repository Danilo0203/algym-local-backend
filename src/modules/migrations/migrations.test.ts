import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { env } from "../../config/env.js";

const sourceDatabaseName = "algym_test";
const targetDatabaseName = "algym_0005_sequence_test";
const testPlanNamePrefix = "ZZTEST MIGRATION 0005";
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "../../..");
const migrationPath = path.join(
  projectRoot,
  "database/migrations/0005_memberships_phase_b.sql",
);
const adminCustomersViewMigrationPath = path.join(
  projectRoot,
  "database/migrations/0008_admin_customers_view.sql",
);
const customersHealthMigrationPath = path.join(
  projectRoot,
  "database/migrations/0009_customers_health_assessments.sql",
);

type SequenceState = {
  isCalled: boolean;
  lastValue: number;
};

function runDatabaseCommand(command: "createdb" | "dropdb", args: string[]): void {
  execFileSync(command, args, {
    cwd: projectRoot,
    stdio: "ignore",
  });
}

function runAdminSql(sql: string): void {
  execFileSync(
    "psql",
    ["-X", "-d", targetDatabaseName, "-v", "ON_ERROR_STOP=1", "-c", sql],
    { cwd: projectRoot, stdio: "ignore" },
  );
}

function runAdminQuery(sql: string): string {
  return execFileSync(
    "psql",
    [
      "-X",
      "-d",
      targetDatabaseName,
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-c",
      sql,
    ],
    { cwd: projectRoot, encoding: "utf8" },
  ).trim();
}

function applyMigration(): void {
  execFileSync(
    "psql",
    [
      "-X",
      "-d",
      targetDatabaseName,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      migrationPath,
    ],
    { cwd: projectRoot, stdio: "ignore" },
  );
}

function applyAdminCustomersViewMigration(): void {
  execFileSync(
    "psql",
    [
      "-X",
      "-d",
      targetDatabaseName,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      adminCustomersViewMigrationPath,
    ],
    { cwd: projectRoot, stdio: "ignore" },
  );
}

function applyAdminCustomersViewMigrationExpectingFailure(): string {
  try {
    execFileSync(
      "psql",
      [
        "-X",
        "-d",
        targetDatabaseName,
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        adminCustomersViewMigrationPath,
      ],
      { cwd: projectRoot, encoding: "utf8" },
    );
  } catch (error) {
    assert.ok(error instanceof Error);
    const processError = error as Error & {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };

    return `${processError.stdout ?? ""}\n${processError.stderr ?? ""}`;
  }

  assert.fail("La migración 0008 debía fallar");
}

function applyCustomersHealthMigration(): void {
  execFileSync(
    "psql",
    [
      "-X",
      "-d",
      targetDatabaseName,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      customersHealthMigrationPath,
    ],
    { cwd: projectRoot, stdio: "ignore" },
  );
}

function applyCustomersHealthMigrationExpectingFailure(): string {
  try {
    execFileSync(
      "psql",
      [
        "-X",
        "-d",
        targetDatabaseName,
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        customersHealthMigrationPath,
      ],
      { cwd: projectRoot, encoding: "utf8" },
    );
  } catch (error) {
    assert.ok(error instanceof Error);
    const processError = error as Error & {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };

    return `${processError.stdout ?? ""}\n${processError.stderr ?? ""}`;
  }

  assert.fail("La migración 0009 debía fallar");
}

function getSequenceState(): SequenceState {
  const [lastValue, isCalled] = runAdminQuery(
    "SELECT last_value, is_called FROM public.plans_id_seq;",
  ).split("|");

  assert.ok(lastValue);
  assert.ok(isCalled);

  return {
    lastValue: Number(lastValue),
    isCalled: isCalled === "t",
  };
}

function resetIsolatedPlans(): void {
  runAdminSql(`
    TRUNCATE TABLE public.plans CASCADE;
    SELECT setval('public.plans_id_seq', 1, false);
  `);
}

before(() => {
  assert.equal(env.DB_NAME, sourceDatabaseName);
  runDatabaseCommand("dropdb", ["--if-exists", targetDatabaseName]);
  runDatabaseCommand("createdb", [
    "--owner=algym_migrator",
    `--template=${sourceDatabaseName}`,
    targetDatabaseName,
  ]);
  resetIsolatedPlans();
});

beforeEach(() => {
  resetIsolatedPlans();
});

after(() => {
  runDatabaseCommand("dropdb", ["--if-exists", targetDatabaseName]);
});

test("0005 alinea una secuencia detrás de MAX(plans.id)", () => {
  const planId = 9_950_001;

  runAdminSql(`
    INSERT INTO public.plans (id, name, price, duration_days, is_active)
    VALUES (
      ${planId},
      '${testPlanNamePrefix} DETRAS',
      100,
      30,
      true
    );
    SELECT setval('public.plans_id_seq', ${planId - 10}, true);
  `);

  applyMigration();

  assert.deepEqual(getSequenceState(), {
    lastValue: planId,
    isCalled: true,
  });
  assert.equal(
    Number(runAdminQuery("SELECT nextval('public.plans_id_seq');")),
    planId + 1,
  );
});

test("0005 no mueve hacia atrás una secuencia delante de MAX(plans.id)", () => {
  const planId = 9_950_002;
  const sequenceValue = planId + 100;

  runAdminSql(`
    INSERT INTO public.plans (id, name, price, duration_days, is_active)
    VALUES (
      ${planId},
      '${testPlanNamePrefix} DELANTE',
      100,
      30,
      true
    );
    SELECT setval('public.plans_id_seq', ${sequenceValue}, true);
  `);

  applyMigration();

  assert.deepEqual(getSequenceState(), {
    lastValue: sequenceValue,
    isCalled: true,
  });
});

test("0005 conserva la secuencia cuando plans está vacía", () => {
  const sequenceValue = 7_500;

  runAdminSql(
    `SELECT setval('public.plans_id_seq', ${sequenceValue}, true);`,
  );

  applyMigration();

  assert.equal(
    Number(runAdminQuery("SELECT count(*) FROM public.plans;")),
    0,
  );
  assert.deepEqual(getSequenceState(), {
    lastValue: sequenceValue,
    isCalled: true,
  });
});

test("0008 falla explícitamente cuando falta admin", () => {
  runAdminSql(`
    UPDATE public.roles
    SET slug = 'admin_missing_test'
    WHERE slug = 'admin';
  `);

  try {
    const output = applyAdminCustomersViewMigrationExpectingFailure();
    assert.match(output, /ROLE_ADMIN_NOT_FOUND/);
  } finally {
    runAdminSql(`
      UPDATE public.roles
      SET slug = 'admin'
      WHERE slug = 'admin_missing_test';
    `);
  }
});

test("0008 falla explícitamente cuando falta customers.view", () => {
  runAdminSql(`
    UPDATE public.permissions
    SET key = 'customers.view_missing_test'
    WHERE key = 'customers.view';
  `);

  try {
    const output = applyAdminCustomersViewMigrationExpectingFailure();
    assert.match(output, /PERMISSION_CUSTOMERS_VIEW_NOT_FOUND/);
  } finally {
    runAdminSql(`
      UPDATE public.permissions
      SET key = 'customers.view'
      WHERE key = 'customers.view_missing_test';
    `);
  }
});

test("0008 conserva una sola relación admin/customers.view al reaplicarse", () => {
  applyAdminCustomersViewMigration();
  applyAdminCustomersViewMigration();

  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM public.role_permissions
      INNER JOIN public.roles
        ON roles.id = role_permissions.role_id
      INNER JOIN public.permissions
        ON permissions.id = role_permissions.permission_id
      WHERE roles.slug = 'admin'
        AND permissions.key = 'customers.view';
    `),
    "1",
  );
});

test("0009 falla explícitamente cuando falta admin", () => {
  runAdminSql(`
    UPDATE public.roles
    SET slug = 'admin_missing_health_test'
    WHERE slug = 'admin';
  `);

  try {
    const output = applyCustomersHealthMigrationExpectingFailure();
    assert.match(output, /ROLE_ADMIN_NOT_FOUND/);
  } finally {
    runAdminSql(`
      UPDATE public.roles
      SET slug = 'admin'
      WHERE slug = 'admin_missing_health_test';
    `);
  }
});

test("0009 falla explícitamente cuando falta trainer", () => {
  runAdminSql(`
    UPDATE public.roles
    SET slug = 'trainer_missing_health_test'
    WHERE slug = 'trainer';
  `);

  try {
    const output = applyCustomersHealthMigrationExpectingFailure();
    assert.match(output, /ROLE_TRAINER_NOT_FOUND/);
  } finally {
    runAdminSql(`
      UPDATE public.roles
      SET slug = 'trainer'
      WHERE slug = 'trainer_missing_health_test';
    `);
  }
});

test("0009 se reaplica y conserva exactamente la matriz aprobada", () => {
  applyCustomersHealthMigration();
  applyCustomersHealthMigration();

  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM public.permissions
      WHERE key IN (
        'body_assessments.view',
        'body_assessments.manage',
        'customer_health_profiles.view',
        'customer_health_profiles.manage'
      );
    `),
    "4",
  );
  assert.equal(
    runAdminQuery(`
      SELECT string_agg(
        roles.slug || ':' || permissions.key,
        ','
        ORDER BY roles.slug, permissions.key
      )
      FROM public.role_permissions
      INNER JOIN public.roles
        ON roles.id = role_permissions.role_id
      INNER JOIN public.permissions
        ON permissions.id = role_permissions.permission_id
      WHERE permissions.key IN (
        'body_assessments.view',
        'body_assessments.manage',
        'customer_health_profiles.view',
        'customer_health_profiles.manage'
      );
    `),
    [
      "admin:body_assessments.manage",
      "admin:body_assessments.view",
      "admin:customer_health_profiles.manage",
      "admin:customer_health_profiles.view",
      "trainer:body_assessments.manage",
      "trainer:body_assessments.view",
      "trainer:customer_health_profiles.view",
    ].join(","),
  );
  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM public.role_permissions
      INNER JOIN public.roles
        ON roles.id = role_permissions.role_id
      INNER JOIN public.permissions
        ON permissions.id = role_permissions.permission_id
      WHERE roles.slug IN ('employee', 'client')
        AND permissions.key IN (
          'body_assessments.view',
          'body_assessments.manage',
          'customer_health_profiles.view',
          'customer_health_profiles.manage'
        );
    `),
    "0",
  );
  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM (
        SELECT role_id, permission_id, count(*)
        FROM public.role_permissions
        INNER JOIN public.permissions
          ON permissions.id = role_permissions.permission_id
        WHERE permissions.key IN (
          'body_assessments.view',
          'body_assessments.manage',
          'customer_health_profiles.view',
          'customer_health_profiles.manage'
        )
        GROUP BY role_id, permission_id
        HAVING count(*) > 1
      ) AS duplicates;
    `),
    "0",
  );
});

test("0009 habilita RLS, políticas explícitas y ACL local mínima", () => {
  assert.equal(
    runAdminQuery(`
      SELECT string_agg(relname || ':' || relrowsecurity::text, ',' ORDER BY relname)
      FROM pg_catalog.pg_class
      WHERE oid IN (
        'public.body_assessments'::regclass,
        'public.customer_health_profiles'::regclass
      );
    `),
    "body_assessments:true,customer_health_profiles:true",
  );
  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'customer_health_profiles';
    `),
    "3",
  );
  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'body_assessments';
    `),
    "3",
  );
  assert.equal(
    runAdminQuery(`
      SELECT concat_ws(',',
        has_table_privilege('anon', 'public.customer_health_profiles', 'SELECT'),
        has_table_privilege('authenticated', 'public.customer_health_profiles', 'SELECT'),
        has_table_privilege('service_role', 'public.customer_health_profiles', 'SELECT'),
        has_table_privilege('anon', 'public.body_assessments', 'SELECT'),
        has_table_privilege('authenticated', 'public.body_assessments', 'SELECT'),
        has_table_privilege('service_role', 'public.body_assessments', 'SELECT'),
        has_table_privilege('algym_app', 'public.customer_health_profiles', 'SELECT'),
        has_table_privilege('algym_app', 'public.body_assessments', 'SELECT'),
        has_table_privilege('algym_app', 'public.body_assessments', 'DELETE')
      );
    `),
    "f,f,f,f,f,f,t,t,f",
  );
  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'body_assessments'
        AND cmd = 'DELETE';
    `),
    "0",
  );
  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename IN (
          'customer_health_profiles',
          'body_assessments'
        )
        AND (
          coalesce(qual, '') LIKE '%customers.view%'
          OR coalesce(qual, '') LIKE '%customers.update%'
          OR coalesce(with_check, '') LIKE '%customers.view%'
          OR coalesce(with_check, '') LIKE '%customers.update%'
        );
    `),
    "0",
  );
});

test("0009 adapta body_assessments al contrato parcial sin tabla duplicada", () => {
  assert.equal(
    runAdminQuery(`
      SELECT concat_ws(',',
        (SELECT is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'body_assessments'
           AND column_name = 'weight_kg'),
        (SELECT is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'body_assessments'
           AND column_name = 'height_cm'),
        to_regclass('public.customer_health_profiles') IS NOT NULL,
        to_regclass('public.customer_body_assessments') IS NULL
      );
    `),
    "YES,YES,t,t",
  );
  assert.equal(
    runAdminQuery(`
      SELECT count(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'body_assessments'
        AND column_name IN ('notes', 'created_at', 'updated_at');
    `),
    "3",
  );
});

test("0005 se puede reaplicar sin volver a mover la secuencia", () => {
  const planId = 9_950_003;

  runAdminSql(`
    INSERT INTO public.plans (id, name, price, duration_days, is_active)
    VALUES (
      ${planId},
      '${testPlanNamePrefix} IDEMPOTENTE',
      100,
      30,
      true
    );
    SELECT setval('public.plans_id_seq', ${planId - 1}, true);
  `);

  applyMigration();
  const stateAfterFirstApplication = getSequenceState();
  applyMigration();

  assert.deepEqual(getSequenceState(), stateAfterFirstApplication);
  assert.equal(
    Number(runAdminQuery("SELECT nextval('public.plans_id_seq');")) >
      planId,
    true,
  );
});
