BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_health_profiles (
  user_id uuid PRIMARY KEY
    REFERENCES auth.users(id)
    ON DELETE CASCADE,
  parq_requires_attention boolean,
  parq_details text,
  injuries_or_pain text,
  medical_conditions text,
  medications text,
  medical_clearance_notes text,
  restricted_movements text,
  primary_goal text,
  secondary_goal text,
  focus_areas text[],
  experience_level text,
  days_per_week integer,
  session_minutes integer,
  training_location text,
  equipment_available text[],
  cardio_preference text,
  exercise_preferences text,
  exercise_dislikes text,
  diet_type text,
  activity_level text,
  created_at timestamptz DEFAULT timezone('utc', now()) NOT NULL,
  updated_at timestamptz DEFAULT timezone('utc', now()) NOT NULL
);

ALTER TABLE public.customer_health_profiles
  OWNER TO algym_migrator;

ALTER TABLE public.customer_health_profiles
  ADD COLUMN IF NOT EXISTS parq_requires_attention boolean,
  ADD COLUMN IF NOT EXISTS parq_details text,
  ADD COLUMN IF NOT EXISTS injuries_or_pain text,
  ADD COLUMN IF NOT EXISTS medical_conditions text,
  ADD COLUMN IF NOT EXISTS medications text,
  ADD COLUMN IF NOT EXISTS medical_clearance_notes text,
  ADD COLUMN IF NOT EXISTS restricted_movements text,
  ADD COLUMN IF NOT EXISTS primary_goal text,
  ADD COLUMN IF NOT EXISTS secondary_goal text,
  ADD COLUMN IF NOT EXISTS focus_areas text[],
  ADD COLUMN IF NOT EXISTS experience_level text,
  ADD COLUMN IF NOT EXISTS days_per_week integer,
  ADD COLUMN IF NOT EXISTS session_minutes integer,
  ADD COLUMN IF NOT EXISTS training_location text,
  ADD COLUMN IF NOT EXISTS equipment_available text[],
  ADD COLUMN IF NOT EXISTS cardio_preference text,
  ADD COLUMN IF NOT EXISTS exercise_preferences text,
  ADD COLUMN IF NOT EXISTS exercise_dislikes text,
  ADD COLUMN IF NOT EXISTS diet_type text,
  ADD COLUMN IF NOT EXISTS activity_level text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz
    DEFAULT timezone('utc', now()),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz
    DEFAULT timezone('utc', now());

UPDATE public.customer_health_profiles
SET created_at = COALESCE(created_at, timezone('utc', now())),
    updated_at = COALESCE(updated_at, timezone('utc', now()))
WHERE created_at IS NULL
   OR updated_at IS NULL;

ALTER TABLE public.customer_health_profiles
  ALTER COLUMN created_at SET DEFAULT timezone('utc', now()),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT timezone('utc', now()),
  ALTER COLUMN updated_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.customer_health_profiles'::regclass
      AND conname = 'customer_health_profiles_days_per_week_check'
  ) THEN
    ALTER TABLE public.customer_health_profiles
      ADD CONSTRAINT customer_health_profiles_days_per_week_check
      CHECK (
        days_per_week IS NULL
        OR days_per_week BETWEEN 1 AND 7
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.customer_health_profiles'::regclass
      AND conname = 'customer_health_profiles_session_minutes_check'
  ) THEN
    ALTER TABLE public.customer_health_profiles
      ADD CONSTRAINT customer_health_profiles_session_minutes_check
      CHECK (
        session_minutes IS NULL
        OR session_minutes BETWEEN 15 AND 480
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.customer_health_profiles'::regclass
      AND conname = 'customer_health_profiles_focus_areas_check'
  ) THEN
    ALTER TABLE public.customer_health_profiles
      ADD CONSTRAINT customer_health_profiles_focus_areas_check
      CHECK (
        focus_areas IS NULL
        OR array_position(focus_areas, '') IS NULL
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.customer_health_profiles'::regclass
      AND conname = 'customer_health_profiles_equipment_available_check'
  ) THEN
    ALTER TABLE public.customer_health_profiles
      ADD CONSTRAINT customer_health_profiles_equipment_available_check
      CHECK (
        equipment_available IS NULL
        OR array_position(equipment_available, '') IS NULL
      ) NOT VALID;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS customer_health_profiles_set_updated_at
