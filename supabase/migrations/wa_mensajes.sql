-- Tabla de mensajes WhatsApp (Cloud API) — BARATUSS
-- Todos los mensajes entrantes/salientes quedan registrados acá.
create table if not exists public.wa_mensajes (
  id                bigserial primary key,
  wa_message_id     text unique,                  -- id de Meta: evita duplicados si Meta reintenta
  telefono          text not null,                -- número del cliente (formato internacional sin +)
  nombre_perfil     text,                         -- nombre de perfil de WhatsApp
  texto             text,
  tipo              text default 'text',          -- text | button | interactive | image | audio ...
  direccion         text not null default 'entrante',  -- entrante | saliente
  phone_number_id   text,                         -- número del negocio que recibió
  display_phone_number text,
  order_reference   text,                         -- pedido asociado (si se detecta)
  despacho_id       bigint,                       -- despacho asociado (si se detecta)
  leido             boolean not null default false,
  atendido_por      text,                         -- 'humano' | 'agente' | null
  respuesta         text,
  respondido_en     timestamptz,
  wa_timestamp      timestamptz,                  -- hora que reporta Meta
  creado_en         timestamptz not null default now()
);

create index if not exists wa_mensajes_telefono_idx on public.wa_mensajes (telefono, creado_en desc);
create index if not exists wa_mensajes_no_leidos_idx on public.wa_mensajes (leido) where leido = false;
create index if not exists wa_mensajes_pedido_idx on public.wa_mensajes (order_reference);

-- Seguridad: solo administradores autenticados (mismo patrón que inventory)
alter table public.wa_mensajes enable row level security;

drop policy if exists "Admin gestiona wa_mensajes" on public.wa_mensajes;
create policy "Admin gestiona wa_mensajes" on public.wa_mensajes
  for all to authenticated
  using (exists (select 1 from public.profiles
                 where profiles.id = auth.uid() and profiles.is_admin = true))
  with check (exists (select 1 from public.profiles
                      where profiles.id = auth.uid() and profiles.is_admin = true));

comment on table public.wa_mensajes is 'Mensajes de WhatsApp (Cloud API) de BARATUSS: consultas de clientes, confirmaciones de entrega y respuestas.';
