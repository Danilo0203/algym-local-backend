BEGIN;

-- El catálogo de plantillas se administra desde la API local con el permiso
-- que ya utiliza la interfaz de Rutinas.
DROP POLICY IF EXISTS "routine_blueprints_admin_trainer_all" ON public.routine_blueprints;
DROP POLICY IF EXISTS "routine_blueprint_details_admin_trainer_all" ON public.routine_blueprint_details;
DROP POLICY IF EXISTS "routine_blueprint_assignments_admin_trainer_all" ON public.routine_blueprint_assignments;

CREATE POLICY local_blueprints_all ON public.routine_blueprints
  FOR ALL TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'))
  WITH CHECK (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprint_details_all ON public.routine_blueprint_details
  FOR ALL TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'))
  WITH CHECK (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprint_assignments_all ON public.routine_blueprint_assignments
  FOR ALL TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'))
  WITH CHECK (public.is_owner() OR public.has_permission('routines.view'));

-- Guardar una rutina como plantilla y asignar una plantilla a un cliente
-- necesitan leer y modificar rutinas desde el panel de Rutinas.
CREATE POLICY local_blueprints_routines_select ON public.routines
  FOR SELECT TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprints_routines_insert ON public.routines
  FOR INSERT TO algym_app
  WITH CHECK (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprints_routines_update ON public.routines
  FOR UPDATE TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'))
  WITH CHECK (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprints_routine_details_select ON public.routine_details
  FOR SELECT TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprints_routine_details_insert ON public.routine_details
  FOR INSERT TO algym_app
  WITH CHECK (public.is_owner() OR public.has_permission('routines.view'));

COMMIT;