ON public.customer_health_profiles;

CREATE TRIGGER customer_health_profiles_set_updated_at
BEFORE UPDATE ON public.customer_health_profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_row_updated_at();

ALTER TABLE public.body_assessments
  ALTER COLUMN weight_kg DROP NOT NULL,
  ALTER COLUMN height_cm DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz
    DEFAULT timezone('utc', now()),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz
    DEFAULT timezone('utc', now());

ALTER TABLE public.body_assessments
  DROP CONSTRAINT IF EXISTS body_assessments_diet_type_check;

UPDATE public.body_assessments
SET created_at = COALESCE(created_at, timezone('utc', now())),
    updated_at = COALESCE(updated_at, timezone('utc', now()))
WHERE created_at IS NULL
   OR updated_at IS NULL;

ALTER TABLE public.body_assessments
  ALTER COLUMN created_at SET DEFAULT timezone('utc', now()),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT timezone('utc', now()),
  ALTER COLUMN updated_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.body_assessments'::regclass
      AND conname = 'body_assessments_weight_kg_operational_check'
  ) THEN
    ALTER TABLE public.body_assessments
      ADD CONSTRAINT body_assessments_weight_kg_operational_check
      CHECK (weight_kg IS NULL OR weight_kg > 0 AND weight_kg <= 700)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.body_assessments'::regclass
      AND conname = 'body_assessments_height_cm_operational_check'
  ) THEN
    ALTER TABLE public.body_assessments
      ADD CONSTRAINT body_assessments_height_cm_operational_check
      CHECK (height_cm IS NULL OR height_cm > 0 AND height_cm <= 300)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.body_assessments'::regclass
      AND conname = 'body_assessments_body_fat_operational_check'
  ) THEN
    ALTER TABLE public.body_assessments
      ADD CONSTRAINT body_assessments_body_fat_operational_check
      CHECK (
        body_fat_percentage IS NULL
        OR body_fat_percentage BETWEEN 0 AND 100
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.body_assessments'::regclass
      AND conname = 'body_assessments_muscle_mass_operational_check'
  ) THEN
    ALTER TABLE public.body_assessments
      ADD CONSTRAINT body_assessments_muscle_mass_operational_check
      CHECK (
        muscle_mass_kg IS NULL
        OR muscle_mass_kg > 0 AND muscle_mass_kg <= 500
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.body_assessments'::regclass
      AND conname = 'body_assessments_measurements_operational_check'
  ) THEN
    ALTER TABLE public.body_assessments
      ADD CONSTRAINT body_assessments_measurements_operational_check
      CHECK (
        (chest IS NULL OR chest > 0 AND chest <= 500)
        AND (waist IS NULL OR waist > 0 AND waist <= 500)
        AND (hip IS NULL OR hip > 0 AND hip <= 500)
        AND (arm_right IS NULL OR arm_right > 0 AND arm_right <= 500)
        AND (arm_left IS NULL OR arm_left > 0 AND arm_left <= 500)
        AND (leg_right IS NULL OR leg_right > 0 AND leg_right <= 500)
        AND (leg_left IS NULL OR leg_left > 0 AND leg_left <= 500)
      ) NOT VALID;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS body_assessments_set_updated_at
ON public.body_assessments;

CREATE TRIGGER body_assessments_set_updated_at
BEFORE UPDATE ON public.body_assessments
FOR EACH ROW
EXECUTE FUNCTION public.set_row_updated_at();

INSERT INTO public.permissions (key, description, module, action)
VALUES
  (
    'customer_health_profiles.view',
    'Permite consultar perfiles de salud de clientes',
    'customer_health_profiles',
    'view'
  ),
  (
    'customer_health_profiles.manage',
    'Permite crear y editar perfiles de salud de clientes',
    'customer_health_profiles',
    'manage'
  ),
  (
    'body_assessments.view',
    'Permite consultar evaluaciones corporales de clientes',
    'body_assessments',
    'view'
  ),
  (
    'body_assessments.manage',
    'Permite crear y editar evaluaciones corporales de clientes',
    'body_assessments',
    'manage'
  )
