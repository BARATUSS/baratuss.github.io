-- ========================================================================
-- vender_carrito — venta ATÓMICA de todo el carrito (Escenario 2, punto 1)
-- 2026-09-18
--
-- PROBLEMA QUE RESUELVE
-- Antes la venta se hacía producto por producto (en un bucle). Si el tercero
-- ya se había vendido, los dos primeros quedaban VENDIDOS (stock descontado)
-- aunque no existiera ningún pedido → productos desaparecidos del catálogo,
-- sin venta registrada y sin que nadie se enterara.
--
-- SOLUCIÓN
-- Todo-o-nada: primero se VALIDA cada producto (con bloqueo de fila) y recién
-- después se venden todos. Como todo corre dentro de una sola transacción, si
-- algo falla se deshace completo y el stock queda intacto.
--
-- SEGURIDAD: solo service_role la puede ejecutar (la llama la función
-- stock-api con la clave de servicio). El público NO tiene acceso.
-- ========================================================================

create or replace function public.vender_carrito(p_items jsonb, p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $function$
declare
  it      jsonb;
  v_id    bigint;
  v_qty   int;
  v_stock int;
  v_hasta timestamptz;
  v_tok   text;
  v_n     int := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return json_build_object('ok', false, 'motivo', 'faltan_datos');
  end if;

  -- 1) VALIDAR TODO PRIMERO (con bloqueo): si algo no está disponible, no se toca nada
  for it in select value from jsonb_array_elements(p_items) loop
    v_id  := coalesce((it->>'id')::bigint, 0);
    v_qty := greatest(coalesce((it->>'qty')::int, 1), 1);

    select stock, reservado_hasta, reservado_token
      into v_stock, v_hasta, v_tok
      from public.inventory
     where id = v_id
       for update;

    if not found then
      return json_build_object('ok', false, 'motivo', 'no_existe', 'producto', v_id);
    end if;
    if coalesce(v_stock, 0) < v_qty then
      return json_build_object('ok', false, 'motivo', 'sin_stock', 'producto', v_id);
    end if;
    if v_hasta is not null and v_hasta > now() and coalesce(v_tok, '') <> coalesce(p_token, '') then
      return json_build_object('ok', false, 'motivo', 'reservada_por_otro', 'producto', v_id);
    end if;
  end loop;

  -- 2) VENDER TODO (una sola transacción: si algo falla, se deshace completo)
  for it in select value from jsonb_array_elements(p_items) loop
    v_id  := coalesce((it->>'id')::bigint, 0);
    v_qty := greatest(coalesce((it->>'qty')::int, 1), 1);

    update public.inventory
       set stock = stock - v_qty,
           reservado_hasta = null,
           reservado_token = null
     where id = v_id;

    v_n := v_n + 1;
  end loop;

  return json_build_object('ok', true, 'vendidos', v_n);
end
$function$;

-- Solo la función (service_role) puede ejecutarla
revoke all on function public.vender_carrito(jsonb, text) from public;
revoke all on function public.vender_carrito(jsonb, text) from anon, authenticated;
grant execute on function public.vender_carrito(jsonb, text) to service_role;

comment on function public.vender_carrito(jsonb, text) is
  'Venta atómica (todo-o-nada) del carrito. Solo service_role. Escenario 2 punto 1, 2026-09-18.';
