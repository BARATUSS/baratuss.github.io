-- ========================================================================
-- BARATUSS — Etapa 1 · Tablas base del ERP (4 nuevas)
-- Fecha: 2026-10-20 · Autorizado por Cindy ("1" → paso 1)
--
-- Crea (100% ADITIVO: no modifica ni borra nada de lo que ya funciona):
--   · proveedores          → MXM, Más Bella… con contacto y términos
--   · inventory_movements  → historial de stock (compra/venta/devolución/merma)
--   · order_items          → items del pedido (variante + cantidad + precio)
--   · pagos                → el pago como entidad (método, monto, estado, Wompi)
--
-- Convención (igual que el resto del sistema):
--   · bigint identity PK · timestamptz default now() · numeric(10,2)
--   · clave de pedido = order_reference (text), igual que ventas/despachos/etc.
--   · RLS habilitada, política "solo admin" (service_role la saltea)
-- ========================================================================

-- ============ 1) PROVEEDORES ============
create table if not exists public.proveedores (
  id         bigint generated always as identity primary key,
  nombre     text not null,
  contacto   text,
  telefono   text,
  email      text,
  instagram  text,
  terminos   text,
  notas      text,
  creado_en  timestamptz not null default now()
);
create index if not exists proveedores_nombre_idx on public.proveedores (nombre);

-- ============ 2) MOVIMIENTOS DE INVENTARIO ============
create table if not exists public.inventory_movements (
  id              bigint generated always as identity primary key,
  inventory_id    integer not null references public.inventory(id),
  tipo            text not null,                -- compra | venta | devolucion | merma | ajuste
  cantidad        integer not null,             -- con signo: + entra (compra/devolución), − sale (venta/merma)
  order_reference text,                         -- pedido que originó la venta/devolución
  proveedor_id    bigint references public.proveedores(id),  -- para compra
  costo_unitario  numeric(10,2),                -- costo en compra (o valor en merma)
  motivo          text,
  creado_en       timestamptz not null default now(),
  creado_por      text default 'sistema'
);
create index if not exists inv_mov_inv_idx  on public.inventory_movements (inventory_id, creado_en desc);
create index if not exists inv_mov_ref_idx  on public.inventory_movements (order_reference);
create index if not exists inv_mov_prov_idx on public.inventory_movements (proveedor_id);

-- ============ 3) ITEMS DEL PEDIDO ============
create table if not exists public.order_items (
  id              bigint generated always as identity primary key,
  order_reference text not null,
  inventory_id    integer references public.inventory(id),
  nombre          text,                          -- nombre al momento de comprar (foto del dato)
  cantidad        integer not null default 1,
  precio_unitario numeric(10,2) not null default 0,
  descuento       numeric(10,2) not null default 0,
  creado_en       timestamptz not null default now()
);
create index if not exists order_items_ref_idx on public.order_items (order_reference);
create index if not exists order_items_inv_idx on public.order_items (inventory_id);

-- ============ 4) PAGOS ============
create table if not exists public.pagos (
  id              bigint generated always as identity primary key,
  order_reference text not null,
  metodo          text not null default 'tarjeta',  -- tarjeta | efectivo | transferencia
  monto           numeric(10,2) not null default 0,
  estado          text not null default 'pendiente', -- pendiente | pagado | fallido | expirado | reembolsado | disputado
  wompi_id        text,                             -- id de transacción Wompi (tarjeta)
  wompi_estado    text,                             -- APPROVED | DECLINED | PENDING | ...
  referencia      text,                             -- referencia externa (transferencia)
  comprobante_url text,                             -- comprobante (efectivo/transferencia)
  pagado_en       timestamptz,
  creado_en       timestamptz not null default now()
);
create index if not exists pagos_ref_idx    on public.pagos (order_reference);
create index if not exists pagos_estado_idx on public.pagos (estado);

-- ============ 5) RLS: solo admin (service_role la saltea) ============
do $do$
declare t text;
begin
  foreach t in array array['proveedores', 'inventory_movements', 'order_items', 'pagos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: admin" on public.%I', t, t);
    execute format(
      'create policy "%s: admin" on public.%I for all to authenticated using '
      '(exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)) with check '
      '(exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true))', t, t);
  end loop;
end
$do$;

-- ============ 6) Comentarios ============
comment on table public.proveedores         is 'Proveedores (MXM, Más Bella…): contacto y términos.';
comment on table public.inventory_movements is 'Historial de stock: compra/venta/devolución/merma. cantidad con signo (+ entra, − sale).';
comment on table public.order_items         is 'Items del pedido (una fila por variante + cantidad + precio).';
comment on table public.pagos               is 'Pago de un pedido: método, monto, estado y datos de Wompi.';
