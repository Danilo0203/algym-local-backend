BEGIN;

CREATE TABLE public.cash_device_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.profiles(id),
  movement_id uuid REFERENCES public.cash_movements(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('drawer_auto', 'drawer_manual', 'receipt')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatching', 'sent', 'failed', 'unknown', 'expired')),
  reason text,
  message text,
  spool_job_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX cash_device_one_auto_open
  ON public.cash_device_operations(movement_id) WHERE kind = 'drawer_auto';
CREATE INDEX cash_device_actor_recent ON public.cash_device_operations(actor_user_id, created_at DESC);
ALTER TABLE public.cash_device_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_device_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cash_device_operations TO algym_app;
CREATE POLICY cash_device_read ON public.cash_device_operations FOR SELECT TO algym_app
  USING (actor_user_id = (SELECT auth.uid()) OR (SELECT public.is_owner()));
CREATE POLICY cash_device_insert ON public.cash_device_operations FOR INSERT TO algym_app
  WITH CHECK (actor_user_id = (SELECT auth.uid()) AND
    ((SELECT public.is_owner()) OR 'cash.operate' = ANY(public.get_current_permissions())));
CREATE POLICY cash_device_update ON public.cash_device_operations FOR UPDATE TO algym_app
  USING (actor_user_id = (SELECT auth.uid()))
  WITH CHECK (actor_user_id = (SELECT auth.uid()));

COMMIT;
