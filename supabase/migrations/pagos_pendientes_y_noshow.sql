-- ========================================================================
-- PAGOS PENDIENTES, ABANDONO Y NO_SHOW — Planes 2 y 3 (aprobados por Cindy)
-- 2026-09-19
--
-- Reglas aprobadas:
--   · Factura solo cuando la compra está PAGADA
--   · Pedido sin pagar: 2 recordatorios (2 h y 24 h) → a las 48 h se cierra y vuelve el stock
--   · Sin pagar: NO se prepara (fuera de "Preparar") · etiqueta naranja en Despachos
--   · Teléfono OBLIGATORIO (validado, normalizado a 503XXXXXXXX)
--   · Cliente sin WhatsApp: se detecta, se avisa por correo y se puede llamar
--   · NO_SHOW: menú de opciones, 48 h para responder, si no responde vuelve el stock
--   · 2ª vez sin responder: pago adelantado con tarjeta (no se le habilita efectivo)
-- ========================================================================

-- ─────────────────────────── PEDIDOS ───────────────────────────
alter table public.orders add column if not exists pago_expira_en timestamptz;
alter table public.orders add column if not exists requiere_pago_adelantado boolean not null default false;
alter table public.orders add column if not exists whatsapp_estado text;      -- ok | sin_whatsapp
alter table public.orders add column if not exists contacto_preferido text;   -- whatsapp | correo
alter table public.orders add column if not exists aviso_pago jsonb not null default '{}'::jsonb;
alter table public.orders add column if not exists telefono_normalizado text;
create index if not exists orders_tel_idx on public.orders (telefono_normalizado);

-- ─────────────────── CARRITOS ABANDONADOS (Nivel B) ───────────────────
-- Se guarda SOLO el teléfono que el cliente escribió en el checkout y no confirmó.
-- Se avisa UNA vez y el dato se borra solo a los 30 días.
create table if not exists public.carritos_abandonados (
  telefono text primary key,
  nombre text,
  items jsonb not null default '[]'::jsonb,
  total numeric(10,2),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  avisado_en timestamptz,
  borrar_en timestamptz not null default (now() + interval '30 days'),
  convertido boolean not null default false
);
alter table public.carritos_abandonados enable row level security;
drop policy if exists "Carritos: admin" on public.carritos_abandonados;
create policy "Carritos: admin" on public.carritos_abandonados for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- ─────────────── TELÉFONOS: ¿tienen WhatsApp? ───────────────
create table if not exists public.wa_telefonos (
  telefono text primary key,
  tiene_whatsapp boolean,
  motivo text,
  detectado_en timestamptz not null default now()
);
alter table public.wa_telefonos enable row level security;
drop policy if exists "WaTelefonos: admin" on public.wa_telefonos;
create policy "WaTelefonos: admin" on public.wa_telefonos for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- ─────────────────── INCIDENCIAS (NO_SHOW) ───────────────────
alter table public.incidencias_entrega add column if not exists respuesta_cliente text;
alter table public.incidencias_entrega add column if not exists cobro_adelantado boolean not null default false;

-- ========================================================================
-- RPC · cerrar_pedido_sin_venta
-- Cierra un pedido que NO se vendió (vencido / no-retirado / cancelado):
-- devuelve TODO el stock de sus items y cancela sus despachos.
-- ========================================================================
create or replace function public.cerrar_pedido_sin_venta(p_ref text, p_motivo text default 'cancelado')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
  v_estado text;
  it record;
  v_devueltos int := 0;
begin
  select items, status into v_items, v_estado from orders where reference = p_ref;
  if v_items is null then
    return json_build_object('ok', false, 'motivo', 'pedido_no_existe');
  end if;

  -- Devolver el stock de cada item (si el pedido todavía lo tenía tomado)
  for it in select * from jsonb_to_recordset(v_items) as x(id text, qty int) loop
    if it.id is not null and coalesce(it.qty, 0) > 0 then
      perform devolver_stock(it.id::bigint, it.qty);
      v_devueltos := v_devueltos + 1;
    end if;
  end loop;

  update orders
     set status = p_motivo,
         updated_at = now()
   where reference = p_ref;

  update despachos
     set estado_logistico = p_motivo,
         updated_at = now(),
         notas = coalesce(notas, '') || E'\n🔒 ' || p_motivo || ' ' || to_char(now() - interval '6 hours', 'YYYY-MM-DD HH24:MI')
   where order_reference = p_ref
     and estado_logistico not in ('entregado');

  return json_build_object('ok', true, 'items_devueltos', v_devueltos, 'estado', p_motivo);
