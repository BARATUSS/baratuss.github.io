-- ============================================================================
-- NIVEL B (Etapa 1) · arreglo: los cupones de CRÉDITO son monto fijo, no %
-- Los cupones de crédito (los que se dan al ajustar un pedido) guardan el monto
-- en 'valor'. El cálculo viejo los trataba como PORCENTAJE y descontaba mucho
-- menos de lo que correspondía (ej: crédito de $12 sobre una compra de $30 daba
-- $3.60 en vez de $12).
-- ============================================================================
create or replace function public.validar_cupon(
  p_codigo text,
  p_telefono text default null,
  p_subtotal numeric default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  v_desc numeric := 0;
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
    if lower(coalesce(c.tipo, '')) = 'credito' then
      -- CRÉDITO: monto fijo (nunca más que el subtotal)
      v_desc := round(least(coalesce(c.valor, 0), p_subtotal), 2);
    else
      -- PORCENTAJE con tope
      v_desc := round(least(p_subtotal * coalesce(c.valor, 0) / 100.0, coalesce(c.tope, 1e9)), 2);
    end if;
  end if;

  return json_build_object(
    'ok', true, 'codigo', c.codigo, 'valor', c.valor, 'tope', c.tope, 'tipo', c.tipo,
    'expira_en', c.expira_en, 'descuento', v_desc,
    'solo_producto', true, 'acumulable', c.acumulable
  );
end $$;

select 'listo' as resultado;
