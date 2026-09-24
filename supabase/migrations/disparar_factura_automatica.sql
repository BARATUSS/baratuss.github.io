-- ============================================================================
-- BARATUSS · 24-sep-2026 · Factura 100% AUTOMÁTICA por GATILLO de base de datos
-- ----------------------------------------------------------------------------
-- Regla de Cindy (LEY): 💳 tarjeta → la factura sale cuando el pago YA CAYÓ
-- (payment_status = pagado/aprobado) · 💵 efectivo → SOLO cuando el pedido se
-- marca ENTREGADO. NUNCA antes.
--
-- El trigger llama a la Edge Function `enviar-factura`, que REVALIDA la regla y
-- evita el doble envío con el campo `factura_enviada_en`. Solo dispara en la
-- TRANSICIÓN real (no en actualizaciones sin cambio de estado), así no hace
-- ruido ni llama de más.
--
-- 🔐 La clave de autorización (x-baratuss-key) NO va en este archivo: se lee de
-- `config_operativa` (clave `factura_trigger_key`), que se carga en el momento
-- de desplegar con el mismo valor de FACTURA_KEY (fuera del repo).
-- ============================================================================

create or replace function public.disparar_factura_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := 'https://lizybztwnlrlvsrmgnug.functions.supabase.co/enviar-factura';
  v_key text;
begin
  if new.factura_por_correo is true
     and new.factura_enviada_en is null
     and coalesce(new.factura_tipo, 'ninguna') <> 'ninguna'
     and new.customer_email is not null
     and (
        -- 💵 efectivo: el pedido pasa a ENTREGADO
        (new.status = 'entregado' and old.status is distinct from new.status)
        -- 💳 tarjeta: el pago cae (el webhook de Wompi graba 'aprobado')
        or (new.payment_method = 'tarjeta'
            and new.payment_status in ('pagado', 'aprobado')
            and old.payment_status is distinct from new.payment_status)
     ) then
     select valor into v_key from public.config_operativa where clave = 'factura_trigger_key';
     if v_key is not null and v_key <> '' then
       perform net.http_post(
         url := v_url,
         body := jsonb_build_object('referencia', coalesce(new.reference, '')),
         headers := jsonb_build_object('Content-Type', 'application/json', 'x-baratuss-key', v_key),
         timeout_milliseconds := 30000
       );
     end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_disparar_factura on public.orders;
create trigger trg_disparar_factura
after update on public.orders
for each row execute function public.disparar_factura_trigger();
