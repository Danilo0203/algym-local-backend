BEGIN;

CREATE TABLE public.routine_exercise_completions (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  detail_id bigint NOT NULL REFERENCES public.routine_details(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, detail_id)
);

ALTER TABLE public.routine_exercise_completions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.routine_exercise_completions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.routine_exercise_completions TO algym_app;

CREATE POLICY own_exercise_completions_read ON public.routine_exercise_completions
  FOR SELECT TO algym_app USING (user_id = (SELECT auth.uid()));
CREATE POLICY own_exercise_completions_delete ON public.routine_exercise_completions
  FOR DELETE TO algym_app USING (user_id = (SELECT auth.uid()));
CREATE POLICY own_exercise_completions_insert ON public.routine_exercise_completions
  FOR INSERT TO algym_app WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.routine_details AS detail
      JOIN public.routines AS routine ON routine.id = detail.routine_id
      JOIN public.profiles AS profile ON profile.id = routine.user_id
      WHERE detail.id = detail_id AND routine.user_id = (SELECT auth.uid())
        AND routine.status = 'active' AND profile.role = 'client'
    )
  );

-- A replacement or changed prescription must not inherit a completed checkmark.
CREATE FUNCTION private.clear_changed_exercise_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.routine_exercise_completions WHERE detail_id = NEW.id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.clear_changed_exercise_completion() FROM PUBLIC;
CREATE TRIGGER clear_changed_exercise_completion
  AFTER UPDATE ON public.routine_details FOR EACH ROW
  WHEN (ROW(OLD.routine_id, OLD.day_of_week, OLD.exercise_id, OLD.sets, OLD.reps,
            OLD.rest_seconds, OLD.duration_minutes, OLD.target_rir)
    IS DISTINCT FROM
        ROW(NEW.routine_id, NEW.day_of_week, NEW.exercise_id, NEW.sets, NEW.reps,
            NEW.rest_seconds, NEW.duration_minutes, NEW.target_rir))
  EXECUTE FUNCTION private.clear_changed_exercise_completion();

COMMIT;
