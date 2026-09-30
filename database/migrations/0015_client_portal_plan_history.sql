BEGIN;

-- El socio puede consultar el nombre y precio de planes ligados a sus
-- membresías, incluso cuando el plan ya no está activo. No concede acceso a
-- planes históricos de otros socios.
DROP POLICY IF EXISTS plans_subscribed_client_read ON public.plans;
CREATE POLICY plans_subscribed_client_read ON public.plans
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      WHERE subscription.plan_id = plans.id
        AND subscription.user_id = auth.uid()
    )
  );

COMMIT;
