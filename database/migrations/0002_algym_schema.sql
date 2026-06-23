BEGIN;




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."gender_type" AS ENUM (
    'male',
    'female',
    'other'
);


ALTER TYPE "public"."gender_type" OWNER TO "algym_migrator";


CREATE TYPE "public"."payment_method" AS ENUM (
    'cash',
    'card',
    'transfer'
);


ALTER TYPE "public"."payment_method" OWNER TO "algym_migrator";


CREATE TYPE "public"."sub_status" AS ENUM (
    'active',
    'expired',
    'pending',
    'cancelled'
);


ALTER TYPE "public"."sub_status" OWNER TO "algym_migrator";


CREATE TYPE "public"."user_role" AS ENUM (
    'admin',
    'trainer',
    'client',
    'employee',
    'owner'
);


ALTER TYPE "public"."user_role" OWNER TO "algym_migrator";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "movement_type" "text" NOT NULL,
    "quantity_delta" numeric(12,3) NOT NULL,
    "quantity_before" numeric(12,3),
    "quantity_after" numeric(12,3),
    "unit_cost" numeric(12,2),
    "unit_price" numeric(12,2),
    "source_product_sale_id" "uuid",
    "source_product_sale_item_id" "uuid",
    "created_by_user_id" "uuid" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inventory_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['entry'::"text", 'sale'::"text", 'manual_exit'::"text", 'adjustment'::"text", 'void'::"text"]))),
    CONSTRAINT "inventory_movements_quantity_delta_check" CHECK (("quantity_delta" <> (0)::numeric))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."adjust_product_stock"("p_product_id" "uuid", "p_counted_quantity" numeric, "p_note" "text" DEFAULT NULL::"text") RETURNS "public"."inventory_movements"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid;
  v_role text;
  v_product public.products%rowtype;
  v_stock_before numeric(12,3);
  v_delta numeric(12,3);
  v_movement public.inventory_movements%rowtype;
begin
  v_user_id := auth.uid();
  v_role := public.require_cash_operator(v_user_id);

  if v_role not in ('owner', 'admin') and public.get_profile_role(v_user_id) <> 'admin' then
    raise exception 'No autorizado para ajustar inventario';
  end if;

  if p_counted_quantity is null then
    raise exception 'Ingresa el conteo físico';
  end if;

  select *
  into v_product
  from public.products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado';
  end if;

  select coalesce(sum(quantity_delta), 0)::numeric(12,3)
  into v_stock_before
  from public.inventory_movements
  where product_id = p_product_id;

  v_delta := p_counted_quantity - v_stock_before;

  if v_delta = 0 then
    return null;
  end if;

  insert into public.inventory_movements (
    product_id,
    movement_type,
    quantity_delta,
    quantity_before,
    quantity_after,
    unit_cost,
    created_by_user_id,
    note
  )
  values (
    p_product_id,
    'adjustment',
    v_delta,
    v_stock_before,
    p_counted_quantity,
    v_product.cost_price,
    v_user_id,
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning *
  into v_movement;

  return v_movement;
end;
$$;


ALTER FUNCTION "public"."adjust_product_stock"("p_product_id" "uuid", "p_counted_quantity" numeric, "p_note" "text") OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."cash_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cash_session_id" "uuid",
    "movement_type" "text" NOT NULL,
    "category" "text" NOT NULL,
    "payment_method" "text",
    "amount" numeric(12,2) NOT NULL,
    "cash_effect_amount" numeric(12,2) NOT NULL,
    "session_link_status" "text" NOT NULL,
    "origin" "text" NOT NULL,
    "source_payment_id" "uuid",
    "source_subscription_id" "uuid",
    "customer_id" "uuid",
    "created_by_user_id" "uuid" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "voided_at" timestamp with time zone,
    "voided_by_user_id" "uuid",
    "source_product_sale_id" "uuid",
    CONSTRAINT "cash_movements_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "cash_movements_category_check" CHECK (("category" = ANY (ARRAY['membership'::"text", 'product'::"text", 'enrollment'::"text", 'service'::"text", 'other'::"text"]))),
    CONSTRAINT "cash_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['sale'::"text", 'manual_income'::"text", 'withdrawal'::"text", 'refund'::"text", 'adjustment'::"text", 'void'::"text"]))),
    CONSTRAINT "cash_movements_origin_check" CHECK (("origin" = ANY (ARRAY['system'::"text", 'manual'::"text"]))),
    CONSTRAINT "cash_movements_payment_method_check" CHECK ((("payment_method" IS NULL) OR ("payment_method" = ANY (ARRAY['cash'::"text", 'card'::"text", 'transfer'::"text"])))),
    CONSTRAINT "cash_movements_session_link_status_check" CHECK (("session_link_status" = ANY (ARRAY['assigned'::"text", 'out_of_session'::"text"])))
);


ALTER TABLE "public"."cash_movements" OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."attach_payment_to_cash"("p_payment_id" "uuid", "p_actor_user_id" "uuid" DEFAULT NULL::"uuid", "p_source_category" "text" DEFAULT 'membership'::"text", "p_note" "text" DEFAULT NULL::"text") RETURNS "public"."cash_movements"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_request_user_id uuid;
  v_actor_user_id uuid;
  v_role text;
  v_payment public.payments%rowtype;
  v_existing_movement public.cash_movements%rowtype;
  v_session public.cash_sessions%rowtype;
  v_movement public.cash_movements%rowtype;
  v_cash_effect numeric(12,2);
begin
  v_request_user_id := auth.uid();
  v_role := public.require_cash_operator(v_request_user_id);
  v_actor_user_id := coalesce(p_actor_user_id, v_request_user_id);

  if v_role <> 'owner' and v_actor_user_id <> v_request_user_id then
    raise exception 'No autorizado para asignar pagos a otra caja';
  end if;

  if p_source_category not in ('membership', 'product', 'enrollment', 'service', 'other') then
    raise exception 'Categoría inválida';
  end if;

  select *
  into v_existing_movement
  from public.cash_movements
  where source_payment_id = p_payment_id;

  if found then
    return v_existing_movement;
  end if;

  select *
  into v_payment
  from public.payments
  where id = p_payment_id;

  if not found then
    raise exception 'Pago no encontrado';
  end if;

  if v_payment.status <> 'posted' then
    raise exception 'Solo se pueden asociar pagos publicados';
  end if;

  select *
  into v_session
  from public.find_open_cash_session_for_user(v_actor_user_id);

  v_cash_effect := case
    when v_payment.method = 'cash' then v_payment.amount_paid
    else 0
  end;

  insert into public.cash_movements (
    cash_session_id,
    movement_type,
    category,
    payment_method,
    amount,
    cash_effect_amount,
    session_link_status,
    origin,
    source_payment_id,
    source_subscription_id,
    customer_id,
    created_by_user_id,
    note
  )
  values (
    v_session.id,
    'sale',
    p_source_category,
    v_payment.method,
    v_payment.amount_paid,
    v_cash_effect,
    case when v_session.id is null then 'out_of_session' else 'assigned' end,
    'system',
    v_payment.id,
    v_payment.subscription_id,
    v_payment.user_id,
    v_actor_user_id,
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning *
  into v_movement;

  return v_movement;
end;
$$;


ALTER FUNCTION "public"."attach_payment_to_cash"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_source_category" "text", "p_note" "text") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."build_cash_session_number"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_date_key text;
  v_next_number integer;
begin
  v_date_key := to_char(timezone('America/Guatemala', now()), 'YYYYMMDD');
  perform pg_advisory_xact_lock(hashtext('cash-session-' || v_date_key));

  select coalesce(
    max(
      substring(session_number from 'CJ-\d{8}-(\d{4})$')::integer
    ),
    0
  ) + 1
  into v_next_number
  from public.cash_sessions
  where session_number like ('CJ-' || v_date_key || '-%');

  return format('CJ-%s-%s', v_date_key, lpad(v_next_number::text, 4, '0'));
end;
$_$;


ALTER FUNCTION "public"."build_cash_session_number"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."build_product_sale_number"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_date_key text;
  v_next_number integer;
begin
  v_date_key := to_char(timezone('America/Guatemala', now()), 'YYYYMMDD');
  perform pg_advisory_xact_lock(hashtext('product-sale-' || v_date_key));

  select coalesce(max(substring(sale_number from 'VP-\d{8}-(\d{4})$')::integer), 0) + 1
  into v_next_number
  from public.product_sales
  where sale_number like ('VP-' || v_date_key || '-%');

  return format('VP-%s-%s', v_date_key, lpad(v_next_number::text, 4, '0'));
end;
$_$;


ALTER FUNCTION "public"."build_product_sale_number"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."check_is_admin"() RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  is_admin_user boolean;
BEGIN
  SELECT (role = 'admin'::user_role) INTO is_admin_user
  FROM profiles
  WHERE id = auth.uid();
  
  RETURN COALESCE(is_admin_user, false);
END;
$$;


ALTER FUNCTION "public"."check_is_admin"() OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."cash_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_number" "text" NOT NULL,
    "cash_register_id" "uuid" NOT NULL,
    "opened_by_user_id" "uuid" NOT NULL,
    "closed_by_user_id" "uuid",
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "opening_amount" numeric(12,2) NOT NULL,
    "expected_amount" numeric(12,2),
    "counted_amount" numeric(12,2),
    "difference_amount" numeric(12,2),
    "status" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cash_sessions_opening_amount_check" CHECK (("opening_amount" >= (0)::numeric)),
    CONSTRAINT "cash_sessions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text", 'closed_with_difference'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."cash_sessions" OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text" DEFAULT NULL::"text") RETURNS "public"."cash_sessions"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid;
  v_role text;
  v_session public.cash_sessions%rowtype;
  v_expected_amount numeric(12,2);
  v_difference_amount numeric(12,2);
begin
  v_user_id := auth.uid();
  v_role := public.require_cash_operator(v_user_id);

  if p_counted_amount is null or p_counted_amount < 0 then
    raise exception 'Debe ingresar el monto contado';
  end if;

  select *
  into v_session
  from public.cash_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Sesión de caja no encontrada';
  end if;

  if v_session.status <> 'open' then
    raise exception 'La sesión ya no está abierta';
  end if;

  if v_session.opened_by_user_id <> v_user_id and v_role <> 'owner' then
    raise exception 'No autorizado para cerrar esta sesión';
  end if;

  select
    v_session.opening_amount + coalesce(sum(cm.cash_effect_amount), 0)
  into v_expected_amount
  from public.cash_movements cm
  where cm.cash_session_id = v_session.id
    and cm.session_link_status = 'assigned'
    and cm.voided_at is null;

  v_difference_amount := p_counted_amount - v_expected_amount;

  if v_difference_amount <> 0 and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Debe agregar una observación cuando exista diferencia';
  end if;

  update public.cash_sessions
  set closed_by_user_id = v_user_id,
      closed_at = now(),
      expected_amount = v_expected_amount,
      counted_amount = p_counted_amount,
      difference_amount = v_difference_amount,
      status = case
        when v_difference_amount = 0 then 'closed'
        else 'closed_with_difference'
      end,
      notes = case
        when v_difference_amount = 0 then v_session.notes
        else nullif(trim(coalesce(p_notes, '')), '')
      end
  where id = v_session.id
  returning *
  into v_session;

  return v_session;
end;
$$;


ALTER FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text" DEFAULT NULL::"text", "p_requested_by_user_id" "uuid" DEFAULT NULL::"uuid", "p_closed_by_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."cash_sessions"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_session public.cash_sessions%rowtype;
  v_expected_amount numeric(12,2);
  v_difference_amount numeric(12,2);
  v_closed_role text;
begin
  if p_counted_amount is null or p_counted_amount < 0 then
    raise exception 'Debe ingresar el monto contado';
  end if;

  if p_requested_by_user_id is null then
    raise exception 'Debe indicar el usuario solicitante';
  end if;

  if p_closed_by_user_id is null then
    raise exception 'Debe indicar el usuario que autorizó el cierre';
  end if;

  perform 1
  from public.profiles
  where id = p_requested_by_user_id;

  if not found then
    raise exception 'Usuario solicitante no encontrado';
  end if;

  select role::text
  into v_closed_role
  from public.profiles
  where id = p_closed_by_user_id;

  if not found then
    raise exception 'Usuario que autorizó el cierre no encontrado';
  end if;

  if p_closed_by_user_id <> p_requested_by_user_id and v_closed_role not in ('admin', 'owner') then
    raise exception 'Solo un administrador u owner puede autorizar el cierre de otra caja';
  end if;

  select *
  into v_session
  from public.cash_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Sesión de caja no encontrada';
  end if;

  if v_session.status <> 'open' then
    raise exception 'La sesión ya no está abierta';
  end if;

  if v_session.opened_by_user_id <> p_requested_by_user_id and v_closed_role not in ('admin', 'owner') then
    raise exception 'No autorizado para cerrar esta sesión';
  end if;

  select
    v_session.opening_amount + coalesce(sum(cm.cash_effect_amount), 0)
  into v_expected_amount
  from public.cash_movements cm
  where cm.cash_session_id = v_session.id
    and cm.session_link_status = 'assigned'
    and cm.voided_at is null;

  v_difference_amount := p_counted_amount - v_expected_amount;

  if v_difference_amount <> 0 and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Debe agregar una observación cuando exista diferencia';
  end if;

  update public.cash_sessions
  set closed_by_user_id = p_closed_by_user_id,
      closed_at = now(),
      expected_amount = v_expected_amount,
      counted_amount = p_counted_amount,
      difference_amount = v_difference_amount,
      status = case
        when v_difference_amount = 0 then 'closed'
        else 'closed_with_difference'
      end,
      notes = case
        when v_difference_amount = 0 then v_session.notes
        else nullif(trim(coalesce(p_notes, '')), '')
      end
  where id = v_session.id
  returning *
  into v_session;

  return v_session;
end;
$$;


ALTER FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text", "p_requested_by_user_id" "uuid", "p_closed_by_user_id" "uuid") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."codex_ping"() RETURNS integer
    LANGUAGE "sql"
    AS $$ select 1 $$;


ALTER FUNCTION "public"."codex_ping"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."create_subscription_payment_for_existing_customer"("p_customer_id" "uuid", "p_plan_id" integer DEFAULT NULL::integer, "p_start_date" "date" DEFAULT NULL::"date", "p_end_date" "date" DEFAULT NULL::"date", "p_final_price" numeric DEFAULT NULL::numeric, "p_discount_amount" numeric DEFAULT 0, "p_payment_method" "text" DEFAULT 'cash'::"text", "p_created_by_user_id" "uuid" DEFAULT NULL::"uuid", "p_grace_days" integer DEFAULT 3) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_request_user_id uuid;
  v_role text;
  v_created_by_user_id uuid;
  v_plan public.plans%rowtype;
  v_subscription_id uuid;
  v_payment_id uuid;
  v_movement public.cash_movements%rowtype;
  v_start_date date;
  v_end_date date;
  v_amount_original numeric(12,2);
  v_amount_paid numeric(12,2);
  v_grace_days integer;
begin
  v_request_user_id := auth.uid();
  v_role := public.require_cash_operator(v_request_user_id);

  if v_role <> 'owner' and not exists (
    select 1
    from public.role_permissions rp
    join public.permissions perm on perm.id = rp.permission_id
    join public.roles r on r.id = rp.role_id
    where r.slug = v_role
      and perm.key = 'customers.manage_membership'
  ) then
    raise exception 'Solo administradores pueden registrar altas con pago';
  end if;

  v_created_by_user_id := coalesce(p_created_by_user_id, v_request_user_id);
  v_grace_days := greatest(coalesce(p_grace_days, 3), 0);

  if p_plan_id is null then
    return jsonb_build_object(
      'subscription_id', null,
      'payment_id', null,
      'cash_movement_id', null,
      'session_link_status', null
    );
  end if;

  if p_payment_method not in ('cash', 'card', 'transfer') then
    raise exception 'Método de pago inválido';
  end if;

  select *
  into v_plan
  from public.plans
  where id = p_plan_id;

  if not found then
    raise exception 'Plan no encontrado';
  end if;

  v_start_date := coalesce(p_start_date, timezone('America/Guatemala', now())::date);
  v_end_date := coalesce(p_end_date, (v_start_date + coalesce(v_plan.duration_days, 30)));
  v_amount_original := v_plan.price;
  v_amount_paid := coalesce(p_final_price, v_amount_original - coalesce(p_discount_amount, 0));

  insert into public.subscriptions (
    user_id,
    plan_id,
    start_date,
    end_date,
    status,
    discount_amount,
    grace_days
  )
  values (
    p_customer_id,
    p_plan_id,
    v_start_date,
    v_end_date,
    'active',
    coalesce(p_discount_amount, 0),
    v_grace_days
  )
  returning id
  into v_subscription_id;

  insert into public.payments (
    subscription_id,
    user_id,
    amount_original,
    discount_amount,
    amount_paid,
    method,
    payment_date,
    created_by_user_id,
    status
  )
  values (
    v_subscription_id,
    p_customer_id,
    v_amount_original,
    coalesce(p_discount_amount, 0),
    v_amount_paid,
    p_payment_method,
    now(),
    v_created_by_user_id,
    'posted'
  )
  returning id
  into v_payment_id;

  select *
  into v_movement
  from public.attach_payment_to_cash(
    v_payment_id,
    v_created_by_user_id,
    'membership',
    null
  );

  return jsonb_build_object(
    'subscription_id', v_subscription_id,
    'payment_id', v_payment_id,
    'cash_movement_id', v_movement.id,
    'session_link_status', v_movement.session_link_status
  );
end;
$$;


ALTER FUNCTION "public"."create_subscription_payment_for_existing_customer"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_final_price" numeric, "p_discount_amount" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid", "p_grace_days" integer) OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."find_open_cash_session_for_user"("p_user_id" "uuid") RETURNS "public"."cash_sessions"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select cs.*
  from public.cash_sessions cs
  where cs.opened_by_user_id = p_user_id
    and cs.status = 'open'
  order by cs.opened_at desc
  limit 1
