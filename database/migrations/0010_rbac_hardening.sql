BEGIN;

-- Modelo de confianza RBAC aprobado:
-- - admin es un administrador RBAC plenamente confiable. Puede administrar
--   roles de sistema o protegidos, sus permisos y los roles de perfiles,
--   incluido owner. is_protected evita cambios accidentales en interfaces
--   ordinarias, pero no es una frontera de seguridad frente a admin.
-- - todos los perfiles cuyo rol tenga scope = 'panel' pueden consultar el
--   catálogo RBAC; roles.view no limita esa visibilidad.
-- - algym_app es una frontera de confianza. auth.uid() lee
--   app.current_user_id y cualquier actor capaz de ejecutar SQL arbitrario
--   como algym_app puede configurar ese GUC e impersonar otro UUID.
-- - la protección frente al navegador depende de que el backend entregue a
--   withUserTransaction exclusivamente el userId de una sesión validada.

CREATE SCHEMA IF NOT EXISTS private AUTHORIZATION algym_migrator;
ALTER SCHEMA private OWNER TO algym_migrator;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO algym_app;

CREATE OR REPLACE FUNCTION private.rbac_catalog_visible()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    JOIN public.roles AS role
      ON role.slug = profile.role::text
    WHERE profile.id = auth.uid()
      AND role.scope = 'panel'
  )
$$;

ALTER FUNCTION private.rbac_catalog_visible() OWNER TO algym_migrator;

CREATE OR REPLACE FUNCTION private.current_actor_has_permission(
  p_permission_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.id = auth.uid()
      AND (
        profile.role = 'owner'::public.user_role
        OR EXISTS (
          SELECT 1
          FROM public.role_permissions AS role_permission
          JOIN public.permissions AS permission
            ON permission.id = role_permission.permission_id
          JOIN public.roles AS role
            ON role.id = role_permission.role_id
          WHERE role.slug = profile.role::text
            AND permission.key = p_permission_key
        )
      )
  )
$$;

ALTER FUNCTION private.current_actor_has_permission(text)
  OWNER TO algym_migrator;

CREATE OR REPLACE FUNCTION public.check_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT profile.role = 'admin'::public.user_role
    FROM public.profiles AS profile
    WHERE profile.id = auth.uid()
  ), false)
$$;

CREATE OR REPLACE FUNCTION public.get_current_permissions()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.array_agg(permission.key ORDER BY permission.key),
    '{}'::text[]
  )
  FROM public.role_permissions AS role_permission
  JOIN public.permissions AS permission
    ON permission.id = role_permission.permission_id
  JOIN public.roles AS role
    ON role.id = role_permission.role_id
  JOIN public.profiles AS profile
    ON profile.role::text = role.slug
  WHERE profile.id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.get_current_role_slug()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT role.slug
  FROM public.profiles AS profile
  JOIN public.roles AS role
    ON role.slug = profile.role::text
  WHERE profile.id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS public.user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT profile.role
  FROM public.profiles AS profile
  WHERE profile.id = auth.uid()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.get_profile_role(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT profile.role::text
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.has_permission(p_permission_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.current_actor_has_permission(p_permission_key)
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT profile.role = 'owner'::public.user_role
    FROM public.profiles AS profile
    WHERE profile.id = auth.uid()
  ), false)
$$;

