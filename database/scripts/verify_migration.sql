\set ON_ERROR_STOP on

SELECT 'public_tables' AS check_name, count(*)::text AS result
FROM pg_tables
WHERE schemaname = 'public';

SELECT 'public_policies' AS check_name, count(*)::text AS result
FROM pg_policies
WHERE schemaname = 'public';

DO $$
DECLARE
  tables_without_rls text;
  broadly_executable_functions text;
BEGIN
  SELECT string_agg(relation.relname, ', ' ORDER BY relation.relname)
  INTO tables_without_rls
  FROM pg_class AS relation
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relkind IN ('r', 'p')
    AND NOT relation.relrowsecurity;

  IF tables_without_rls IS NOT NULL THEN
    RAISE EXCEPTION 'Tablas públicas sin RLS: %', tables_without_rls;
  END IF;

  SELECT string_agg(routine.oid::regprocedure::text, ', ' ORDER BY routine.oid::regprocedure::text)
  INTO broadly_executable_functions
  FROM pg_proc AS routine
  WHERE routine.pronamespace = 'public'::regnamespace
    AND routine.prosecdef
    AND (
      has_function_privilege('public', routine.oid, 'EXECUTE')
      OR has_function_privilege('anon', routine.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', routine.oid, 'EXECUTE')
      OR has_function_privilege('service_role', routine.oid, 'EXECUTE')
    );

  IF broadly_executable_functions IS NOT NULL THEN
    RAISE EXCEPTION 'Funciones privilegiadas con EXECUTE heredado: %', broadly_executable_functions;
  END IF;
END;
$$;

DO $$
DECLARE
  exposed_count integer;
BEGIN
  SELECT count(*) INTO exposed_count
  FROM pg_namespace AS schema
  CROSS JOIN pg_roles AS role
  WHERE schema.nspname IN ('public', 'auth')
    AND role.rolname IN ('anon', 'authenticated', 'service_role')
    AND has_schema_privilege(role.oid, schema.oid, 'USAGE');
  IF exposed_count > 0 THEN
    RAISE EXCEPTION '% accesos heredados a esquemas locales', exposed_count;
  END IF;

  SELECT count(*) INTO exposed_count
  FROM pg_class AS relation
  CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, '{}'::aclitem[])) AS privilege
  WHERE relation.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace)
    AND relation.relkind IN ('r', 'p', 'v', 'S')
    AND privilege.grantee IN (
      0, 'anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole
    );
  IF exposed_count > 0 THEN
    RAISE EXCEPTION '% permisos heredados en tablas, vistas o secuencias', exposed_count;
  END IF;

  SELECT count(*) INTO exposed_count
  FROM pg_proc AS routine
  CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl, '{}'::aclitem[])) AS privilege
  WHERE routine.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace)
    AND routine.proowner = 'algym_migrator'::regrole
    AND privilege.grantee IN (
      0, 'anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole
    );
  IF exposed_count > 0 THEN
    RAISE EXCEPTION '% permisos heredados en funciones de negocio', exposed_count;
  END IF;

  SELECT count(*) INTO exposed_count
  FROM pg_default_acl AS default_acl
  CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS privilege
  WHERE default_acl.defaclrole = 'algym_migrator'::regrole
    AND privilege.grantee IN (
      0, 'anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole
    );
  IF exposed_count > 0 THEN
    RAISE EXCEPTION '% permisos predeterminados heredados del migrador', exposed_count;
  END IF;

  IF NOT has_schema_privilege('algym_sync', 'auth', 'USAGE')
     OR NOT has_function_privilege('algym_sync', 'auth.uid()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'El rol algym_sync necesita auth.uid() para sus políticas RLS';
  END IF;
END;
$$;

SELECT
  'auth_profile_consistency' AS check_name,
  json_build_object(
    'auth_users', (SELECT count(*) FROM auth.users),
    'profiles', (SELECT count(*) FROM public.profiles),
    'users_without_profile', (
      SELECT count(*)
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
      WHERE p.id IS NULL
    ),
    'profiles_without_user', (
      SELECT count(*)
      FROM public.profiles p
      LEFT JOIN auth.users u ON u.id = p.id
      WHERE u.id IS NULL
    )
  )::text AS result;

DO $$
DECLARE
  fk record;
  violation_count bigint;
  total_violations bigint := 0;
BEGIN
  FOR fk IN
    SELECT
      c.conname,
      c.conrelid::regclass::text AS child_table,
      c.confrelid::regclass::text AS parent_table,
      string_agg(
        format('child.%I = parent.%I', child_col.attname, parent_col.attname),
        ' AND '
        ORDER BY columns.ordinality
      ) AS join_condition,
      string_agg(
        format('child.%I IS NOT NULL', child_col.attname),
        ' AND '
        ORDER BY columns.ordinality
      ) AS child_not_null_condition
    FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY
      AS columns(child_attnum, parent_attnum, ordinality)
      ON true
    JOIN pg_attribute child_col
      ON child_col.attrelid = c.conrelid
     AND child_col.attnum = columns.child_attnum
    JOIN pg_attribute parent_col
      ON parent_col.attrelid = c.confrelid
     AND parent_col.attnum = columns.parent_attnum
    WHERE c.contype = 'f'
      AND c.connamespace IN (
        'public'::regnamespace,
        'auth'::regnamespace
      )
    GROUP BY
      c.oid,
      c.conname,
      c.conrelid,
      c.confrelid
    ORDER BY child_table, c.conname
  LOOP
    EXECUTE format(
      'SELECT count(*)
         FROM %s AS child
         LEFT JOIN %s AS parent
           ON %s
        WHERE (%s)
          AND parent.tableoid IS NULL',
      fk.child_table,
      fk.parent_table,
      fk.join_condition,
      fk.child_not_null_condition
    )
    INTO violation_count;

    IF violation_count > 0 THEN
      total_violations := total_violations + violation_count;

      RAISE WARNING
        'FK %: % -> % tiene % registros huérfanos',
        fk.conname,
        fk.child_table,
        fk.parent_table,
        violation_count;
    ELSE
      RAISE NOTICE
        'FK %: correcta',
        fk.conname;
    END IF;
  END LOOP;

  IF total_violations > 0 THEN
    RAISE EXCEPTION
      'Se encontraron % violaciones de llaves foráneas',
      total_violations;
  END IF;

  RAISE NOTICE 'Todas las llaves foráneas son válidas';
END
$$;

SELECT
  tgrelid::regclass AS table_name,
  tgname AS trigger_name,
  tgenabled
FROM pg_trigger
WHERE NOT tgisinternal
ORDER BY tgrelid::regclass::text, tgname;
