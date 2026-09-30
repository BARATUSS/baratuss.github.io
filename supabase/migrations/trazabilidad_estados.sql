-- ============================================================
-- BARATUSS — Trazabilidad de estados del pedido
-- Fecha: 30-sep-2026
-- Fuente: documento "Baratuss_Flujo_Pagar_Ahora_Dudu.md" §14, §17
--
-- Registra CADA cambio de estado (status / payment_status) de un
-- pedido para poder reconstruir qué ocurrió sin depender de datos
-- manuales. NO mezcla "entregado" con "pagado": guarda ambos por
-- separado en cada renglón del historial.
--
-- Es 100% aditivo: no modifica ni borra nada de lo que ya funciona.
-- El trigger se encarga de loguear automáticamente; las funciones
-- existentes (crear-pedido, entregar_pedido, admin) NO se tocan.
-- ============================================================

create table if not exists public.pedido_estado_historial (
    id bigint generated always as identity primary key,
    order_reference text not null,
    status text,
    payment_status text,
    changed_at timestamptz not null default now()
);

create index if not exists idx_pedido_hist_ref
    on public.pedido_estado_historial (order_reference);

create or replace function public.log_pedido_estado()
returns trigger
language plpgsql
as $$
begin
    -- Loguea al crear el pedido y cada vez que cambia status o payment_status
    if (tg_op = 'INSERT')
       or (coalesce(new.status, '') is distinct from coalesce(old.status, ''))
       or (coalesce(new.payment_status, '') is distinct from coalesce(old.payment_status, '')) then
        insert into public.pedido_estado_historial (order_reference, status, payment_status)
        values (new.reference, new.status, new.payment_status);
    end if;
    return new;
end;
$$;

drop trigger if exists trg_pedido_estado on public.orders;
create trigger trg_pedido_estado
after insert or update on public.orders
for each row execute function public.log_pedido_estado();