$$;


ALTER FUNCTION "public"."find_open_cash_session_for_user"("p_user_id" "uuid") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."get_current_permissions"() RETURNS "text"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(array_agg(perm.key order by perm.key), '{}')
  from public.role_permissions rp
  join public.permissions perm on perm.id = rp.permission_id
  join public.roles r on r.id = rp.role_id
  join public.profiles p on p.role::text = r.slug
  where p.id = auth.uid()
$$;


ALTER FUNCTION "public"."get_current_permissions"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."get_current_role_slug"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select r.slug
  from public.profiles p
  join public.roles r on r.slug = p.role::text
  where p.id = auth.uid()
$$;


ALTER FUNCTION "public"."get_current_role_slug"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."get_my_role"() RETURNS "public"."user_role"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;


ALTER FUNCTION "public"."get_my_role"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."get_profile_role"("p_user_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.role
  from public.profiles p
  where p.id = p_user_id
$$;


ALTER FUNCTION "public"."get_profile_role"("p_user_id" "uuid") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."has_permission"("p_permission_key" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.role_permissions rp
    join public.permissions perm on perm.id = rp.permission_id
    join public.profiles prof on prof.role::text = (
      select r.slug from public.roles r where r.id = rp.role_id
    )
    where prof.id = auth.uid()
      and perm.key = p_permission_key
  )
  or public.is_owner()
$$;


ALTER FUNCTION "public"."has_permission"("p_permission_key" "text") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."insert_reversal_cash_movement"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_category" "text", "p_note" "text" DEFAULT NULL::"text") RETURNS "public"."cash_movements"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_payment public.payments%rowtype;
  v_session public.cash_sessions%rowtype;
  v_category text;
  v_movement public.cash_movements%rowtype;
  v_cash_effect numeric(12,2);
begin
  select *
  into v_payment
  from public.payments
  where id = p_payment_id;

  if not found then
    raise exception 'Pago no encontrado';
  end if;

  v_category := coalesce(p_category, 'other');
  if v_category not in ('membership', 'product', 'enrollment', 'service', 'other') then
    raise exception 'Categoría inválida';
  end if;

  select *
  into v_session
  from public.find_open_cash_session_for_user(p_actor_user_id);

  v_cash_effect := case
    when v_payment.method = 'cash' then v_payment.amount_paid * -1
    else 0
  end;

  insert into public.cash_movements (
    cash_session_id,
    movement_type,
    category,
    payment_method,
    amount,
    cash_effect_amount,
    session_link_status,
    origin,
    source_subscription_id,
    customer_id,
    created_by_user_id,
    note
  )
  values (
    v_session.id,
    'void',
    v_category,
    v_payment.method,
    v_payment.amount_paid,
    v_cash_effect,
    case when v_session.id is null then 'out_of_session' else 'assigned' end,
    'system',
    v_payment.subscription_id,
    v_payment.user_id,
    p_actor_user_id,
    coalesce(p_note, format('Reverso del pago %s', p_payment_id))
  )
  returning *
  into v_movement;

  return v_movement;
end;
$$;


ALTER FUNCTION "public"."insert_reversal_cash_movement"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_category" "text", "p_note" "text") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."is_owner"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.role::text = 'owner'
  from public.profiles p
  where p.id = auth.uid()
$$;


ALTER FUNCTION "public"."is_owner"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."open_cash_session"("p_register_id" "uuid", "p_opening_amount" numeric, "p_notes" "text" DEFAULT NULL::"text") RETURNS "public"."cash_sessions"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid;
  v_session public.cash_sessions%rowtype;
begin
  v_user_id := auth.uid();
  perform public.require_cash_operator(v_user_id);

  if p_opening_amount is null or p_opening_amount < 0 then
    raise exception 'El monto inicial debe ser mayor o igual a 0';
  end if;

  if not exists (
    select 1
    from public.cash_registers cr
    where cr.id = p_register_id
      and cr.is_active = true
  ) then
    raise exception 'Caja no disponible';
  end if;

  if exists (
    select 1
    from public.cash_sessions cs
    where cs.opened_by_user_id = v_user_id
      and cs.status = 'open'
  ) then
    raise exception 'El usuario ya tiene una caja abierta';
  end if;

  insert into public.cash_sessions (
    session_number,
    cash_register_id,
    opened_by_user_id,
    opened_at,
    opening_amount,
    status,
    notes
  )
  values (
    public.build_cash_session_number(),
    p_register_id,
    v_user_id,
    now(),
    p_opening_amount,
    'open',
    nullif(trim(coalesce(p_notes, '')), '')
  )
  returning *
  into v_session;

  return v_session;
end;
$$;


ALTER FUNCTION "public"."open_cash_session"("p_register_id" "uuid", "p_opening_amount" numeric, "p_notes" "text") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."prevent_locked_payment_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
    if (to_jsonb(new) - array['status', 'reversed_at', 'reversed_by_user_id', 'replacement_payment_id', 'reversal_reason'])
       <> (to_jsonb(old) - array['status', 'reversed_at', 'reversed_by_user_id', 'replacement_payment_id', 'reversal_reason']) then
      raise exception 'No se puede modificar el núcleo de un pago vinculado a una caja cerrada';
    end if;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."prevent_locked_payment_mutation"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."record_manual_cash_movement"("p_session_id" "uuid", "p_movement_type" "text", "p_category" "text", "p_amount" numeric, "p_payment_method" "text" DEFAULT NULL::"text", "p_note" "text" DEFAULT NULL::"text", "p_customer_id" "uuid" DEFAULT NULL::"uuid", "p_cash_effect_amount" numeric DEFAULT NULL::numeric) RETURNS "public"."cash_movements"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid;
  v_role text;
  v_session public.cash_sessions%rowtype;
  v_cash_effect numeric(12,2);
  v_payment_method text;
  v_movement public.cash_movements%rowtype;
begin
  v_user_id := auth.uid();
  v_role := public.require_cash_operator(v_user_id);

  if p_movement_type not in ('manual_income', 'withdrawal', 'refund', 'adjustment') then
    raise exception 'Tipo de movimiento manual inválido';
  end if;

  if p_category not in ('membership', 'product', 'enrollment', 'service', 'other') then
    raise exception 'Categoría inválida';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'El monto debe ser mayor a 0';
  end if;

  if p_payment_method is not null and p_payment_method not in ('cash', 'card', 'transfer') then
    raise exception 'Método de pago inválido';
  end if;

  select *
  into v_session
  from public.cash_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Sesión de caja no encontrada';
  end if;

  if v_session.status <> 'open' then
    raise exception 'No se pueden registrar movimientos sobre una caja cerrada';
  end if;

  if v_session.opened_by_user_id <> v_user_id and v_role <> 'owner' then
    raise exception 'No autorizado para registrar movimientos en esta caja';
  end if;

  if p_movement_type = 'manual_income' then
    v_cash_effect := p_amount;
    v_payment_method := coalesce(p_payment_method, 'cash');
  elsif p_movement_type = 'withdrawal' then
    v_cash_effect := p_amount * -1;
    v_payment_method := coalesce(p_payment_method, 'cash');
  elsif p_movement_type = 'refund' then
    v_payment_method := coalesce(p_payment_method, 'cash');
    v_cash_effect := case when v_payment_method = 'cash' then p_amount * -1 else 0 end;
  else
    if p_cash_effect_amount is null or p_cash_effect_amount = 0 then
      raise exception 'Los ajustes requieren cash_effect_amount firmado';
    end if;

    if abs(p_cash_effect_amount) <> p_amount then
      raise exception 'En ajustes, amount debe coincidir con el valor absoluto de cash_effect_amount';
    end if;

    v_cash_effect := p_cash_effect_amount;
    v_payment_method := p_payment_method;
  end if;

  insert into public.cash_movements (
    cash_session_id,
    movement_type,
    category,
    payment_method,
    amount,
    cash_effect_amount,
    session_link_status,
    origin,
    customer_id,
    created_by_user_id,
    note
  )
  values (
    v_session.id,
    p_movement_type,
    p_category,
    v_payment_method,
    p_amount,
    v_cash_effect,
    'assigned',
    'manual',
    p_customer_id,
    v_user_id,
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning *
  into v_movement;

  return v_movement;
end;
$$;


ALTER FUNCTION "public"."record_manual_cash_movement"("p_session_id" "uuid", "p_movement_type" "text", "p_category" "text", "p_amount" numeric, "p_payment_method" "text", "p_note" "text", "p_customer_id" "uuid", "p_cash_effect_amount" numeric) OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."record_product_inventory_movement"("p_product_id" "uuid", "p_movement_type" "text", "p_quantity" numeric, "p_unit_cost" numeric DEFAULT NULL::numeric, "p_note" "text" DEFAULT NULL::"text") RETURNS "public"."inventory_movements"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid;
  v_role text;
  v_product public.products%rowtype;
  v_stock_before numeric(12,3);
  v_delta numeric(12,3);
  v_movement public.inventory_movements%rowtype;
begin
  v_user_id := auth.uid();
  v_role := public.require_cash_operator(v_user_id);

  if v_role not in ('owner', 'admin') and public.get_profile_role(v_user_id) <> 'admin' then
    raise exception 'No autorizado para ajustar inventario';
  end if;

  if p_movement_type not in ('entry', 'manual_exit') then
    raise exception 'Tipo de movimiento inválido';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'La cantidad debe ser mayor a 0';
  end if;

  select *
  into v_product
  from public.products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'Producto no encontrado';
  end if;

  select coalesce(sum(quantity_delta), 0)::numeric(12,3)
  into v_stock_before
  from public.inventory_movements
  where product_id = p_product_id;

  v_delta := case when p_movement_type = 'entry' then p_quantity else p_quantity * -1 end;

  insert into public.inventory_movements (
    product_id,
    movement_type,
    quantity_delta,
    quantity_before,
    quantity_after,
    unit_cost,
    created_by_user_id,
    note
  )
  values (
    p_product_id,
    p_movement_type,
    v_delta,
    v_stock_before,
    v_stock_before + v_delta,
    coalesce(p_unit_cost, v_product.cost_price),
    v_user_id,
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning *
  into v_movement;

  return v_movement;
end;
$$;


ALTER FUNCTION "public"."record_product_inventory_movement"("p_product_id" "uuid", "p_movement_type" "text", "p_quantity" numeric, "p_unit_cost" numeric, "p_note" "text") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."renew_subscription_with_payment"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_price" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid" DEFAULT NULL::"uuid", "p_grace_days" integer DEFAULT 3) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_request_user_id uuid;
  v_role text;
  v_created_by_user_id uuid;
  v_subscription_id uuid;
  v_payment_id uuid;
  v_movement public.cash_movements%rowtype;
  v_grace_days integer;
begin
  v_request_user_id := auth.uid();
  v_role := public.require_cash_operator(v_request_user_id);
  v_created_by_user_id := coalesce(p_created_by_user_id, v_request_user_id);
  v_grace_days := greatest(coalesce(p_grace_days, 3), 0);

  if p_payment_method not in ('cash', 'card', 'transfer') then
    raise exception 'Método de pago inválido';
  end if;

  if not exists (
    select 1
    from public.plans
    where id = p_plan_id
  ) then
    raise exception 'Plan no encontrado';
  end if;

  update public.subscriptions
  set status = 'expired'
  where user_id = p_customer_id
    and status = 'active';

  insert into public.subscriptions (
    user_id,
    plan_id,
    start_date,
    end_date,
    status,
    discount_amount,
    grace_days
  )
  values (
    p_customer_id,
    p_plan_id,
    p_start_date,
    p_end_date,
    'active',
    coalesce(p_discount_amount, 0),
    v_grace_days
  )
  returning id
  into v_subscription_id;

  insert into public.payments (
    subscription_id,
    user_id,
    amount_original,
    discount_amount,
    amount_paid,
    method,
    payment_date,
    created_by_user_id,
    status
  )
  values (
    v_subscription_id,
    p_customer_id,
    p_price,
    coalesce(p_discount_amount, 0),
    p_amount_paid,
    p_payment_method,
    now(),
    v_created_by_user_id,
    'posted'
  )
  returning id
  into v_payment_id;

  select *
  into v_movement
  from public.attach_payment_to_cash(
    v_payment_id,
    v_created_by_user_id,
    'membership',
    null
  );

  return jsonb_build_object(
    'subscription_id', v_subscription_id,
    'payment_id', v_payment_id,
    'cash_movement_id', v_movement.id,
    'session_link_status', v_movement.session_link_status
  );
end;
$$;


ALTER FUNCTION "public"."renew_subscription_with_payment"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_price" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid", "p_grace_days" integer) OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."require_cash_operator"("p_user_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_role text;
begin
  if p_user_id is null then
    raise exception 'Usuario no autenticado';
  end if;

  v_role := public.get_profile_role(p_user_id);

  if v_role is null then
    raise exception 'Perfil no encontrado';
  end if;

  if v_role = 'owner' then
    return v_role;
  end if;

  if not exists (
    select 1
    from public.role_permissions rp
    join public.permissions perm on perm.id = rp.permission_id
    join public.roles r on r.id = rp.role_id
    where r.slug = v_role
      and perm.key = 'cash.operate'
  ) then
    raise exception 'No autorizado para operar caja';
  end if;

  return v_role;
end;
$$;


ALTER FUNCTION "public"."require_cash_operator"("p_user_id" "uuid") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."reverse_and_recreate_payment"("p_payment_id" "uuid", "p_amount_original" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_reason" "text", "p_source_category" "text" DEFAULT 'membership'::"text", "p_note" "text" DEFAULT NULL::"text", "p_actor_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_request_user_id uuid;
  v_role text;
  v_actor_user_id uuid;
  v_original_payment public.payments%rowtype;
  v_reversal_movement public.cash_movements%rowtype;
  v_replacement_movement public.cash_movements%rowtype;
  v_replacement_payment_id uuid;
begin
  v_request_user_id := auth.uid();
  v_role := public.require_cash_operator(v_request_user_id);

  if v_role <> 'owner' and not exists (
    select 1
    from public.role_permissions rp
    join public.permissions perm on perm.id = rp.permission_id
    join public.roles r on r.id = rp.role_id
    where r.slug = v_role
      and perm.key = 'cash.reverse_payment'
  ) then
    raise exception 'Solo administradores pueden revertir pagos';
  end if;

  v_actor_user_id := coalesce(p_actor_user_id, v_request_user_id);

  if p_payment_method not in ('cash', 'card', 'transfer') then
    raise exception 'Método de pago inválido';
  end if;

  if p_source_category not in ('membership', 'product', 'enrollment', 'service', 'other') then
    raise exception 'Categoría inválida';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Debe indicar el motivo del reverso';
  end if;

  select *
  into v_original_payment
  from public.payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'Pago no encontrado';
  end if;

  if v_original_payment.status <> 'posted' then
    raise exception 'Solo se pueden revertir pagos publicados';
  end if;

  select *
  into v_reversal_movement
  from public.insert_reversal_cash_movement(
    p_payment_id,
    v_actor_user_id,
    p_source_category,
    coalesce(p_note, format('Reverso administrativo del pago %s', p_payment_id))
  );

  insert into public.payments (
    subscription_id,
    user_id,
    amount_original,
    discount_amount,
    amount_paid,
    method,
    payment_date,
    created_by_user_id,
    status
  )
  values (
    v_original_payment.subscription_id,
    v_original_payment.user_id,
    p_amount_original,
    coalesce(p_discount_amount, 0),
    p_amount_paid,
    p_payment_method,
    now(),
    v_actor_user_id,
    'posted'
  )
  returning id
  into v_replacement_payment_id;

  update public.payments
  set status = 'reversed',
      reversed_at = now(),
      reversed_by_user_id = v_actor_user_id,
      replacement_payment_id = v_replacement_payment_id,
      reversal_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_payment_id;

  select *
  into v_replacement_movement
  from public.attach_payment_to_cash(
    v_replacement_payment_id,
    v_actor_user_id,
    p_source_category,
    p_note
  );

  return jsonb_build_object(
    'reversed_payment_id', p_payment_id,
    'replacement_payment_id', v_replacement_payment_id,
    'reversal_movement_id', v_reversal_movement.id,
    'replacement_movement_id', v_replacement_movement.id
  );
end;
$$;


ALTER FUNCTION "public"."reverse_and_recreate_payment"("p_payment_id" "uuid", "p_amount_original" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_reason" "text", "p_source_category" "text", "p_note" "text", "p_actor_user_id" "uuid") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."roles_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."roles_set_updated_at"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."sell_products_from_cash_session"("p_items" "jsonb", "p_payment_method" "text" DEFAULT 'cash'::"text", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid;
  v_role text;
  v_session public.cash_sessions%rowtype;
  v_sale public.product_sales%rowtype;
  v_item jsonb;
  v_product public.products%rowtype;
  v_quantity numeric(12,3);
  v_line_total numeric(12,2);
  v_total numeric(12,2) := 0;
  v_cash_effect numeric(12,2) := 0;
  v_stock_before numeric(12,3);
  v_sale_item public.product_sale_items%rowtype;
  v_cash_movement public.cash_movements%rowtype;
  v_item_count integer := 0;
begin
  v_user_id := auth.uid();
  v_role := public.require_cash_operator(v_user_id);

  if p_payment_method not in ('cash', 'card', 'transfer') then
    raise exception 'Método de pago inválido';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agrega al menos un producto para vender';
  end if;

  select *
  into v_session
  from public.find_open_cash_session_for_user(v_user_id);

  if v_session.id is null then
    raise exception 'Abre una caja antes de vender productos';
  end if;

  insert into public.product_sales (
    cash_session_id,
    sale_number,
    payment_method,
    subtotal_amount,
    total_amount,
    sold_by_user_id,
    note
  )
  values (
    v_session.id,
    public.build_product_sale_number(),
    p_payment_method,
    0,
    0,
    v_user_id,
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning *
  into v_sale;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_quantity := nullif((v_item ->> 'quantity'), '')::numeric;

    if v_quantity is null or v_quantity <= 0 then
      raise exception 'La cantidad debe ser mayor a 0';
    end if;

    select *
    into v_product
    from public.products
    where id = nullif((v_item ->> 'product_id'), '')::uuid
    for update;

    if not found then
      raise exception 'Producto no encontrado';
    end if;

    if v_product.is_active is not true then
      raise exception 'El producto % no está activo', v_product.name;
    end if;

    select coalesce(sum(quantity_delta), 0)::numeric(12,3)
    into v_stock_before
    from public.inventory_movements
    where product_id = v_product.id;

    v_line_total := round((v_product.sale_price * v_quantity)::numeric, 2);
    v_total := v_total + v_line_total;
    v_item_count := v_item_count + 1;

    insert into public.product_sale_items (
      product_sale_id,
      product_id,
      product_name,
      sku,
      barcode,
      quantity,
      unit_cost,
      unit_price,
      line_total
    )
    values (
      v_sale.id,
      v_product.id,
      v_product.name,
      v_product.sku,
      v_product.barcode,
      v_quantity,
      v_product.cost_price,
      v_product.sale_price,
      v_line_total
    )
    returning *
    into v_sale_item;

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
      v_product.id,
      'sale',
      v_quantity * -1,
      v_stock_before,
      v_stock_before - v_quantity,
      v_product.cost_price,
      v_product.sale_price,
      v_sale.id,
      v_sale_item.id,
      v_user_id,
      format('Venta %s', v_sale.sale_number)
    );
  end loop;

  if v_item_count = 0 then
    raise exception 'Agrega al menos un producto para vender';
  end if;

  update public.product_sales
  set subtotal_amount = round(v_total, 2),
      total_amount = round(v_total, 2)
  where id = v_sale.id
  returning *
  into v_sale;

  v_cash_effect := case
    when p_payment_method = 'cash' then v_sale.total_amount
    else 0
  end;

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
    'sale',
    'product',
    p_payment_method,
    v_sale.total_amount,
    v_cash_effect,
    'assigned',
    'system',
    v_user_id,
    coalesce(nullif(trim(coalesce(p_note, '')), ''), format('Venta de productos %s', v_sale.sale_number)),
    v_sale.id
  )
  returning *
  into v_cash_movement;

  return jsonb_build_object(
    'product_sale_id', v_sale.id,
    'sale_number', v_sale.sale_number,
    'cash_movement_id', v_cash_movement.id,
    'total_amount', v_sale.total_amount
  );
end;
$$;


ALTER FUNCTION "public"."sell_products_from_cash_session"("p_items" "jsonb", "p_payment_method" "text", "p_note" "text") OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."set_row_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;


ALTER FUNCTION "public"."set_row_updated_at"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."subscription_access_until"("p_end_date" "date", "p_grace_days" integer DEFAULT 3) RETURNS "date"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  with base as (
    select p_end_date + greatest(coalesce(p_grace_days, 3), 0) as access_date
  )
  select case extract(isodow from access_date)::int
    when 6 then access_date + 2
    when 7 then access_date + 1
    else access_date
  end
  from base;
$$;


ALTER FUNCTION "public"."subscription_access_until"("p_end_date" "date", "p_grace_days" integer) OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."sync_profile_from_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_full_name text;
  v_role user_role;
begin
  v_full_name := nullif(
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    ''
  );

  v_role := case lower(coalesce(new.raw_user_meta_data->>'role', 'client'))
    when 'owner' then 'owner'::user_role
    when 'admin' then 'admin'::user_role
    when 'trainer' then 'trainer'::user_role
    when 'employee' then 'employee'::user_role
    when 'client' then 'client'::user_role
    else 'client'::user_role
  end;

  insert into public.profiles (id, full_name, phone, birth_date, role, created_at, updated_at)
  values (
    new.id,
    coalesce(v_full_name, 'Sin nombre'),
    coalesce(nullif(new.raw_user_meta_data->>'phone', ''), ''),
    current_date,
    v_role,
    coalesce(new.created_at, timezone('utc'::text, now())),
    timezone('utc'::text, now())
  )
  on conflict (id) do update
    set full_name = excluded.full_name,
        role = coalesce(public.profiles.role, excluded.role),
        updated_at = timezone('utc'::text, now());

  return new;
end;
$$;


ALTER FUNCTION "public"."sync_profile_from_auth_user"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."sync_user_to_zkteco"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  -- Reemplaza con el Serial Number real de tu dispositivo si cambia
  target_device_id text := 'CN4C232260011';
BEGIN
  -- Solo enviamos si hay un ID biométrico válido
  IF NEW.biometric_id IS NOT NULL THEN
    INSERT INTO public.device_commands (device_id, command, executed)
    VALUES (
      target_device_id,
      -- Concatenamos el comando. 
      -- NOTA: Asegúrate que full_name no rompa el comando si tiene espacios (ZKTeco a veces prefiere guiones)
      'DATA UPDATE USERINFO PIN=' || NEW.biometric_id || ' Name=' || NEW.full_name || ' Pri=0',
      FALSE
    );
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_user_to_zkteco"() OWNER TO "algym_migrator";


CREATE OR REPLACE FUNCTION "public"."touch_products_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_products_updated_at"() OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."access_logs" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "check_in_time" timestamp with time zone DEFAULT "now"(),
    "status" "text"
);


ALTER TABLE "public"."access_logs" OWNER TO "algym_migrator";


ALTER TABLE "public"."access_logs" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."access_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."plans" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "duration_days" integer NOT NULL,
    "price" numeric(10,2) NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true
);


ALTER TABLE "public"."plans" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "birth_date" "date" NOT NULL,
    "gender" "public"."gender_type" DEFAULT 'male'::"public"."gender_type" NOT NULL,
    "injuries" "text",
    "medical_notes" "text",
    "avatar_url" "text",
    "role" "public"."user_role" DEFAULT 'client'::"public"."user_role",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "device_id" integer,
    "biometric_id" integer NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "training_profile_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    CONSTRAINT "profiles_training_profile_status_check" CHECK (("training_profile_status" = ANY (ARRAY['pending'::"text", 'complete'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "plan_id" bigint NOT NULL,
    "start_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "end_date" "date" NOT NULL,
    "status" "public"."sub_status" DEFAULT 'active'::"public"."sub_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "discount_amount" numeric(10,2) DEFAULT 0,
    "grace_days" integer DEFAULT 3 NOT NULL,
    CONSTRAINT "subscriptions_grace_days_non_negative" CHECK (("grace_days" >= 0))
);


ALTER TABLE "public"."subscriptions" OWNER TO "algym_migrator";


COMMENT ON COLUMN "public"."subscriptions"."discount_amount" IS 'Descuento aplicado al momento de la suscripción';



COMMENT ON COLUMN "public"."subscriptions"."grace_days" IS 'Días de prórroga de acceso después de end_date.';



CREATE OR REPLACE VIEW "public"."active_memberships_view" WITH ("security_invoker"='true') AS
 SELECT "p"."full_name",
    "p"."avatar_url",
    "p"."phone",
    "s"."user_id",
    "s"."end_date",
    "s"."grace_days",
    "public"."subscription_access_until"("s"."end_date", "s"."grace_days") AS "access_until",
    "pl"."name" AS "plan_name",
        CASE
            WHEN ("public"."subscription_access_until"("s"."end_date", "s"."grace_days") < CURRENT_DATE) THEN 'Vencido'::"text"
            WHEN ("s"."end_date" < CURRENT_DATE) THEN 'En Prórroga'::"text"
            WHEN (("s"."end_date" >= CURRENT_DATE) AND ("s"."end_date" <= (CURRENT_DATE + 5))) THEN 'Por Vencer'::"text"
            ELSE 'Al día'::"text"
        END AS "status_label"
   FROM (("public"."subscriptions" "s"
     JOIN "public"."profiles" "p" ON (("s"."user_id" = "p"."id")))
     JOIN "public"."plans" "pl" ON (("s"."plan_id" = "pl"."id")))
  WHERE ("s"."status" = 'active'::"public"."sub_status");


ALTER VIEW "public"."active_memberships_view" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."attendance_logs" (
    "id" bigint NOT NULL,
    "device_id" "text" NOT NULL,
    "biometric_id" integer NOT NULL,
    "punch_time" timestamp with time zone NOT NULL,
    "status1" integer,
    "status2" integer,
    "status3" integer,
    "status4" integer,
    "status5" integer,
    "raw_line" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."attendance_logs" OWNER TO "algym_migrator";


CREATE SEQUENCE IF NOT EXISTS "public"."attendance_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."attendance_logs_id_seq" OWNER TO "algym_migrator";


ALTER SEQUENCE "public"."attendance_logs_id_seq" OWNED BY "public"."attendance_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."body_assessments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "date" "date" DEFAULT CURRENT_DATE,
    "weight_kg" numeric(5,2) NOT NULL,
    "height_cm" numeric(5,2) NOT NULL,
    "body_fat_percentage" numeric(4,2),
    "muscle_mass_kg" numeric(5,2),
    "body_type" "text",
    "activity_level" "text",
    "water_liters_goal" numeric(4,2),
    "daily_calories" integer,
    "protein_grams" integer,
    "carbs_grams" integer,
    "fat_grams" integer,
    "chest" numeric(5,2),
    "waist" numeric(5,2),
    "hip" numeric(5,2),
    "arm_right" numeric(5,2),
    "arm_left" numeric(5,2),
    "leg_right" numeric(5,2),
    "leg_left" numeric(5,2),
    "photos_url" "text"[],
    "diet_type" "text",
    CONSTRAINT "body_assessments_diet_type_check" CHECK ((("diet_type" IS NULL) OR ("diet_type" = ANY (ARRAY['hipocalorica'::"text", 'normocalorica'::"text", 'hipercalorica'::"text"]))))
);


ALTER TABLE "public"."body_assessments" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."cash_registers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cash_registers" OWNER TO "algym_migrator";


CREATE OR REPLACE VIEW "public"."customer_overview" WITH ("security_invoker"='true') AS
 WITH "latest_subscription" AS (
         SELECT DISTINCT ON ("subscriptions"."user_id") "subscriptions"."user_id",
            "subscriptions"."status",
            "subscriptions"."start_date",
            "subscriptions"."end_date",
            "subscriptions"."grace_days",
            "public"."subscription_access_until"("subscriptions"."end_date", "subscriptions"."grace_days") AS "access_until",
            "subscriptions"."plan_id"
           FROM "public"."subscriptions"
          ORDER BY "subscriptions"."user_id",
                CASE
                    WHEN ("subscriptions"."status" = 'active'::"public"."sub_status") THEN 0
                    ELSE 1
                END, "subscriptions"."created_at" DESC
        ), "latest_access" AS (
         SELECT DISTINCT ON ("access_logs"."user_id") "access_logs"."user_id",
            "access_logs"."check_in_time"
           FROM "public"."access_logs"
          ORDER BY "access_logs"."user_id", "access_logs"."check_in_time" DESC
        ), "subscription_state" AS (
         SELECT "p_1"."id" AS "user_id",
                CASE
                    WHEN ("ls_1"."status" IS NULL) THEN 'none'::"text"
                    WHEN ("ls_1"."status" = 'cancelled'::"public"."sub_status") THEN 'cancelled'::"text"
                    WHEN ("ls_1"."access_until" < CURRENT_DATE) THEN 'expired'::"text"
                    WHEN (("ls_1"."end_date" < CURRENT_DATE) AND ("ls_1"."access_until" >= CURRENT_DATE)) THEN 'grace'::"text"
                    WHEN (("ls_1"."end_date" >= CURRENT_DATE) AND (("ls_1"."end_date" - CURRENT_DATE) <= 3)) THEN 'expiring'::"text"
                    WHEN ("ls_1"."status" = 'active'::"public"."sub_status") THEN 'active'::"text"
                    ELSE "lower"(("ls_1"."status")::"text")
                END AS "subscription_display_status"
           FROM ("public"."profiles" "p_1"
             LEFT JOIN "latest_subscription" "ls_1" ON (("p_1"."id" = "ls_1"."user_id")))
        )
 SELECT "p"."id",
    "p"."full_name",
    "p"."phone",
    "p"."avatar_url",
    "p"."role",
    "p"."birth_date",
    "p"."gender",
    "p"."is_active",
        CASE
            WHEN (("ls"."status" = 'active'::"public"."sub_status") AND ("ls"."access_until" < CURRENT_DATE)) THEN 'expired'::"public"."sub_status"
            ELSE "ls"."status"
        END AS "subscription_status",
    "ls"."start_date" AS "subscription_start_date",
    "ls"."end_date" AS "subscription_end_date",
    "ls"."grace_days" AS "subscription_grace_days",
    "ls"."access_until" AS "subscription_access_until",
    "ls"."plan_id",
    "pl"."name" AS "plan_name",
    "la"."check_in_time" AS "last_check_in",
    "lower"("public"."unaccent"(COALESCE("p"."full_name", ''::"text"))) AS "full_name_search",
    "ss"."subscription_display_status"
   FROM (((("public"."profiles" "p"
     LEFT JOIN "latest_subscription" "ls" ON (("p"."id" = "ls"."user_id")))
     LEFT JOIN "subscription_state" "ss" ON (("p"."id" = "ss"."user_id")))
     LEFT JOIN "public"."plans" "pl" ON (("ls"."plan_id" = "pl"."id")))
     LEFT JOIN "latest_access" "la" ON (("la"."user_id" = "p"."id")))
  WHERE ("p"."role" = 'client'::"public"."user_role");


ALTER VIEW "public"."customer_overview" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."device_commands" (
    "id" bigint NOT NULL,
    "device_id" "text" NOT NULL,
    "command" "text" NOT NULL,
    "executed" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    "return_code" "text"
);


ALTER TABLE "public"."device_commands" OWNER TO "algym_migrator";


ALTER TABLE "public"."device_commands" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."device_commands_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."exercises" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "target_muscle" "text",
    "equipment_needed" "text",
    "animation_url" "text",
    "video_url" "text",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "slug" "text",
    "display_name" "text",
    "display_name_es" "text",
    "provider" "text",
    "provider_item_id" "text",
    "body_parts" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "target_muscles" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "secondary_muscles" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "equipments" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "exercise_type" "text",
    "instructions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "tips" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "keywords" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "variations" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "raw_payload" "jsonb",
    "last_synced_at" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "image_url" "text",
    "is_favorite" boolean DEFAULT false NOT NULL,
    "is_preview_hidden" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."exercises" OWNER TO "algym_migrator";


ALTER TABLE "public"."exercises" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."exercises_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."message_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."message_templates" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subscription_id" "uuid",
    "user_id" "uuid",
    "amount_original" numeric(10,2) NOT NULL,
    "discount_amount" numeric(10,2) DEFAULT 0,
    "amount_paid" numeric(10,2) NOT NULL,
    "method" "public"."payment_method" DEFAULT 'cash'::"public"."payment_method",
    "payment_date" timestamp with time zone DEFAULT "now"(),
    "notes" "text",
    "created_by_user_id" "uuid",
    "status" "text" DEFAULT 'posted'::"text" NOT NULL,
    "reversed_at" timestamp with time zone,
    "reversed_by_user_id" "uuid",
    "replacement_payment_id" "uuid",
    "reversal_reason" "text",
    CONSTRAINT "payments_status_check" CHECK (("status" = ANY (ARRAY['posted'::"text", 'reversed'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "algym_migrator";


CREATE OR REPLACE VIEW "public"."monthly_revenue_view" WITH ("security_invoker"='true') AS
 SELECT "to_char"("payment_date", 'YYYY-MM'::"text") AS "month_year",
    "sum"("amount_paid") AS "total_income",
    "count"("id") AS "transactions_count",
    "method"
   FROM "public"."payments"
  GROUP BY ("to_char"("payment_date", 'YYYY-MM'::"text")), "method"
  ORDER BY ("to_char"("payment_date", 'YYYY-MM'::"text")) DESC;


ALTER VIEW "public"."monthly_revenue_view" OWNER TO "algym_migrator";


CREATE OR REPLACE VIEW "public"."payments_overview" WITH ("security_invoker"='true') AS
 SELECT "p"."id",
    "p"."payment_date",
    "p"."amount_paid",
    "p"."method",
    "p"."user_id",
    "p"."subscription_id",
    "pr"."full_name" AS "user_name",
    "pr"."avatar_url",
    "pl"."name" AS "plan_name",
        CASE
            WHEN (("s"."status" = 'active'::"public"."sub_status") AND ("public"."subscription_access_until"("s"."end_date", "s"."grace_days") < CURRENT_DATE)) THEN 'expired'::"public"."sub_status"
            ELSE "s"."status"
        END AS "subscription_status",
    "s"."end_date" AS "subscription_end_date",
    "s"."grace_days" AS "subscription_grace_days",
    "public"."subscription_access_until"("s"."end_date", "s"."grace_days") AS "subscription_access_until"
   FROM ((("public"."payments" "p"
     LEFT JOIN "public"."profiles" "pr" ON (("pr"."id" = "p"."user_id")))
     LEFT JOIN "public"."subscriptions" "s" ON (("s"."id" = "p"."subscription_id")))
     LEFT JOIN "public"."plans" "pl" ON (("pl"."id" = "s"."plan_id")))
  WHERE ("p"."status" = 'posted'::"text");


ALTER VIEW "public"."payments_overview" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "description" "text",
    "module" "text" NOT NULL,
    "action" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."permissions" OWNER TO "algym_migrator";


ALTER TABLE "public"."plans" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."plans_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."product_inventory_overview" AS
SELECT
    NULL::"uuid" AS "id",
    NULL::"text" AS "name",
    NULL::"text" AS "sku",
    NULL::"text" AS "barcode",
    NULL::"text" AS "image_url",
    NULL::numeric(12,2) AS "cost_price",
    NULL::numeric(12,2) AS "sale_price",
    NULL::boolean AS "is_active",
    NULL::numeric(12,3) AS "stock_quantity",
    NULL::timestamp with time zone AS "last_movement_at",
    NULL::timestamp with time zone AS "created_at",
    NULL::timestamp with time zone AS "updated_at";


ALTER VIEW "public"."product_inventory_overview" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."product_sale_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_sale_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "product_name" "text" NOT NULL,
    "sku" "text",
    "barcode" "text",
    "quantity" numeric(12,3) NOT NULL,
    "unit_cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "unit_price" numeric(12,2) NOT NULL,
    "line_total" numeric(12,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_sale_items_line_total_check" CHECK (("line_total" >= (0)::numeric)),
    CONSTRAINT "product_sale_items_quantity_check" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "product_sale_items_unit_cost_check" CHECK (("unit_cost" >= (0)::numeric)),
    CONSTRAINT "product_sale_items_unit_price_check" CHECK (("unit_price" >= (0)::numeric))
);


ALTER TABLE "public"."product_sale_items" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."product_sales" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cash_session_id" "uuid" NOT NULL,
    "sale_number" "text" NOT NULL,
    "payment_method" "text" NOT NULL,
    "subtotal_amount" numeric(12,2) NOT NULL,
    "total_amount" numeric(12,2) NOT NULL,
    "status" "text" DEFAULT 'posted'::"text" NOT NULL,
    "sold_by_user_id" "uuid" NOT NULL,
    "note" "text",
    "voided_at" timestamp with time zone,
    "voided_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_sales_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['cash'::"text", 'card'::"text", 'transfer'::"text"]))),
    CONSTRAINT "product_sales_status_check" CHECK (("status" = ANY (ARRAY['posted'::"text", 'voided'::"text"]))),
    CONSTRAINT "product_sales_subtotal_amount_check" CHECK (("subtotal_amount" >= (0)::numeric)),
    CONSTRAINT "product_sales_total_amount_check" CHECK (("total_amount" >= (0)::numeric))
);


ALTER TABLE "public"."product_sales" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "sku" "text",
    "barcode" "text",
    "image_url" "text",
    "cost_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "sale_price" numeric(12,2) NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by_user_id" "uuid",
    "updated_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "products_cost_price_check" CHECK (("cost_price" >= (0)::numeric)),
    CONSTRAINT "products_name_not_blank" CHECK (("char_length"(TRIM(BOTH FROM "name")) >= 2)),
    CONSTRAINT "products_sale_price_check" CHECK (("sale_price" >= (0)::numeric))
);


ALTER TABLE "public"."products" OWNER TO "algym_migrator";


CREATE SEQUENCE IF NOT EXISTS "public"."profiles_biometric_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."profiles_biometric_id_seq" OWNER TO "algym_migrator";


ALTER SEQUENCE "public"."profiles_biometric_id_seq" OWNED BY "public"."profiles"."biometric_id";



CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "role_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_permissions" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "is_system" boolean DEFAULT false NOT NULL,
    "is_protected" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "roles_scope_check" CHECK (("scope" = ANY (ARRAY['panel'::"text", 'client'::"text"])))
);


ALTER TABLE "public"."roles" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."routine_blueprint_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "blueprint_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "assigned_routine_id" "uuid" NOT NULL,
    "assigned_by" "uuid" NOT NULL,
    "assigned_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."routine_blueprint_assignments" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."routine_blueprint_details" (
    "id" bigint NOT NULL,
    "blueprint_id" "uuid" NOT NULL,
    "day_of_week" integer NOT NULL,
    "exercise_id" bigint,
    "exercise_order" integer,
    "block_type" "text" DEFAULT 'strength'::"text" NOT NULL,
    "sets" integer,
    "reps" "text",
    "rest_seconds" integer,
    "duration_minutes" integer,
    "target_rir" numeric(3,1),
    "notes" "text",
    "exercise_name_snapshot" "text",
    CONSTRAINT "routine_blueprint_details_block_type_check" CHECK (("block_type" = ANY (ARRAY['warmup'::"text", 'strength'::"text", 'accessory'::"text", 'cardio'::"text", 'mobility'::"text"])))
);


ALTER TABLE "public"."routine_blueprint_details" OWNER TO "algym_migrator";


ALTER TABLE "public"."routine_blueprint_details" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."routine_blueprint_details_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."routine_blueprints" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "primary_goal" "text",
    "secondary_goal" "text",
    "source_routine_id" "uuid",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."routine_blueprints" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."routine_details" (
    "id" bigint NOT NULL,
    "routine_id" "uuid",
    "day_of_week" integer NOT NULL,
    "exercise_id" bigint,
    "sets" integer,
    "reps" "text",
    "weight_target" "text",
    "rest_seconds" integer,
    "notes" "text",
    "exercise_order" integer,
    "block_type" "text" DEFAULT 'strength'::"text" NOT NULL,
    "duration_minutes" integer,
    "target_rir" numeric(3,1),
    "exercise_name_snapshot" "text",
    CONSTRAINT "routine_details_block_type_check" CHECK (("block_type" = ANY (ARRAY['warmup'::"text", 'strength'::"text", 'accessory'::"text", 'cardio'::"text", 'mobility'::"text"])))
);


ALTER TABLE "public"."routine_details" OWNER TO "algym_migrator";


ALTER TABLE "public"."routine_details" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."routine_details_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."routine_templates" (
    "id" bigint NOT NULL,
    "body_type" "text" NOT NULL,
    "day_index" integer NOT NULL,
    "muscle_group" "text" NOT NULL,
    "exercise_order" integer NOT NULL,
    "exercise_name" "text" NOT NULL,
    "sets" integer NOT NULL,
    "reps_range" "text" NOT NULL,
    "rest_seconds" integer NOT NULL,
    "cardio_minutes" "text" NOT NULL,
    "routine_mode" "text" DEFAULT 'volumen'::"text" NOT NULL,
    CONSTRAINT "routine_templates_body_type_check" CHECK (("body_type" = ANY (ARRAY['ectomorph'::"text", 'mesomorph'::"text", 'endomorph'::"text"]))),
    CONSTRAINT "routine_templates_day_index_check" CHECK ((("day_index" >= 1) AND ("day_index" <= 5))),
    CONSTRAINT "routine_templates_exercise_order_check" CHECK ((("exercise_order" >= 1) AND ("exercise_order" <= 6))),
    CONSTRAINT "routine_templates_routine_mode_check" CHECK (("routine_mode" = ANY (ARRAY['definicion'::"text", 'volumen'::"text"])))
);


