BEGIN;

CREATE INDEX IF NOT EXISTS attendance_logs_biometric_punch_idx
ON public.attendance_logs (biometric_id, punch_time DESC, id DESC);

CREATE INDEX IF NOT EXISTS subscriptions_user_created_idx
ON public.subscriptions (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS payments_user_status_date_idx
ON public.payments (user_id, status, payment_date DESC, id DESC);

CREATE INDEX IF NOT EXISTS body_assessments_user_date_idx
ON public.body_assessments (user_id, date DESC, id DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'attendance_logs'
      AND policyname = 'Customers readers can view attendance history'
  ) THEN
    CREATE POLICY "Customers readers can view attendance history"
    ON public.attendance_logs
    FOR SELECT
    TO authenticated
    USING (public.has_permission('customers.view'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'body_assessments'
      AND policyname = 'Customers readers can view customer assessments'
  ) THEN
    CREATE POLICY "Customers readers can view customer assessments"
    ON public.body_assessments
    FOR SELECT
    TO authenticated
    USING (public.has_permission('customers.view'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'payments'
      AND policyname = 'Payments readers can view customer payments'
  ) THEN
    CREATE POLICY "Payments readers can view customer payments"
    ON public.payments
    FOR SELECT
    TO authenticated
    USING (public.has_permission('payments.view'));
  END IF;
END;
$$;

COMMIT;
