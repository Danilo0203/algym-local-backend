BEGIN;

-- La caja solo puede leer y marcar completa la ficha del cliente que acaba
-- de crear dentro de la misma transacción. El identificador se fija con
-- set_config(..., true), de modo que no sobrevive al commit.
CREATE POLICY "Cash intake can view new customer training"
ON public.training_profiles FOR SELECT TO authenticated
USING (
  user_id::text = current_setting('app.new_cash_customer_id', true)
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

CREATE POLICY "Cash intake can update new customer training"
ON public.training_profiles FOR UPDATE TO authenticated
USING (
  user_id::text = current_setting('app.new_cash_customer_id', true)
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
)
WITH CHECK (
  user_id::text = current_setting('app.new_cash_customer_id', true)
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

CREATE POLICY "Cash intake can view new customer assessment"
ON public.body_assessments FOR SELECT TO authenticated
USING (
  user_id::text = current_setting('app.new_cash_customer_id', true)
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

CREATE POLICY "Cash renewal can view selected assessment"
ON public.body_assessments FOR SELECT TO authenticated
USING (
  user_id::text = current_setting('app.cash_renew_customer_id', true)
  AND public.has_permission('cash.operate')
  AND public.has_permission('customers.manage_membership')
);

CREATE POLICY "Cash intake can view new customer profile"
ON public.profiles FOR SELECT TO authenticated
USING (
  id::text = current_setting('app.new_cash_customer_id', true)
  AND role = 'client'
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

CREATE POLICY "Cash intake can update new customer profile"
ON public.profiles FOR UPDATE TO authenticated
USING (
  id::text = current_setting('app.new_cash_customer_id', true)
  AND role = 'client'
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
)
WITH CHECK (
  id::text = current_setting('app.new_cash_customer_id', true)
  AND role = 'client'
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

COMMIT;
