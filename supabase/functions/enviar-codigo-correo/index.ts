// ============================================================================
// BARATUSS · enviar-codigo-correo · 24-sep-2026
// Envía por correo el código de verificación de 6 dígitos (correo).
// · Reutiliza el OAuth de Gmail de enviar-factura (refresh token + client id/secret).
// · Código guardado SOLO como hash (SHA-256 con pepita). 10 min de vida, 3 intentos.
// · Anti-abuso: cooldown 30 s · 3 envíos/hora por correo · 10/hora por IP.
// ============================================================================
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabase, generarCodigo6, hashCodigo, hashIP } from '../_shared/verificacion.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const G_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const G_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const G_REFRESH = Deno.env.get('GOOGLE_REFRESH_TOKEN') || '';
const REMITENTE = Deno.env.get('FACTURA_REMITENTE') || 'BARATUSS <baratusses@gmail.com>';

const MINUTOS_VALIDEZ = 10;
const SEGUNDOS_COOLDOWN = 30;
const TOPE_ENVIOS_HORA_MAIL = 3;
const TOPE_ENVIOS_HORA_IP = 10;

// Correo simple: minúsculas, sin espacios. Valida forma básica usuario@dominio.tld.
function normalizarCorreo(c: string): string {
  const s = (c || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return '';
  return s;
}

function codigoFormateado(codigo: string): string {
  return codigo.split('').join(' ');
}

async function tokenGmail(): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: G_ID, client_secret: G_SECRET,
      refresh_token: G_REFRESH, grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('No se pudo obtener el permiso de Gmail: ' + JSON.stringify(d).slice(0, 200));
  return d.access_token as string;
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const b64url = (s: string) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function envolverBase64(contenido: string) {
  const s = b64(contenido);
  return s.replace(/.{1,76}/g, (m) => m + '\r\n');
}

async function enviarCorreo(accessToken: string, destinatario: string, asunto: string, html: string, texto: string) {
  const limAlt = '==BARATUSS-ALT==';
  const cabeceras = [
    `From: ${REMITENTE}`,
    `To: ${destinatario}`,
    `Reply-To: baratusses@gmail.com`,
    `Subject: =?UTF-8?B?${b64(asunto)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 10)}@baratuss>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${limAlt}"`,
    '',
    `--${limAlt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    envolverBase64(texto),
    `--${limAlt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    envolverBase64(html),
    `--${limAlt}--`,
    '',
  ];
  const mime = cabeceras.join('\r\n');

  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Gmail rechazó el envío: ' + JSON.stringify(d).slice(0, 250));
  return { id: d.id, threadId: d.threadId };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const correo = normalizarCorreo(String(b.correo || ''));
    if (!correo) return json({ ok: false, motivo: 'correo_invalido' }, 400);

    const nombre = String(b.nombre || '').trim();
    const ref = String(b.order_reference || '');
    const ip = String(b.ip || req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('cf-connecting-ip') || '').trim();

    // 1) ¿Ya está verificado? → no se manda nada.
    const { data: yaVerificado } = await supabase.from('verif_datos')
      .select('id').eq('tipo', 'correo').eq('dato', correo).is('revocado_en', null).maybeSingle();
    if (yaVerificado) return json({ ok: true, motivo: 'ya_verificado', ya_verificado: true });

    const ahora = Date.now();

    // 2) Cooldown 30 s entre envíos (mismo correo)
    const { data: ultimo } = await supabase.from('verif_codigos')
      .select('ultimo_envio_en').eq('tipo', 'correo').eq('dato', correo)
      .order('creado_en', { ascending: false }).limit(1).maybeSingle();
    if (ultimo?.ultimo_envio_en) {
      const diff = Math.floor((ahora - new Date(ultimo.ultimo_envio_en).getTime()) / 1000);
      if (diff < SEGUNDOS_COOLDOWN) {
        return json({ ok: false, motivo: 'cooldown', segundos_reenvio: SEGUNDOS_COOLDOWN - diff });
      }
    }

    // 3) 3 envíos/hora por correo
    const { count: enviosHora } = await supabase.from('verif_codigos')
      .select('id', { count: 'exact', head: true }).eq('tipo', 'correo').eq('dato', correo)
      .gte('creado_en', new Date(ahora - 3600000).toISOString());
    if ((enviosHora || 0) >= TOPE_ENVIOS_HORA_MAIL) return json({ ok: false, motivo: 'limite_envios' });

    // 4) 10 envíos/hora por IP
    const ipHash = ip ? await hashIP(ip) : '';
    if (ipHash) {
      const { count: enviosIP } = await supabase.from('verif_codigos')
        .select('id', { count: 'exact', head: true }).eq('ip_hash', ipHash)
        .gte('creado_en', new Date(ahora - 3600000).toISOString());
      if ((enviosIP || 0) >= TOPE_ENVIOS_HORA_IP) return json({ ok: false, motivo: 'limite_ip' });
    }

    // 5) Generar el código y guardar SOLO el hash
    const codigo = generarCodigo6();
    const hash = await hashCodigo(codigo, correo);
    const expiraEn = new Date(ahora + MINUTOS_VALIDEZ * 60000).toISOString();

    // 6) Enviar el correo (primero el envío; si falla, no se guarda el código)
    if (!G_ID || !G_SECRET || !G_REFRESH) return json({ ok: false, motivo: 'sin_credenciales' }, 500);
    const accessToken = await tokenGmail();
    const codigoVisible = codigoFormateado(codigo);
    const saludo = nombre ? '¡Hola ' + nombre + '! 💖' : '¡Hola! 💖';
    const html = `<div style="background:#f7f7f7;padding:24px;">\n`
      + `  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:26px;font-family:Arial,Helvetica,sans-serif;">\n`
      + `    <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;letter-spacing:2px;margin-bottom:14px;">BARATUSS</div>\n`
      + `    <p style="font-size:15px;color:#333;">${saludo}<br>Este es tu código para confirmar tu correo:</p>\n`
      + `    <div style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#c9553f;padding:14px 0;text-align:center;">${codigoVisible}</div>\n`
      + `    <p style="font-size:13px;color:#666;">⏰ Vale ${MINUTOS_VALIDEZ} minutos. Si no lo pediste, ignorá este correo.</p>\n`
      + `    <p style="font-size:12px;color:#999;margin-top:18px;">BARATUSS · San Salvador, El Salvador</p>\n`
      + `  </div>\n</div>`;
    const texto = `${saludo}\n\nEste es tu código para confirmar tu correo:\n\n${codigoVisible}\n\n⏰ Vale ${MINUTOS_VALIDEZ} minutos. Si no lo pediste, ignorá este correo.\n\nBARATUSS · San Salvador, El Salvador`;
    await enviarCorreo(accessToken, correo, 'Tu código de verificación de BARATUSS 💛', html, texto);

    const { error: errIns } = await supabase.from('verif_codigos').insert({
      tipo: 'correo', dato: correo, codigo_hash: hash, canal: 'correo',
      intentos: 0, max_intentos: 3, envios: 1,
      ultimo_envio_en: new Date().toISOString(), expira_en: expiraEn,
      ip_hash: ipHash || null, order_reference: ref || null,
    });
    if (errIns) return json({ ok: false, motivo: 'error_db' }, 500);

    return json({
      ok: true, canal: 'correo', expira_en: expiraEn,
      segundos_reenvio: SEGUNDOS_COOLDOWN, intentos_restantes: 3,
    });
  } catch (e) {
    console.log('ERROR enviar-codigo-correo', String(e));
    return json({ ok: false, motivo: 'error', detalle: String(e).slice(0, 200) }, 500);
  }
});
