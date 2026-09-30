BEGIN;

-- Caja se consulta con el usuario autenticado de la API local. Las funciones
-- históricas de apertura/cierre siguen siendo la frontera de escritura.
DROP POLICY IF EXISTS local_cash_registers_select ON public.cash_registers;
CREATE POLICY local_cash_registers_select ON public.cash_registers
  FOR SELECT TO algym_app
  USING (public.has_permission('cash.operate') OR public.has_permission('cash.view'));

DROP POLICY IF EXISTS local_cash_registers_insert ON public.cash_registers;
CREATE POLICY local_cash_registers_insert ON public.cash_registers
  FOR INSERT TO algym_app
  WITH CHECK (public.is_owner() OR public.get_my_role() = 'admin'::public.user_role);

DROP POLICY IF EXISTS local_cash_registers_update ON public.cash_registers;
CREATE POLICY local_cash_registers_update ON public.cash_registers
  FOR UPDATE TO algym_app
  USING (public.is_owner() OR public.get_my_role() = 'admin'::public.user_role)
  WITH CHECK (public.is_owner() OR public.get_my_role() = 'admin'::public.user_role);

DROP POLICY IF EXISTS local_cash_sessions_select ON public.cash_sessions;
CREATE POLICY local_cash_sessions_select ON public.cash_sessions
  FOR SELECT TO algym_app
  USING (
    public.is_owner()
    OR ((public.has_permission('cash.operate') OR public.has_permission('cash.view'))
        AND opened_by_user_id = auth.uid())
  );

DROP POLICY IF EXISTS local_cash_movements_select ON public.cash_movements;
CREATE POLICY local_cash_movements_select ON public.cash_movements
  FOR SELECT TO algym_app
  USING (
    public.is_owner()
    OR ((public.has_permission('cash.operate') OR public.has_permission('cash.view'))
        AND (created_by_user_id = auth.uid()
             OR EXISTS (
               SELECT 1 FROM public.cash_sessions AS session
               WHERE session.id = cash_session_id
                 AND session.opened_by_user_id = auth.uid()
             )))
  );

-- El estado del pago vinculado permite identificar anulaciones en caja.
DROP POLICY IF EXISTS local_cash_payments_select ON public.payments;
CREATE POLICY local_cash_payments_select ON public.payments
  FOR SELECT TO algym_app
  USING (public.has_permission('cash.operate') OR public.has_permission('payments.view'));

-- RLS oculta los perfiles internos a un cajero. La API necesita comprobar
-- que quien autoriza con contraseña sigue activo sin abrir la tabla completa.
CREATE OR REPLACE FUNCTION private.is_active_cash_authorizer(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.id = p_user_id AND p.is_active = true
      AND p.role IN ('owner'::public.user_role, 'admin'::public.user_role)
  )
$$;
ALTER FUNCTION private.is_active_cash_authorizer(uuid) OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION private.is_active_cash_authorizer(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_active_cash_authorizer(uuid) TO algym_app;

COMMIT;
