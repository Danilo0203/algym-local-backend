BEGIN;

-- Quien edita la ficha de salud debe poder mantener los datos de entrenamiento
-- de ese mismo cliente. La autorización del endpoint sigue comprobando
-- customer_health_profiles.manage antes de escribir cualquiera de las tablas.
DROP POLICY IF EXISTS "training_profiles_health_editor_select" ON public.training_profiles;
DROP POLICY IF EXISTS "training_profiles_health_editor_insert" ON public.training_profiles;
DROP POLICY IF EXISTS "training_profiles_health_editor_update" ON public.training_profiles;

CREATE POLICY "training_profiles_health_editor_select"
ON public.training_profiles FOR SELECT TO authenticated
USING (public.has_permission('customer_health_profiles.manage'));

CREATE POLICY "training_profiles_health_editor_insert"
ON public.training_profiles FOR INSERT TO authenticated
WITH CHECK (public.has_permission('customer_health_profiles.manage'));

CREATE POLICY "training_profiles_health_editor_update"
ON public.training_profiles FOR UPDATE TO authenticated
USING (public.has_permission('customer_health_profiles.manage'))
WITH CHECK (public.has_permission('customer_health_profiles.manage'));

-- Recuperar datos ya guardados en la ficha sin reemplazar valores existentes
-- en training_profiles. Los campos históricos de texto libre solo se copian
-- cuando pertenecen al catálogo admitido por el generador.
WITH health AS (
  SELECT
    h.user_id,
    CASE WHEN h.primary_goal IN ('fat_loss', 'muscle_gain', 'recomp', 'strength', 'general_fitness', 'cardio') THEN h.primary_goal END AS primary_goal,
    CASE WHEN h.secondary_goal IN ('fat_loss', 'muscle_gain', 'recomp', 'strength', 'general_fitness', 'cardio') THEN h.secondary_goal END AS secondary_goal,
    ARRAY(SELECT item FROM unnest(COALESCE(h.focus_areas, '{}'::text[])) AS item
          WHERE item IN ('upper_body', 'lower_body', 'glutes', 'core', 'chest', 'back', 'shoulders', 'arms', 'conditioning')) AS focus_areas,
    CASE WHEN h.experience_level IN ('beginner', 'intermediate', 'advanced') THEN h.experience_level END AS experience_level,
    CASE WHEN h.days_per_week BETWEEN 1 AND 7 THEN h.days_per_week END AS days_per_week,
    CASE WHEN h.session_minutes BETWEEN 1 AND 480 THEN h.session_minutes END AS session_minutes,
    CASE WHEN h.training_location IN ('gym', 'home', 'mixed') THEN h.training_location END AS training_location,
    ARRAY(SELECT item FROM unnest(COALESCE(h.equipment_available, '{}'::text[])) AS item
          WHERE item IN ('full_gym', 'body_weight', 'dumbbell', 'barbell', 'machine', 'bands', 'kettlebell', 'treadmill', 'bike', 'rower')) AS equipment_available,
    CASE WHEN h.activity_level IN ('sedentario', '1_3_dias', '3_5_dias', '6_7_dias', '2_veces_dia') THEN h.activity_level END AS activity_level,
    CASE WHEN h.cardio_preference IN ('none', 'light', 'moderate', 'high') THEN h.cardio_preference END AS cardio_preference,
    h.exercise_preferences,
    h.exercise_dislikes,
    h.injuries_or_pain,
    ARRAY(SELECT item FROM regexp_split_to_table(COALESCE(h.restricted_movements, ''), '\s*,\s*') AS item
          WHERE item IN ('deep_knee_flexion', 'overhead_pressing', 'loaded_spinal_flexion', 'high_impact', 'horizontal_pressing', 'vertical_pulling', 'hip_hinge', 'unilateral_lower_body')) AS restricted_movements,
    h.parq_requires_attention,
    h.medical_clearance_notes
  FROM public.customer_health_profiles AS h
  JOIN public.profiles AS p ON p.id = h.user_id AND p.role = 'client'
  WHERE h.primary_goal IS NOT NULL OR h.secondary_goal IS NOT NULL
     OR h.experience_level IS NOT NULL OR h.days_per_week IS NOT NULL
     OR h.session_minutes IS NOT NULL OR h.training_location IS NOT NULL
     OR h.activity_level IS NOT NULL OR h.cardio_preference IS NOT NULL
     OR h.parq_requires_attention IS NOT NULL OR h.focus_areas IS NOT NULL
     OR h.equipment_available IS NOT NULL OR h.restricted_movements IS NOT NULL
     OR h.exercise_preferences IS NOT NULL OR h.exercise_dislikes IS NOT NULL
     OR h.injuries_or_pain IS NOT NULL OR h.medical_clearance_notes IS NOT NULL
)
INSERT INTO public.training_profiles AS t (
  user_id, primary_goal, secondary_goal, focus_areas, experience_level,
  days_per_week, session_minutes, training_location, equipment_available,
  activity_level, cardio_preference, exercise_preferences, exercise_dislikes,
  injuries_or_pain, restricted_movements, parq_requires_attention,
  medical_clearance_notes
)
SELECT user_id, primary_goal, secondary_goal, focus_areas, experience_level,
       days_per_week, session_minutes, training_location, equipment_available,
       activity_level, cardio_preference, exercise_preferences, exercise_dislikes,
       injuries_or_pain, restricted_movements, parq_requires_attention,
       medical_clearance_notes
