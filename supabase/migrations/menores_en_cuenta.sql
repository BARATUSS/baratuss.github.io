-- ============================================================
-- BARATUSS — Menor de edad en la CUENTA (crear cuenta)
-- Fecha: 30-sep-2026
-- Al crear cuenta se pregunta ¿eres mayor? y, si es menor, se
-- guarda la autorización del responsable en el perfil.
-- 100% aditivo.
-- ============================================================

alter table public.profiles
  add column if not exists menor_de_edad boolean not null default false,
  add column if not exists menor_nombre text,
  add column if not exists menor_fecha_nac text,
  add column if not exists responsable_nombre text,
  add column if not exists responsable_relacion text,
  add column if not exists responsable_telefono text,
  add column if not exists responsable_correo text,
  add column if not exists autorizacion_estado text;