ON CONFLICT (key) DO UPDATE
SET description = EXCLUDED.description,
    module = EXCLUDED.module,
    action = EXCLUDED.action;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.roles
    WHERE slug = 'admin'
  ) THEN
    RAISE EXCEPTION 'ROLE_ADMIN_NOT_FOUND';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.roles
    WHERE slug = 'trainer'
  ) THEN
    RAISE EXCEPTION 'ROLE_TRAINER_NOT_FOUND';
  END IF;
END;
$$;

DELETE FROM public.role_permissions AS role_permissions
USING public.permissions AS permissions
WHERE role_permissions.permission_id = permissions.id
  AND permissions.key IN (
    'customer_health_profiles.view',
    'customer_health_profiles.manage',
    'body_assessments.view',
    'body_assessments.manage'
  );

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT roles.id, permissions.id
FROM public.roles AS roles
CROSS JOIN public.permissions AS permissions
WHERE
  (
    roles.slug = 'admin'
    AND permissions.key IN (
      'customer_health_profiles.view',
      'customer_health_profiles.manage',
      'body_assessments.view',
      'body_assessments.manage'
    )
  )
  OR (
    roles.slug = 'trainer'
    AND permissions.key IN (
      'customer_health_profiles.view',
      'body_assessments.view',
      'body_assessments.manage'
    )
  )
ON CONFLICT (role_id, permission_id) DO NOTHING;

ALTER TABLE public.customer_health_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.body_assessments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Customer health readers can view profiles"
ON public.customer_health_profiles;
DROP POLICY IF EXISTS "Customer health editors can insert profiles"
ON public.customer_health_profiles;
DROP POLICY IF EXISTS "Customer health editors can update profiles"
ON public.customer_health_profiles;

CREATE POLICY "Customer health readers can view profiles"
ON public.customer_health_profiles
FOR SELECT
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customer_health_profiles.view')
);

CREATE POLICY "Customer health editors can insert profiles"
ON public.customer_health_profiles
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_owner()
  OR public.has_permission('customer_health_profiles.manage')
);

CREATE POLICY "Customer health editors can update profiles"
ON public.customer_health_profiles
FOR UPDATE
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('customer_health_profiles.manage')
)
WITH CHECK (
  public.is_owner()
  OR public.has_permission('customer_health_profiles.manage')
);

DROP POLICY IF EXISTS "Admins and trainers can create body assessments"
ON public.body_assessments;
DROP POLICY IF EXISTS "Admins and trainers can modify body assessments"
ON public.body_assessments;
DROP POLICY IF EXISTS "Only admins can delete body assessments"
ON public.body_assessments;
DROP POLICY IF EXISTS "Users can view own body assessments"
ON public.body_assessments;
DROP POLICY IF EXISTS "Customers readers can view customer assessments"
ON public.body_assessments;
DROP POLICY IF EXISTS "Body assessments readers can view assessments"
ON public.body_assessments;
DROP POLICY IF EXISTS "Body assessments managers can insert assessments"
ON public.body_assessments;
DROP POLICY IF EXISTS "Body assessments managers can update assessments"
ON public.body_assessments;
DROP POLICY IF EXISTS "Body assessments managers can delete assessments"
ON public.body_assessments;

CREATE POLICY "Body assessments readers can view assessments"
ON public.body_assessments
FOR SELECT
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('body_assessments.view')
);

CREATE POLICY "Body assessments managers can insert assessments"
ON public.body_assessments
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_owner()
  OR public.has_permission('body_assessments.manage')
);

CREATE POLICY "Body assessments managers can update assessments"
ON public.body_assessments
FOR UPDATE
TO authenticated
USING (
  public.is_owner()
  OR public.has_permission('body_assessments.manage')
)
WITH CHECK (
  public.is_owner()
  OR public.has_permission('body_assessments.manage')
);

REVOKE ALL ON public.customer_health_profiles
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.customer_health_profiles
TO algym_app;

REVOKE ALL ON public.body_assessments
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.body_assessments
TO algym_app;

COMMIT;
