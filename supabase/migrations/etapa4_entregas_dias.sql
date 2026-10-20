-- Etapa 4 (2026-10-20): PERSONA DE ENTREGA escalable + cancelar entregas.
-- Por cada DÍA de entrega (mié/sáb) donde Cindy tiene una actividad en su calendario,
-- se guarda si está ocupada y qué decidió (escalar a la siguiente persona / cancelar).
-- La escribe calendario_ventanas.py (ocupación), la consultan seguimiento-entregas y
-- whatsapp-webhook. RLS sin políticas = solo service key (el navegador no la lee).

create table if not exists public.entregas_dias (
  fecha date primary key,
  cindy_ocupada boolean not null default false,
  accion text,                 -- 'escalar' | 'cancelar' | null (todavía sin decidir)
  entregador text,             -- nombre de quien entrega cuando se escaló
  entregador_tel text,         -- teléfono normalizado 503XXXXXXXX
  notificado_en timestamptz,   -- anti-duplicado: ya se mandó el menú a Cindy
  decidido_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table public.entregas_dias enable row level security;
