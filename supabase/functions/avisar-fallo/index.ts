// ========================================================================
// avisar-fallo — pedidos que NO se pudieron guardar (nivel A · 2026-09-18)
//
// La tienda llama acá cuando el guardado del pedido falla. Esta función:
//   1) guarda el registro en pedidos_fallidos (solo service_role)
//   2) avisa al negocio por Telegram (para que Cindy se entere al instante)
//
// No manda credenciales al navegador: el token de Telegram vive acá.
// ========================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TG_TOKEN     = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const TG_CHAT      = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function recortar(v: unknown, n = 120): string {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const responder = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const b = await req.json().catch(() => ({} as Record<string, unknown>));

    const reference = recortar(b.reference, 60);
    const nombre    = recortar(b.nombre, 80) || 'sin nombre';
    const telefono  = recortar(b.telefono, 30);
    const total     = Number(b.total) || 0;
    const motivo    = recortar(b.motivo, 300);
    const items     = Array.isArray(b.items) ? b.items.slice(0, 20) : [];

    // 1) Registro en la base (queda el historial de pedidos que fallaron)
    const { error: errIns } = await supabase.from('pedidos_fallidos').insert({
      reference, customer_name: nombre, customer_phone: telefono,
      total, items, motivo,
    });
    if (errIns) console.log('no se pudo registrar el fallo:', errIns.message);

    // 2) Aviso por Telegram (con tope: máx. 5 avisos en 10 min, para no spamear)
    let avisado = false;
    if (TG_TOKEN && TG_CHAT) {
      const desde = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from('pedidos_fallidos')
        .select('id', { count: 'exact', head: true })
        .gte('creado_en', desde);
      if ((count ?? 0) <= 5) {
        const lista = items.map((i: any) => (i.qty || 1) + '× ' + recortar(i.name, 50)).join('\n');
        const texto =
          '⚠️ *PEDIDO NO REGISTRADO*\n\n' +
          '👤 ' + nombre + (telefono ? ' · ' + telefono : '') + '\n' +
          '💵 Total: $' + total.toFixed(2) + '\n\n' +
          '🛍️ ' + (lista || '(sin detalle)') + '\n\n' +
          '🔎 Motivo: ' + (motivo || 'desconocido') + '\n\n' +
          '✅ El stock ya se devolvió solo y el cliente recibió el aviso con botón de WhatsApp.';
        try {
          const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT, text: texto, parse_mode: 'Markdown' }),
          });
          avisado = r.ok;
        } catch (e) {
          console.log('no se pudo avisar por Telegram:', String(e));
        }
      }
    }

    return responder({ ok: true, registrado: !errIns, avisado });
  } catch (e) {
    // Nunca romper la experiencia del cliente: siempre 200
    console.log('error en avisar-fallo:', String(e));
    return responder({ ok: false, error: String(e).slice(0, 200) });
  }
});
