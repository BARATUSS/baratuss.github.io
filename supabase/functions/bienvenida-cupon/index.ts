// ============================================================================
// BARATUSS · bienvenida-cupon · 30-sep-2026
// Genera el cupón de 10% de bienvenida de una cuenta nueva verificada y lo
// manda por WhatsApp. Un solo cupón por teléfono (tabla bienvenidas).
// ============================================================================
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabase, normalizarTel, generarTokenCorto, enviarTexto, bienvenidaYaUsada } from '../_shared/verificacion.ts';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const PORCENTAJE = 10;   // 10% de bienvenida
const TOPE = 5;          // tope $5
const DIAS_VALIDEZ = 30; // 30 días

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const tel = normalizarTel(String(b?.telefono || ''));
    if (tel.length !== 11) return json({ ok: false, motivo: 'telefono_invalido' }, 400);
    const nombre = String(b?.nombre || '').trim();

    // Un solo cupón de bienvenida por teléfono.
    if (await bienvenidaYaUsada(tel)) return json({ ok: true, ya_usado: true });

    const codigo = 'BIEN' + generarTokenCorto(6);
    const expira = new Date(Date.now() + DIAS_VALIDEZ * 86400000).toISOString();

    const { error: errCup } = await supabase.from('cupones').insert({
      codigo, valor: PORCENTAJE, tope: TOPE, cliente_telefono: tel,
      expira_en: expira, activo: true, acumulable: false, un_solo_uso: true,
      origen: 'bienvenida',
    });
    if (errCup) return json({ ok: false, motivo: 'error_cupon', detalle: errCup.message }, 500);

    await supabase.from('bienvenidas').insert({ dato: tel });

    const texto = '🎉 ¡Bienvenida a BARATUSS' + (nombre ? ', ' + nombre : '') + '! 💖\n\n'
      + 'Tu cupón de *10% de descuento* es:\n*' + codigo + '*\n\n'
      + 'Usalo en tu primera compra escribiéndolo al finalizar.\n'
      + '⏰ Vale ' + DIAS_VALIDEZ + ' días · tope $' + TOPE + ' · un solo uso.';
    const env = await enviarTexto(tel, texto, 'BIENVENIDA');

    return json({ ok: true, codigo, wa: env });
  } catch (e) {
    console.log('ERROR bienvenida-cupon', String(e));
    return json({ ok: false, motivo: 'error', detalle: String(e).slice(0, 200) }, 500);
  }
});
