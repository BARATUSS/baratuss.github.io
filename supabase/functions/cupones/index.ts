// ========================================================================
// cupones — validar y usar cupones (plan v1.2 · Etapa 3)
// 2026-09-18
//
// Acciones:
//   validar → ¿sirve este código? (lo usa el checkout para mostrar el descuento)
//   usar    → aplica el cupón al pedido REAL: recalcula el descuento desde los items
//             del pedido (solo producto, con tope), lo marca usado de forma atómica
//             y lo deja guardado en el pedido. Si el total del pedido no coincide con
//             lo esperado, avisa al negocio (posible manipulación desde el navegador).
//
// Reglas: solo producto (nunca envío), un solo uso, 30 días, no acumulable, con tope.
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const MOTIVOS: Record<string, string> = {
  no_existe: 'Ese código no existe',
  inactivo: 'Ese cupón ya no está activo',
  ya_usado: 'Ese cupón ya fue usado',
  vencido: 'Ese cupón ya venció',
  no_corresponde: 'Ese cupón es de otro cliente',
  pedido_no_existe: 'No encontramos el pedido',
};

async function avisarTelegram(texto: string) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: texto, parse_mode: 'Markdown' }),
    });
  } catch (_e) { /* silencio */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let b: any = {};
  try { b = await req.json(); } catch (_e) { /* sin body */ }
  const accion = String(b.accion || '');

  try {
    // ---------- VALIDAR ----------
    if (accion === 'validar') {
      const { data, error } = await supabase.rpc('validar_cupon', {
        p_codigo: String(b.codigo || ''),
        p_telefono: b.telefono ? String(b.telefono) : null,
        p_subtotal: Number(b.subtotal || 0) || null,
      });
      if (error) return json({ ok: false, error: error.message });
      const r = data as any;
      if (r && r.ok === false) r.mensaje = MOTIVOS[r.motivo] || 'Cupón no disponible';
      return json(r ?? { ok: false, error: 'sin_respuesta' });
    }

    // ---------- USAR ----------
    if (accion === 'usar') {
      const ref = String(b.reference || '');
      if (!ref) return json({ ok: false, error: 'falta_reference' });

      const { data, error } = await supabase.rpc('usar_cupon', {
        p_codigo: String(b.codigo || ''),
        p_reference: ref,
      });
      if (error) return json({ ok: false, error: error.message });
      const r = data as any;

      // Verificación de total: productos + envío − descuento debe dar el total del pedido
      if (r && r.ok) {
        const { data: ped } = await supabase.from('orders')
          .select('total, delivery_fee').eq('reference', ref).limit(1);
        const totalPedido = Number(ped?.[0]?.total || 0);
        const esperado = Number(r.subtotal_productos || 0) + Number(r.envio_sin_descuento || 0) - Number(r.descuento || 0);
        if (Math.abs(esperado - totalPedido) > 0.02) {
          await avisarTelegram(
            `⚠️ *CUPÓN: el total no cuadra*\n📦 ${ref}\n🎟️ ${r.codigo} (−$${r.descuento})\n`
            + `Esperado: $${esperado.toFixed(2)} · Guardado: $${totalPedido.toFixed(2)}\n`
            + `_Revisar el pedido antes de entregar._`);
        }
      }
      return json(r ?? { ok: false, error: 'sin_respuesta' });
    }

    return json({ ok: false, error: 'accion_desconocida', accion }, 400);
  } catch (e) {
    console.log('ERROR cupones:', String(e));
    return json({ ok: false, error: String(e).slice(0, 300) });
  }
});