FROM health
ON CONFLICT (user_id) DO UPDATE SET
  primary_goal = COALESCE(t.primary_goal, EXCLUDED.primary_goal),
  secondary_goal = COALESCE(t.secondary_goal, EXCLUDED.secondary_goal),
  focus_areas = CASE WHEN cardinality(t.focus_areas) = 0 THEN EXCLUDED.focus_areas ELSE t.focus_areas END,
  experience_level = COALESCE(t.experience_level, EXCLUDED.experience_level),
  days_per_week = COALESCE(t.days_per_week, EXCLUDED.days_per_week),
  session_minutes = COALESCE(t.session_minutes, EXCLUDED.session_minutes),
  training_location = COALESCE(t.training_location, EXCLUDED.training_location),
  equipment_available = CASE WHEN cardinality(t.equipment_available) = 0 THEN EXCLUDED.equipment_available ELSE t.equipment_available END,
  activity_level = COALESCE(t.activity_level, EXCLUDED.activity_level),
  cardio_preference = COALESCE(t.cardio_preference, EXCLUDED.cardio_preference),
  exercise_preferences = COALESCE(t.exercise_preferences, EXCLUDED.exercise_preferences),
  exercise_dislikes = COALESCE(t.exercise_dislikes, EXCLUDED.exercise_dislikes),
  injuries_or_pain = COALESCE(t.injuries_or_pain, EXCLUDED.injuries_or_pain),
  restricted_movements = CASE WHEN cardinality(t.restricted_movements) = 0 THEN EXCLUDED.restricted_movements ELSE t.restricted_movements END,
  parq_requires_attention = COALESCE(t.parq_requires_attention, EXCLUDED.parq_requires_attention),
  medical_clearance_notes = COALESCE(t.medical_clearance_notes, EXCLUDED.medical_clearance_notes);

WITH completion AS (
  SELECT t.user_id,
    COALESCE(
      p.birth_date IS NOT NULL AND p.gender IS NOT NULL
      AND assessment.weight_kg > 0 AND assessment.height_cm > 0
      AND t.primary_goal IS NOT NULL AND t.parq_requires_attention IS NOT NULL
      AND (t.parq_requires_attention = false OR NULLIF(BTRIM(t.injuries_or_pain), '') IS NOT NULL)
      AND t.experience_level IS NOT NULL AND t.days_per_week > 0
      AND t.session_minutes > 0 AND t.activity_level IS NOT NULL
      AND t.cardio_preference IS NOT NULL
      AND (COALESCE(t.training_location, 'gym') = 'gym' OR cardinality(t.equipment_available) > 0),
      false
    ) AS is_complete
  FROM public.training_profiles AS t
  JOIN public.profiles AS p ON p.id = t.user_id
  LEFT JOIN LATERAL (
    SELECT weight_kg, height_cm FROM public.body_assessments
    WHERE user_id = t.user_id ORDER BY date DESC, id DESC LIMIT 1
  ) AS assessment ON true
  WHERE EXISTS (SELECT 1 FROM public.customer_health_profiles AS h WHERE h.user_id = t.user_id)
), updated AS (
  UPDATE public.training_profiles AS t
  SET is_complete = c.is_complete
  FROM completion AS c
  WHERE t.user_id = c.user_id AND t.is_complete IS DISTINCT FROM c.is_complete
  RETURNING t.user_id
)
UPDATE public.profiles AS p
SET training_profile_status = CASE WHEN c.is_complete THEN 'complete' ELSE 'pending' END
FROM completion AS c
WHERE p.id = c.user_id
  AND p.training_profile_status IS DISTINCT FROM CASE WHEN c.is_complete THEN 'complete' ELSE 'pending' END;

COMMIT;
