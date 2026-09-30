BEGIN;

-- La API fija este identificador solo después de crear el cliente dentro de
-- la misma transacción. El permiso de caja no concede edición general de salud.
CREATE POLICY "Cash intake can insert new customer health"
ON public.customer_health_profiles
FOR INSERT TO authenticated
WITH CHECK (
  user_id::text = current_setting('app.new_cash_customer_id', true)
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

CREATE POLICY "Cash intake can insert new customer assessment"
ON public.body_assessments
FOR INSERT TO authenticated
WITH CHECK (
  user_id::text = current_setting('app.new_cash_customer_id', true)
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

CREATE POLICY "Cash intake can insert new customer training"
ON public.training_profiles
FOR INSERT TO authenticated
WITH CHECK (
  user_id::text = current_setting('app.new_cash_customer_id', true)
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

COMMIT;