ALTER TABLE "public"."routine_templates" OWNER TO "algym_migrator";


CREATE SEQUENCE IF NOT EXISTS "public"."routine_templates_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."routine_templates_id_seq" OWNER TO "algym_migrator";


ALTER SEQUENCE "public"."routine_templates_id_seq" OWNED BY "public"."routine_templates"."id";



CREATE TABLE IF NOT EXISTS "public"."routines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "created_by" "uuid",
    "name" "text" NOT NULL,
    "start_date" "date" DEFAULT CURRENT_DATE,
    "end_date" "date",
    "is_active" boolean DEFAULT true,
    "goal" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "source" "text" DEFAULT 'system'::"text" NOT NULL,
    "training_profile_id" "uuid",
    "primary_goal" "text",
    "secondary_goal" "text",
    "generation_version" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    CONSTRAINT "routines_source_check" CHECK (("source" = ANY (ARRAY['system'::"text", 'admin'::"text"]))),
    CONSTRAINT "routines_status_check" CHECK (("status" = ANY (ARRAY['pending_profile'::"text", 'draft'::"text", 'active'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."routines" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."training_nutrition_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "source_event" "text" NOT NULL,
    "subscription_id" "uuid",
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "gender" "text" NOT NULL,
    "age_years" integer NOT NULL,
    "height_cm" numeric NOT NULL,
    "weight_kg" numeric NOT NULL,
    "body_type" "text" NOT NULL,
    "diet_type" "text" NOT NULL,
    "activity_level" "text" NOT NULL,
    "body_fat_percentage" numeric,
    "muscle_mass_kg" numeric,
    "chest_cm" numeric,
    "waist_cm" numeric,
    "arm_right_cm" numeric,
    "arm_left_cm" numeric,
    "hip_cm" numeric,
    "leg_right_cm" numeric,
    "leg_left_cm" numeric,
    "daily_calories" integer NOT NULL,
    "protein_grams" integer NOT NULL,
    "carbs_grams" integer NOT NULL,
    "fat_grams" integer NOT NULL,
    "water_liters_goal" numeric NOT NULL,
    "cardio_minutes" "text" NOT NULL,
    "routine_mode" "text" NOT NULL,
    "algorithm_version" "text" NOT NULL,
    CONSTRAINT "training_nutrition_snapshots_age_years_check" CHECK ((("age_years" >= 0) AND ("age_years" <= 120))),
    CONSTRAINT "training_nutrition_snapshots_body_type_check" CHECK (("body_type" = ANY (ARRAY['ectomorph'::"text", 'mesomorph'::"text", 'endomorph'::"text"]))),
    CONSTRAINT "training_nutrition_snapshots_diet_type_check" CHECK (("diet_type" = ANY (ARRAY['hipocalorica'::"text", 'normocalorica'::"text", 'hipercalorica'::"text"]))),
    CONSTRAINT "training_nutrition_snapshots_gender_check" CHECK (("gender" = ANY (ARRAY['male'::"text", 'female'::"text", 'other'::"text"]))),
    CONSTRAINT "training_nutrition_snapshots_height_cm_check" CHECK (("height_cm" > (0)::numeric)),
    CONSTRAINT "training_nutrition_snapshots_routine_mode_check" CHECK (("routine_mode" = ANY (ARRAY['definicion'::"text", 'volumen'::"text"]))),
    CONSTRAINT "training_nutrition_snapshots_source_event_check" CHECK (("source_event" = ANY (ARRAY['signup'::"text", 'renewal'::"text"]))),
    CONSTRAINT "training_nutrition_snapshots_weight_kg_check" CHECK (("weight_kg" > (0)::numeric))
);


ALTER TABLE "public"."training_nutrition_snapshots" OWNER TO "algym_migrator";


CREATE TABLE IF NOT EXISTS "public"."training_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "primary_goal" "text",
    "secondary_goal" "text",
    "focus_areas" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "experience_level" "text",
    "days_per_week" integer,
    "session_minutes" integer,
    "training_location" "text" DEFAULT 'gym'::"text",
    "equipment_available" "text"[] DEFAULT ARRAY['full_gym'::"text", 'body_weight'::"text", 'dumbbell'::"text", 'barbell'::"text", 'machine'::"text", 'treadmill'::"text", 'bike'::"text", 'rower'::"text"] NOT NULL,
    "activity_level" "text",
    "cardio_preference" "text",
    "exercise_preferences" "text",
    "exercise_dislikes" "text",
    "injuries_or_pain" "text",
    "restricted_movements" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "parq_requires_attention" boolean,
    "medical_clearance_notes" "text",
    "is_complete" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "training_profiles_activity_level_check" CHECK ((("activity_level" IS NULL) OR ("activity_level" = ANY (ARRAY['sedentario'::"text", '1_3_dias'::"text", '3_5_dias'::"text", '6_7_dias'::"text", '2_veces_dia'::"text"])))),
    CONSTRAINT "training_profiles_cardio_preference_check" CHECK ((("cardio_preference" IS NULL) OR ("cardio_preference" = ANY (ARRAY['none'::"text", 'light'::"text", 'moderate'::"text", 'high'::"text"])))),
    CONSTRAINT "training_profiles_days_per_week_check" CHECK ((("days_per_week" IS NULL) OR (("days_per_week" >= 1) AND ("days_per_week" <= 7)))),
    CONSTRAINT "training_profiles_experience_level_check" CHECK ((("experience_level" IS NULL) OR ("experience_level" = ANY (ARRAY['beginner'::"text", 'intermediate'::"text", 'advanced'::"text"])))),
    CONSTRAINT "training_profiles_primary_goal_check" CHECK ((("primary_goal" IS NULL) OR ("primary_goal" = ANY (ARRAY['fat_loss'::"text", 'muscle_gain'::"text", 'recomp'::"text", 'strength'::"text", 'general_fitness'::"text", 'cardio'::"text"])))),
    CONSTRAINT "training_profiles_secondary_goal_check" CHECK ((("secondary_goal" IS NULL) OR ("secondary_goal" = ANY (ARRAY['fat_loss'::"text", 'muscle_gain'::"text", 'recomp'::"text", 'strength'::"text", 'general_fitness'::"text", 'cardio'::"text"])))),
    CONSTRAINT "training_profiles_session_minutes_check" CHECK ((("session_minutes" IS NULL) OR (("session_minutes" >= 1) AND ("session_minutes" <= 480)))),
    CONSTRAINT "training_profiles_training_location_check" CHECK ((("training_location" IS NULL) OR ("training_location" = ANY (ARRAY['gym'::"text", 'home'::"text", 'mixed'::"text"]))))
);


ALTER TABLE "public"."training_profiles" OWNER TO "algym_migrator";


ALTER TABLE ONLY "public"."attendance_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."attendance_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."profiles" ALTER COLUMN "biometric_id" SET DEFAULT "nextval"('"public"."profiles_biometric_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."routine_templates" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."routine_templates_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."access_logs"
    ADD CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attendance_logs"
    ADD CONSTRAINT "attendance_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."body_assessments"
    ADD CONSTRAINT "body_assessments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_registers"
    ADD CONSTRAINT "cash_registers_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."cash_registers"
    ADD CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_sessions"
    ADD CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_sessions"
    ADD CONSTRAINT "cash_sessions_session_number_key" UNIQUE ("session_number");



ALTER TABLE ONLY "public"."device_commands"
    ADD CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."exercises"
    ADD CONSTRAINT "exercises_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_templates"
    ADD CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_sale_items"
    ADD CONSTRAINT "product_sale_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_sales"
    ADD CONSTRAINT "product_sales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_sales"
    ADD CONSTRAINT "product_sales_sale_number_key" UNIQUE ("sale_number");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_device_id_key" UNIQUE ("device_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."routine_blueprint_assignments"
    ADD CONSTRAINT "routine_blueprint_assignments_assigned_routine_id_key" UNIQUE ("assigned_routine_id");



ALTER TABLE ONLY "public"."routine_blueprint_assignments"
    ADD CONSTRAINT "routine_blueprint_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."routine_blueprint_details"
    ADD CONSTRAINT "routine_blueprint_details_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."routine_blueprints"
    ADD CONSTRAINT "routine_blueprints_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."routine_details"
    ADD CONSTRAINT "routine_details_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."routine_templates"
    ADD CONSTRAINT "routine_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."routines"
    ADD CONSTRAINT "routines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_nutrition_snapshots"
    ADD CONSTRAINT "training_nutrition_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_profiles"
    ADD CONSTRAINT "training_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_profiles"
    ADD CONSTRAINT "training_profiles_user_id_key" UNIQUE ("user_id");



CREATE INDEX "body_assessments_user_id_idx" ON "public"."body_assessments" USING "btree" ("user_id");



CREATE INDEX "cash_movements_created_by_user_id_idx" ON "public"."cash_movements" USING "btree" ("created_by_user_id", "created_at" DESC);



CREATE INDEX "cash_movements_out_of_session_idx" ON "public"."cash_movements" USING "btree" ("session_link_status", "created_at" DESC);



CREATE INDEX "cash_movements_session_created_at_idx" ON "public"."cash_movements" USING "btree" ("cash_session_id", "created_at" DESC);



CREATE UNIQUE INDEX "cash_movements_source_payment_unique" ON "public"."cash_movements" USING "btree" ("source_payment_id") WHERE ("source_payment_id" IS NOT NULL);



CREATE INDEX "cash_movements_source_product_sale_idx" ON "public"."cash_movements" USING "btree" ("source_product_sale_id") WHERE ("source_product_sale_id" IS NOT NULL);



CREATE UNIQUE INDEX "cash_sessions_opened_by_open_unique" ON "public"."cash_sessions" USING "btree" ("opened_by_user_id") WHERE ("status" = 'open'::"text");



CREATE INDEX "cash_sessions_register_status_opened_at_idx" ON "public"."cash_sessions" USING "btree" ("cash_register_id", "status", "opened_at" DESC);



CREATE INDEX "cash_sessions_status_opened_at_idx" ON "public"."cash_sessions" USING "btree" ("status", "opened_at" DESC);



CREATE INDEX "exercises_active_favorite_idx" ON "public"."exercises" USING "btree" ("is_favorite") WHERE ("is_active" = true);



CREATE INDEX "exercises_active_idx" ON "public"."exercises" USING "btree" ("is_active");



CREATE INDEX "exercises_active_preview_hidden_idx" ON "public"."exercises" USING "btree" ("is_preview_hidden") WHERE ("is_active" = true);



CREATE INDEX "exercises_body_parts_gin_idx" ON "public"."exercises" USING "gin" ("body_parts");



CREATE INDEX "exercises_display_name_es_trgm_idx" ON "public"."exercises" USING "gin" ("lower"(COALESCE("display_name_es", ''::"text")) "public"."gin_trgm_ops");



CREATE INDEX "exercises_display_name_trgm_idx" ON "public"."exercises" USING "gin" ("lower"(COALESCE("display_name", "name")) "public"."gin_trgm_ops");



CREATE INDEX "exercises_equipments_gin_idx" ON "public"."exercises" USING "gin" ("equipments");



CREATE INDEX "exercises_provider_item_idx" ON "public"."exercises" USING "btree" ("provider", "provider_item_id");



CREATE UNIQUE INDEX "exercises_slug_uidx" ON "public"."exercises" USING "btree" ("slug");



CREATE INDEX "exercises_target_muscles_gin_idx" ON "public"."exercises" USING "gin" ("target_muscles");



CREATE INDEX "idx_access_logs_check_in_time" ON "public"."access_logs" USING "btree" ("check_in_time" DESC);



CREATE INDEX "idx_access_logs_user_id" ON "public"."access_logs" USING "btree" ("user_id");



CREATE INDEX "idx_attendance_logs_biometric_id" ON "public"."attendance_logs" USING "btree" ("biometric_id");



CREATE INDEX "idx_attendance_logs_device_id" ON "public"."attendance_logs" USING "btree" ("device_id");



CREATE INDEX "idx_attendance_logs_punch_time" ON "public"."attendance_logs" USING "btree" ("punch_time" DESC);



CREATE INDEX "idx_payments_subscription_id" ON "public"."payments" USING "btree" ("subscription_id");



CREATE INDEX "idx_payments_user_id" ON "public"."payments" USING "btree" ("user_id");



CREATE INDEX "idx_profiles_is_active" ON "public"."profiles" USING "btree" ("is_active");



CREATE INDEX "idx_routine_templates_body_type_day" ON "public"."routine_templates" USING "btree" ("body_type", "day_index", "exercise_order");



CREATE INDEX "idx_training_snapshots_captured_at" ON "public"."training_nutrition_snapshots" USING "btree" ("captured_at" DESC);



CREATE INDEX "idx_training_snapshots_subscription_id" ON "public"."training_nutrition_snapshots" USING "btree" ("subscription_id");



CREATE INDEX "idx_training_snapshots_user_id" ON "public"."training_nutrition_snapshots" USING "btree" ("user_id");



CREATE INDEX "inventory_movements_created_by_user_idx" ON "public"."inventory_movements" USING "btree" ("created_by_user_id");



CREATE INDEX "inventory_movements_product_created_at_idx" ON "public"."inventory_movements" USING "btree" ("product_id", "created_at" DESC);



CREATE INDEX "inventory_movements_sale_idx" ON "public"."inventory_movements" USING "btree" ("source_product_sale_id") WHERE ("source_product_sale_id" IS NOT NULL);



CREATE INDEX "inventory_movements_sale_item_idx" ON "public"."inventory_movements" USING "btree" ("source_product_sale_item_id") WHERE ("source_product_sale_item_id" IS NOT NULL);



CREATE INDEX "inventory_movements_type_created_at_idx" ON "public"."inventory_movements" USING "btree" ("movement_type", "created_at" DESC);



CREATE INDEX "payments_created_by_user_id_idx" ON "public"."payments" USING "btree" ("created_by_user_id");



CREATE INDEX "payments_replacement_payment_id_idx" ON "public"."payments" USING "btree" ("replacement_payment_id");



CREATE INDEX "payments_status_idx" ON "public"."payments" USING "btree" ("status");



CREATE INDEX "permissions_module_idx" ON "public"."permissions" USING "btree" ("module");



CREATE INDEX "product_sale_items_product_created_at_idx" ON "public"."product_sale_items" USING "btree" ("product_id", "created_at" DESC);



CREATE INDEX "product_sale_items_sale_idx" ON "public"."product_sale_items" USING "btree" ("product_sale_id");



CREATE INDEX "product_sales_cash_session_created_at_idx" ON "public"."product_sales" USING "btree" ("cash_session_id", "created_at" DESC);



CREATE INDEX "product_sales_sold_by_created_at_idx" ON "public"."product_sales" USING "btree" ("sold_by_user_id", "created_at" DESC);



CREATE INDEX "product_sales_voided_by_user_idx" ON "public"."product_sales" USING "btree" ("voided_by_user_id") WHERE ("voided_by_user_id" IS NOT NULL);



CREATE INDEX "products_active_name_idx" ON "public"."products" USING "btree" ("is_active", "name");



CREATE UNIQUE INDEX "products_barcode_unique" ON "public"."products" USING "btree" ("lower"("barcode")) WHERE (("barcode" IS NOT NULL) AND (TRIM(BOTH FROM "barcode") <> ''::"text"));



CREATE INDEX "products_created_by_user_idx" ON "public"."products" USING "btree" ("created_by_user_id") WHERE ("created_by_user_id" IS NOT NULL);



CREATE INDEX "products_name_trgm_idx" ON "public"."products" USING "gin" ("name" "public"."gin_trgm_ops");



CREATE UNIQUE INDEX "products_sku_unique" ON "public"."products" USING "btree" ("lower"("sku")) WHERE (("sku" IS NOT NULL) AND (TRIM(BOTH FROM "sku") <> ''::"text"));



CREATE INDEX "products_updated_by_user_idx" ON "public"."products" USING "btree" ("updated_by_user_id") WHERE ("updated_by_user_id" IS NOT NULL);



CREATE INDEX "role_permissions_permission_id_idx" ON "public"."role_permissions" USING "btree" ("permission_id");



CREATE INDEX "role_permissions_role_id_idx" ON "public"."role_permissions" USING "btree" ("role_id");



CREATE INDEX "roles_scope_idx" ON "public"."roles" USING "btree" ("scope");



CREATE INDEX "routine_blueprint_assignments_blueprint_idx" ON "public"."routine_blueprint_assignments" USING "btree" ("blueprint_id");



CREATE INDEX "routine_blueprint_assignments_user_idx" ON "public"."routine_blueprint_assignments" USING "btree" ("user_id");



CREATE INDEX "routine_blueprint_details_blueprint_idx" ON "public"."routine_blueprint_details" USING "btree" ("blueprint_id");



CREATE INDEX "routine_blueprint_details_day_idx" ON "public"."routine_blueprint_details" USING "btree" ("blueprint_id", "day_of_week");



CREATE INDEX "routine_blueprints_created_by_idx" ON "public"."routine_blueprints" USING "btree" ("created_by");



CREATE INDEX "routine_details_exercise_id_idx" ON "public"."routine_details" USING "btree" ("exercise_id");



CREATE INDEX "routine_details_routine_id_idx" ON "public"."routine_details" USING "btree" ("routine_id");



CREATE INDEX "routines_created_by_idx" ON "public"."routines" USING "btree" ("created_by");



CREATE INDEX "routines_reviewed_by_idx" ON "public"."routines" USING "btree" ("reviewed_by");



CREATE INDEX "routines_training_profile_idx" ON "public"."routines" USING "btree" ("training_profile_id");



CREATE INDEX "routines_user_status_idx" ON "public"."routines" USING "btree" ("user_id", "status");



CREATE INDEX "subscriptions_plan_id_idx" ON "public"."subscriptions" USING "btree" ("plan_id");



CREATE INDEX "subscriptions_user_id_idx" ON "public"."subscriptions" USING "btree" ("user_id");



CREATE INDEX "training_profiles_is_complete_idx" ON "public"."training_profiles" USING "btree" ("is_complete");



CREATE INDEX "training_profiles_user_id_idx" ON "public"."training_profiles" USING "btree" ("user_id");



CREATE UNIQUE INDEX "uq_attendance_logs_dedupe" ON "public"."attendance_logs" USING "btree" ("device_id", "biometric_id", "punch_time", "status1", "status2");



CREATE OR REPLACE VIEW "public"."product_inventory_overview" WITH ("security_invoker"='true') AS
 SELECT "p"."id",
    "p"."name",
    "p"."sku",
    "p"."barcode",
    "p"."image_url",
    "p"."cost_price",
    "p"."sale_price",
    "p"."is_active",
    (COALESCE("sum"("im"."quantity_delta"), (0)::numeric))::numeric(12,3) AS "stock_quantity",
    "max"("im"."created_at") AS "last_movement_at",
    "p"."created_at",
    "p"."updated_at"
   FROM ("public"."products" "p"
     LEFT JOIN "public"."inventory_movements" "im" ON (("im"."product_id" = "p"."id")))
  GROUP BY "p"."id";



CREATE OR REPLACE TRIGGER "on_profile_created" AFTER INSERT ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."sync_user_to_zkteco"();



CREATE OR REPLACE TRIGGER "on_profile_created_sync_zk" AFTER INSERT ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."sync_user_to_zkteco"();



CREATE OR REPLACE TRIGGER "prevent_locked_payment_mutation" BEFORE DELETE OR UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_locked_payment_mutation"();



CREATE OR REPLACE TRIGGER "products_touch_updated_at" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."touch_products_updated_at"();



CREATE OR REPLACE TRIGGER "roles_set_updated_at_trigger" BEFORE UPDATE ON "public"."roles" FOR EACH ROW EXECUTE FUNCTION "public"."roles_set_updated_at"();



CREATE OR REPLACE TRIGGER "set_training_profiles_updated_at" BEFORE UPDATE ON "public"."training_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_row_updated_at"();



ALTER TABLE ONLY "public"."access_logs"
    ADD CONSTRAINT "access_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."body_assessments"
    ADD CONSTRAINT "body_assessments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_cash_session_id_fkey" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_source_payment_id_fkey" FOREIGN KEY ("source_payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_source_product_sale_id_fkey" FOREIGN KEY ("source_product_sale_id") REFERENCES "public"."product_sales"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_source_subscription_id_fkey" FOREIGN KEY ("source_subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_movements"
    ADD CONSTRAINT "cash_movements_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_sessions"
    ADD CONSTRAINT "cash_sessions_cash_register_id_fkey" FOREIGN KEY ("cash_register_id") REFERENCES "public"."cash_registers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cash_sessions"
    ADD CONSTRAINT "cash_sessions_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_sessions"
    ADD CONSTRAINT "cash_sessions_opened_by_user_id_fkey" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_source_product_sale_id_fkey" FOREIGN KEY ("source_product_sale_id") REFERENCES "public"."product_sales"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_source_product_sale_item_id_fkey" FOREIGN KEY ("source_product_sale_item_id") REFERENCES "public"."product_sale_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_templates"
    ADD CONSTRAINT "message_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_replacement_payment_id_fkey" FOREIGN KEY ("replacement_payment_id") REFERENCES "public"."payments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_reversed_by_user_id_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."product_sale_items"
    ADD CONSTRAINT "product_sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."product_sale_items"
    ADD CONSTRAINT "product_sale_items_product_sale_id_fkey" FOREIGN KEY ("product_sale_id") REFERENCES "public"."product_sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_sales"
    ADD CONSTRAINT "product_sales_cash_session_id_fkey" FOREIGN KEY ("cash_session_id") REFERENCES "public"."cash_sessions"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."product_sales"
    ADD CONSTRAINT "product_sales_sold_by_user_id_fkey" FOREIGN KEY ("sold_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."product_sales"
    ADD CONSTRAINT "product_sales_voided_by_user_id_fkey" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routine_blueprint_assignments"
    ADD CONSTRAINT "routine_blueprint_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routine_blueprint_assignments"
    ADD CONSTRAINT "routine_blueprint_assignments_assigned_routine_id_fkey" FOREIGN KEY ("assigned_routine_id") REFERENCES "public"."routines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routine_blueprint_assignments"
    ADD CONSTRAINT "routine_blueprint_assignments_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "public"."routine_blueprints"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routine_blueprint_assignments"
    ADD CONSTRAINT "routine_blueprint_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routine_blueprint_details"
    ADD CONSTRAINT "routine_blueprint_details_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "public"."routine_blueprints"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routine_blueprint_details"
    ADD CONSTRAINT "routine_blueprint_details_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."routine_blueprints"
    ADD CONSTRAINT "routine_blueprints_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routine_blueprints"
    ADD CONSTRAINT "routine_blueprints_source_routine_id_fkey" FOREIGN KEY ("source_routine_id") REFERENCES "public"."routines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."routine_details"
    ADD CONSTRAINT "routine_details_exercise_id_fkey" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id");



ALTER TABLE ONLY "public"."routine_details"
    ADD CONSTRAINT "routine_details_routine_id_fkey" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routines"
    ADD CONSTRAINT "routines_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."routines"
    ADD CONSTRAINT "routines_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."routines"
    ADD CONSTRAINT "routines_training_profile_id_fkey" FOREIGN KEY ("training_profile_id") REFERENCES "public"."training_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."routines"
    ADD CONSTRAINT "routines_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."training_nutrition_snapshots"
    ADD CONSTRAINT "training_nutrition_snapshots_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."training_nutrition_snapshots"
    ADD CONSTRAINT "training_nutrition_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."training_profiles"
    ADD CONSTRAINT "training_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



CREATE POLICY "Admins and trainers can create access logs" ON "public"."access_logs" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))))));



