import assert from "node:assert/strict";
import test from "node:test";

import { pool } from "../../db/pool.js";

test("las tablas públicas conservan RLS y las funciones privilegiadas no quedan expuestas", async () => {
  const tables = await pool.query<{ table_name: string }>(`
    SELECT relation.relname AS table_name
    FROM pg_class AS relation
    JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
    WHERE schema.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND NOT relation.relrowsecurity
    ORDER BY relation.relname
  `);
  assert.deepEqual(tables.rows, []);

  const functions = await pool.query<{ signature: string }>(`
    SELECT routine.oid::regprocedure::text AS signature
    FROM pg_proc AS routine
    JOIN pg_namespace AS schema ON schema.oid = routine.pronamespace
    WHERE schema.nspname = 'public'
      AND routine.prosecdef
      AND (
        has_function_privilege('public', routine.oid, 'EXECUTE')
        OR has_function_privilege('anon', routine.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', routine.oid, 'EXECUTE')
        OR has_function_privilege('service_role', routine.oid, 'EXECUTE')
      )
    ORDER BY signature
  `);
  assert.deepEqual(functions.rows, []);
});

test("algym_app conserva las llamadas directas de caja necesarias", async () => {
  const expected = [
    "public.attach_payment_to_cash(uuid,uuid,text,text)",
    "public.close_cash_session(uuid,numeric,text,uuid,uuid)",
    "public.find_open_cash_session_for_user(uuid)",
    "public.insert_reversal_cash_movement(uuid,uuid,text,text)",
    "public.open_cash_session(uuid,numeric,text)",
    "public.record_manual_cash_movement(uuid,text,text,numeric,text,text,uuid,numeric)",
    "public.sell_products_from_cash_session(jsonb,text,text)",
  ];

  for (const signature of expected) {
    const result = await pool.query<{ allowed: boolean }>(
      `SELECT to_regprocedure($1) IS NOT NULL
         AND has_function_privilege('algym_app', to_regprocedure($1), 'EXECUTE') AS allowed`,
      [signature],
    );
    assert.equal(result.rows[0]?.allowed, true, signature);
  }
});

test("los roles heredados no acceden a esquemas, relaciones ni funciones de negocio", async () => {
  const schemas = await pool.query<{ schema_name: string; role_name: string }>(`
    SELECT schema.nspname AS schema_name, role.rolname AS role_name
    FROM pg_namespace AS schema
    CROSS JOIN pg_roles AS role
    WHERE schema.nspname IN ('public', 'auth')
      AND role.rolname IN ('anon', 'authenticated', 'service_role')
      AND has_schema_privilege(role.oid, schema.oid, 'USAGE')
  `);
  assert.deepEqual(schemas.rows, []);

  const relations = await pool.query<{ relation_name: string }>(`
    SELECT relation.oid::regclass::text AS relation_name
    FROM pg_class AS relation
    WHERE relation.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace)
      AND relation.relkind IN ('r', 'p', 'v', 'S')
      AND EXISTS (
        SELECT 1 FROM pg_roles AS role
        WHERE role.rolname IN ('anon', 'authenticated', 'service_role')
          AND (
            CASE WHEN relation.relkind = 'S'
              THEN has_sequence_privilege(role.oid, relation.oid, 'USAGE')
                OR has_sequence_privilege(role.oid, relation.oid, 'SELECT')
                OR has_sequence_privilege(role.oid, relation.oid, 'UPDATE')
              ELSE has_table_privilege(role.oid, relation.oid, 'SELECT')
                OR has_table_privilege(role.oid, relation.oid, 'INSERT')
                OR has_table_privilege(role.oid, relation.oid, 'UPDATE')
                OR has_table_privilege(role.oid, relation.oid, 'DELETE')
            END
          )
      )
  `);
  assert.deepEqual(relations.rows, []);

  const functions = await pool.query<{ signature: string }>(`
    SELECT routine.oid::regprocedure::text AS signature
    FROM pg_proc AS routine
    WHERE routine.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace)
      AND routine.proowner = 'algym_migrator'::regrole
      AND (
        has_function_privilege('anon', routine.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', routine.oid, 'EXECUTE')
        OR has_function_privilege('service_role', routine.oid, 'EXECUTE')
      )
  `);
  assert.deepEqual(functions.rows, []);

  const defaults = await pool.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_default_acl AS default_acl
    CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS privilege
    WHERE default_acl.defaclrole = 'algym_migrator'::regrole
      AND privilege.grantee IN (
        0,
        'anon'::regrole,
        'authenticated'::regrole,
        'service_role'::regrole
      )
  `);
  assert.equal(defaults.rows[0]?.count, "0");

  const sync = await pool.query<{ auth_schema: boolean; auth_uid: boolean }>(`
    SELECT
      has_schema_privilege('algym_sync', 'auth', 'USAGE') AS auth_schema,
      has_function_privilege('algym_sync', 'auth.uid()'::regprocedure, 'EXECUTE') AS auth_uid
  `);
  assert.equal(sync.rows[0]?.auth_schema, true);
  assert.equal(sync.rows[0]?.auth_uid, true);
});
