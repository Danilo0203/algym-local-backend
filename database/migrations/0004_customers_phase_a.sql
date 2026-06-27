BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_lower_unique
ON auth.users (lower(email))
WHERE email IS NOT NULL
  AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS on_profile_created
ON public.profiles;

DROP TRIGGER IF EXISTS on_profile_created_sync_zk
ON public.profiles;

CREATE TRIGGER on_profile_created_sync_zk
AFTER INSERT ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.sync_user_to_zkteco();

INSERT INTO public.permissions (key, description, module, action)
VALUES
  (
    'customers.view',
    'Permite consultar clientes',
    'customers',
    'view'
  ),
  (
    'customers.create',
    'Permite registrar clientes',
    'customers',
    'create'
  ),
  (
    'customers.update',
    'Permite editar clientes',
    'customers',
    'update'
  )
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    module = EXCLUDED.module,
    action = EXCLUDED.action;

DROP POLICY IF EXISTS "Staff with customers.update can modify client profiles"
ON public.profiles;

CREATE POLICY "Staff with customers.update can modify client profiles"
ON public.profiles
FOR UPDATE
TO authenticated
USING (
  role = 'client'::public.user_role
  AND (
    public.is_owner()
    OR public.has_permission('customers.update')
  )
)
WITH CHECK (
  role = 'client'::public.user_role
  AND (
    public.is_owner()
    OR public.has_permission('customers.update')
  )
);

CREATE OR REPLACE FUNCTION public.create_customer_core(
  p_full_name text,
  p_phone text,
  p_birth_date date,
  p_gender public.gender_type,
  p_email text DEFAULT NULL,
  p_injuries text DEFAULT NULL,
  p_medical_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, auth, pg_temp
AS $$
DECLARE
  v_actor_user_id uuid;
  v_customer_id uuid;
  v_normalized_email text;
  v_full_name text;
  v_phone text;
BEGIN
  v_actor_user_id := auth.uid();

  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN'
      USING ERRCODE = 'P0001',
            DETAIL = 'MISSING_ACTOR';
  END IF;

  IF NOT (
    public.is_owner()
    OR public.has_permission('customers.create')
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN'
      USING ERRCODE = 'P0001',
            DETAIL = 'CUSTOMERS_CREATE_REQUIRED';
  END IF;

  v_full_name := nullif(btrim(coalesce(p_full_name, '')), '');
  v_phone := btrim(coalesce(p_phone, ''));
  v_normalized_email := nullif(lower(btrim(coalesce(p_email, ''))), '');

  IF v_full_name IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR'
      USING ERRCODE = 'P0001',
            DETAIL = 'FULL_NAME_REQUIRED';
  END IF;

  INSERT INTO auth.users (
    email,
    phone,
    encrypted_password,
    raw_app_meta_data,
    raw_user_meta_data,
    email_confirmed_at,
    created_at,
    updated_at
  )
  VALUES (
    v_normalized_email,
    NULLIF(v_phone, ''),
    NULL,
    jsonb_build_object('provider', 'email', 'providers', ARRAY['email']),
    jsonb_build_object(
      'full_name',
      v_full_name,
      'phone',
      v_phone,
      'role',
      'client'
    ),
    CASE
      WHEN v_normalized_email IS NULL THEN NULL
      ELSE timezone('utc', now())
    END,
    timezone('utc', now()),
    timezone('utc', now())
  )
  RETURNING id
  INTO v_customer_id;

  INSERT INTO public.profiles (
    id,
    full_name,
    phone,
    birth_date,
    gender,
    injuries,
    medical_notes,
    role,
    is_active,
    training_profile_status
  )
  VALUES (
    v_customer_id,
    v_full_name,
    v_phone,
    p_birth_date,
    p_gender,
    nullif(btrim(coalesce(p_injuries, '')), ''),
    nullif(btrim(coalesce(p_medical_notes, '')), ''),
    'client',
    true,
    'pending'
  );

  RETURN v_customer_id;
EXCEPTION
  WHEN unique_violation THEN
    IF strpos(coalesce(SQLERRM, ''), 'auth_users_email_lower_unique') > 0 THEN
      RAISE EXCEPTION 'EMAIL_ALREADY_EXISTS'
        USING ERRCODE = 'P0001';
    END IF;

    RAISE;
END;
$$;

ALTER FUNCTION public.create_customer_core(
  text,
  text,
  date,
  public.gender_type,
  text,
  text,
  text
) OWNER TO algym_migrator;

REVOKE ALL ON FUNCTION public.create_customer_core(
  text,
  text,
  date,
  public.gender_type,
  text,
  text,
  text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_customer_core(
  text,
  text,
  date,
  public.gender_type,
  text,
  text,
  text
) TO algym_app;

COMMIT;