CREATE POLICY "Admins and trainers can create body assessments" ON "public"."body_assessments" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))))));



CREATE POLICY "Admins and trainers can create routines" ON "public"."routines" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))))));



CREATE POLICY "Admins and trainers can manage exercises" ON "public"."exercises" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))))));



CREATE POLICY "Admins and trainers can manage routine details" ON "public"."routine_details" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))))));



CREATE POLICY "Admins and trainers can modify body assessments" ON "public"."body_assessments" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))))));



CREATE POLICY "Admins can update any profile" ON "public"."profiles" FOR UPDATE USING (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'owner'::"public"."user_role"]))) WITH CHECK (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'owner'::"public"."user_role"])));



CREATE POLICY "Admins can view all plans" ON "public"."plans" FOR SELECT USING (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'owner'::"public"."user_role"])));



CREATE POLICY "Admins can view all profiles" ON "public"."profiles" FOR SELECT USING (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'owner'::"public"."user_role"])));



CREATE POLICY "Allow anon to insert own profile during signup" ON "public"."profiles" FOR INSERT TO "anon" WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Authenticated users can view active plans" ON "public"."plans" FOR SELECT TO "authenticated" USING (("is_active" = true));



CREATE POLICY "Authenticated users can view exercises" ON "public"."exercises" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Creators and admins can modify routines" ON "public"."routines" FOR UPDATE USING ((("created_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role"))))));



