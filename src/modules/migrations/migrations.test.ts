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
