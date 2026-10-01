-- Informe de solo lectura para la base local. No modifica importes ni vínculos.
BEGIN READ ONLY;

SELECT current_database() AS database_name, now() AS checked_at;

SELECT 'profiles' AS entity, count(*) AS rows FROM public.profiles
UNION ALL SELECT 'subscriptions', count(*) FROM public.subscriptions
UNION ALL SELECT 'payments', count(*) FROM public.payments
UNION ALL SELECT 'cash_movements', count(*) FROM public.cash_movements
UNION ALL SELECT 'products', count(*) FROM public.products
UNION ALL SELECT 'inventory_movements', count(*) FROM public.inventory_movements
ORDER BY entity;

SELECT status, count(*) AS payments, COALESCE(sum(amount_paid), 0) AS total
FROM public.payments GROUP BY status ORDER BY status;

WITH movement_per_payment AS (
  SELECT p.id, p.amount_paid,
         count(m.id) AS sales,
         COALESCE(sum(m.amount), 0) AS sale_amount
  FROM public.payments AS p
  LEFT JOIN public.cash_movements AS m
    ON m.source_payment_id = p.id AND m.movement_type = 'sale'
  GROUP BY p.id, p.amount_paid
)
SELECT count(*) FILTER (WHERE sales <> 1) AS payments_without_one_sale,
       count(*) FILTER (WHERE sales = 1 AND sale_amount <> amount_paid)
         AS payment_sale_amount_mismatches,
       count(*) AS checked_payments
FROM movement_per_payment;

SELECT movement_type, category, count(*) AS unlinked_movements,
       COALESCE(sum(amount), 0) AS gross_amount,
       COALESCE(sum(cash_effect_amount), 0) AS cash_effect
FROM public.cash_movements
WHERE source_payment_id IS NULL
GROUP BY movement_type, category ORDER BY movement_type, category;

SELECT count(*) AS reversed_payments_without_replacement
FROM public.payments AS p
LEFT JOIN public.payments AS replacement ON replacement.id = p.replacement_payment_id
WHERE p.status = 'reversed' AND replacement.id IS NULL;

SELECT (SELECT COALESCE(sum(amount_paid), 0) FROM public.payments WHERE status = 'posted')
         AS posted_payment_total,
       (SELECT COALESCE(sum(cash_effect_amount), 0) FROM public.cash_movements)
         AS cash_movement_effect_total,
       (SELECT COALESCE(sum(cash_effect_amount), 0) FROM public.cash_movements
        WHERE movement_type = 'sale' AND source_payment_id IS NULL)
         AS unlinked_sales_effect_total;

SELECT count(*) AS broken_inventory_movement_arithmetic
FROM public.inventory_movements
WHERE quantity_after - quantity_before <> quantity_delta;

SELECT count(*) AS products_with_negative_stock
FROM public.product_inventory_overview WHERE stock_quantity < 0;

COMMIT;
