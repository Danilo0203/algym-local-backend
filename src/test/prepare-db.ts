import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

dotenv.config({
  path: process.env.ALGYM_ENV_FILE?.trim() || ".env",
});

const targetDatabaseName = "algym_test";

if (process.env.DB_NAME?.trim() !== targetDatabaseName) {
  throw new Error(
    `DB_NAME debe ser exactamente ${targetDatabaseName} antes de recrear la base de pruebas.`,
  );
}

const dbHost = process.env.DB_HOST?.trim() || "127.0.0.1";
const dbPort = process.env.DB_PORT?.trim() || "5432";
const adminUser = process.env.TEST_DB_ADMIN_USER?.trim() || "";
const dbPassword = process.env.TEST_DB_ADMIN_PASSWORD ?? "";
const dbOwner =
  process.env.TEST_DB_OWNER?.trim() || "algym_migrator";

if (!["127.0.0.1", "localhost", "::1"].includes(dbHost)) {
  throw new Error("Las pruebas destructivas solo pueden apuntar a PostgreSQL local.");
}

for (const inheritedHost of [process.env.PGHOST, process.env.PGHOSTADDR]) {
  if (inheritedHost && !["127.0.0.1", "localhost", "::1"].includes(inheritedHost)) {
    throw new Error("PGHOST/PGHOSTADDR no puede dirigir pruebas a PostgreSQL remoto.");
  }
}

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  ...(dbPassword ? { PGPASSWORD: dbPassword } : {}),
};
delete environment.PGHOST;
delete environment.PGHOSTADDR;
delete environment.PGSERVICE;
delete environment.PGSERVICEFILE;

const currentDirectory = path.dirname(
  fileURLToPath(import.meta.url),
);
const projectRoot = path.resolve(currentDirectory, "../..");
const migrationDirectory = path.join(
  projectRoot,
  "database",
  "migrations",
);
const syntheticRoleSeedSql = `
  INSERT INTO public.roles (slug, name, scope, is_system, is_protected)
  VALUES
    ('admin', 'admin', 'panel', true, false),
    ('client', 'client', 'client', true, false),
    ('employee', 'employee', 'panel', true, false),
    ('owner', 'owner', 'panel', true, false),
    ('trainer', 'trainer', 'panel', true, false)
  ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      scope = EXCLUDED.scope;
`;
const syntheticAuthorizationSeedSql = `
  INSERT INTO public.permissions (key, description, module, action)
  VALUES
    ('customers.create', 'Permiso sintético customers.create', 'customers', 'create'),
    ('customers.manage_membership', 'Permiso sintético customers.manage_membership', 'customers', 'manage_membership'),
    ('customers.manage_routine', 'Permiso sintético customers.manage_routine', 'customers', 'manage_routine'),
    ('customers.update', 'Permiso sintético customers.update', 'customers', 'update'),
    ('customers.view', 'Permiso sintético customers.view', 'customers', 'view'),
    ('dashboard.view', 'Permiso sintético dashboard.view', 'dashboard', 'view'),
    ('plans.view', 'Permiso sintético plans.view', 'plans', 'view'),
    ('payments.view', 'Permiso sintético payments.view', 'payments', 'view'),
    ('profile.update', 'Permiso sintético profile.update', 'profile', 'update'),
    ('profile.view', 'Permiso sintético profile.view', 'profile', 'view'),
    ('roles.view', 'Permiso sintético roles.view', 'roles', 'view'),
    ('users.view', 'Permiso sintético users.view', 'users', 'view')
  ON CONFLICT (key) DO UPDATE
  SET description = EXCLUDED.description,
      module = EXCLUDED.module,
      action = EXCLUDED.action;

  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM public.roles AS r
  JOIN public.permissions AS p
    ON (
      (r.slug = 'employee' AND p.key IN ('customers.create', 'customers.manage_membership', 'customers.manage_routine', 'customers.update', 'customers.view', 'dashboard.view', 'payments.view', 'plans.view', 'profile.view', 'profile.update'))
      OR (r.slug = 'admin' AND p.key = 'payments.view')
      OR (r.slug = 'owner' AND p.key IN ('dashboard.view', 'roles.view', 'users.view'))
    )
  ON CONFLICT (role_id, permission_id) DO NOTHING;
`;

const connectionArguments = adminUser
  ? [
      "-h",
      dbHost,
      "-p",
      dbPort,
      "-U",
      adminUser,
    ]
  : [];

function runCommand(
  command: string,
  args: string[],
): void {
  execFileSync(command, args, {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
  });
}

runCommand("dropdb", [
  ...connectionArguments,
  "--if-exists",
  targetDatabaseName,
]);

runCommand("createdb", [
  ...connectionArguments,
  "--owner",
  dbOwner,
  "--encoding",
  "UTF8",
  targetDatabaseName,
]);

for (const migrationName of [
  "0001_local_auth_compat.sql",
  "0002_algym_schema.sql",
  "0003_local_auth_sessions.sql",
  "0004_customers_phase_a.sql",
  "0005_memberships_phase_b.sql",
  "0006_customers_read_history.sql",
]) {
  runCommand("psql", [
    ...connectionArguments,
    "-d",
    targetDatabaseName,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    path.join(migrationDirectory, migrationName),
  ]);
}

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  syntheticRoleSeedSql,
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  syntheticAuthorizationSeedSql,
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(
    migrationDirectory,
    "0007_customers_account_local.sql",
  ),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(
    migrationDirectory,
    "0008_admin_customers_view.sql",
  ),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(
    migrationDirectory,
    "0009_customers_health_assessments.sql",
  ),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(
    migrationDirectory,
    "0010_rbac_hardening.sql",
  ),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(
    migrationDirectory,
    "0011_customer_routines.sql",
  ),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0012_plans_local_writes.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0013_exercises_local_writes.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0014_exercise_editor_routine_visibility.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0015_client_portal_plan_history.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0016_message_templates_local.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0017_sync_local_role.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0018_internal_users_local.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0019_cash_local_access.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0020_membership_payments_local.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0021_local_payment_reversal.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0022_cash_customer_intake.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0023_cash_customer_nutrition.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0024_cash_customer_renewal_intake.sql"),
]);

runCommand("psql", [
  ...connectionArguments,
  "-d",
  targetDatabaseName,
  "-v",
  "ON_ERROR_STOP=1",
  "-f",
  path.join(migrationDirectory, "0025_local_product_sale_void.sql"),
]);
