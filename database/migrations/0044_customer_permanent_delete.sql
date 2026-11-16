BEGIN;

-- Eliminación permanente de clientes. Los pagos y movimientos de caja se
-- conservan para no alterar la caja ni los reportes: quedan desvinculados del
-- cliente y guardan su nombre (y el del plan) en columnas de respaldo.

INSERT INTO public.permissions (key, description, module, action)
VALUES ('customers.delete', 'Eliminar clientes permanentemente conservando pagos y caja', 'customers', 'delete')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.payments
  ADD COLUMN deleted_customer_name text,
  ADD COLUMN deleted_plan_name text;
ALTER TABLE public.cash_movements
  ADD COLUMN deleted_customer_name text;

-- Los pagos de cajas cerradas siguen inmutables. La única excepción nueva es
-- desvincularlos de un cliente eliminado: cliente y membresía pasan a NULL y se
-- guardan los nombres de respaldo. Montos, fechas y método no pueden cambiar.
CREATE OR REPLACE FUNCTION public.prevent_locked_payment_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_reversal_columns text[] := array['status', 'reversed_at', 'reversed_by_user_id', 'replacement_payment_id', 'reversal_reason'];
  v_unlink_columns text[] := array['user_id', 'subscription_id', 'deleted_customer_name', 'deleted_plan_name'];
  v_ignored text[];
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from public.cash_movements cm
      join public.cash_sessions cs on cs.id = cm.cash_session_id
      where cm.source_payment_id = old.id
        and cs.status in ('closed', 'closed_with_difference')
    ) then
      raise exception 'No se puede eliminar un pago vinculado a una caja cerrada';
    end if;
    return old;
  end if;

  if exists (
    select 1
    from public.cash_movements cm
    join public.cash_sessions cs on cs.id = cm.cash_session_id
    where cm.source_payment_id = old.id
      and cs.status in ('closed', 'closed_with_difference')
  ) then
    v_ignored := v_reversal_columns;
    if old.user_id is not null and new.user_id is null
       and old.deleted_customer_name is null and new.deleted_customer_name is not null
       and new.subscription_id is null then
      v_ignored := v_reversal_columns || v_unlink_columns;
    end if;
    if (to_jsonb(new) - v_ignored) <> (to_jsonb(old) - v_ignored) then
      raise exception 'No se puede modificar el núcleo de un pago vinculado a una caja cerrada';
    end if;
  end if;

  return new;
end;
$$;

-- Un pago de inscripción sin cliente es válido solo si el cliente fue eliminado.
ALTER TABLE public.payments DROP CONSTRAINT enrollment_payment_shape;
ALTER TABLE public.payments ADD CONSTRAINT enrollment_payment_shape CHECK (
  (payment_kind = 'enrollment' AND enrollment_year IS NOT NULL AND subscription_id IS NULL
    AND (user_id IS NOT NULL OR deleted_customer_name IS NOT NULL))
  OR (payment_kind IS DISTINCT FROM 'enrollment' AND enrollment_year IS NULL)
);

CREATE OR REPLACE VIEW public.payments_overview WITH (security_invoker = true) AS
 SELECT p.id,
    p.payment_date,
    p.amount_paid,
    p.method,
    p.user_id,
    p.subscription_id,
    COALESCE(pr.full_name, p.deleted_customer_name) AS user_name,
    pr.avatar_url,
    COALESCE(pl.name, p.deleted_plan_name) AS plan_name,
        CASE
            WHEN s.status = 'active'::public.sub_status
              AND public.subscription_access_until(s.end_date, s.grace_days) < CURRENT_DATE
            THEN 'expired'::public.sub_status
            ELSE s.status
        END AS subscription_status,
    s.end_date AS subscription_end_date,
    s.grace_days AS subscription_grace_days,
    public.subscription_access_until(s.end_date, s.grace_days) AS subscription_access_until
   FROM public.payments p
     LEFT JOIN public.profiles pr ON pr.id = p.user_id
     LEFT JOIN public.subscriptions s ON s.id = p.subscription_id
     LEFT JOIN public.plans pl ON pl.id = s.plan_id
  WHERE p.status = 'posted';

-- Borra al cliente y todo lo que solo le pertenece a él. Devuelve el nombre y el
-- ID biométrico para que la aplicación lo quite también del reloj.
CREATE OR REPLACE FUNCTION private.delete_customer_permanently(p_customer_id uuid)
RETURNS TABLE (full_name text, biometric_id integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_name text;
  v_biometric integer;
  v_role public.user_role;
BEGIN
  IF v_actor_id IS NULL OR NOT private.current_actor_has_permission('customers.delete') THEN
    RAISE EXCEPTION 'No autorizado para eliminar clientes' USING ERRCODE = '42501';
  END IF;

  SELECT profile.full_name, profile.biometric_id, profile.role
    INTO v_name, v_biometric, v_role
  FROM public.profiles AS profile
  WHERE profile.id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente no encontrado' USING ERRCODE = 'P0002';
  END IF;
  IF v_role IS DISTINCT FROM 'client'::public.user_role THEN
    RAISE EXCEPTION 'Solo se pueden eliminar clientes' USING ERRCODE = '22023';
  END IF;

  v_name := COALESCE(NULLIF(btrim(v_name), ''), 'Cliente eliminado');

  -- Conservar pagos y caja con el nombre del cliente y del plan.
  UPDATE public.payments AS payment
     SET deleted_customer_name = v_name,
         deleted_plan_name = COALESCE(payment.deleted_plan_name, (
           SELECT plan.name FROM public.subscriptions AS subscription
           JOIN public.plans AS plan ON plan.id = subscription.plan_id
           WHERE subscription.id = payment.subscription_id)),
         user_id = NULL,
         subscription_id = NULL
   WHERE payment.user_id = p_customer_id;

  UPDATE public.cash_movements
     SET deleted_customer_name = v_name
   WHERE customer_id = p_customer_id;

  -- Datos propios del cliente sin borrado en cascada.
  DELETE FROM public.access_logs WHERE user_id = p_customer_id;
  DELETE FROM public.body_assessments WHERE user_id = p_customer_id;
  DELETE FROM public.routines WHERE user_id = p_customer_id;
  DELETE FROM public.subscriptions WHERE user_id = p_customer_id;

  -- El resto (perfil, ficha de salud, perfil de entrenamiento, inscripciones,
  -- progreso de rutinas, sesiones) se borra en cascada desde la cuenta.
  DELETE FROM auth.users WHERE id = p_customer_id;

  RETURN QUERY SELECT v_name, v_biometric;
END;
$$;

ALTER FUNCTION private.delete_customer_permanently(uuid) OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION private.delete_customer_permanently(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.delete_customer_permanently(uuid) TO algym_app;

COMMIT;
