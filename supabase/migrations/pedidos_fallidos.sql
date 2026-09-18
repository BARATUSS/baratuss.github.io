-- ========================================================================
-- pedidos_fallidos — registra los pedidos que NO se pudieron guardar
-- (nivel A del arreglo del Escenario 1, 2026-09-18)
--
-- Contexto: si al confirmar la compra el guardado del pedido falla, el cliente
-- NO debe ver un ticket falso. La tienda: (1) devuelve el stock, (2) guarda un
-- respaldo en el navegador, (3) avisa acá y (4) le muestra un mensaje claro
-- con botón de WhatsApp.
--
-- Seguridad: RLS activo y SIN permisos para anon/authenticated → solo las
-- funciones (service_role) pueden leer o escribir. El público no ve nada.
-- ========================================================================

create table if not exists public.pedidos_fallidos (
  id             bigserial primary key,
  creado_en      timestamptz not null default now(),
  reference      text,
  customer_name  text,
  customer_phone text,
  total          numeric(10,2),
  items          jsonb,
  motivo         text,
  resuelto       boolean not null default false,
  notas          text
);

alter table public.pedidos_fallidos enable row level security;

revoke all on public.pedidos_fallidos from anon, authenticated;
revoke all on sequence public.pedidos_fallidos_id_seq from anon, authenticated;
grant all on public.pedidos_fallidos to service_role;
grant all on sequence public.pedidos_fallidos_id_seq to service_role;

create index if not exists pedidos_fallidos_creado_idx on public.pedidos_fallidos (creado_en desc);

comment on table public.pedidos_fallidos is
  'Pedidos que la tienda no pudo guardar (nivel A, 2026-09-18). Solo service_role.';
