-- ============================================================
-- BARATUSS — DUI obligatorio (crear cuenta + invitado)
-- Fecha: 30-sep-2026
-- El DUI se usa para verificar la identidad al ENTREGAR.
-- Se guarda en la cuenta (profiles) y en cada pedido (orders).
-- 100% aditivo: no modifica ni borra nada existente.
-- ============================================================

alter table public.orders   add column if not exists dui text;
alter table public.profiles add column if not exists dui text;