CREATE POLICY "Only admins can delete body assessments" ON "public"."body_assessments" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));



CREATE POLICY "Only admins can delete routines" ON "public"."routines" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));



CREATE POLICY "Only admins can manage device commands" ON "public"."device_commands" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));



CREATE POLICY "Only admins can manage payments" ON "public"."payments" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));



CREATE POLICY "Only admins can manage plans" ON "public"."plans" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'owner'::"public"."user_role"]))))));



CREATE POLICY "Only admins can manage subscriptions" ON "public"."subscriptions" USING (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'owner'::"public"."user_role"]))) WITH CHECK (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'owner'::"public"."user_role"])));



CREATE POLICY "Only admins can modify access logs" ON "public"."access_logs" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));



CREATE POLICY "Only admins can view device commands" ON "public"."device_commands" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"public"."user_role")))));



CREATE POLICY "Routine templates visible to authenticated" ON "public"."routine_templates" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Routine templates writable by admin trainer" ON "public"."routine_templates" TO "authenticated" USING (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))) WITH CHECK (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"])));



CREATE POLICY "Snapshots modifiable by admin trainer" ON "public"."training_nutrition_snapshots" TO "authenticated" USING (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))) WITH CHECK (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"])));



CREATE POLICY "Snapshots visible to self and staff" ON "public"."training_nutrition_snapshots" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR ("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role", 'employee'::"public"."user_role"]))));



