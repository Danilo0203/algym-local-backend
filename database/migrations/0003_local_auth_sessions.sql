BEGIN;

CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES auth.users(id)
    ON DELETE CASCADE,
  secret_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  user_agent text,
  ip_address inet
);

ALTER TABLE auth.sessions OWNER TO algym_migrator;

CREATE INDEX auth_sessions_user_id_idx
ON auth.sessions (user_id);

CREATE INDEX auth_sessions_active_idx
ON auth.sessions (expires_at)
WHERE revoked_at IS NULL;

CREATE INDEX auth_sessions_cleanup_idx
ON auth.sessions (expires_at, revoked_at);

REVOKE ALL ON auth.sessions FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE
ON auth.sessions
TO algym_app;

COMMIT;
