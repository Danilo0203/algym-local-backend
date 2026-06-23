BEGIN;

-- Extensiones utilizadas por el esquema actual de ALGYM.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Roles equivalentes a los utilizados por Supabase.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'anon'
  ) THEN
    CREATE ROLE anon NOLOGIN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'
  ) THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role'
  ) THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- El backend podrá asumir estos roles dentro de una transacción.
GRANT authenticated TO algym_app;
GRANT service_role TO algym_app;

-- Esquema local que sustituye la parte necesaria de Supabase Auth.
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION algym_migrator;
ALTER SCHEMA auth OWNER TO algym_migrator;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  phone text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
);

ALTER TABLE auth.users OWNER TO algym_migrator;

CREATE TABLE IF NOT EXISTS auth.identities (
  id text PRIMARY KEY,
  user_id uuid NOT NULL
    REFERENCES auth.users(id)
    ON DELETE CASCADE,
  provider text,
  identity_data jsonb,
  created_at timestamptz,
  updated_at timestamptz
);

ALTER TABLE auth.identities OWNER TO algym_migrator;

-- Sustituye auth.uid() de Supabase.
-- La API establecerá app.current_user_id al comenzar cada transacción.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    current_setting('app.current_user_id', true),
    ''
  )::uuid;
$$;

ALTER FUNCTION auth.uid() OWNER TO algym_migrator;

REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON auth.users FROM PUBLIC;
REVOKE ALL ON auth.identities FROM PUBLIC;

GRANT USAGE ON SCHEMA auth
TO algym_app, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
ON auth.users, auth.identities
TO algym_app, service_role;

GRANT EXECUTE ON FUNCTION auth.uid()
TO algym_app, anon, authenticated, service_role;

COMMIT;