CREATE POLICY "Staff can view attendance logs" ON "public"."attendance_logs" FOR SELECT TO "authenticated" USING (("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role", 'employee'::"public"."user_role"])));



CREATE POLICY "Staff can view client profiles" ON "public"."profiles" FOR SELECT USING ((("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role", 'employee'::"public"."user_role", 'owner'::"public"."user_role"])) AND ("role" = 'client'::"public"."user_role")));



CREATE POLICY "Users can delete own profile" ON "public"."profiles" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can insert own client profile" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK ((("id" = "auth"."uid"()) AND (COALESCE("role", 'client'::"public"."user_role") = 'client'::"public"."user_role")));



CREATE POLICY "Users can update own profile without role escalation" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK ((("id" = "auth"."uid"()) AND ("role" = "public"."get_my_role"())));



CREATE POLICY "Users can view own access logs" ON "public"."access_logs" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role", 'employee'::"public"."user_role"])))))));



CREATE POLICY "Users can view own body assessments" ON "public"."body_assessments" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role", 'employee'::"public"."user_role"])))))));



CREATE POLICY "Users can view own payments and admins can view all" ON "public"."payments" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR ("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'owner'::"public"."user_role"]))));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "Users can view own routine details" ON "public"."routine_details" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."routines"
  WHERE (("routines"."id" = "routine_details"."routine_id") AND (("routines"."user_id" = "auth"."uid"()) OR ("routines"."created_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."profiles"
          WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"]))))))))));



CREATE POLICY "Users can view own routines" ON "public"."routines" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR ("created_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role"])))))));



