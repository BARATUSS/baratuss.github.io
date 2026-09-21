-- ========================================================================
-- ESCENARIO 3 · PRODUCTO NO DISPONIBLE (aprobado por Cindy 20-sep-2026)
--
-- 1) ARREGLO GRAVE: la venta se registraba SOLO si TODOS los productos estaban
--    entregados y por el TOTAL del pedido. Ahora:
--      · Los productos anulados (no disponibles / cancelados) no bloquean el registro
--      · La venta se calcula con lo que REALMENTE se entregó (+ el envío)
--      · Si no se entregó nada, no se registra venta
-- 2) Nueva función `ajustar_pedido`: saca productos del pedido, devuelve su stock,
--    marca sus despachos como 'no-disponible' y recalcula el total.
-- ========================================================================

-- ─────────────── RPC · registrar_venta_entrega (corregida) ───────────────
create or replace function public.registrar_venta_entrega(p_ref text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order      record;
  v_pendientes int;
  v_entregados int;
  v_total      numeric := 0;
  v_items_ok   jsonb := '[]'::jsonb;
  v_anulados   jsonb := '[]'::jsonb;
  v_cogs       numeric := 0;
  v_iva        numeric := 0;
  v_neta       numeric := 0;
  v_com        numeric := 0;
  v_fee        numeric := 0;
  v_it         jsonb;
  v_qty        int;
  v_cost       numeric;
  v_id         bigint;
begin
  if p_ref is null or p_ref = '' then
    return json_build_object('ok', false, 'motivo', 'sin_referencia');
  end if;

  select * into v_order from public.orders where reference = p_ref;
  if not found then
    return json_build_object('ok', false, 'motivo', 'pedido_no_existe');
  end if;

  if exists (select 1 from public.ventas where order_reference = p_ref) then
    return json_build_object('ok', true, 'motivo', 'ya_registrada');
  end if;

  -- ⚠️ ANTES: exigía que TODOS estuvieran 'entregado' → con un producto anulado la
  -- venta no se registraba NUNCA (dinero cobrado invisible en finanzas).
  -- AHORA: los estados "cerrados sin entrega" no bloquean el registro.
  select count(*) into v_pendientes
    from public.despachos
   where order_reference = p_ref
     and coalesce(estado_logistico, '') not in
         ('entregado', 'anulado', 'no-disponible', 'cancelado', 'no-retirado', 'vencido', 'no-show');
  if v_pendientes > 0 then
    return json_build_object('ok', false, 'motivo', 'faltan_entregas', 'pendientes', v_pendientes);
  end if;

  select count(*) into v_entregados
    from public.despachos
   where order_reference = p_ref and estado_logistico = 'entregado';
  if v_entregados = 0 then
    return json_build_object('ok', true, 'motivo', 'nada_entregado');
  end if;

  -- Productos que NO se entregaron (su despacho quedó anulado).
  -- Se identifica por PRODUCTO + TALLA (así un pedido con el mismo producto en dos
  -- tallas distintas se ajusta correctamente).
  select coalesce(jsonb_agg(distinct jsonb_build_object('id', inventory_id, 'talla', coalesce(talla, ''))), '[]'::jsonb)
    into v_anulados
    from public.despachos
   where order_reference = p_ref
     and estado_logistico in ('anulado', 'no-disponible', 'cancelado', 'no-retirado', 'vencido', 'no-show');

  v_fee := coalesce(v_order.delivery_fee, 0);
  if jsonb_typeof(v_order.items) = 'array' then
    for v_it in select * from jsonb_array_elements(v_order.items) loop
      begin
        v_id := coalesce((v_it->>'id')::bigint, -1);
      exception when others then v_id := -1;
      end;
      -- ¿este producto (id + talla) quedó anulado?
      if v_anulados @> jsonb_build_array(jsonb_build_object('id', v_id, 'talla', coalesce(v_it->>'size', v_it->>'talla', ''))) then
        continue;
      end if;
      v_qty := coalesce((v_it->>'qty')::int, 1);
      v_total := v_total + coalesce((v_it->>'price')::numeric, 0) * v_qty;
      v_items_ok := v_items_ok || v_it;
      v_cost := 0;
      begin
        select coalesce(cost_price, 0) into v_cost from public.inventory where id = v_id;
      exception when others then v_cost := 0;
      end;
      v_cogs := v_cogs + v_qty * coalesce(v_cost, 0);
    end loop;
  end if;

  v_total := round(coalesce(v_total, 0) + v_fee, 2);
  if v_total <= 0 then
    return json_build_object('ok', true, 'motivo', 'nada_entregado');
  end if;

  v_iva  := round(v_total * 13 / 113, 2);
  v_neta := round(v_total - v_iva, 2);
  v_com  := case when coalesce(v_order.payment_method, 'efectivo') <> 'efectivo'
                 then round(v_total * 0.035 + 0.25, 2) else 0 end;

  insert into public.ventas (
    order_reference, fecha_compra, fecha_entrega, cliente, telefono, metodo_pago, punto_entrega,
    total_bruto, iva_incluido, venta_neta, costo_productos, comision_wompi, gasto_envio,
    utilidad_bruta, utilidad_neta, items, registrado_por
  ) values (
    p_ref, v_order.created_at::date, current_date, v_order.customer_name, v_order.customer_phone,
    v_order.payment_method, coalesce(v_order.delivery_point, ''),
    v_total, v_iva, v_neta, v_cogs, v_com, v_fee,
    round(v_neta - v_cogs, 2), round(v_neta - v_cogs - v_com, 2), v_items_ok, 'entrega'
  )
  on conflict (order_reference) do nothing;

  update public.orders
     set status = 'entregado',
         payment_status = case when coalesce(payment_status, '') in ('efectivo', 'pendiente')
                               then 'pagado' else payment_status end,
         updated_at = now()
   where reference = p_ref;

  return json_build_object('ok', true, 'motivo', 'registrada',
                           'total', v_total, 'iva', v_iva, 'costo', v_cogs,
                           'comision', v_com, 'utilidad', round(v_neta - v_cogs - v_com, 2),
                           'productos_anulados', (select count(*) from public.despachos
                                                  where order_reference = p_ref
                                                    and estado_logistico in ('anulado','no-disponible','cancelado','no-retirado','vencido','no-show')));
end $$;

-- ─────────────── DISPARADOR · la venta también se revisa al cerrar un producto sin entregar ───────────────
-- ⚠️ Antes el disparador SOLO miraba cuando un producto pasaba a 'entregado'. Si después
-- se anulaba otro producto (ajuste, cancelación, no-show), la venta de lo YA entregado
-- nunca se registraba. Ahora también se revisa al cerrar un producto sin entrega.
create or replace function public.trg_despacho_entregado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.estado_logistico, '') = 'entregado'
     and (tg_op = 'INSERT' or coalesce(old.estado_logistico, '') <> 'entregado') then
    perform public.registrar_venta_entrega(new.order_reference);

  elsif coalesce(new.estado_logistico, '') in ('no-disponible', 'anulado', 'cancelado', 'vencido', 'no-retirado', 'no-show')
        and (tg_op = 'INSERT' or coalesce(old.estado_logistico, '') <> coalesce(new.estado_logistico, '')) then
    -- Se cerró un producto SIN entregar: si el resto del pedido ya se entregó, la venta se registra igual
    perform public.registrar_venta_entrega(new.order_reference);
  end if;
  return new;