end $$;

revoke all on function public.cerrar_pedido_sin_venta(text, text) from public, anon, authenticated;
grant execute on function public.cerrar_pedido_sin_venta(text, text) to service_role;

-- ========================================================================
-- RPC · expirar_pedidos_sin_pagar
-- Pedidos con tarjeta que nunca se pagaron y ya pasaron las horas límite:
-- devuelve el stock y los marca como 'vencido'.
-- ========================================================================
create or replace function public.expirar_pedidos_sin_pagar(p_horas int default 48)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exp jsonb := '[]'::jsonb;
  o record;
  r json;
begin
  for o in
    select reference, customer_name, customer_phone, total
      from orders
     where coalesce(payment_status, 'pendiente') in ('pendiente', 'rechazado', 'creado')
       and coalesce(status, 'pendiente') not in ('cancelado', 'entregado', 'vencido', 'no-retirado')
       and created_at < now() - make_interval(hours => p_horas)
       and (pago_expira_en is null or pago_expira_en < now())
     order by created_at asc
     limit 50
  loop
    r := cerrar_pedido_sin_venta(o.reference, 'vencido');
    v_exp := v_exp || jsonb_build_object('reference', o.reference, 'cliente', o.customer_name,
                                        'telefono', o.customer_phone, 'total', o.total);
  end loop;

  return json_build_object('ok', true, 'expirados', jsonb_array_length(v_exp), 'pedidos', v_exp);
end $$;

revoke all on function public.expirar_pedidos_sin_pagar(int) from public, anon, authenticated;
grant execute on function public.expirar_pedidos_sin_pagar(int) to service_role;

-- ========================================================================
-- RPC · no_shows_cliente
-- Cuenta las veces que un cliente no retiró y NO respondió (para la 2ª vez:
-- pago adelantado con tarjeta).
-- ========================================================================
create or replace function public.no_shows_cliente(p_telefono text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tel text;
  v_n int;
begin
  v_tel := regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g');
  if length(v_tel) = 8 then v_tel := '503' || v_tel; end if;

  select count(*) into v_n
    from incidencias_entrega
   where tipo = 'no_show'
     and estado = 'no_retirado'
     and regexp_replace(coalesce(customer_phone, ''), '[^0-9]', '', 'g') = v_tel;

  return json_build_object('ok', true, 'telefono', v_tel, 'no_shows', v_n,
                           'pago_adelantado', (v_n >= 1));
end $$;

revoke all on function public.no_shows_cliente(text) from public, anon, authenticated;
grant execute on function public.no_shows_cliente(text) to service_role;

-- ========================================================================
-- CUPONES: soportar CRÉDITO (monto fijo, para el "crédito por no-show")
-- ========================================================================
create or replace function public.calcular_descuento_cupon(p_codigo text, p_subtotal numeric)
returns numeric
language sql
stable
as $$
  select case
    when c.tipo = 'credito' then least(coalesce(c.valor, 0), coalesce(p_subtotal, 0))
    else least(round(coalesce(p_subtotal, 0) * coalesce(c.valor, 0) / 100.0, 2), coalesce(c.tope, 999999))
  end
  from cupones c where upper(c.codigo) = upper(trim(p_codigo));
$$;

grant execute on function public.calcular_descuento_cupon(text, numeric) to service_role;

-- Marca de control: dejar constancia de la aplicación del plan
insert into public.config_operativa (clave, valor, notas) values
  ('plan_pagos_48h', 'activo', 'Pagos pendientes y abandono: recordatorios 2h/24h y vencimiento a las 48h (Cindy 19-sep-2026)'),
  ('plan_noshow_48h', 'activo', 'NO_SHOW: menú de opciones, 48h para responder; 2ª vez sin responder = pago adelantado (Cindy 19-sep-2026)'),
  ('contacto_hablar_con', '76626575', 'Número personal de Cindy para el menú de no-show (Cindy 19-sep-2026)')
on conflict (clave) do update set valor = excluded.valor, notas = excluded.notas, actualizado_en = now();
