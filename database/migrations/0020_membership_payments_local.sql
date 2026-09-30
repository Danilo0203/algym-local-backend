BEGIN;

-- El backend es el único escritor local de pagos de membresía. La política
-- evita que un actor cambie la identidad del cajero o cree un pago reversado.
DROP POLICY IF EXISTS local_membership_payment_insert ON public.payments;
CREATE POLICY local_membership_payment_insert ON public.payments
  FOR INSERT TO algym_app
  WITH CHECK (
    (public.is_owner() OR (
      public.has_permission('cash.operate')
      AND public.has_permission('customers.manage_membership')
    ))
    AND created_by_user_id = auth.uid()
    AND status = 'posted'
    AND subscription_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.subscriptions AS subscription
      WHERE subscription.id = subscription_id
        AND subscription.user_id = user_id
    )
  );

COMMIT;
