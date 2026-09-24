// ============================================================================
// BARATUSS · enviar-codigo-wa · 24-sep-2026
// Envía por WhatsApp el código de verificación de 6 dígitos (teléfono).
// · Ventana de 24 h abierta → texto libre ($0) · cerrada → plantilla aprobada
//   `codigo_verificacion_baratuss_v1` (~$0.0113) · sin WhatsApp → `sin_whatsapp`.
// · Código guardado SOLO como hash (SHA-256 con pepita). 10 min de vida, 3 intentos.
// · Anti-abuso: cooldown 30 s · 3 envíos/hora por teléfono · 10/hora por IP.
// ============================================================================
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  supabase, normalizarTel, generarCodigo6, hashCodigo, hashIP,
  ventanaAbierta, enviarTexto, enviarPlantilla, registrarSaliente,
} from '../_shared/verificacion.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const PLANTILLA_CODIGO = 'codigo_verificacion_baratuss_v1';
const MINUTOS_VALIDEZ = 10;
const SEGUNDOS_COOLDOWN = 30;
const TOPE_ENVIOS_HORA_TEL = 3;
const TOPE_ENVIOS_HORA_IP = 10;
const TOPE_PLANTILLAS_MES = 175;   // ~$2/mes (tope de control autorizado por Cindy)

