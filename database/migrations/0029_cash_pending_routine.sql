BEGIN;

-- El cobro crea una tarea de rutina dentro de la misma transacción. La función
-- acepta únicamente un pago publicado, hecho por el actor en una caja abierta;
-- no concede al cajero permisos generales sobre las rutinas de otros clientes.
CREATE OR REPLACE FUNCTION private.create_pending_routine_for_cash_payment(p_payment_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_customer_id uuid;
  v_routine_id uuid;
BEGIN
  IF v_actor_id IS NULL
     OR NOT private.current_actor_has_permission('cash.operate')
     OR NOT private.current_actor_has_permission('customers.manage_membership') THEN
    RAISE EXCEPTION 'No autorizado para preparar la rutina del cobro';
  END IF;

  SELECT payment.user_id
    INTO v_customer_id
  FROM public.payments AS payment
  JOIN public.cash_movements AS movement
    ON movement.source_payment_id = payment.id
  JOIN public.profiles AS customer
    ON customer.id = payment.user_id
  WHERE payment.id = p_payment_id
    AND payment.status = 'posted'
    AND payment.created_by_user_id = v_actor_id
    AND customer.role = 'client'::public.user_role
    AND customer.is_active
    AND movement.created_by_user_id = v_actor_id
    AND movement.session_link_status = 'assigned'
    AND movement.voided_at IS NULL;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'No se encontró un cobro en caja válido para preparar la rutina';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_customer_id::text, 0)
  );

  UPDATE public.routines
     SET status = 'archived', is_active = false
   WHERE user_id = v_customer_id AND status = 'pending_profile';

  INSERT INTO public.routines (
    user_id, created_by, name, start_date, is_active, goal, status, source,
    generation_version
  ) VALUES (
    v_customer_id, v_actor_id, 'Rutina pendiente de perfil', CURRENT_DATE,
    false, 'Pendiente de perfil', 'pending_profile', 'system', 'cash-local-v1'
  ) RETURNING id INTO v_routine_id;

  RETURN v_routine_id;
END;
$$;

ALTER FUNCTION private.create_pending_routine_for_cash_payment(uuid)
  OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION private.create_pending_routine_for_cash_payment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.create_pending_routine_for_cash_payment(uuid) TO algym_app;

COMMIT;
