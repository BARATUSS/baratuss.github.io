-- Registro detallado de interacciones del menú de Dudu (clicks de clientes en WhatsApp).
-- Sustituye a los avisos de Telegram: cada click queda guardado acá para revisar sin ruido.
create table if not exists dudu_menu_log (
  id bigserial primary key,
  telefono text not null,
  texto text,
  intent text,
  respuesta text,
  tipo_respuesta text,
  created_at timestamptz not null default now()
);
