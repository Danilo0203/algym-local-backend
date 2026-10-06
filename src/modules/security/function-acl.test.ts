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
