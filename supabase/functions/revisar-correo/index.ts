// ============================================================================
// BARATUSS · revisar-correo (E5 del plan "todo en código")
//
// Revisa baratusses@gmail.com (Gmail API, OAuth refresh token) y SOLO avisa a
// Cindy por Telegram cuando escribe un CLIENTE. Ignora en silencio: plataformas
// (Google, Meta, Wompi…), proveedores (facturas/DTE), Hacienda y publicidad —
// la misma regla de clasificación que gmail_clientes_silent.py.
//
// Reemplaza el cron de la PC "BARATUSS correo de clientes" (15 min).
//
// Anti-ruido:
//   · cada correo se avisa UNA sola vez (se guarda su id en config_operativa);
//   · si el permiso de Gmail falla, avisa UNA vez por día (no cada 15 min).
//
// Seguridad: función pública (no-verify-jwt) pero exige la clave interna
// x-baratuss-key (FACTURA_KEY / config_operativa.factura_trigger_key).
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const FACTURA_KEY = Deno.env.get('FACTURA_KEY') || '';
const G_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const G_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const G_REFRESH = Deno.env.get('GOOGLE_REFRESH_TOKEN') || '';
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const CINDY = Deno.env.get('SALUD_TELEGRAM_CHAT_ID') || '8635242458';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-baratuss-key' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ---------- claves de estado en config_operativa ----------
const CLAVE_VISTOS = 'revisar_correo_vistos';   // JSON array de ids de mensaje ya procesados
const CLAVE_ERROR = 'revisar_correo_error';     // ISO timestamp del último aviso de fallo de Gmail

// ---------- reglas de clasificación (portadas de gmail_pendientes.py) ----------
const PROPIO = 'baratusses@gmail.com';
const NO_CLIENTE = [
  'no-reply', 'noreply', 'no_reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
  'notificaciones', 'notification', 'notify', 'newsletter', 'soporte@', 'support@',
  'marketing', 'promo@', 'bounce', 'postmaster',
  'accounts.google', 'google.com', 'googlemail.com', 'facebookmail', 'facebook.com',
  'instagram.com', 'meta.com', 'whatsapp.com', 'wompi', 'supabase', 'github', 'vercel',
  'netlify', 'paypal', 'apple.com', 'microsoft.com',
];
const MARKETING = [
  'unsubscribe', 'darse de baja', 'cancelar suscrip', 'boletín', 'boletin',
  'newsletter', 'suscríbete', 'suscribete', '% off', 'promoción exclusiva',
  'envío gratis en tu', 'últimas unidades en oferta', 'liquidación total',
];
const FISCAL = ['gob.sv', 'hacienda', 'ministerio', '@mh.', 'dte.', 'factura.gob'];
const PALABRAS_CLIENTE = [
  'pedido', 'orden', 'talla', 'precio', 'cuánto', 'cuanto', 'disponible', 'stock',
  'comprar', 'compro', 'envío', 'envio', 'entrega', 'retiro', 'factura', 'vestido',
  'blusa', 'pantalón', 'pantalon', 'zapatos', 'bolso', 'maquillaje', 'crema',
  'colores', 'color', 'modelo', 'reserva', 'apartar', 'aparto', 'catálogo', 'catalogo',
];
const DOMINIOS_PERSONALES = [
  'gmail.com', 'hotmail.com', 'outlook.com', 'outlook.es', 'yahoo.com', 'yahoo.es',
  'icloud.com', 'live.com', 'me.com', 'proton.me', 'protonmail.com', 'tutanota.com',
  'gmx.com', 'aol.com', 'msn.com',
];
const PALABRAS_PROVEEDOR = [
  'factura', 'dte', 'comprobante', 'crédito fiscal', 'credito fiscal',
  'cotización', 'cotizacion', 'proforma', 'orden de compra', 'guía de envío',
];

// ---------- utilidades ----------

function headers(d: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of (d?.payload?.headers || [])) out[String(h.name).toLowerCase()] = String(h.value || '');
  return out;
}

function clasificarRemitente(de: string, asunto: string, resumen: string): 'cliente' | 'proveedor' | 'plataforma' | 'fiscal' | 'propio' | 'marketing' | 'desconocido' {
  const texto = `${de} ${asunto} ${resumen}`.toLowerCase();
  const m = (de || '').match(/[\w.+-]+@[\w.-]+/);
  const correo = m ? m[0].toLowerCase() : '';
  const esPersonal = DOMINIOS_PERSONALES.some((d) => correo.endsWith('@' + d));

  // Solo es "propio" si el remitente es el propio negocio. NO mirar el cuerpo:
  // un cliente que RESPONDE a un correo nuestro lo trae citado y se perdería el aviso.
  if (correo === PROPIO) return 'propio';
  if (FISCAL.some((p) => (de || '').toLowerCase().includes(p))) return 'fiscal';
  if (correo && NO_CLIENTE.some((d) => correo.endsWith(d) || correo.includes(d))) return 'plataforma';

  if (esPersonal) return 'cliente'; // persona escribiendo desde su correo personal
  if (PALABRAS_PROVEEDOR.some((p) => texto.includes(p))) return 'proveedor';
  if (MARKETING.some((p) => texto.includes(p))) return 'marketing';
  if (PALABRAS_CLIENTE.some((p) => (asunto || '').toLowerCase().includes(p))) return 'cliente';
  return 'desconocido';
}

// avisa SOLO a Cindy (chat privado), un solo sendMessage.
async function avisarCindy(texto: string): Promise<boolean> {
  if (!TG_TOKEN || !CINDY) return false;
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CINDY, text: texto, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (_e) {
    return false;
  }
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
  if (!d.access_token) throw new Error('No se pudo obtener el permiso de Gmail');
  return d.access_token as string;
}

