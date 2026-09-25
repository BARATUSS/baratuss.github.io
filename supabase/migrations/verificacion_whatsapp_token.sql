-- ============================================================================
-- BARATUSS · 25-sep-2026 · Verificación de WhatsApp SIN código (token)
-- ----------------------------------------------------------------------------
-- El flujo nuevo ("escribinos primero") ya no manda un código de 6 dígitos por
-- WhatsApp: la clienta manda "Hola BARATUSS 💛 Confirmar {TOKEN}" desde SU número
-- y el webhook la marca verificada. Ese token se guarda (hasheado) en verif_codigos
-- con canal 'whatsapp_token', así que ampliamos el CHECK de la columna canal.
-- Aditivo: no borra ni modifica nada de lo que ya funciona.
-- ============================================================================
alter table public.verif_codigos
  drop constraint if exists verif_codigos_canal_check;

alter table public.verif_codigos
  add constraint verif_codigos_canal_check
  check (canal in ('correo','whatsapp_texto','whatsapp_plantilla','whatsapp_token'));
