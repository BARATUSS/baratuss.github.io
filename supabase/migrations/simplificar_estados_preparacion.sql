-- Simplificar el flujo logístico (Cindy, 2026-10-24):
-- Antes: ⏳ Pendiente → 🔨 En preparación → ✅ Listo → 🚚 Salió → ✅ Entregado
-- Ahora: ⏳ Pendiente → ✅ Listo → 🚚 Salió → ✅ Entregado
-- ("marcar preparado" ya se entiende como "listo", el paso intermedio sobraba).
--
-- Migrar los despachos que estén en el estado viejo "en-preparacion" a "listo".
update public.despachos
   set estado_logistico = 'listo',
       updated_at = now()
 where estado_logistico = 'en-preparacion';
