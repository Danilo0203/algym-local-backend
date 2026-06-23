\set ON_ERROR_STOP on

SELECT 'public_tables' AS check_name, count(*)::text AS result
FROM pg_tables
WHERE schemaname = 'public';

SELECT 'public_policies' AS check_name, count(*)::text AS result
FROM pg_policies
WHERE schemaname = 'public';

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
