BEGIN;

-- Conservar para la API las operaciones DML que algym_app ya podía ejecutar
-- (muchas llegaban por su membresía en authenticated), sin trasladar los
-- privilegios heredados de TRUNCATE, TRIGGER, REFERENCES o MAINTAIN.
DO $$
DECLARE
  relation_record record;
  allowed_privileges text[];
  privilege_name text;
BEGIN
  FOR relation_record IN
    SELECT relation.oid, relation.oid::regclass AS name, relation.relkind
    FROM pg_class AS relation
    JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
    WHERE schema.nspname IN ('public', 'auth')
      AND relation.relkind IN ('r', 'p', 'v', 'S')
  LOOP
    allowed_privileges := ARRAY[]::text[];

    IF relation_record.relkind = 'S' THEN
      FOREACH privilege_name IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
        IF has_sequence_privilege('algym_app', relation_record.oid, privilege_name) THEN
          allowed_privileges := array_append(allowed_privileges, privilege_name);
        END IF;
      END LOOP;

      IF cardinality(allowed_privileges) > 0 THEN
        EXECUTE format(
          'GRANT %s ON SEQUENCE %s TO algym_app',
          array_to_string(allowed_privileges, ', '), relation_record.name
        );
      END IF;
    ELSE
      FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF relation_record.relkind <> 'v' OR privilege_name = 'SELECT' THEN
          IF has_table_privilege('algym_app', relation_record.oid, privilege_name) THEN
            allowed_privileges := array_append(allowed_privileges, privilege_name);
          END IF;
        END IF;
      END LOOP;

      IF cardinality(allowed_privileges) > 0 THEN
        EXECUTE format(
          'GRANT %s ON TABLE %s TO algym_app',
          array_to_string(allowed_privileges, ', '), relation_record.name
        );
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- Las funciones de negocio pertenecen a algym_migrator. Mantener la ejecución
-- efectiva que ya tenía algym_app y quitar el acceso Data API heredado.
DO $$
DECLARE
  routine_record record;
BEGIN
  FOR routine_record IN
    SELECT routine.oid, routine.oid::regprocedure AS signature
    FROM pg_proc AS routine
    JOIN pg_namespace AS schema ON schema.oid = routine.pronamespace
    WHERE schema.nspname IN ('public', 'auth')
      AND routine.proowner = 'algym_migrator'::regrole
  LOOP
    IF has_function_privilege('algym_app', routine_record.oid, 'EXECUTE') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO algym_app', routine_record.signature);
    END IF;
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      routine_record.signature
    );
  END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA public, auth TO algym_app;
GRANT USAGE ON SCHEMA public TO algym_sync;
-- Las políticas RLS que filtran lecturas/escrituras del reloj usan auth.uid().
GRANT USAGE ON SCHEMA auth TO algym_sync;
GRANT EXECUTE ON FUNCTION auth.uid() TO algym_sync;

REVOKE ALL ON ALL TABLES IN SCHEMA public, auth
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, auth
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SCHEMA public, auth
  FROM PUBLIC, anon, authenticated, service_role;

-- Evitar que una tabla, secuencia o función nueva del migrador recupere los
-- permisos amplios del esquema antiguo.
ALTER DEFAULT PRIVILEGES FOR ROLE algym_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE algym_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE algym_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE algym_migrator IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

COMMIT;