function codigoFormateado(codigo: string): string {
  return codigo.split('').join(' ');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const tel = normalizarTel(String(b.telefono || ''));
    if (!tel || tel.length !== 11) return json({ ok: false, motivo: 'telefono_invalido' }, 400);

    const nombre = String(b.nombre || '').trim();
    const ref = String(b.order_reference || '');
    const ip = String(b.ip || req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('cf-connecting-ip') || '').trim();

    // 1) ¿Ya está verificado? → no se manda nada.
    const { data: yaVerificado } = await supabase.from('verif_datos')
      .select('id').eq('tipo', 'telefono').eq('dato', tel).is('revocado_en', null).maybeSingle();
    if (yaVerificado) return json({ ok: true, motivo: 'ya_verificado', ya_verificado: true });

    const ahora = Date.now();

    // 2) Cooldown 30 s entre envíos (mismo teléfono)
    const { data: ultimo } = await supabase.from('verif_codigos')
      .select('ultimo_envio_en').eq('tipo', 'telefono').eq('dato', tel)
      .order('creado_en', { ascending: false }).limit(1).maybeSingle();
    if (ultimo?.ultimo_envio_en) {
      const diff = Math.floor((ahora - new Date(ultimo.ultimo_envio_en).getTime()) / 1000);
      if (diff < SEGUNDOS_COOLDOWN) {
        return json({ ok: false, motivo: 'cooldown', segundos_reenvio: SEGUNDOS_COOLDOWN - diff });
      }
    }

    // 3) 3 envíos/hora por teléfono
    const { count: enviosHora } = await supabase.from('verif_codigos')
      .select('id', { count: 'exact', head: true }).eq('tipo', 'telefono').eq('dato', tel)
      .gte('creado_en', new Date(ahora - 3600000).toISOString());
    if ((enviosHora || 0) >= TOPE_ENVIOS_HORA_TEL) return json({ ok: false, motivo: 'limite_envios' });

    // 4) 10 envíos/hora por IP
    const ipHash = ip ? await hashIP(ip) : '';
    if (ipHash) {
      const { count: enviosIP } = await supabase.from('verif_codigos')
        .select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash)
        .gte('creado_en', new Date(ahora - 3600000).toISOString());
      if ((enviosIP || 0) >= TOPE_ENVIOS_HORA_IP) return json({ ok: false, motivo: 'limite_ip' });
    }

    // 5) Tope mensual de plantillas (~$2)
    const inicioMes = new Date(Date.now()); inicioMes.setUTCDate(1); inicioMes.setUTCHours(0, 0, 0, 0);
    const { count: plantillasMes } = await supabase.from('verif_codigos')
      .select('id', { count: 'exact', head: true }).eq('canal', 'whatsapp_plantilla')
      .gte('creado_en', inicioMes.toISOString());
    const sinPlantilla = (plantillasMes || 0) >= TOPE_PLANTILLAS_MES;

    // 6) ¿Hay ventana de 24 h abierta? WhatsApp sólo deja RESPONDER gratis dentro
    //    de la ventana que abre la clienta al escribir primero. Un código a un
    //    número que nunca escribió (o que no escribió hace +24 h) se pierde con
    //    "re-engagement" (#131047) aunque Meta devuelva wamid. Por eso, si no hay
    //    ventana, le damos el enlace para que abra el chat y nos escriba primero.
    const abierta = await ventanaAbierta(tel);
    if (!abierta) {
      const waLink = 'https://wa.me/50362852631?text=' + encodeURIComponent('Hola BARATUSS 💛 quiero verificar mi número');
      return json({ ok: false, motivo: 'abrir_whatsapp', wa_link: waLink });
    }

    // 7) Generar el código (6 dígitos impredecibles) y guardar SOLO el hash
    const codigo = generarCodigo6();
    const hash = await hashCodigo(codigo, tel);
    const expiraEn = new Date(ahora + MINUTOS_VALIDEZ * 60000).toISOString();

    // 8) Enviar por texto libre (la ventana está abierta → llega seguro y es $0).
    //    La plantilla queda de respaldo para cuando Meta apruebe la de código.
    let canal = '';
    let envio: { wamid: string | null; error: string } = { wamid: null, error: 'sin_canal' };
    const texto = (nombre ? '¡Hola ' + nombre + '! 👋' : '¡Hola! 👋') + ' Soy Cindy de BARATUSS 💛\n\n'
      + 'Escribí este código en la página para confirmar tu número:\n\n'
      + codigoFormateado(codigo) + '\n\n'
      + '⏰ Vale ' + MINUTOS_VALIDEZ + ' minutos. Si no lo pediste, avisame 🙈';
    envio = await enviarTexto(tel, texto, 'CODIGO-VERIF');
    if (envio.wamid) { canal = 'whatsapp_texto'; await registrarSaliente(envio.wamid, tel, 'texto-libre', ref, 'código de verificación'); }
    if (!envio.wamid && envio.error !== 'sin_whatsapp' && !sinPlantilla) {
      envio = await enviarPlantilla(tel, PLANTILLA_CODIGO, [codigo], 'CODIGO-VERIF');
      if (envio.wamid) { canal = 'whatsapp_plantilla'; await registrarSaliente(envio.wamid, tel, PLANTILLA_CODIGO, ref); }
    }

    // 9) ¿Se pudo mandar? Si no, no se guarda el código (no sirve de nada un código que no llegó)
    if (!envio.wamid) {
      if (envio.error === 'sin_whatsapp') return json({ ok: false, motivo: 'sin_whatsapp' });
      return json({ ok: false, motivo: 'sin_canal' });
    }

    const { error: errIns } = await supabase.from('verif_codigos').insert({
      tipo: 'telefono', dato: tel, codigo_hash: hash, canal,
      intentos: 0, max_intentos: 3, envios: 1,
      ultimo_envio_en: new Date().toISOString(), expira_en: expiraEn,
      ip_hash: ipHash || null, order_reference: ref || null,
    });
    if (errIns) return json({ ok: false, motivo: 'error_db' }, 500);

    return json({
      ok: true, canal, expira_en: expiraEn,
      segundos_reenvio: SEGUNDOS_COOLDOWN, intentos_restantes: 3,
    });
  } catch (e) {
    console.log('ERROR enviar-codigo-wa', String(e));
    return json({ ok: false, motivo: 'error', detalle: String(e).slice(0, 200) }, 500);
  }
});
