-- ========================================================================
-- CONTINGENCIAS DE ENTREGA — Etapas 1, 2 y 3
-- 2026-09-18 · Aprobado por Cindy (plan v1.2)
--
-- Crea:
--   · incidencias_entrega  → la ficha de cada caso (registro completo)
--   · cupones              → escalonados, solo producto, con tope, un solo uso
--   · reembolsos           → registro y aprobación (el pago es manual en Wompi)
--   · config_operativa     → configuración (teléfonos de respaldo, costo motorista)
--   · columnas nuevas      → prioridad/entregador en despachos; cupón en orders
--   · vender_carrito ya existe; acá se agregan las funciones de cupones
--
-- Seguridad: mismas reglas que despachos/ventas (solo admins leen y escriben).
-- Las funciones de cupón son SECURITY DEFINER y solo para service_role.
-- ========================================================================

-- ============ 1) INCIDENCIAS (la ficha de cada caso) ============
create table if not exists public.incidencias_entrega (
  id                    bigserial primary key,
  creado_en             timestamptz not null default now(),
  actualizado_en        timestamptz not null default now(),
  order_reference       text,
  despacho_id           bigint,
  customer_name         text,
  customer_phone        text,
  tipo                  text not null default 'contingencia',   -- contingencia | cancelacion_enojo
  motivo                text,
  detalle               text,
  opciones_probadas     jsonb not null default '[]'::jsonb,      -- [{opcion, resultado, cuando}]
  entregador            text,                                    -- cindy | isabel | motorista | otro
  entregador_nombre     text,
  entregador_telefono   text,
  costo_entregador      numeric(10,2),                           -- solo si Cindy ya definió el costo
  opcion_cliente        text,                                    -- reagendar | reembolso | mantener
  nivel_aprobado        int,                                     -- 1..5 (lo aprueba Cindy)
  cupon_codigo          text,
  cupon_descuento       numeric(10,2),
  reembolso_monto       numeric(10,2),
  estado                text not null default 'abierta',         -- abierta | esperando_cliente | esperando_aprobacion | resuelta | sin_resolver
  aprobado_por          text,
  resuelto_en           timestamptz,
  notas                 text
);
create index if not exists incidencias_estado_idx on public.incidencias_entrega (estado, creado_en desc);
create index if not exists incidencias_pedido_idx on public.incidencias_entrega (order_reference);
create index if not exists incidencias_tel_idx on public.incidencias_entrega (customer_phone);

-- ============ 2) CUPONES ============
create table if not exists public.cupones (
  codigo              text primary key,
  creado_en           timestamptz not null default now(),
  tipo                text not null default 'porcentaje_producto',  -- SOLO producto, nunca envío
  valor               numeric(5,2) not null,                         -- % de descuento
  tope                numeric(10,2),                                 -- máximo en dólares
  cliente_telefono    text,
  cliente_email       text,
  un_solo_uso         boolean not null default true,
  usado_en            timestamptz,
  order_reference_uso text,
  descuento_aplicado  numeric(10,2),
  expira_en           timestamptz not null default (now() + interval '30 days'),
  acumulable          boolean not null default false,
  origen              text,                                          -- contingencia | cancelacion_enojo | promo
  incidencia_id       bigint,
  nivel               int,
  aprobado_por        text,
  activo              boolean not null default true
);
create index if not exists cupones_telefono_idx on public.cupones (cliente_telefono);

-- ============ 3) REEMBOLSOS ============
create table if not exists public.reembolsos (
  id                bigserial primary key,
  creado_en         timestamptz not null default now(),
  order_reference   text,
  incidencia_id     bigint,
  customer_name     text,
  customer_phone    text,
  monto             numeric(10,2) not null,
  motivo            text,
  metodo            text,                                    -- wompi | efectivo | transferencia
  estado            text not null default 'solicitado',       -- solicitado | aprobado | pagado | rechazado
  aprobado_por      text,
  aprobado_en       timestamptz,
  pagado_en         timestamptz,
  notas             text
);

-- ============ 4) CONFIG OPERATIVA ============
create table if not exists public.config_operativa (
  clave           text primary key,
  valor           text,
  notas           text,
  actualizado_en  timestamptz not null default now()
);

insert into public.config_operativa (clave, valor, notas) values
  ('isabel_nombre',       'Isabel',        'Entregadora de respaldo'),
  ('isabel_telefono',     '7888-0766',     'Entregadora de respaldo'),
  ('motorista_nombre',    'Motorista de confianza', 'Motorista de respaldo'),
  ('motorista_telefono',  '7652-7809',     'Motorista de respaldo'),
  ('costo_motorista',     null,            'Costo fijo del motorista. Cindy lo define mas adelante; mientras este vacio NO se registra gasto automatico.')
on conflict (clave) do nothing;

