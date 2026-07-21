BEGIN;

DO $$
DECLARE
  v_admin_role_id uuid;
  v_permission_id uuid;
BEGIN
  SELECT roles.id
  INTO v_admin_role_id
  FROM public.roles AS roles
  WHERE roles.slug = 'admin'
  LIMIT 1;

  IF v_admin_role_id IS NULL THEN
    RAISE EXCEPTION 'ROLE_ADMIN_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT permissions.id
  INTO v_permission_id
  FROM public.permissions AS permissions
  WHERE permissions.key = 'customers.view'
  LIMIT 1;

  IF v_permission_id IS NULL THEN
    RAISE EXCEPTION 'PERMISSION_CUSTOMERS_VIEW_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.role_permissions (role_id, permission_id)
  VALUES (v_admin_role_id, v_permission_id)
  ON CONFLICT (role_id, permission_id) DO NOTHING;
END
$$;

COMMIT;
