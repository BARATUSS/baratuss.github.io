-- ============================================================================
-- BARATUSS · 24-sep-2026 · VERIFICACIÓN DE CLIENTES (correo + WhatsApp) · Etapa 1
-- ----------------------------------------------------------------------------
-- Decisiones de Cindy (23-sep-2026): verificar ANTES de pagar, a TODO cliente,
-- teléfono por WhatsApp, código hasheado, 10% de bienvenida solo 1ª compra.
-- Todo ADITIVO: no borra ni modifica nada de lo que ya funciona.
-- ============================================================================

-- 1) CÓDIGOS TEMPORALES (el "papelito" con el código; se puede borrar)
create table if not exists public.verif_codigos (
  id              uuid primary key default gen_random_uuid(),
  tipo            text not null check (tipo in ('correo','telefono')),
  dato            text not null,
  codigo_hash     text not null,
  canal           text not null default 'correo'
                  check (canal in ('correo','whatsapp_texto','whatsapp_plantilla')),
  intentos        smallint  not null default 0,
  max_intentos    smallint  not null default 3,
  envios          smallint  not null default 1,
  ultimo_envio_en timestamptz not null default now(),
  expira_en       timestamptz not null,
  ip_hash         text,
  order_reference text,
  verificado_en   timestamptz,
  consumido_en    timestamptz,
  creado_en       timestamptz not null default now()
);

create index if not exists ix_verif_codigos_dato
  on public.verif_codigos (tipo, dato, creado_en desc);
create index if not exists ix_verif_codigos_ip
  on public.verif_codigos (ip_hash, creado_en desc);
create index if not exists ix_verif_codigos_limpieza
  on public.verif_codigos (creado_en);

-- 2) DATOS VERIFICADOS (la memoria: "un dato verificado se queda verificado")
create table if not exists public.verif_datos (
  id              uuid primary key default gen_random_uuid(),
  tipo            text not null check (tipo in ('correo','telefono')),
  dato            text not null,
  cliente_id      uuid,
  order_reference text,
  canal           text,
  verificado_en   timestamptz not null default now(),
  revocado_en     timestamptz
);

-- 🔐 Un dato verificado = UN SOLO DUEÑO.
create unique index if not exists ux_verif_datos_dato
  on public.verif_datos (tipo, dato)
  where revocado_en is null;

-- 3) EL 10% DE BIENVENIDA (una sola vez por teléfono verificado)
create table if not exists public.bienvenidas (
  dato            text primary key,
  order_reference text,
  usado_en        timestamptz not null default now()
);

-- 4) CAMPOS NUEVOS EN profiles
alter table public.profiles
  add column if not exists correo_verificado_en    timestamptz,
  add column if not exists telefono_verificado     text,
  add column if not exists telefono_verificado_en  timestamptz,
  add column if not exists bienvenida_usada        boolean not null default false,
  add column if not exists bienvenida_usada_en     timestamptz;

-- 5) CAMPOS NUEVOS EN orders
alter table public.orders
  add column if not exists correo_verificado       boolean not null default false,
  add column if not exists telefono_verificado     boolean not null default false,
  add column if not exists correo_verificado_en    timestamptz,
  add column if not exists telefono_verificado_en  timestamptz,
  add column if not exists verificacion_estado     text not null default 'no_requiere'
      check (verificacion_estado in ('no_requiere','pendiente','verificado','atencion_manual')),
  add column if not exists descuento_bienvenida    numeric(10,2) not null default 0,
  add column if not exists bienvenida_aplicada     boolean not null default false,
  add column if not exists reserva_expira_en       timestamptz,
  add column if not exists ip_hash                 text;

-- 6) SEGURIDAD: solo el SERVIDOR (service_role) toca estas tablas.
alter table public.verif_codigos enable row level security;
alter table public.verif_datos   enable row level security;
alter table public.bienvenidas   enable row level security;

-- 7) INTERRUPTOR MAESTRO (apagado = la tienda funciona como hoy)
insert into public.config_operativa (clave, valor, notas)
values ('plan_verificacion_clientes', 'apagado',
        'Interruptor del sistema de verificación de clientes. apagado = como hoy (sin verificación).')
on conflict (clave) do nothing;
