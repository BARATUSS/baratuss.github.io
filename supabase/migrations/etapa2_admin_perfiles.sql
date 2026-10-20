-- ========================================================================
-- BARATUSS — Etapa 2 · Acceso admin a los perfiles (buscar por DUI + editar)
-- Fecha: 2026-10-20 · Autorizado por Cindy ("me parece tu propuesta")
--
-- Problema: `profiles` solo tenía RLS "cada quien ve/edita lo suyo"
-- (auth.uid() = id). El panel admin no podía leer ni editar a OTRAS
-- clientas → imposible la Asistencia (buscar por DUI y corregir datos).
--
-- Solución (100% aditivo, no toca datos):
--   1) Función `is_admin()` SECURITY DEFINER (lee profiles SIN RLS) →
--      evita la recursión infinita de RLS.
--   2) Dos políticas nuevas en `profiles`: los admins leen y editan
--      cualquier perfil (buscar por DUI + corregir teléfono/correo).
-- ========================================================================

-- ---------- 1) Función segura "es admin" (sin recursión) ----------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_admin = true);
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------- 2) Los admins leen cualquier perfil ----------
drop policy if exists "Perfil: admin lee" on public.profiles;
create policy "Perfil: admin lee" on public.profiles
  for select to authenticated
  using (public.is_admin());

-- ---------- 3) Los admins editan cualquier perfil ----------
drop policy if exists "Perfil: admin edita" on public.profiles;
create policy "Perfil: admin edita" on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
