BEGIN;

DROP POLICY IF EXISTS "Staff with customers.view can view customer attendance"
ON public.attendance_logs;

CREATE POLICY "Staff with customers.view can view customer attendance"
ON public.attendance_logs
FOR SELECT
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customers.view')
);

DROP POLICY IF EXISTS "Staff with customers.view can view body assessments"
ON public.body_assessments;

CREATE POLICY "Staff with customers.view can view body assessments"
ON public.body_assessments
FOR SELECT
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customers.view')
);

COMMIT;
