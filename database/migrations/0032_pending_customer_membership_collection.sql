BEGIN;

-- Las suscripciones históricas no se clasifican automáticamente como impagas.
ALTER TABLE public.subscriptions ADD COLUMN initial_collection_origin text;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_initial_collection_origin_check
  CHECK (initial_collection_origin IS NULL OR initial_collection_origin = 'customers');

CREATE UNIQUE INDEX subscriptions_one_pending_customer_collection_idx
  ON public.subscriptions (user_id)
  WHERE status = 'pending' AND initial_collection_origin = 'customers';

COMMIT;
