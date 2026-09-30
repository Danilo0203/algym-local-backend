BEGIN;

DROP POLICY IF EXISTS "Admins and trainers can manage exercises" ON public.exercises;
DROP POLICY IF EXISTS "Local exercises insert" ON public.exercises;
DROP POLICY IF EXISTS "Local exercises update" ON public.exercises;

CREATE POLICY "Local exercises insert" ON public.exercises
FOR INSERT TO authenticated
WITH CHECK (public.is_owner() OR public.has_permission('exercises.create'));

CREATE POLICY "Local exercises update" ON public.exercises
FOR UPDATE TO authenticated
USING (public.is_owner() OR public.has_permission('exercises.update'))
WITH CHECK (public.is_owner() OR public.has_permission('exercises.update'));

DROP POLICY IF EXISTS "Local routine detail name update" ON public.routine_details;
CREATE POLICY "Local routine detail name update" ON public.routine_details
FOR UPDATE TO authenticated
USING (public.is_owner() OR public.has_permission('exercises.update'))
WITH CHECK (public.is_owner() OR public.has_permission('exercises.update'));

REVOKE INSERT, UPDATE, DELETE ON public.exercises FROM anon;
REVOKE DELETE ON public.exercises FROM authenticated;

COMMIT;
