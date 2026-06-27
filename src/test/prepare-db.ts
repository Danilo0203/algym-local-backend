import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

dotenv.config({
  path: process.env.ALGYM_ENV_FILE?.trim() || ".env",
});

const targetDatabaseName = "algym_test";

const dbHost = process.env.DB_HOST?.trim() || "127.0.0.1";
const dbPort = process.env.DB_PORT?.trim() || "5432";
const adminUser = process.env.TEST_DB_ADMIN_USER?.trim() || "";
const dbPassword = process.env.TEST_DB_ADMIN_PASSWORD ?? "";
const dbOwner =
  process.env.TEST_DB_OWNER?.trim() || "algym_migrator";

const environment = {
  ...process.env,
  ...(dbPassword ? { PGPASSWORD: dbPassword } : {}),
};

const currentDirectory = path.dirname(
  fileURLToPath(import.meta.url),
);
const projectRoot = path.resolve(currentDirectory, "../..");
const migrationDirectory = path.join(
  projectRoot,
  "database",
  "migrations",
);
const syntheticAuthorizationSeedSql = `
  INSERT INTO public.roles (slug, name, scope, is_system, is_protected)
  VALUES
    ('client', 'client', 'client', true, false),
    ('employee', 'employee', 'panel', true, false),
    ('owner', 'owner', 'panel', true, false)
  ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      scope = EXCLUDED.scope;

  INSERT INTO public.permissions (key, description, module, action)
  VALUES
    ('customers.create', 'Permiso sintético customers.create', 'customers', 'create'),
    ('customers.update', 'Permiso sintético customers.update', 'customers', 'update'),
    ('customers.view', 'Permiso sintético customers.view', 'customers', 'view'),
    ('dashboard.view', 'Permiso sintético dashboard.view', 'dashboard', 'view'),
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
      (r.slug = 'employee' AND p.key IN ('customers.create', 'customers.update', 'customers.view', 'dashboard.view', 'profile.view', 'profile.update'))
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
  syntheticAuthorizationSeedSql,
]);
