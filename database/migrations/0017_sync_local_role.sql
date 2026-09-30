BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'algym_sync') THEN
    CREATE ROLE algym_sync LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE algym_sync CONNECTION LIMIT 5;
REVOKE ALL ON SCHEMA public FROM algym_sync;
GRANT USAGE ON SCHEMA public TO algym_sync;
-- Las políticas heredadas para PUBLIC evalúan get_my_role() aunque la política
-- específica de sync permita la fila. Sin identidad de usuario devuelve NULL.
GRANT EXECUTE ON FUNCTION public.get_my_role() TO algym_sync;

GRANT SELECT (id, full_name, biometric_id, is_active, role)
  ON public.profiles TO algym_sync;
GRANT SELECT (id, user_id, end_date, status), UPDATE (status)
  ON public.subscriptions TO algym_sync;
GRANT SELECT (id, device_id, command, executed, created_at, return_code),
      INSERT (device_id, command, executed), UPDATE (executed, return_code)
  ON public.device_commands TO algym_sync;
GRANT SELECT (id, device_id, biometric_id, punch_time, status1, status2, status3,
              status4, status5, raw_line, created_at),
      INSERT (device_id, biometric_id, punch_time, status1, status2, status3,
              status4, status5, raw_line, created_at)
  ON public.attendance_logs TO algym_sync;
GRANT USAGE ON SEQUENCE public.device_commands_id_seq,
                        public.attendance_logs_id_seq TO algym_sync;

DROP POLICY IF EXISTS sync_profiles_select ON public.profiles;
CREATE POLICY sync_profiles_select ON public.profiles
  FOR SELECT TO algym_sync
  USING (role = 'client'::public.user_role);

DROP POLICY IF EXISTS sync_subscriptions_select ON public.subscriptions;
CREATE POLICY sync_subscriptions_select ON public.subscriptions
  FOR SELECT TO algym_sync
  USING (status IN ('active'::public.sub_status, 'expired'::public.sub_status));

DROP POLICY IF EXISTS sync_subscriptions_expire ON public.subscriptions;
CREATE POLICY sync_subscriptions_expire ON public.subscriptions
  FOR UPDATE TO algym_sync
  USING (
    status = 'active'::public.sub_status
    AND end_date < (now() AT TIME ZONE 'America/Guatemala')::date
  )
  WITH CHECK (status = 'expired'::public.sub_status);

DROP POLICY IF EXISTS sync_device_commands_select ON public.device_commands;
CREATE POLICY sync_device_commands_select ON public.device_commands
  FOR SELECT TO algym_sync USING (true);
DROP POLICY IF EXISTS sync_device_commands_insert ON public.device_commands;
CREATE POLICY sync_device_commands_insert ON public.device_commands
  FOR INSERT TO algym_sync WITH CHECK (length(device_id) > 0 AND length(command) > 0);
DROP POLICY IF EXISTS sync_device_commands_update ON public.device_commands;
CREATE POLICY sync_device_commands_update ON public.device_commands
  FOR UPDATE TO algym_sync USING (true) WITH CHECK (executed = true);

DROP POLICY IF EXISTS sync_attendance_select ON public.attendance_logs;
CREATE POLICY sync_attendance_select ON public.attendance_logs
  FOR SELECT TO algym_sync USING (true);
DROP POLICY IF EXISTS sync_attendance_insert ON public.attendance_logs;
CREATE POLICY sync_attendance_insert ON public.attendance_logs
  FOR INSERT TO algym_sync WITH CHECK (biometric_id > 0 AND length(device_id) > 0);

CREATE INDEX IF NOT EXISTS device_commands_pending_device_created_idx
  ON public.device_commands (device_id, created_at, id)
  WHERE executed = false;

-- El índice anterior trataba cada NULL como distinto y permitía que el reloj
-- reintentara indefinidamente el mismo marcaje si omitía status1/status2.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_logs_dedupe_nulls
  ON public.attendance_logs (device_id, biometric_id, punch_time, status1, status2)
  NULLS NOT DISTINCT;
DROP INDEX IF EXISTS public.uq_attendance_logs_dedupe;

COMMIT;
