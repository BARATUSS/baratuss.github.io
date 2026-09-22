-- ============================================================================
-- NIVEL B · ETAPA 3 (21-sep-2026) — CERRAR LA PUERTA VIEJA
-- ----------------------------------------------------------------------------
-- Hasta acá, CUALQUIERA podía escribir un pedido directo en la base de datos
-- (la política "Pedido nuevo desde la tienda" lo permitía: with check = true).
-- Eso permitía mandar precios y totales inventados por fuera de la tienda.
--
-- Con la Etapa 2 en vivo, el único camino para crear un pedido es la función
-- del servidor `crear-pedido`, que usa la clave de servicio (no depende de RLS).
-- Por eso ahora se cierra este permiso.
--
-- ✅ REVERSIBLE EN 1 MINUTO: si algo fallara, se vuelve a abrir con
--      create policy "Pedido nuevo desde la tienda" on public.orders
--        for insert to anon, authenticated with check (true);
-- ============================================================================

drop policy if exists "Pedido nuevo desde la tienda" on public.orders;

-- Chequeo: ¿quedó cerrada? (no debe quedar ninguna política de INSERT para anon)
select policyname, cmd, roles::text
  from pg_policies
 where tablename = 'orders';
