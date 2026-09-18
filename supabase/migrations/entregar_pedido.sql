-- ============================================================
-- BARATUSS — Entregar un pedido completo desde el panel de PEDIDOS
-- Marca todos los despachos del pedido como entregados y registra la venta.
-- Así "marcar pagado/entregado" desde Pedidos SÍ queda en finanzas
-- (antes ese botón no registraba nada).
-- Fecha: 2026-09-18
-- ============================================================

create or replace function public.entregar_pedido(p_ref text)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_marcados int := 0;
  v_res      json;
begin
  if p_ref is null or p_ref = '' then
    return json_build_object('ok', false, 'motivo', 'sin_referencia');
  end if;

  if not exists (select 1 from public.orders where reference = p_ref) then
    return json_build_object('ok', false, 'motivo', 'pedido_no_existe');
  end if;

  -- 1) Todos los productos del pedido quedan entregados
  update public.despachos
     set estado_logistico = 'entregado',
         updated_at = now()
   where order_reference = p_ref
     and coalesce(estado_logistico, '') <> 'entregado';
  get diagnostics v_marcados = row_count;

  -- 2) El pedido queda pagado (el efectivo se cobra al entregar)
  update public.orders
     set payment_status = case when coalesce(payment_status, '') in ('efectivo', 'pendiente')
                               then 'pagado' else payment_status end,
         payment_date   = coalesce(payment_date, now()),
         updated_at     = now()
   where reference = p_ref;

  -- 3) Registro de la venta (IVA, costo real, comisión, utilidad)
  v_res := public.registrar_venta_entrega(p_ref);

  return json_build_object('ok', true, 'despachos_entregados', v_marcados, 'venta', v_res);
end $function$;
