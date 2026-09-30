BEGIN;

-- El backend fija el cliente solo durante la transacción de renovación.
-- Los permisos de caja no se convierten en edición general de fichas.
CREATE POLICY "Cash renewal can view selected customer profile"
ON public.profiles FOR SELECT TO authenticated
USING (
  id::text = current_setting('app.cash_renew_customer_id', true)
  AND role = 'client'
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can update selected customer profile"
ON public.profiles FOR UPDATE TO authenticated
USING (
  id::text = current_setting('app.cash_renew_customer_id', true)
  AND role = 'client'
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
)
WITH CHECK (
  id::text = current_setting('app.cash_renew_customer_id', true)
  AND role = 'client'
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can view selected health profile"
ON public.customer_health_profiles FOR SELECT TO authenticated
USING (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can insert selected health profile"
ON public.customer_health_profiles FOR INSERT TO authenticated
WITH CHECK (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can update selected health profile"
ON public.customer_health_profiles FOR UPDATE TO authenticated
USING (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
)
WITH CHECK (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can insert selected assessment"
ON public.body_assessments FOR INSERT TO authenticated
WITH CHECK (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can insert selected nutrition snapshot"
ON public.training_nutrition_snapshots FOR INSERT TO authenticated
WITH CHECK (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can view selected training profile"
ON public.training_profiles FOR SELECT TO authenticated
USING (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can insert selected training profile"
ON public.training_profiles FOR INSERT TO authenticated
WITH CHECK (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash renewal can update selected training profile"
ON public.training_profiles FOR UPDATE TO authenticated
USING (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
)
WITH CHECK (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

COMMIT;
