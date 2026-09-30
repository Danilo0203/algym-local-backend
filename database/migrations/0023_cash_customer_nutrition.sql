BEGIN;

CREATE POLICY "Cash intake can insert new customer nutrition snapshot"
ON public.training_nutrition_snapshots
FOR INSERT TO authenticated
WITH CHECK (
  user_id::text = current_setting('app.new_cash_customer_id', true)
  AND public.has_permission('customers.create')
  AND public.has_permission('cash.operate')
);

COMMIT;