async function correosNoLeidos(token: string, limite = 25): Promise<Array<{ id: string; de: string; asunto: string; fecha: string; resumen: string }>> {
  const listR = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent('is:unread in:inbox') + '&maxResults=' + limite, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const list = await listR.json();
  if (!listR.ok) throw new Error('Gmail list: ' + JSON.stringify(list).slice(0, 200));
  const ids = (list.messages || []).map((m: any) => m.id);
  const salida: Array<{ id: string; de: string; asunto: string; fecha: string; resumen: string }> = [];
  for (const id of ids) {
    const mR = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    const d = await mR.json();
    const h = headers(d);
    salida.push({
      id,
      de: h['from'] || '',
      asunto: h['subject'] || '(sin asunto)',
      fecha: h['date'] || '',
      resumen: (d.snippet || '').slice(0, 120),
    });
  }
  return salida;
}

// ---------- estado en config_operativa ----------

async function leerEstado(clave: string): Promise<string> {
  try {
    const { data } = await supabase.from('config_operativa').select('valor').eq('clave', clave).maybeSingle();
    return data?.valor || '';
  } catch (_e) { return ''; }
}

async function guardarEstado(clave: string, valor: string): Promise<void> {
  try {
    await supabase.from('config_operativa').upsert({ clave, valor, actualizado_en: new Date().toISOString() }, { onConflict: 'clave' });
  } catch (e) { console.log('guardarEstado(' + clave + '):', String(e)); }
}

// ---------- autenticación (misma clave que enviar-factura / salud-baratuss) ----------

async function claveValida(clave: string): Promise<boolean> {
  if (!clave) return false;
  if (FACTURA_KEY && clave === FACTURA_KEY) return true;
  try {
    const { data } = await supabase.from('config_operativa').select('valor').eq('clave', 'factura_trigger_key').maybeSingle();
    if (data?.valor && clave === data.valor) return true;
  } catch (_e) { /* silencio */ }
  return false;
}

// ---------- aviso de fallo del permiso: UNA vez por día ----------

function inicioDiaSVUTC(): Date {
  const now = new Date();
  let inicio = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0);
  if (now.getTime() < inicio) inicio -= 24 * 3600 * 1000;
  return new Date(inicio);
}

async function avisoErrorUnaVezAlDia(detalle: string): Promise<boolean> {
  const ultimo = await leerEstado(CLAVE_ERROR);
  if (ultimo) {
    try {
      const t = new Date(ultimo).getTime();
      if (t >= inicioDiaSVUTC().getTime()) return false; // ya avisé hoy
    } catch (_e) { /* fecha ilegible: seguimos */ }
  }
  const enviado = await avisarCindy(
    '⚠️ *Aviso de correos de clientes: no pude revisar el correo del negocio*\n\n' +
    '(' + (detalle || 'sin detalle') + ')\n\n' +
    '→ El permiso de Google pudo haberse vencido. Te aviso una vez por día, no en cada intento.',
  );
  await guardarEstado(CLAVE_ERROR, new Date().toISOString());
  return enviado;
}

// ---------- corrida ----------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const clave = req.headers.get('x-baratuss-key') || '';
    if (!(await claveValida(clave))) return json({ error: 'no autorizado' }, 401);

    if (!G_ID || !G_SECRET || !G_REFRESH) {
      await avisoErrorUnaVezAlDia('faltan las credenciales de Gmail en Supabase Secrets');
      return json({ ok: true, revisados: 0, clientes: 0, error: 'faltan credenciales de Gmail' });
    }

    // 1) token + listar no leídos
    let correos;
    try {
      const token = await tokenGmail();
      correos = await correosNoLeidos(token, 25);
      // si la consulta funcionó, se limpia el aviso de error pendiente
      await guardarEstado(CLAVE_ERROR, '');
    } catch (e) {
      await avisoErrorUnaVezAlDia(String(e).slice(0, 200));
      return json({ ok: true, revisados: 0, clientes: 0, error: String(e).slice(0, 200) });
    }

    // 2) clasificar
    const clasificados = correos.map((c) => ({ ...c, tipo: clasificarRemitente(c.de, c.asunto, c.resumen) }));

    // 3) dedupe: solo avisamos de CLIENTES no vistos antes
    let vistos: string[] = [];
    try { vistos = JSON.parse(await leerEstado(CLAVE_VISTOS)) || []; } catch (_e) { vistos = []; }
    const setVistos = new Set<string>(vistos);
    const nuevosClientes = clasificados.filter((c) => c.tipo === 'cliente' && !setVistos.has(c.id));

    // marcamos TODOS los no-leídos como vistos para no reprocesarlos
    const nuevosIds = clasificados.map((c) => c.id);
    const totalVistos = [...new Set([...setVistos, ...nuevosIds])].slice(-300);
    await guardarEstado(CLAVE_VISTOS, JSON.stringify(totalVistos));

    // 4) avisar si hay clientes nuevos
    let avisado = false;
    if (nuevosClientes.length) {
      const lineas = ['📬 *¡Escribió un cliente!* (baratusses@gmail.com)', ''];
      for (const c of nuevosClientes) {
        lineas.push('De: ' + c.de);
        lineas.push('Asunto: ' + c.asunto);
        if (c.resumen) lineas.push(c.resumen);
        lineas.push('');
      }
      lineas.push('→ ¿Querés que te prepare una respuesta o que lo revise?');
      avisado = await avisarCindy(lineas.join('\n'));
    }

    return json({
      ok: true,
      revisados: correos.length,
      clientes_nuevos: nuevosClientes.length,
      avisado_telegram: avisado,
      tipos: clasificados.map((c) => c.tipo),
    });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
