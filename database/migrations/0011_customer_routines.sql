BEGIN;

INSERT INTO public.permissions (key, description, module, action)
VALUES (
  'customers.manage_routine',
  'Consultar y administrar la rutina de un cliente',
  'customers',
  'manage_routine'
)
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    module = EXCLUDED.module,
    action = EXCLUDED.action;

DROP POLICY IF EXISTS "Staff with customers.manage_routine can view routines"
ON public.routines;

DROP POLICY IF EXISTS "Users can view own routines"
ON public.routines;

DROP POLICY IF EXISTS "Admins and trainers can create routines"
ON public.routines;

DROP POLICY IF EXISTS "Creators and admins can modify routines"
ON public.routines;

DROP POLICY IF EXISTS "Only admins can delete routines"
ON public.routines;

DROP POLICY IF EXISTS "Staff with customers.manage_routine can create routines"
ON public.routines;

DROP POLICY IF EXISTS "Creators or staff with customers.manage_routine can update rout"
ON public.routines;

DROP POLICY IF EXISTS "Creators or routine staff can update routines"
ON public.routines;

CREATE POLICY "Users can view own routines"
ON public.routines
FOR SELECT
TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR created_by = (SELECT auth.uid())
);

CREATE POLICY "Staff with customers.manage_routine can view routines"
ON public.routines
FOR SELECT
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
);

CREATE POLICY "Staff with customers.manage_routine can create routines"
ON public.routines
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
);

CREATE POLICY "Creators or routine staff can update routines"
ON public.routines
FOR UPDATE
TO authenticated
USING (
  created_by = (SELECT auth.uid())
  OR public.is_owner()
  OR public.has_permission('customers.manage_routine')
)
WITH CHECK (
  created_by = (SELECT auth.uid())
  OR public.is_owner()
  OR public.has_permission('customers.manage_routine')
);

DROP POLICY IF EXISTS "Staff with customers.manage_routine can view routine details"
ON public.routine_details;

DROP POLICY IF EXISTS "Users can view own routine details"
ON public.routine_details;

DROP POLICY IF EXISTS "Admins and trainers can manage routine details"
ON public.routine_details;

DROP POLICY IF EXISTS "Staff with customers.manage_routine can insert routine details"
ON public.routine_details;

DROP POLICY IF EXISTS "Staff with customers.manage_routine can update routine details"
ON public.routine_details;

DROP POLICY IF EXISTS "Staff with customers.manage_routine can delete routine details"
ON public.routine_details;

CREATE POLICY "Users can view own routine details"
ON public.routine_details
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.routines
    WHERE routines.id = routine_details.routine_id
      AND (
        routines.user_id = (SELECT auth.uid())
        OR routines.created_by = (SELECT auth.uid())
      )
  )
);

CREATE POLICY "Staff with customers.manage_routine can view routine details"
ON public.routine_details
FOR SELECT
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
);

CREATE POLICY "Staff with customers.manage_routine can insert routine details"
ON public.routine_details
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
);

CREATE POLICY "Staff with customers.manage_routine can update routine details"
ON public.routine_details
FOR UPDATE
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
)
WITH CHECK (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
);

CREATE POLICY "Staff with customers.manage_routine can delete routine details"
ON public.routine_details
FOR DELETE
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
);

DROP POLICY IF EXISTS "training_profiles_admin_all"
ON public.training_profiles;

CREATE POLICY "training_profiles_admin_all"
ON public.training_profiles
FOR ALL
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
)
WITH CHECK (
  public.is_owner()
  OR public.has_permission('customers.manage_routine')
);

COMMIT;
