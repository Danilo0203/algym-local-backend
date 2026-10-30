BEGIN;

INSERT INTO public.permissions (key, description, module, action)
VALUES ('enrollment.manage', 'Administrar tarifa y reconocer inscripciones anteriores', 'enrollment', 'manage')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
WHERE r.slug IN ('admin', 'owner') AND p.key = 'enrollment.manage'
ON CONFLICT DO NOTHING;

ALTER TABLE public.payments
  ADD COLUMN payment_kind text CHECK (payment_kind IN ('membership', 'enrollment')),
  ADD COLUMN enrollment_year integer CHECK (enrollment_year BETWEEN 2000 AND 9999),
  ADD COLUMN collection_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.payments ALTER COLUMN payment_kind SET DEFAULT 'membership';
ALTER TABLE public.payments ADD CONSTRAINT enrollment_payment_shape CHECK (
  (payment_kind = 'enrollment' AND enrollment_year IS NOT NULL AND subscription_id IS NULL AND user_id IS NOT NULL)
  OR (payment_kind IS DISTINCT FROM 'enrollment' AND enrollment_year IS NULL)
);
CREATE INDEX payments_collection_idx ON public.payments (collection_id);

CREATE TABLE public.enrollment_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  fee numeric(10,2) NOT NULL CHECK (fee > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id)
);
INSERT INTO public.enrollment_settings (fee) VALUES (50);

CREATE TABLE public.customer_enrollments (
  customer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  status text NOT NULL CHECK (status IN ('needs_review', 'pending', 'paid', 'recognized')),
  payment_id uuid UNIQUE REFERENCES public.payments(id),
  amount numeric(10,2),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES public.profiles(id),
  reason text,
  PRIMARY KEY (customer_id, year),
  CHECK ((status = 'paid' AND payment_id IS NOT NULL AND amount > 0)
    OR (status <> 'paid' AND payment_id IS NULL AND amount IS NULL))
);
-- Only profiles present at activation need individual review. No income is invented.
INSERT INTO public.customer_enrollments (customer_id, year, status)
SELECT id, extract(year FROM now() AT TIME ZONE 'America/Guatemala')::int, 'needs_review'
FROM public.profiles WHERE role::text = 'client';

CREATE TABLE public.enrollment_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  year integer,
  action text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES public.profiles(id)
);

ALTER TABLE public.enrollment_settings OWNER TO algym_migrator;
ALTER TABLE public.customer_enrollments OWNER TO algym_migrator;
ALTER TABLE public.enrollment_audit OWNER TO algym_migrator;
ALTER TABLE public.enrollment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollment_audit ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON public.enrollment_settings TO algym_app;
GRANT SELECT, INSERT, UPDATE ON public.customer_enrollments TO algym_app;
GRANT SELECT, INSERT ON public.enrollment_audit TO algym_app;

CREATE POLICY enrollment_settings_read ON public.enrollment_settings FOR SELECT TO algym_app
USING (public.is_owner() OR public.has_permission('cash.operate') OR public.has_permission('customers.view')
  OR public.has_permission('plans.view') OR public.has_permission('enrollment.manage'));
CREATE POLICY enrollment_settings_write ON public.enrollment_settings FOR UPDATE TO algym_app
USING (public.is_owner() OR public.has_permission('enrollment.manage'))
WITH CHECK (updated_by = auth.uid() AND (public.is_owner() OR public.has_permission('enrollment.manage')));
CREATE POLICY enrollment_read ON public.customer_enrollments FOR SELECT TO algym_app
USING (public.is_owner() OR public.has_permission('cash.operate') OR public.has_permission('customers.view')
  OR public.has_permission('enrollment.manage'));
CREATE POLICY enrollment_insert ON public.customer_enrollments FOR INSERT TO algym_app
WITH CHECK (recorded_by = auth.uid() AND (public.is_owner() OR public.has_permission('enrollment.manage')
  OR (public.has_permission('cash.operate') AND status IN ('pending', 'paid'))));
CREATE POLICY enrollment_update ON public.customer_enrollments FOR UPDATE TO algym_app
USING (public.is_owner() OR public.has_permission('enrollment.manage') OR public.has_permission('cash.operate'))
WITH CHECK (recorded_by = auth.uid() AND (public.is_owner() OR public.has_permission('enrollment.manage')
  OR (public.has_permission('cash.operate') AND status IN ('pending', 'paid'))));
CREATE POLICY enrollment_audit_read ON public.enrollment_audit FOR SELECT TO algym_app
USING (public.is_owner() OR public.has_permission('enrollment.manage'));
CREATE POLICY enrollment_audit_insert ON public.enrollment_audit FOR INSERT TO algym_app
WITH CHECK (created_by = auth.uid() AND (public.is_owner() OR public.has_permission('enrollment.manage')
  OR public.has_permission('cash.operate')));

CREATE POLICY local_enrollment_payment_insert ON public.payments FOR INSERT TO algym_app
WITH CHECK ((public.is_owner() OR public.has_permission('cash.operate'))
  AND created_by_user_id = auth.uid() AND status = 'posted'
  AND payment_kind = 'enrollment' AND subscription_id IS NULL AND enrollment_year IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = user_id AND p.role::text = 'client'));

COMMIT;
