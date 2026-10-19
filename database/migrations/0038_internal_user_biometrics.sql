BEGIN;

-- Evita que un PIN de personal se asigne a un cliente ya registrado.
LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_biometric_id_unique_idx
  ON public.profiles (biometric_id)
  WHERE biometric_id IS NOT NULL;

DO $$
DECLARE
  next_pin bigint;
BEGIN
  SELECT GREATEST(
    COALESCE((SELECT MAX(biometric_id) + 1 FROM public.profiles), 1),
    (SELECT last_value + 1 FROM public.profiles_biometric_id_seq)
  ) INTO next_pin;
  EXECUTE format('ALTER SEQUENCE public.profiles_biometric_id_seq RESTART WITH %s', next_pin);
END
$$;

-- El sincronizador solo ve los campos necesarios del personal. La regla de
-- membresía para perfiles de clientes permanece en el servicio del reloj.
DROP POLICY IF EXISTS sync_profiles_select ON public.profiles;
CREATE POLICY sync_profiles_select ON public.profiles
  FOR SELECT TO algym_sync
  USING (role IN ('client', 'owner', 'admin', 'trainer', 'employee', 'custom'));

COMMIT;