-- Los diez llamadores históricos de require_cash_operator (caja, pagos,
-- inventario y ventas) construyen p_user_id a partir de auth.uid(). La
-- igualdad siguiente conserva esos flujos y rechaza identidad delegada.
CREATE OR REPLACE FUNCTION public.require_cash_operator(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_request_user_id uuid;
  v_role text;
BEGIN
  v_request_user_id := auth.uid();

  IF v_request_user_id IS NULL THEN
    RAISE EXCEPTION 'Usuario no autenticado';
  END IF;

  IF p_user_id IS DISTINCT FROM v_request_user_id THEN
    RAISE EXCEPTION 'Identidad de usuario no autorizada';
  END IF;

  v_role := public.get_profile_role(v_request_user_id);

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Perfil no encontrado';
  END IF;

  IF v_role = 'owner' THEN
    RETURN v_role;
  END IF;

  IF NOT private.current_actor_has_permission('cash.operate') THEN
    RAISE EXCEPTION 'No autorizado para operar caja';
  END IF;

  RETURN v_role;
END;
$$;

ALTER FUNCTION public.check_is_admin() OWNER TO algym_migrator;
ALTER FUNCTION public.get_current_permissions() OWNER TO algym_migrator;
ALTER FUNCTION public.get_current_role_slug() OWNER TO algym_migrator;
ALTER FUNCTION public.get_my_role() OWNER TO algym_migrator;
ALTER FUNCTION public.get_profile_role(uuid) OWNER TO algym_migrator;
ALTER FUNCTION public.has_permission(text) OWNER TO algym_migrator;
ALTER FUNCTION public.is_owner() OWNER TO algym_migrator;
ALTER FUNCTION public.require_cash_operator(uuid) OWNER TO algym_migrator;

REVOKE ALL ON FUNCTION private.rbac_catalog_visible()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.current_actor_has_permission(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.rbac_catalog_visible()
  TO algym_app;
GRANT EXECUTE ON FUNCTION private.current_actor_has_permission(text)
  TO algym_app;

REVOKE ALL ON FUNCTION public.check_is_admin()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_current_permissions()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_current_role_slug()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_my_role()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_profile_role(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.has_permission(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_owner()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.require_cash_operator(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.check_is_admin()
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.get_current_permissions()
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.get_current_role_slug()
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.get_my_role()
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.get_profile_role(uuid)
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.has_permission(text)
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.is_owner()
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.require_cash_operator(uuid)
  TO algym_app;

REVOKE ALL ON TABLE public.roles
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.permissions
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.role_permissions
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.roles
  TO algym_app;
GRANT SELECT ON TABLE public.permissions
  TO algym_app;
GRANT SELECT, INSERT, DELETE ON TABLE public.role_permissions
  TO algym_app;

DROP POLICY IF EXISTS permissions_view_panel
  ON public.permissions;
CREATE POLICY permissions_view_panel
  ON public.permissions
  FOR SELECT
  TO algym_app
  USING ((SELECT private.rbac_catalog_visible()));

DROP POLICY IF EXISTS role_permissions_delete_admin
  ON public.role_permissions;
CREATE POLICY role_permissions_delete_admin
  ON public.role_permissions
  FOR DELETE
  TO algym_app
  USING ((SELECT private.current_actor_has_permission('roles.update')));

DROP POLICY IF EXISTS role_permissions_insert_admin
  ON public.role_permissions;
CREATE POLICY role_permissions_insert_admin
  ON public.role_permissions
  FOR INSERT
  TO algym_app
  WITH CHECK ((SELECT private.current_actor_has_permission('roles.update')));

DROP POLICY IF EXISTS role_permissions_view_panel
  ON public.role_permissions;
CREATE POLICY role_permissions_view_panel
  ON public.role_permissions
  FOR SELECT
  TO algym_app
  USING ((SELECT private.rbac_catalog_visible()));

DROP POLICY IF EXISTS roles_delete_admin
  ON public.roles;
CREATE POLICY roles_delete_admin
  ON public.roles
  FOR DELETE
  TO algym_app
  USING ((SELECT private.current_actor_has_permission('roles.delete')));

DROP POLICY IF EXISTS roles_insert_admin
  ON public.roles;
CREATE POLICY roles_insert_admin
  ON public.roles
  FOR INSERT
  TO algym_app
  WITH CHECK ((SELECT private.current_actor_has_permission('roles.create')));

DROP POLICY IF EXISTS roles_update_admin
  ON public.roles;
CREATE POLICY roles_update_admin
  ON public.roles
  FOR UPDATE
  TO algym_app
  USING ((SELECT private.current_actor_has_permission('roles.update')))
  WITH CHECK ((SELECT private.current_actor_has_permission('roles.update')));

DROP POLICY IF EXISTS roles_view_all
  ON public.roles;
CREATE POLICY roles_view_all
  ON public.roles
  FOR SELECT
  TO algym_app
  USING ((SELECT private.rbac_catalog_visible()));

COMMIT;
