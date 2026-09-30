-- ============================================================================
-- BARATUSS · usuario_codigo_amiga · 30-sep-2026
-- El "nombre de usuario" que la clienta elige al crear su cuenta es su CÓDIGO
-- DE AMIGA (profiles.codigo_referido). Lo dejamos ÚNICO (permitiendo nulls para
-- las cuentas viejas que no tienen código) para que dos clientas no compartan
-- el mismo código de referido.
-- ============================================================================
create unique index if not exists profiles_codigo_referido_key
  on public.profiles (codigo_referido)
  where codigo_referido is not null;
