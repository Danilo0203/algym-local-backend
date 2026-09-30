BEGIN;

-- El rol del reloj solo lee los campos necesarios para decidir el acceso.
GRANT SELECT (start_date, grace_days)
  ON public.subscriptions TO algym_sync;
GRANT EXECUTE ON FUNCTION public.subscription_access_until(date, integer)
  TO algym_sync;

DROP POLICY IF EXISTS sync_subscriptions_expire ON public.subscriptions;
CREATE POLICY sync_subscriptions_expire ON public.subscriptions
  FOR UPDATE TO algym_sync
  USING (
    status = 'active'::public.sub_status
    AND public.subscription_access_until(end_date, grace_days)
        < (now() AT TIME ZONE 'America/Guatemala')::date
  )
  WITH CHECK (status = 'expired'::public.sub_status);

COMMIT;
