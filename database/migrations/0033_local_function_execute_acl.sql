BEGIN;

-- El esquema importado de Supabase dejaba funciones SECURITY DEFINER de
-- public ejecutables por PUBLIC/anon/authenticated/service_role. Algunas
-- aceptan IDs de actor como argumentos y confían en la autorización de la API.
-- La API local llama directamente a las siete funciones heredadas de Caja
-- listadas abajo mediante algym_app. Otras funciones ya tenían una concesión
-- explícita para ese rol; las funciones de trigger se ejecutan por sus
-- triggers y las demás llamadas internas se hacen como su propietario.
DO $$
DECLARE
  function_signature regprocedure;
BEGIN
  FOR function_signature IN
    SELECT routine.oid::regprocedure
    FROM pg_proc AS routine
    JOIN pg_namespace AS schema ON schema.oid = routine.pronamespace
    WHERE schema.nspname = 'public'
      AND routine.prosecdef
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      function_signature
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.attach_payment_to_cash(uuid, uuid, text, text)
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.close_cash_session(uuid, numeric, text, uuid, uuid)
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.find_open_cash_session_for_user(uuid)
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.insert_reversal_cash_movement(uuid, uuid, text, text)
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.open_cash_session(uuid, numeric, text)
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.record_manual_cash_movement(uuid, text, text, numeric, text, text, uuid, numeric)
  TO algym_app;
GRANT EXECUTE ON FUNCTION public.sell_products_from_cash_session(jsonb, text, text)
  TO algym_app;

COMMIT;
