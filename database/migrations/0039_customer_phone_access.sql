BEGIN;

-- Once set by a first login or an administrator, this marker is never cleared.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS customer_password_set_at timestamptz;
UPDATE auth.users AS u
SET customer_password_set_at = COALESCE(u.last_sign_in_at, u.updated_at, u.created_at, now())
WHERE u.customer_password_set_at IS NULL
  AND (u.last_sign_in_at IS NOT NULL
       OR (NULLIF(btrim(u.email), '') IS NOT NULL AND u.encrypted_password IS NOT NULL)
       OR EXISTS (SELECT 1 FROM auth.sessions AS s WHERE s.user_id = u.id));

CREATE OR REPLACE FUNCTION private.normalize_client_phone(value text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE
    WHEN btrim(value) !~ '^\+?[0-9 ()-]+$' THEN NULL
    WHEN length(regexp_replace(value, '[^0-9]', '', 'g')) = 8
      THEN '+502' || regexp_replace(value, '[^0-9]', '', 'g')
    WHEN regexp_replace(value, '[^0-9]', '', 'g') ~ '^502[0-9]{8}$'
      THEN '+' || regexp_replace(value, '[^0-9]', '', 'g')
    ELSE NULL END
$$;
ALTER FUNCTION private.normalize_client_phone(text) OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION private.normalize_client_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.normalize_client_phone(text) TO algym_app;

-- The pre-login API needs only identifiers and active status, not customer data.
-- Include inactive duplicates so we never pick one owner of a shared number.
CREATE OR REPLACE FUNCTION private.customer_ids_for_phone(value text)
RETURNS TABLE(id uuid, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id, p.is_active
  FROM public.profiles AS p
  JOIN auth.users AS u ON u.id = p.id
  WHERE p.role::text = 'client' AND u.deleted_at IS NULL
    AND private.normalize_client_phone(p.phone) = private.normalize_client_phone(value)
  ORDER BY p.id LIMIT 2
$$;
ALTER FUNCTION private.customer_ids_for_phone(text) OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION private.customer_ids_for_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.customer_ids_for_phone(text) TO algym_app;

COMMIT;
