BEGIN;

-- El empleado con inventory.sell puede bloquear existencias sin obtener permiso
-- general de UPDATE sobre productos. El bloqueo vive hasta el COMMIT del backend.
CREATE OR REPLACE FUNCTION public.lock_cash_sale_products(p_product_ids uuid[])
RETURNS TABLE (id uuid, name text, is_active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  PERFORM public.require_cash_operator(auth.uid());
  IF NOT public.is_owner() AND NOT public.has_permission('inventory.sell') THEN
    RAISE EXCEPTION 'No autorizado para vender productos';
  END IF;

  RETURN QUERY
    SELECT product.id, product.name, product.is_active
    FROM public.products AS product
    WHERE product.id = ANY(p_product_ids)
    ORDER BY product.id FOR UPDATE;
END;
$$;

ALTER FUNCTION public.lock_cash_sale_products(uuid[]) OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION public.lock_cash_sale_products(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_cash_sale_products(uuid[]) FROM authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lock_cash_sale_products(uuid[]) TO algym_app;

CREATE OR REPLACE FUNCTION "public"."void_product_sale_from_cash_session"("p_product_sale_id" uuid, "p_note" text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_request_user_id uuid;
  v_role text;
  v_session public.cash_sessions%rowtype;
  v_sale public.product_sales%rowtype;
  v_sale_item public.product_sale_items%rowtype;
  v_stock_before numeric(12,3);
  v_cash_movement public.cash_movements%rowtype;
  v_inventory_movement_count integer := 0;
begin
  v_request_user_id := auth.uid();
  v_role := public.require_cash_operator(v_request_user_id);

  select *
  into v_session
  from public.find_open_cash_session_for_user(v_request_user_id);

  if v_session.id is null then
    raise exception 'Abre una caja antes de anular ventas';
  end if;

  select *
  into v_sale
  from public.product_sales
  where id = p_product_sale_id
  for update;

  if not found then
    raise exception 'Venta no encontrada';
  end if;

  if v_sale.status <> 'posted' then
    raise exception 'Solo se pueden anular ventas publicadas';
  end if;

  if v_role <> 'owner' and v_sale.sold_by_user_id <> v_request_user_id then
    raise exception 'No autorizado para anular una venta de otro cajero';
  end if;

  update public.product_sales
  set status = 'voided',
      voided_at = now(),
      voided_by_user_id = v_request_user_id
  where id = v_sale.id;

  for v_sale_item in
    select *
    from public.product_sale_items
    where product_sale_id = v_sale.id
    order by product_id, id
  loop
    perform 1 from public.products
    where id = v_sale_item.product_id
    for update;

    select coalesce(sum(quantity_delta), 0)::numeric(12,3)
    into v_stock_before
    from public.inventory_movements
    where product_id = v_sale_item.product_id;

    insert into public.inventory_movements (
      product_id,
      movement_type,
      quantity_delta,
      quantity_before,
      quantity_after,
      unit_cost,
      unit_price,
      source_product_sale_id,
      source_product_sale_item_id,
      created_by_user_id,
      note
    )
    values (
      v_sale_item.product_id,
      'void',
      v_sale_item.quantity,
      v_stock_before,
      v_stock_before + v_sale_item.quantity,
      v_sale_item.unit_cost,
      v_sale_item.unit_price,
      v_sale.id,
      v_sale_item.id,
      v_request_user_id,
      format('Anulacion de venta %s', v_sale.sale_number)
    );

    v_inventory_movement_count := v_inventory_movement_count + 1;
  end loop;

  insert into public.cash_movements (
    cash_session_id,
    movement_type,
    category,
    payment_method,
    amount,
    cash_effect_amount,
    session_link_status,
    origin,
    created_by_user_id,
    note,
    source_product_sale_id
  )
  values (
    v_session.id,
    'void',
    'product',
    v_sale.payment_method,
    v_sale.total_amount,
    case
      when v_sale.payment_method = 'cash' then v_sale.total_amount * -1
      else 0
    end,
    'assigned',
    'system',
    v_request_user_id,
    coalesce(nullif(trim(coalesce(p_note, '')), ''), format('Anulacion de venta %s', v_sale.sale_number)),
    v_sale.id
  )
  returning *
  into v_cash_movement;

  return jsonb_build_object(
    'product_sale_id', v_sale.id,
    'cash_movement_id', v_cash_movement.id,
    'inventory_movement_count', v_inventory_movement_count
  );
end;
$$;


ALTER FUNCTION "public"."void_product_sale_from_cash_session"("p_product_sale_id" uuid, "p_note" text) OWNER TO "algym_migrator";


REVOKE ALL ON FUNCTION "public"."void_product_sale_from_cash_session"("p_product_sale_id" uuid, "p_note" text) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."void_product_sale_from_cash_session"("p_product_sale_id" uuid, "p_note" text) FROM authenticated, service_role;
GRANT EXECUTE ON FUNCTION "public"."void_product_sale_from_cash_session"("p_product_sale_id" uuid, "p_note" text) TO algym_app;

COMMIT;
