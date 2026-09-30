BEGIN;

-- UPDATE sobre routine_details también necesita que las filas sean visibles al actor.
-- El dueño y los editores de ejercicios deben poder sincronizar los nombres históricos.
DROP POLICY IF EXISTS "Local exercise editors view routine details" ON public.routine_details;
CREATE POLICY "Local exercise editors view routine details" ON public.routine_details
FOR SELECT TO authenticated
USING (public.is_owner() OR public.has_permission('exercises.update'));

COMMIT;
