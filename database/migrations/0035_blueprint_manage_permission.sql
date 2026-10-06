BEGIN;

-- El permiso de lectura deja de autorizar escrituras de plantillas. Los roles
-- que ya tenían routines.view conservan su capacidad anterior al migrar.
INSERT INTO public.permissions (key, description, module, action)
VALUES (
  'routines.manage_blueprints',
  'Crear, editar y asignar plantillas de rutina',
  'routines',
  'manage'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT existing.role_id, manage.id
FROM public.role_permissions AS existing
JOIN public.permissions AS view_permission
  ON view_permission.id = existing.permission_id
JOIN public.permissions AS manage
  ON manage.key = 'routines.manage_blueprints'
WHERE view_permission.key = 'routines.view'
ON CONFLICT DO NOTHING;

DROP POLICY IF EXISTS local_blueprints_all ON public.routine_blueprints;
DROP POLICY IF EXISTS local_blueprint_details_all ON public.routine_blueprint_details;
DROP POLICY IF EXISTS local_blueprint_assignments_all ON public.routine_blueprint_assignments;

CREATE POLICY local_blueprints_read ON public.routine_blueprints
  FOR SELECT TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprints_write ON public.routine_blueprints
  FOR ALL TO algym_app
  USING (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  )
  WITH CHECK (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  );

CREATE POLICY local_blueprint_details_read ON public.routine_blueprint_details
  FOR SELECT TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprint_details_write ON public.routine_blueprint_details
  FOR ALL TO algym_app
  USING (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  )
  WITH CHECK (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  );

CREATE POLICY local_blueprint_assignments_read ON public.routine_blueprint_assignments
  FOR SELECT TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprint_assignments_write ON public.routine_blueprint_assignments
  FOR ALL TO algym_app
  USING (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  )
  WITH CHECK (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  );

DROP POLICY IF EXISTS local_blueprints_routines_select ON public.routines;
DROP POLICY IF EXISTS local_blueprints_routines_insert ON public.routines;
DROP POLICY IF EXISTS local_blueprints_routines_update ON public.routines;
DROP POLICY IF EXISTS local_blueprints_routine_details_select ON public.routine_details;
DROP POLICY IF EXISTS local_blueprints_routine_details_insert ON public.routine_details;

CREATE POLICY local_blueprints_routines_select ON public.routines
  FOR SELECT TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprints_routines_insert ON public.routines
  FOR INSERT TO algym_app
  WITH CHECK (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  );
CREATE POLICY local_blueprints_routines_update ON public.routines
  FOR UPDATE TO algym_app
  USING (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  )
  WITH CHECK (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  );
CREATE POLICY local_blueprints_routine_details_select ON public.routine_details
  FOR SELECT TO algym_app
  USING (public.is_owner() OR public.has_permission('routines.view'));
CREATE POLICY local_blueprints_routine_details_insert ON public.routine_details
  FOR INSERT TO algym_app
  WITH CHECK (
    public.is_owner() OR
    (public.has_permission('routines.view') AND public.has_permission('routines.manage_blueprints'))
  );

COMMIT;