CREATE POLICY "Users can view own subscriptions" ON "public"."subscriptions" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR ("public"."get_my_role"() = ANY (ARRAY['admin'::"public"."user_role", 'trainer'::"public"."user_role", 'employee'::"public"."user_role", 'owner'::"public"."user_role"]))));



ALTER TABLE "public"."access_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attendance_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."body_assessments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cash_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cash_registers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cash_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_commands" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."exercises" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_movements_delete_internal" ON "public"."inventory_movements" FOR DELETE TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "inventory_movements_insert_internal" ON "public"."inventory_movements" FOR INSERT TO "authenticated" WITH CHECK (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "inventory_movements_select_internal" ON "public"."inventory_movements" FOR SELECT TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "inventory_movements_update_internal" ON "public"."inventory_movements" FOR UPDATE TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"]))) WITH CHECK (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



ALTER TABLE "public"."message_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "message_templates_admin_all" ON "public"."message_templates" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role" = 'owner'::"public"."user_role") OR ("p"."role" = 'admin'::"public"."user_role")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role" = 'owner'::"public"."user_role") OR ("p"."role" = 'admin'::"public"."user_role"))))));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "permissions_view_panel" ON "public"."permissions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."roles" "r" ON (("r"."slug" = ("p"."role")::"text")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("r"."scope" = 'panel'::"text")))));



ALTER TABLE "public"."plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_sale_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_sale_items_delete_internal" ON "public"."product_sale_items" FOR DELETE TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "product_sale_items_insert_internal" ON "public"."product_sale_items" FOR INSERT TO "authenticated" WITH CHECK (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "product_sale_items_select_internal" ON "public"."product_sale_items" FOR SELECT TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "product_sale_items_update_internal" ON "public"."product_sale_items" FOR UPDATE TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"]))) WITH CHECK (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



ALTER TABLE "public"."product_sales" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_sales_delete_internal" ON "public"."product_sales" FOR DELETE TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "product_sales_insert_internal" ON "public"."product_sales" FOR INSERT TO "authenticated" WITH CHECK (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "product_sales_select_internal" ON "public"."product_sales" FOR SELECT TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "product_sales_update_internal" ON "public"."product_sales" FOR UPDATE TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"]))) WITH CHECK (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "products_delete_admin" ON "public"."products" FOR DELETE TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text"])));



CREATE POLICY "products_insert_admin" ON "public"."products" FOR INSERT TO "authenticated" WITH CHECK (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text"])));



CREATE POLICY "products_select_internal" ON "public"."products" FOR SELECT TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text", 'employee'::"text"])));



CREATE POLICY "products_update_admin" ON "public"."products" FOR UPDATE TO "authenticated" USING (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text"]))) WITH CHECK (("public"."get_profile_role"("auth"."uid"()) = ANY (ARRAY['owner'::"text", 'admin'::"text"])));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_permissions_delete_admin" ON "public"."role_permissions" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp2"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp2"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp2"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'roles.update'::"text")))))))));



CREATE POLICY "role_permissions_insert_admin" ON "public"."role_permissions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp2"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp2"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp2"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'roles.update'::"text")))))))));



