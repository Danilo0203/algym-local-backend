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
