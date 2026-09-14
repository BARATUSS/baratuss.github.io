import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * wa-enviar — envía mensajes de WhatsApp por el canal oficial (Cloud API) y los registra.
 *
 * Seguridad:
 *  - Solo administradores autenticados (se valida el JWT del panel + profiles.is_admin).
 *  - El token de Meta NUNCA toca el navegador: vive como secreto de la función.
 *  - Solo permite texto libre (dentro de la ventana de 24 h del cliente).
 *
 * Secretos requeridos: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 */

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

const WA_TOKEN = Deno.env.get('WHATSAPP_TOKEN') || '';
const PHONE_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';
const GRAPH = 'https://graph.facebook.com/v21.0';

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'metodo no permitido' }, 405);

  // ===== 1) Autorización: solo administradores =====
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: 'sin sesion' }, 401);

  const { data: userData, error: errAuth } = await supabase.auth.getUser(jwt);
  if (errAuth || !userData?.user) return json({ ok: false, error: 'sesion invalida' }, 401);

  const { data: perfil } = await supabase
    .from('profiles').select('is_admin, name').eq('id', userData.user.id).maybeSingle();
  if (!perfil?.is_admin) return json({ ok: false, error: 'no autorizado' }, 403);

  // ===== 2) Datos del mensaje =====
  let payload: any = {};
  try { payload = await req.json(); } catch { /* body inválido */ }

  const to = String(payload.to || '').replace(/\D/g, '');
  const texto = String(payload.texto || '').trim();

  if (!/^\d{8,15}$/.test(to)) return json({ ok: false, error: 'numero invalido' }, 400);
  if (!texto) return json({ ok: false, error: 'texto vacio' }, 400);
  if (texto.length > 4000) return json({ ok: false, error: 'texto demasiado largo' }, 400);
  if (!WA_TOKEN || !PHONE_ID) return json({ ok: false, error: 'faltan secretos de WhatsApp' }, 500);

  // ===== 3) Envío por la API de Meta =====
  const resp = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: texto, preview_url: true }
    })
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return json({ ok: false, error: data?.error?.message || `error de Meta (HTTP ${resp.status})`, detalle: data?.error || null });
  }

  const waId = data?.messages?.[0]?.id || null;

  // ===== 4) Registro en la bitácora =====
  await supabase.from('wa_mensajes').insert({
    wa_message_id: waId,
    telefono: to,
    texto,
    tipo: 'text',
    direccion: 'saliente',
    phone_number_id: PHONE_ID,
    leido: true,
    atendido_por: payload.atendido_por || 'humano',
    respondido_en: new Date().toISOString()
  });

  // Los mensajes entrantes de esa conversación quedan marcados como leídos
  await supabase.from('wa_mensajes')
    .update({ leido: true })
    .eq('telefono', to)
    .eq('direccion', 'entrante');

  return json({ ok: true, id: waId, enviado_por: perfil.name || userData.user.email });
});
