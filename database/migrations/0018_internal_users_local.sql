BEGIN;

-- Los usuarios internos no necesitan fecha de nacimiento ni PIN de reloj.
-- Los clientes conservan ambas obligaciones de datos.
ALTER TABLE public.profiles
  ALTER COLUMN birth_date DROP NOT NULL,
  ALTER COLUMN biometric_id DROP NOT NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_client_required_fields,
  ADD CONSTRAINT profiles_client_required_fields
    CHECK (role IS DISTINCT FROM 'client'::public.user_role
           OR (birth_date IS NOT NULL AND biometric_id IS NOT NULL));

DROP POLICY IF EXISTS local_internal_users_select ON public.profiles;
CREATE POLICY local_internal_users_select ON public.profiles
  FOR SELECT TO algym_app
  USING (
    role IN ('owner'::public.user_role, 'admin'::public.user_role,
             'trainer'::public.user_role, 'employee'::public.user_role)
    AND (public.is_owner() OR public.has_permission('users.view')
         OR public.has_permission('users.update') OR public.has_permission('users.delete'))
  );

DROP POLICY IF EXISTS local_internal_users_insert ON public.profiles;
CREATE POLICY local_internal_users_insert ON public.profiles
  FOR INSERT TO algym_app
  WITH CHECK (
    role IN ('owner'::public.user_role, 'admin'::public.user_role,
             'trainer'::public.user_role, 'employee'::public.user_role)
    AND (public.is_owner() OR public.has_permission('users.create'))
  );

DROP POLICY IF EXISTS local_internal_users_update ON public.profiles;
CREATE POLICY local_internal_users_update ON public.profiles
  FOR UPDATE TO algym_app
  USING (
    role IN ('owner'::public.user_role, 'admin'::public.user_role,
             'trainer'::public.user_role, 'employee'::public.user_role)
    AND (public.is_owner() OR public.has_permission('users.update')
         OR public.has_permission('users.delete'))
  )
  WITH CHECK (
    role IN ('owner'::public.user_role, 'admin'::public.user_role,
             'trainer'::public.user_role, 'employee'::public.user_role)
    AND (public.is_owner() OR public.has_permission('users.update')
         OR public.has_permission('users.delete'))
  );

COMMIT;