end $$;

-- ─────────────── RPC · ajustar_pedido (sacar productos que no están) ───────────────
create or replace function public.ajustar_pedido(p_ref text, p_items jsonb, p_motivo text default 'no disponible')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items   jsonb;
  v_total   numeric;
  v_it      jsonb;
  v_id      bigint;
  v_qty     int;
  v_talla   text;
  v_precio  numeric;
  v_resta   numeric := 0;
  v_count   int := 0;
begin
  select items, total into v_items, v_total from public.orders where reference = p_ref;
  if v_items is null then
    return json_build_object('ok', false, 'motivo', 'pedido_no_existe');
  end if;
  if coalesce(jsonb_array_length(p_items), 0) = 0 then
    return json_build_object('ok', false, 'motivo', 'sin_items');
  end if;

  for v_it in select * from jsonb_array_elements(p_items) loop
    v_id   := coalesce((v_it->>'id')::bigint, -1);
    v_qty  := coalesce((v_it->>'qty')::int, 1);
    v_talla := nullif(v_it->>'talla', '');
    if v_id <= 0 then continue; end if;

    -- 1) devolver el stock de ese producto
    perform devolver_stock(v_id, v_qty);

    -- 2) sus tarjetas de despacho quedan 'no-disponible' (salen de las listas)
    if v_talla is null then
      update public.despachos
         set estado_logistico = 'no-disponible', updated_at = now(),
             notas = coalesce(notas, '') || E'\n✂️ NO DISPONIBLE: ' || coalesce(p_motivo, '') || ' ' ||
                     to_char(now() - interval '6 hours', 'YYYY-MM-DD HH24:MI')
       where order_reference = p_ref and inventory_id = v_id
         and coalesce(estado_logistico, '') <> 'entregado';
    else
      update public.despachos
         set estado_logistico = 'no-disponible', updated_at = now(),
             notas = coalesce(notas, '') || E'\n✂️ NO DISPONIBLE: ' || coalesce(p_motivo, '') || ' ' ||
                     to_char(now() - interval '6 hours', 'YYYY-MM-DD HH24:MI')
       where order_reference = p_ref and inventory_id = v_id and coalesce(talla, '') = v_talla
         and coalesce(estado_logistico, '') <> 'entregado';
    end if;

    -- 3) cuánto hay que descontar del total (precio del propio pedido)
    v_precio := null;
    select coalesce((x->>'price')::numeric, 0) into v_precio
      from jsonb_array_elements(v_items) x
     where (x->>'id')::bigint = v_id
       and (v_talla is null or coalesce(x->>'size', x->>'talla', '') = v_talla)
     limit 1;
    if v_precio is null then
      select coalesce((x->>'price')::numeric, 0) into v_precio
        from jsonb_array_elements(v_items) x where (x->>'id')::bigint = v_id limit 1;
    end if;
    v_resta := v_resta + coalesce(v_precio, 0) * v_qty;
    v_count := v_count + 1;
  end loop;

  update public.orders
     set total = greatest(0, round(coalesce(v_total, 0) - v_resta, 2)),
         updated_at = now()
   where reference = p_ref;

  return json_build_object('ok', true, 'items_ajustados', v_count,
                           'descontado', round(v_resta, 2),
                           'total_anterior', v_total,
                           'total_nuevo', greatest(0, round(coalesce(v_total, 0) - v_resta, 2)));
end $$;

revoke all on function public.ajustar_pedido(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.ajustar_pedido(text, jsonb, text) to service_role;
grant execute on function public.registrar_venta_entrega(text) to service_role;
