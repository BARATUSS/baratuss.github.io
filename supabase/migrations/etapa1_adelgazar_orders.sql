-- ========================================================================
-- BARATUSS — Etapa 1 paso 2 · Adelgazar orders
-- Fecha: 2026-10-20 · Preparado para Cindy (NO ejecutado aún)
--
-- PARTE A (aditiva — NO borra nada de `orders`):
--   1) order_items.variante  (columna nueva: talla/tono del item)
--   2) order_items <- orders.items (jsonb)
--   3) pagos        <- orders.payment_*
--
-- PARTE B (borrar columnas de `orders`) NO va aquí: se ejecuta DESPUÉS,
--   cuando el checkout y el panel lean las tablas nuevas (Etapas 2 y 3),
--   para no romper lo que ya funciona. Ver detalle en el plan §5.2.
-- ========================================================================

-- ---------- 1) columna variante (talla/tono) ----------
alter table public.order_items add column if not exists variante text;

-- ---------- 2) items del pedido -> order_items ----------
insert into public.order_items
  (order_reference, inventory_id, nombre, variante, cantidad, precio_unitario, descuento)
select
  o.reference,
  (it->>'id')::int,
  it->>'name',
  coalesce(it->>'size', it->>'tono', it->>'color'),
  coalesce((it->>'qty')::int, 1),
  coalesce((it->>'price')::numeric, 0),
  coalesce((it->>'descuento')::numeric, 0)
from public.orders o
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(o.items::jsonb) = 'array' then o.items::jsonb else '[]'::jsonb end
) it
where o.items is not null
  and not exists (select 1 from public.order_items oi where oi.order_reference = o.reference);

-- ---------- 3) pago -> pagos ----------
insert into public.pagos
  (order_reference, metodo, monto, estado, wompi_id, pagado_en)
select
  reference,
  case
    when payment_method in ('tarjeta', 'wompi') then 'tarjeta'
    when payment_method = 'transferencia' then 'transferencia'
    else 'efectivo'
  end,
  coalesce(total, 0),
  case
    when payment_status = 'pagado' then 'pagado'
    when payment_status = 'fallido' then 'fallido'
    when payment_status = 'reembolsado' then 'reembolsado'
    when payment_status = 'disputado' then 'disputado'
    else 'pendiente'
  end,
  transaction_id,
  payment_date
from public.orders o
where (o.payment_method is not null
   or o.payment_status is not null
   or o.transaction_id is not null)
  and not exists (select 1 from public.pagos p where p.order_reference = o.reference);

-- ========================================================================
-- PARTE B (referencia — NO ejecutar hasta que el código lea las tablas nuevas)
--   drop column en `orders`: items, payment_status, transaction_id,
--   payment_method, payment_date, pago_expira_en            -> order_items / pagos
--   factura_tipo, factura_numero, factura_nombre, factura_nit, factura_nrc,
--   factura_giro, factura_direccion, factura_por_correo, factura_por_whatsapp,
--   factura_enviada_en                                       -> fac_facturas / fac_clientes (tras NRC)
--   correo_verificado, telefono_verificado, correo_verificado_en,
--   telefono_verificado_en, verificacion_estado              -> verif_datos
--   menor_de_edad, menor_nombre, menor_fecha_nac, menor_telefono,
--   responsable_nombre, responsable_relacion, responsable_telefono,
--   responsable_correo, autorizacion_estado, dui             -> profiles
--   referido_por_codigo, referido_descuento, referido_premiado -> cupones / profiles
--   descuento_bienvenida, bienvenida_aplicada                -> cupones
-- ========================================================================
