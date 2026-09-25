// ============================================================================
// BARATUSS · iniciar-verificacion-wa · 25-sep-2026
// Inicia la verificación de WhatsApp SIN código (flujo "escribinos primero"):
// genera un token corto único, guarda SOLO su hash (ligado al teléfono) y
// devuelve el enlace wa.me preescrito. La clienta manda ese mensaje desde SU
// WhatsApp → el webhook (whatsapp-webhook) detecta el token y la marca verificada.
// ============================================================================
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabase, normalizarTel, generarTokenCorto, hashCodigo, hashIP } from '../_shared/verificacion.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MINUTOS_VALIDEZ = 10;
const SEGUNDOS_COOLDOWN = 30;
const TOPE_INTENTOS_HORA_TEL = 3;
const TOPE_INTENTOS_HORA_IP = 10;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const tel = normalizarTel(String(b.telefono || ''));
    if (!tel || tel.length !== 11) return json({ ok: false, motivo: 'telefono_invalido' }, 400);

    const ip = String(b.ip || req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('cf-connecting-ip') || '').trim();

    // 1) ¿Ya está verificado? → no se genera nada.
    const { data: yaVerificado } = await supabase.from('verif_datos')
      .select('id').eq('tipo', 'telefono').eq('dato', tel).is('revocado_en', null).maybeSingle();
    if (yaVerificado) return json({ ok: true, motivo: 'ya_verificado', ya_verificado: true });

    const ahora = Date.now();

    // 2) Cooldown 30 s entre pedidos (mismo teléfono)
    const { data: ultimo } = await supabase.from('verif_codigos')
      .select('ultimo_envio_en').eq('tipo', 'telefono').eq('dato', tel)
      .order('creado_en', { ascending: false }).limit(1).maybeSingle();
    if (ultimo?.ultimo_envio_en) {
      const diff = Math.floor((ahora - new Date(ultimo.ultimo_envio_en).getTime()) / 1000);
      if (diff < SEGUNDOS_COOLDOWN) {
        return json({ ok: false, motivo: 'cooldown', segundos_reenvio: SEGUNDOS_COOLDOWN - diff });
      }
    }

    // 3) 3 pedidos/hora por teléfono
    const { count: intentosTel } = await supabase.from('verif_codigos')
      .select('id', { count: 'exact', head: true }).eq('tipo', 'telefono').eq('dato', tel)
      .gte('creado_en', new Date(ahora - 3600000).toISOString());
    if ((intentosTel || 0) >= TOPE_INTENTOS_HORA_TEL) return json({ ok: false, motivo: 'limite_envios' });

    // 4) 10 pedidos/hora por IP
    const ipHash = ip ? await hashIP(ip) : '';
    if (ipHash) {
      const { count: intentosIP } = await supabase.from('verif_codigos')
        .select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash)
        .gte('creado_en', new Date(ahora - 3600000).toISOString());
      if ((intentosIP || 0) >= TOPE_INTENTOS_HORA_IP) return json({ ok: false, motivo: 'limite_ip' });
    }

    // 5) Generar el token corto y guardar SOLO el hash (hash = sha256(token:tel:PEPPER))
    const token = generarTokenCorto(6);
    const hash = await hashCodigo(token, tel);
    const expiraEn = new Date(ahora + MINUTOS_VALIDEZ * 60000).toISOString();

    const { error: errIns } = await supabase.from('verif_codigos').insert({
      tipo: 'telefono', dato: tel, codigo_hash: hash, canal: 'whatsapp_token',
      intentos: 0, max_intentos: 3, envios: 1,
      ultimo_envio_en: new Date().toISOString(), expira_en: expiraEn,
      ip_hash: ipHash || null, order_reference: null,
    });
    if (errIns) return json({ ok: false, motivo: 'error_db' }, 500);

    const wa_link = 'https://wa.me/50362852631?text=' + encodeURIComponent('Hola BARATUSS 💛 Confirmar ' + token);

    return json({
      ok: true, token, wa_link, expira_en: expiraEn,
      segundos_reenvio: SEGUNDOS_COOLDOWN,
    });
  } catch (e) {
    console.log('ERROR iniciar-verificacion-wa', String(e));
    return json({ ok: false, motivo: 'error', detalle: String(e).slice(0, 200) }, 500);
  }
});
