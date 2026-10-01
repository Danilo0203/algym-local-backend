-- ALTER TYPE debe confirmarse antes de usar el nuevo valor en la misma sesión.
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'custom';

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS panel_role_id uuid REFERENCES public.roles(id) ON DELETE RESTRICT;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_custom_panel_role_pair,
  ADD CONSTRAINT profiles_custom_panel_role_pair CHECK (
    (role IS NOT DISTINCT FROM 'custom'::public.user_role) = (panel_role_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION private.validate_profile_panel_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.role = 'custom'::public.user_role THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.roles AS r
      WHERE r.id = NEW.panel_role_id AND r.scope = 'panel' AND r.is_system = false
    ) THEN
      RAISE EXCEPTION 'Rol personalizado de panel no válido' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.panel_role_id IS NOT NULL THEN
    RAISE EXCEPTION 'Un rol del sistema no admite panel_role_id' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.validate_profile_panel_role() OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION private.validate_profile_panel_role() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS profiles_validate_panel_role ON public.profiles;
CREATE TRIGGER profiles_validate_panel_role
  BEFORE INSERT OR UPDATE OF role, panel_role_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.validate_profile_panel_role();

CREATE OR REPLACE FUNCTION private.effective_panel_role_id(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN p.role = 'custom'::public.user_role THEN p.panel_role_id ELSE r.id END
  FROM public.profiles AS p
  LEFT JOIN public.roles AS r ON r.slug = p.role::text
  WHERE p.id = p_user_id
  LIMIT 1
$$;
ALTER FUNCTION private.effective_panel_role_id(uuid) OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION private.effective_panel_role_id(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.rbac_catalog_visible()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.roles AS r
    WHERE r.id = private.effective_panel_role_id(auth.uid()) AND r.scope = 'panel'
  )
$$;

CREATE OR REPLACE FUNCTION private.current_actor_has_permission(p_permission_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = auth.uid()
      AND (p.role = 'owner'::public.user_role OR EXISTS (
        SELECT 1 FROM public.role_permissions AS rp
        JOIN public.permissions AS permission ON permission.id = rp.permission_id
        WHERE rp.role_id = private.effective_panel_role_id(p.id)
          AND permission.key = p_permission_key
      ))
  )
$$;

CREATE OR REPLACE FUNCTION public.get_current_permissions()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(pg_catalog.array_agg(permission.key ORDER BY permission.key), '{}'::text[])
  FROM public.role_permissions AS rp
  JOIN public.permissions AS permission ON permission.id = rp.permission_id
  WHERE rp.role_id = private.effective_panel_role_id(auth.uid())
$$;

CREATE OR REPLACE FUNCTION public.get_current_role_slug()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.slug FROM public.roles AS r
  WHERE r.id = private.effective_panel_role_id(auth.uid())
$$;

CREATE OR REPLACE FUNCTION public.get_current_role_scope()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.scope FROM public.roles AS r
  WHERE r.id = private.effective_panel_role_id(auth.uid())
$$;
ALTER FUNCTION public.get_current_role_scope() OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION public.get_current_role_scope() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_current_role_scope() TO algym_app;

CREATE OR REPLACE FUNCTION public.get_profile_role(p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.slug FROM public.roles AS r
  WHERE r.id = private.effective_panel_role_id(p_user_id)
$$;

DROP POLICY IF EXISTS local_internal_users_select ON public.profiles;
CREATE POLICY local_internal_users_select ON public.profiles
  FOR SELECT TO algym_app
  USING (
    role IN ('owner'::public.user_role, 'admin'::public.user_role,
             'trainer'::public.user_role, 'employee'::public.user_role,
             'custom'::public.user_role)
    AND (public.is_owner() OR public.has_permission('users.view')
         OR public.has_permission('users.update') OR public.has_permission('users.delete'))
  );

DROP POLICY IF EXISTS local_internal_users_insert ON public.profiles;
CREATE POLICY local_internal_users_insert ON public.profiles
  FOR INSERT TO algym_app
  WITH CHECK (
    role IN ('owner'::public.user_role, 'admin'::public.user_role,
             'trainer'::public.user_role, 'employee'::public.user_role,
             'custom'::public.user_role)
    AND (public.is_owner() OR public.has_permission('users.create'))
  );

DROP POLICY IF EXISTS local_internal_users_update ON public.profiles;
CREATE POLICY local_internal_users_update ON public.profiles
  FOR UPDATE TO algym_app
  USING (
    role IN ('owner'::public.user_role, 'admin'::public.user_role,
             'trainer'::public.user_role, 'employee'::public.user_role,
             'custom'::public.user_role)
    AND (public.is_owner() OR public.has_permission('users.update')
         OR public.has_permission('users.delete'))
  )
  WITH CHECK (
    role IN ('owner'::public.user_role, 'admin'::public.user_role,
             'trainer'::public.user_role, 'employee'::public.user_role,
             'custom'::public.user_role)
    AND (public.is_owner() OR public.has_permission('users.update')
         OR public.has_permission('users.delete'))
  );

DROP POLICY IF EXISTS local_custom_client_profiles_select ON public.profiles;
CREATE POLICY local_custom_client_profiles_select ON public.profiles
  FOR SELECT TO algym_app
  USING (
    role = 'client'::public.user_role
    AND public.get_current_role_scope() = 'panel'
    AND (
      public.is_owner() OR public.has_permission('customers.view')
      OR public.has_permission('customers.create')
      OR public.has_permission('customers.update')
      OR public.has_permission('customers.manage_account')
      OR public.has_permission('customers.manage_membership')
      OR public.has_permission('customers.manage_routine')
      OR public.has_permission('payments.view')
    )
  );

DROP POLICY IF EXISTS local_custom_payments_subscription_select ON public.subscriptions;
CREATE POLICY local_custom_payments_subscription_select ON public.subscriptions
  FOR SELECT TO algym_app
  USING (
    public.get_current_role_scope() = 'panel'
    AND public.has_permission('payments.view')
  );

DROP POLICY IF EXISTS local_custom_payments_plan_select ON public.plans;
CREATE POLICY local_custom_payments_plan_select ON public.plans
  FOR SELECT TO algym_app
  USING (
    public.get_current_role_scope() = 'panel'
    AND public.has_permission('payments.view')
  );

-- Las políticas heredadas de inventario solo reconocen los slugs fijos.
-- Un rol custom necesita SELECT para INSERT ... RETURNING y para leer el
-- catálogo; cada permiso sigue controlando su operación en la API y RLS.
DROP POLICY IF EXISTS products_select_by_permission ON public.products;
CREATE POLICY products_select_by_permission ON public.products
  FOR SELECT TO authenticated
  USING (
    public.is_owner() OR public.has_permission('products.view')
    OR public.has_permission('products.create')
    OR public.has_permission('products.update')
    OR public.has_permission('products.delete')
    OR public.has_permission('inventory.view')
    OR public.has_permission('inventory.adjust')
  );

DROP POLICY IF EXISTS inventory_movements_select_by_permission ON public.inventory_movements;
CREATE POLICY inventory_movements_select_by_permission ON public.inventory_movements
  FOR SELECT TO authenticated
  USING (
    public.is_owner() OR public.has_permission('inventory.view')
    OR public.has_permission('inventory.adjust')
  );

DROP POLICY IF EXISTS inventory_movements_insert_by_permission ON public.inventory_movements;
CREATE POLICY inventory_movements_insert_by_permission ON public.inventory_movements
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner() OR public.has_permission('inventory.adjust'));

COMMIT;
