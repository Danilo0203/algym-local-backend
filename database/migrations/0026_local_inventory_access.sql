BEGIN;

-- Las rutas HTTP comprueban permisos por operación; RLS permite que un rol
-- interno con un permiso asignado use la misma transacción de escritura.
CREATE POLICY products_insert_by_permission ON public.products
FOR INSERT TO authenticated
WITH CHECK (public.has_permission('products.create') OR public.is_owner());

CREATE POLICY products_update_by_permission ON public.products
FOR UPDATE TO authenticated
USING (public.has_permission('products.update') OR public.has_permission('products.delete') OR public.is_owner())
WITH CHECK (public.has_permission('products.update') OR public.has_permission('products.delete') OR public.is_owner());

-- Un usuario con inventory.adjust puede bloquear el producto para calcular
-- existencias sin recibir UPDATE general sobre el catálogo de productos.
CREATE OR REPLACE FUNCTION public.lock_inventory_product_for_adjustment(p_product_id uuid)
RETURNS TABLE (id uuid, cost_price numeric, sale_price numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF NOT public.is_owner() AND NOT public.has_permission('inventory.adjust') THEN
    RAISE EXCEPTION 'No autorizado para ajustar inventario';
  END IF;

  RETURN QUERY
    SELECT product.id, product.cost_price, product.sale_price
    FROM public.products AS product
    WHERE product.id = p_product_id
    FOR UPDATE;
END;
$$;

ALTER FUNCTION public.lock_inventory_product_for_adjustment(uuid) OWNER TO algym_migrator;
REVOKE ALL ON FUNCTION public.lock_inventory_product_for_adjustment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_inventory_product_for_adjustment(uuid) FROM authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lock_inventory_product_for_adjustment(uuid) TO algym_app;

COMMIT;
