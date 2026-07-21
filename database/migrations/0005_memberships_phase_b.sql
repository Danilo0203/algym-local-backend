BEGIN;

INSERT INTO public.permissions (key, description, module, action)
VALUES
  (
    'plans.view',
    'Permite visualizar los planes de membresía',
    'plans',
    'view'
  ),
  (
    'customers.manage_membership',
    'Permite administrar membresías de clientes',
    'customers',
    'manage_membership'
  )
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    module = EXCLUDED.module,
    action = EXCLUDED.action;

DROP POLICY IF EXISTS "Staff with plans.view can view plans"
ON public.plans;

CREATE POLICY "Staff with plans.view can view plans"
ON public.plans
FOR SELECT
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('plans.view')
);

DROP POLICY IF EXISTS "Staff with customers.manage_membership can manage subscriptions"
ON public.subscriptions;

CREATE POLICY "Staff with customers.manage_membership can manage subscriptions"
ON public.subscriptions
FOR ALL
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customers.manage_membership')
)
WITH CHECK (
  public.is_owner()
  OR public.has_permission('customers.manage_membership')
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.subscriptions
    WHERE status = 'active'
    GROUP BY user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Existen clientes con más de una membresía activa. Corrija los datos antes de aplicar 0005.';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.subscriptions'::regclass
      AND conname = 'subscriptions_end_date_check'
  ) THEN
    ALTER TABLE public.subscriptions
    ADD CONSTRAINT subscriptions_end_date_check
    CHECK (end_date >= start_date);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_user_idx
ON public.subscriptions (user_id)
WHERE status = 'active';

COMMIT;
