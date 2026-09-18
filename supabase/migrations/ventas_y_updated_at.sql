-- ============================================================
-- BARATUSS — Arreglo del flujo de compra → entrega → finanzas
-- Fecha: 2026-09-18
-- 1) Columnas updated_at (el panel las escribe; sin ellas TODO fallaba)
-- 2) Tabla `ventas`: registro real de cada venta entregada (con IVA, costo, comisión, utilidad)
-- 3) Trigger: al marcar ENTREGADO el último despacho del pedido → registra la venta
-- ============================================================

-- ---------- 1) updated_at ----------
alter table public.orders     add column if not exists updated_at timestamptz default now();
alter table public.despachos  add column if not exists updated_at timestamptz default now();

-- ---------- 2) Tabla de ventas ----------
create table if not exists public.ventas (
  id                bigserial primary key,
  order_reference   text not null unique,
  fecha_compra      date,
  fecha_entrega     date not null default current_date,
  cliente           text,
  telefono          text,
  metodo_pago       text,
  punto_entrega     text,
  total_bruto       numeric(10,2) not null default 0,   -- lo que pagó el cliente (IVA incluido)
  iva_incluido      numeric(10,2) not null default 0,   -- 13/113 → plata del IVA (obligación)
  venta_neta        numeric(10,2) not null default 0,   -- bruto − IVA
  costo_productos   numeric(10,2) not null default 0,   -- COGS (costo real del inventario)
  comision_wompi    numeric(10,2) not null default 0,   -- 3.5% + $0.25 (solo tarjeta)
  gasto_envio       numeric(10,2) not null default 0,   -- lo cobrado por entrega
  utilidad_bruta    numeric(10,2) not null default 0,   -- venta_neta − costo
  utilidad_neta     numeric(10,2) not null default 0,   -- venta_neta − costo − comisión
  items             jsonb,
  registrado_en     timestamptz not null default now(),
  registrado_por    text default 'sistema'
);

create index if not exists ventas_fecha_entrega_idx on public.ventas (fecha_entrega desc);
create index if not exists ventas_metodo_idx        on public.ventas (metodo_pago);

alter table public.ventas enable row level security;

drop policy if exists "Ventas: admin lee" on public.ventas;
create policy "Ventas: admin lee" on public.ventas
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

drop policy if exists "Ventas: admin escribe" on public.ventas;
create policy "Ventas: admin escribe" on public.ventas
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- ---------- 3) Registro automático de la venta ----------
create or replace function public.registrar_venta_entrega(p_ref text)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order      record;
  v_pendientes int;
  v_total      numeric := 0;
  v_items      jsonb;
  v_cogs       numeric := 0;
  v_iva        numeric := 0;
  v_neta       numeric := 0;
  v_com        numeric := 0;
  v_fee        numeric := 0;
  v_it         jsonb;
  v_qty        int;
  v_cost       numeric;
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

  -- Solo se registra cuando TODOS los productos del pedido están entregados
  select count(*) into v_pendientes
  from public.despachos
  where order_reference = p_ref and coalesce(estado_logistico, '') <> 'entregado';
  if v_pendientes > 0 then
    return json_build_object('ok', false, 'motivo', 'faltan_entregas', 'pendientes', v_pendientes);
  end if;

  v_total := coalesce(v_order.total, 0);
  v_fee   := coalesce(v_order.delivery_fee, 0);
  v_items := case when jsonb_typeof(v_order.items::jsonb) = 'array' then v_order.items::jsonb else '[]'::jsonb end;

  -- COGS: costo REAL del inventario (por id de producto)
  for v_it in select * from jsonb_array_elements(v_items) loop
    v_qty  := coalesce((v_it->>'qty')::int, 1);
    v_cost := 0;
    begin
      select coalesce(cost_price, 0) into v_cost
      from public.inventory where id = coalesce((v_it->>'id')::bigint, -1);
    exception when others then v_cost := 0;
    end;
    v_cogs := v_cogs + v_qty * coalesce(v_cost, 0);
  end loop;

  v_iva  := round(v_total * 13 / 113, 2);          -- IVA incluido en el precio
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
    round(v_neta - v_cogs, 2), round(v_neta - v_cogs - v_com, 2), v_items, 'entrega'
  )
  on conflict (order_reference) do nothing;

  -- El pedido queda marcado como entregado y pagado
  update public.orders
     set status = 'entregado',
         payment_status = case when coalesce(payment_status, '') in ('efectivo', 'pendiente')
                               then 'pagado' else payment_status end,
         updated_at = now()
   where reference = p_ref;

  return json_build_object('ok', true, 'motivo', 'registrada',
                           'total', v_total, 'iva', v_iva, 'costo', v_cogs,
                           'comision', v_com, 'utilidad', round(v_neta - v_cogs - v_com, 2));
end $function$;

-- Trigger: se dispara al pasar un despacho a 'entregado'
create or replace function public.trg_despacho_entregado()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if coalesce(new.estado_logistico, '') = 'entregado'
     and (tg_op = 'INSERT' or coalesce(old.estado_logistico, '') <> 'entregado') then
    perform public.registrar_venta_entrega(new.order_reference);
  end if;
  return new;
end $function$;

drop trigger if exists trg_despacho_entregado on public.despachos;
create trigger trg_despacho_entregado
  after insert or update of estado_logistico on public.despachos
  for each row execute function public.trg_despacho_entregado();
