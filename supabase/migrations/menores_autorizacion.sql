-- ============================================================
-- BARATUSS — Compra de menores de edad (autorización del responsable)
-- Fecha: 30-sep-2026
-- Fuente: documento "Baratuss_Flujo_Pagar_Ahora_Dudu.md" §4, §7 (F-2 / F-1-2)
--
-- Campos nuevos en `orders` para registrar la autorización del
-- responsable legal cuando la clienta es menor de edad. Es 100%
-- aditivo: no modifica ni borra nada de lo que ya funciona.
-- ============================================================

alter table public.orders
  add column if not exists menor_de_edad boolean not null default false,
  add column if not exists menor_nombre text,
  add column if not exists menor_fecha_nac text,
  add column if not exists responsable_nombre text,
  add column if not exists responsable_relacion text,
  add column if not exists responsable_telefono text,
  add column if not exists responsable_correo text,
  add column if not exists autorizacion_estado text;
