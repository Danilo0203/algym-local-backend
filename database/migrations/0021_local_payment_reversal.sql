BEGIN;

-- La API local puede marcar un pago como reversado después de comprobar
-- permiso, identidad y estado. Las demás columnas quedan protegidas por
-- prevent_locked_payment_mutation cuando el turno original está cerrado.
DROP POLICY IF EXISTS local_payment_reverse_update ON public.payments;
CREATE POLICY local_payment_reverse_update ON public.payments
  FOR UPDATE TO algym_app
  USING (
    public.is_owner()
    OR (public.has_permission('cash.operate')
        AND public.has_permission('cash.reverse_payment')
        AND public.has_permission('customers.manage_membership'))
  )
  WITH CHECK (
    public.is_owner()
    OR (public.has_permission('cash.operate')
        AND public.has_permission('cash.reverse_payment')
        AND public.has_permission('customers.manage_membership'))
  );

COMMIT;
