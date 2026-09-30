-- ============================================================================
-- BARATUSS · cupones_usuario_y_premio_referido · 30-sep-2026
-- 1) Asocia los cupones a la CUENTA (user_id) y no solo al teléfono/correo.
-- 2) (El premio de referido — 10% para quien recomendó — se otorga desde las
--    edge functions crear-pedido / wompi-checkout, que escriben el cupón con
--    origen='referido' y marcan orders.referido_premiado=true.)
-- ============================================================================
alter table public.cupones add column if not exists user_id uuid references public.profiles(id) on delete set null;
create index if not exists cupones_user_idx on public.cupones (user_id);