-- ============ 5) COLUMNAS NUEVAS ============
alter table public.despachos add column if not exists prioridad       boolean not null default false;
alter table public.despachos add column if not exists entregador      text;
alter table public.despachos add column if not exists reprogramado_de text;
alter table public.orders    add column if not exists cupon_codigo    text;
alter table public.orders    add column if not exists cupon_descuento numeric(10,2);
alter table public.orders    add column if not exists incidencia_id   bigint;

-- ============ 6) RLS: igual que despachos/ventas (solo admins) ============
do $do$
declare t text;
begin
  foreach t in array array['incidencias_entrega', 'cupones', 'reembolsos', 'config_operativa'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: admin" on public.%I', t, t);
    execute format(
      'create policy "%s: admin" on public.%I for all to authenticated using '
      '(exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)) with check '
      '(exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true))', t, t);
  end loop;
end
$do$;

-- ============ 7) FUNCIONES DE CUPÓN ============

-- 7.1 Validar (lo usa el checkout para mostrar el descuento; NO marca usado)
create or replace function public.validar_cupon(p_codigo text, p_telefono text default null, p_subtotal numeric default null)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare c record; v_desc numeric := 0;
begin
  select * into c from public.cupones where codigo = upper(trim(coalesce(p_codigo, '')));
  if not found then return json_build_object('ok', false, 'motivo', 'no_existe'); end if;
  if not c.activo then return json_build_object('ok', false, 'motivo', 'inactivo'); end if;
  if c.usado_en is not null then return json_build_object('ok', false, 'motivo', 'ya_usado'); end if;
  if c.expira_en < now() then return json_build_object('ok', false, 'motivo', 'vencido'); end if;
  if c.cliente_telefono is not null and p_telefono is not null
     and right(regexp_replace(c.cliente_telefono, '\D', '', 'g'), 8)
         <> right(regexp_replace(p_telefono, '\D', '', 'g'), 8) then
    return json_build_object('ok', false, 'motivo', 'no_corresponde');
  end if;

  if p_subtotal is not null and p_subtotal > 0 then
    v_desc := round(least(p_subtotal * c.valor / 100.0, coalesce(c.tope, 1e9)), 2);
  end if;

  return json_build_object(
    'ok', true, 'codigo', c.codigo, 'valor', c.valor, 'tope', c.tope,
    'expira_en', c.expira_en, 'descuento', v_desc,
    'solo_producto', true, 'acumulable', c.acumulable
  );
end
$function$;

-- 7.2 Usar (autoritativo): calcula el descuento desde los items REALES del pedido,
--     aplica tope, marca el cupón como usado de forma atómica y lo deja en el pedido.
create or replace function public.usar_cupon(p_codigo text, p_reference text)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  c record; v_items jsonb; v_envio numeric := 0; v_subtotal numeric := 0; v_desc numeric := 0;
  v_item jsonb;
begin
  select * into c from public.cupones where codigo = upper(trim(coalesce(p_codigo, ''))) for update;
  if not found then return json_build_object('ok', false, 'motivo', 'no_existe'); end if;
  if not c.activo then return json_build_object('ok', false, 'motivo', 'inactivo'); end if;
  if c.usado_en is not null then return json_build_object('ok', false, 'motivo', 'ya_usado'); end if;
  if c.expira_en < now() then return json_build_object('ok', false, 'motivo', 'vencido'); end if;

  select items, coalesce(delivery_fee, 0) into v_items, v_envio
    from public.orders where reference = p_reference;
  if not found then return json_build_object('ok', false, 'motivo', 'pedido_no_existe'); end if;

  -- Solo PRODUCTOS (el envío nunca lleva descuento)
  for v_item in select value from jsonb_array_elements(coalesce(v_items, '[]'::jsonb)) loop
    v_subtotal := v_subtotal + coalesce((v_item->>'price')::numeric, 0) * greatest(coalesce((v_item->>'qty')::int, 1), 1);
  end loop;

  v_desc := round(least(v_subtotal * c.valor / 100.0, coalesce(c.tope, 1e9)), 2);

  update public.cupones
     set usado_en = now(), order_reference_uso = p_reference, descuento_aplicado = v_desc
   where codigo = c.codigo;

  update public.orders
     set cupon_codigo = c.codigo, cupon_descuento = v_desc, updated_at = now()
   where reference = p_reference;

  return json_build_object('ok', true, 'codigo', c.codigo, 'valor', c.valor,
                           'subtotal_productos', v_subtotal, 'descuento', v_desc,
                           'envio_sin_descuento', v_envio);
end
$function$;

revoke all on function public.validar_cupon(text, text, numeric) from public;
grant execute on function public.validar_cupon(text, text, numeric) to anon, authenticated, service_role;
revoke all on function public.usar_cupon(text, text) from public, anon, authenticated;
grant execute on function public.usar_cupon(text, text) to service_role;

comment on table public.incidencias_entrega is 'Ficha de cada contingencia de entrega (plan v1.2).';
comment on table public.cupones is 'Cupones escalonados: 10/20/30/45% con topes, solo producto, un solo uso.';
comment on table public.reembolsos is 'Reembolsos: el sistema registra y aprueba; el pago se hace a mano en Wompi.';
