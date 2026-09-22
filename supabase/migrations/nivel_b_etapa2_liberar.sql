-- ============================================================================
-- NIVEL B · Etapa 2: soltar la reserva propia (cuando la clienta quita del carrito)
-- Solo libera si el token de la reserva es el de quien la pide (nadie suelta la ajena).
-- ============================================================================
create or replace function public.liberar_mi_reserva(p_id bigint, p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_n int := 0;
begin
  if p_id is null or coalesce(p_token, '') = '' then
    return json_build_object('ok', false, 'motivo', 'faltan_datos');
  end if;
  update public.inventory
     set reservado_hasta = null, reservado_token = null
   where id = p_id
     and reservado_token = p_token;
  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'liberadas', v_n);
end $$;

grant execute on function public.liberar_mi_reserva(bigint, text) to anon, authenticated;
select 'listo' as resultado;
