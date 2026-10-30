BEGIN;

ALTER TABLE public.cash_device_operations ADD COLUMN collection_id uuid;
-- Preserve old operation history and associate at most one opening per collection.
WITH previous AS (
  SELECT o.id, p.collection_id,
    row_number() OVER (PARTITION BY p.collection_id ORDER BY o.created_at, o.id) AS position
  FROM public.cash_device_operations o
  JOIN public.cash_movements m ON m.id = o.movement_id
  JOIN public.payments p ON p.id = m.source_payment_id
  WHERE o.kind = 'drawer_auto'
)
UPDATE public.cash_device_operations o SET collection_id = p.collection_id
FROM previous p WHERE o.id = p.id AND p.position = 1;

CREATE UNIQUE INDEX cash_device_one_auto_collection
  ON public.cash_device_operations(collection_id)
  WHERE kind = 'drawer_auto' AND collection_id IS NOT NULL;

COMMIT;
