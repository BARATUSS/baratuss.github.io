-- 👧 MENOR DE EDAD (30-sep-2026): teléfono de la menor en el pedido COMO INVITADO.
-- Antes solo se guardaba el teléfono del responsable; ahora también el de la menor
-- (para verificarlo por WhatsApp, igual que en el flujo de crear cuenta).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS menor_telefono text;