CREATE POLICY "role_permissions_view_panel" ON "public"."role_permissions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."roles" "r" ON (("r"."slug" = ("p"."role")::"text")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("r"."scope" = 'panel'::"text")))));



ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "roles_delete_admin" ON "public"."roles" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'roles.delete'::"text")))))))));



CREATE POLICY "roles_insert_admin" ON "public"."roles" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'roles.create'::"text")))))))));



CREATE POLICY "roles_update_admin" ON "public"."roles" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'roles.update'::"text"))))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'roles.update'::"text")))))))));



CREATE POLICY "roles_view_all" ON "public"."roles" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."roles" "r" ON (("r"."slug" = ("p"."role")::"text")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("r"."scope" = 'panel'::"text")))));



ALTER TABLE "public"."routine_blueprint_assignments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "routine_blueprint_assignments_admin_trainer_all" ON "public"."routine_blueprint_assignments" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'routines.view'::"text"))))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'routines.view'::"text")))))))));



ALTER TABLE "public"."routine_blueprint_details" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "routine_blueprint_details_admin_trainer_all" ON "public"."routine_blueprint_details" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'routines.view'::"text"))))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'routines.view'::"text")))))))));



ALTER TABLE "public"."routine_blueprints" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "routine_blueprints_admin_trainer_all" ON "public"."routine_blueprints" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'routines.view'::"text"))))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'routines.view'::"text")))))))));



ALTER TABLE "public"."routine_details" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."routine_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."routines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."training_nutrition_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."training_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "training_profiles_admin_all" ON "public"."training_profiles" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'customers.manage_routine'::"text"))))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ((("p"."role")::"text" = 'owner'::"text") OR (EXISTS ( SELECT 1
           FROM (("public"."role_permissions" "rp"
             JOIN "public"."permissions" "perm" ON (("perm"."id" = "rp"."permission_id")))
             JOIN "public"."roles" "r" ON (("r"."id" = "rp"."role_id")))
          WHERE (("r"."slug" = ("p"."role")::"text") AND ("perm"."key" = 'customers.manage_routine'::"text")))))))));



CREATE POLICY "training_profiles_owner_select" ON "public"."training_profiles" FOR SELECT USING (("auth"."uid"() = "user_id"));



GRANT USAGE ON SCHEMA "public" TO "algym_migrator";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT ALL ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



REVOKE ALL ON FUNCTION "public"."adjust_product_stock"("p_product_id" "uuid", "p_counted_quantity" numeric, "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."adjust_product_stock"("p_product_id" "uuid", "p_counted_quantity" numeric, "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."adjust_product_stock"("p_product_id" "uuid", "p_counted_quantity" numeric, "p_note" "text") TO "service_role";



GRANT ALL ON TABLE "public"."cash_movements" TO "anon";
GRANT ALL ON TABLE "public"."cash_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."cash_movements" TO "service_role";



GRANT ALL ON FUNCTION "public"."attach_payment_to_cash"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_source_category" "text", "p_note" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."attach_payment_to_cash"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_source_category" "text", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."attach_payment_to_cash"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_source_category" "text", "p_note" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."build_cash_session_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."build_cash_session_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."build_cash_session_number"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."build_product_sale_number"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."build_product_sale_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."check_is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_is_admin"() TO "service_role";



GRANT ALL ON TABLE "public"."cash_sessions" TO "anon";
GRANT ALL ON TABLE "public"."cash_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."cash_sessions" TO "service_role";



GRANT ALL ON FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text", "p_requested_by_user_id" "uuid", "p_closed_by_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text", "p_requested_by_user_id" "uuid", "p_closed_by_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_cash_session"("p_session_id" "uuid", "p_counted_amount" numeric, "p_notes" "text", "p_requested_by_user_id" "uuid", "p_closed_by_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."codex_ping"() TO "anon";
GRANT ALL ON FUNCTION "public"."codex_ping"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."codex_ping"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_subscription_payment_for_existing_customer"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_final_price" numeric, "p_discount_amount" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid", "p_grace_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."create_subscription_payment_for_existing_customer"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_final_price" numeric, "p_discount_amount" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid", "p_grace_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_subscription_payment_for_existing_customer"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_final_price" numeric, "p_discount_amount" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid", "p_grace_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."find_open_cash_session_for_user"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."find_open_cash_session_for_user"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_open_cash_session_for_user"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_current_permissions"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_permissions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_permissions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_current_role_slug"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_role_slug"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_role_slug"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_profile_role"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_profile_role"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_profile_role"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."has_permission"("p_permission_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_permission"("p_permission_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_permission"("p_permission_key" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."insert_reversal_cash_movement"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_category" "text", "p_note" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."insert_reversal_cash_movement"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_category" "text", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."insert_reversal_cash_movement"("p_payment_id" "uuid", "p_actor_user_id" "uuid", "p_category" "text", "p_note" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_owner"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_owner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."open_cash_session"("p_register_id" "uuid", "p_opening_amount" numeric, "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_cash_session"("p_register_id" "uuid", "p_opening_amount" numeric, "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."open_cash_session"("p_register_id" "uuid", "p_opening_amount" numeric, "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_locked_payment_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_locked_payment_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_locked_payment_mutation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."record_manual_cash_movement"("p_session_id" "uuid", "p_movement_type" "text", "p_category" "text", "p_amount" numeric, "p_payment_method" "text", "p_note" "text", "p_customer_id" "uuid", "p_cash_effect_amount" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."record_manual_cash_movement"("p_session_id" "uuid", "p_movement_type" "text", "p_category" "text", "p_amount" numeric, "p_payment_method" "text", "p_note" "text", "p_customer_id" "uuid", "p_cash_effect_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_manual_cash_movement"("p_session_id" "uuid", "p_movement_type" "text", "p_category" "text", "p_amount" numeric, "p_payment_method" "text", "p_note" "text", "p_customer_id" "uuid", "p_cash_effect_amount" numeric) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_product_inventory_movement"("p_product_id" "uuid", "p_movement_type" "text", "p_quantity" numeric, "p_unit_cost" numeric, "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_product_inventory_movement"("p_product_id" "uuid", "p_movement_type" "text", "p_quantity" numeric, "p_unit_cost" numeric, "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_product_inventory_movement"("p_product_id" "uuid", "p_movement_type" "text", "p_quantity" numeric, "p_unit_cost" numeric, "p_note" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."renew_subscription_with_payment"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_price" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid", "p_grace_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."renew_subscription_with_payment"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_price" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid", "p_grace_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."renew_subscription_with_payment"("p_customer_id" "uuid", "p_plan_id" integer, "p_start_date" "date", "p_end_date" "date", "p_price" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_created_by_user_id" "uuid", "p_grace_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."require_cash_operator"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."require_cash_operator"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."require_cash_operator"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."reverse_and_recreate_payment"("p_payment_id" "uuid", "p_amount_original" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_reason" "text", "p_source_category" "text", "p_note" "text", "p_actor_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."reverse_and_recreate_payment"("p_payment_id" "uuid", "p_amount_original" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_reason" "text", "p_source_category" "text", "p_note" "text", "p_actor_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reverse_and_recreate_payment"("p_payment_id" "uuid", "p_amount_original" numeric, "p_discount_amount" numeric, "p_amount_paid" numeric, "p_payment_method" "text", "p_reason" "text", "p_source_category" "text", "p_note" "text", "p_actor_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."roles_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."roles_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."roles_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sell_products_from_cash_session"("p_items" "jsonb", "p_payment_method" "text", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sell_products_from_cash_session"("p_items" "jsonb", "p_payment_method" "text", "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sell_products_from_cash_session"("p_items" "jsonb", "p_payment_method" "text", "p_note" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_row_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_row_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_row_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."subscription_access_until"("p_end_date" "date", "p_grace_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."subscription_access_until"("p_end_date" "date", "p_grace_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."subscription_access_until"("p_end_date" "date", "p_grace_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_profile_from_auth_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_profile_from_auth_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_profile_from_auth_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_user_to_zkteco"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_user_to_zkteco"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_user_to_zkteco"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_products_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_products_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_products_updated_at"() TO "service_role";



GRANT ALL ON TABLE "public"."access_logs" TO "anon";
GRANT ALL ON TABLE "public"."access_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."access_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."access_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."access_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."access_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."plans" TO "anon";
GRANT ALL ON TABLE "public"."plans" TO "authenticated";
GRANT ALL ON TABLE "public"."plans" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."active_memberships_view" TO "anon";
GRANT ALL ON TABLE "public"."active_memberships_view" TO "authenticated";
GRANT ALL ON TABLE "public"."active_memberships_view" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_logs" TO "anon";
GRANT ALL ON TABLE "public"."attendance_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."attendance_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."attendance_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."attendance_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."body_assessments" TO "anon";
GRANT ALL ON TABLE "public"."body_assessments" TO "authenticated";
GRANT ALL ON TABLE "public"."body_assessments" TO "service_role";



GRANT ALL ON TABLE "public"."cash_registers" TO "anon";
GRANT ALL ON TABLE "public"."cash_registers" TO "authenticated";
GRANT ALL ON TABLE "public"."cash_registers" TO "service_role";



GRANT ALL ON TABLE "public"."customer_overview" TO "anon";
GRANT ALL ON TABLE "public"."customer_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_overview" TO "service_role";



GRANT ALL ON TABLE "public"."device_commands" TO "anon";
GRANT ALL ON TABLE "public"."device_commands" TO "authenticated";
GRANT ALL ON TABLE "public"."device_commands" TO "service_role";



GRANT ALL ON SEQUENCE "public"."device_commands_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."device_commands_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."device_commands_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."exercises" TO "anon";
GRANT ALL ON TABLE "public"."exercises" TO "authenticated";
GRANT ALL ON TABLE "public"."exercises" TO "service_role";



GRANT ALL ON SEQUENCE "public"."exercises_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."exercises_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."exercises_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."message_templates" TO "anon";
GRANT ALL ON TABLE "public"."message_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."message_templates" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."monthly_revenue_view" TO "anon";
GRANT ALL ON TABLE "public"."monthly_revenue_view" TO "authenticated";
GRANT ALL ON TABLE "public"."monthly_revenue_view" TO "service_role";



GRANT ALL ON TABLE "public"."payments_overview" TO "anon";
GRANT ALL ON TABLE "public"."payments_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."payments_overview" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "anon";
GRANT ALL ON TABLE "public"."permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."plans_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."plans_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."plans_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."product_inventory_overview" TO "anon";
GRANT ALL ON TABLE "public"."product_inventory_overview" TO "authenticated";
GRANT ALL ON TABLE "public"."product_inventory_overview" TO "service_role";



GRANT ALL ON TABLE "public"."product_sale_items" TO "anon";
GRANT ALL ON TABLE "public"."product_sale_items" TO "authenticated";
GRANT ALL ON TABLE "public"."product_sale_items" TO "service_role";



GRANT ALL ON TABLE "public"."product_sales" TO "anon";
GRANT ALL ON TABLE "public"."product_sales" TO "authenticated";
GRANT ALL ON TABLE "public"."product_sales" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON SEQUENCE "public"."profiles_biometric_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."profiles_biometric_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."profiles_biometric_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."role_permissions" TO "anon";
GRANT ALL ON TABLE "public"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."roles" TO "anon";
GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";



GRANT ALL ON TABLE "public"."routine_blueprint_assignments" TO "anon";
GRANT ALL ON TABLE "public"."routine_blueprint_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."routine_blueprint_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."routine_blueprint_details" TO "anon";
GRANT ALL ON TABLE "public"."routine_blueprint_details" TO "authenticated";
GRANT ALL ON TABLE "public"."routine_blueprint_details" TO "service_role";



GRANT ALL ON SEQUENCE "public"."routine_blueprint_details_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."routine_blueprint_details_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."routine_blueprint_details_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."routine_blueprints" TO "anon";
GRANT ALL ON TABLE "public"."routine_blueprints" TO "authenticated";
GRANT ALL ON TABLE "public"."routine_blueprints" TO "service_role";



GRANT ALL ON TABLE "public"."routine_details" TO "anon";
GRANT ALL ON TABLE "public"."routine_details" TO "authenticated";
GRANT ALL ON TABLE "public"."routine_details" TO "service_role";



GRANT ALL ON SEQUENCE "public"."routine_details_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."routine_details_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."routine_details_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."routine_templates" TO "anon";
GRANT ALL ON TABLE "public"."routine_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."routine_templates" TO "service_role";



GRANT ALL ON SEQUENCE "public"."routine_templates_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."routine_templates_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."routine_templates_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."routines" TO "anon";
GRANT ALL ON TABLE "public"."routines" TO "authenticated";
GRANT ALL ON TABLE "public"."routines" TO "service_role";



GRANT ALL ON TABLE "public"."training_nutrition_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."training_nutrition_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."training_nutrition_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."training_profiles" TO "anon";
GRANT ALL ON TABLE "public"."training_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."training_profiles" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "algym_migrator";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "algym_migrator";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON TABLES TO "algym_migrator";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "algym_migrator" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";








COMMIT;
