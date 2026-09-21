// ========================================================================
// pagos-noshow — PLAN 2 (pagos pendientes y abandono) + PLAN 3 (NO_SHOW)
// Aprobado por Cindy el 19-sep-2026  ·  BARATUSS
//
// Qué hace:
//   · Recordatorios amables al que no completó el pago  (2 h y 24 h)
//   · A las 48 h: cierra el pedido sin pagar y DEVUELVE el stock
//   · Recuperación del carrito abandonado (Nivel B): UN solo mensaje
//   · NO_SHOW: manda el menú de opciones, recuerda a las 2 h y a las 48 h
//     cierra el caso (efectivo) o te avisa (tarjeta ya pagada)
//   · Detecta si un número NO tiene WhatsApp → avisa por correo y te avisa a vos
//
// Acciones:
//   {accion:'revisar'}            → la corre el cron (todo lo automático)
//   {accion:'noshow', reference}  → botón "🚫 No vino" del panel
//   {accion:'noshow_opcion', incidencia_id, opcion}  → respuesta del cliente al menú
//   {accion:'guardar-intento', telefono, nombre, items, total} → carrito abandonado
//   {accion:'consultar-cliente', telefono} → ¿tiene no-shows? (para pedir pago adelantado)
// ========================================================================
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const WA_TOKEN = Deno.env.get('META_WA_TOKEN') || '';
const PHONE_ID = Deno.env.get('META_PHONE_ID') || '';
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const TG_CHATS = (Deno.env.get('TELEGRAM_CHAT_ID') || '').split(',').map(s => s.trim()).filter(Boolean);
const G_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const G_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const G_REFRESH = Deno.env.get('GOOGLE_REFRESH_TOKEN') || '';
const G_FROM = Deno.env.get('FACTURA_REMITENTE') || 'BARATUSS <baratusses@gmail.com>';

const CINDY_WA = '50376626575';          // avisos directos a Cindy
const CONTACTO_CINDY = '7662-6575';      // número que se le pasa al cliente (menú no-show)
const TEL_NEGOCIO = '6285-2631';
const HORAS_VENCE = 48;                  // regla de Cindy: 48 horas
const WOMPI_CLIENT_ID = 'ad59dd3e-5c32-476d-a864-4ff719f4e7b1';
const WOMPI_CLIENT_SECRET = '9c96e9c3-6a03-464d-90e1-c9e585686cc9';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

// ===== utilidades =====
function ahoraSV(): Date { return new Date(Date.now() - 6 * 3600000); }
function sello(): string { return ahoraSV().toISOString().slice(0, 16).replace('T', ' '); }
function normalizarTel(tel: string): string {
  let t = (tel || '').replace(/\D/g, '');
  if (t.startsWith('0')) t = '503' + t.slice(1);
  if (t.length === 8) t = '503' + t;
  return t;
}
function primerNombre(n: string): string { return String(n || 'cliente').split(' ')[0]; }
// Fecha límite (48 h) en hora de El Salvador, para la plantilla de trámite
function fechaLimiteTexto(o: { created_at?: string; pago_expira_en?: string | null }): string {
  const base = o.pago_expira_en
    ? new Date(o.pago_expira_en)
    : new Date(new Date(o.created_at || Date.now()).getTime() + HORAS_VENCE * 3600000);
  const sv = new Date(base.getTime() - 6 * 3600000);
  const p = (n: number) => String(n).padStart(2, '0');
  return p(sv.getUTCDate()) + '/' + p(sv.getUTCMonth() + 1) + ' a las ' + p(sv.getUTCHours()) + ':' + p(sv.getUTCMinutes());
}

function productoDe(items: any[]): string {
  const it = (items || [])[0] || {};
  const n = String(it.name || 'tu producto');
  return (items || []).length > 1 ? n + ' (+' + ((items || []).length - 1) + ' más)' : n;
}

async function avisarTG(texto: string) {
  if (!TG_TOKEN) return;
  for (const chat of TG_CHATS) {
    try {
      await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
      });
    } catch (e) { console.log('TG err', String(e)); }
  }
}

// ===== correo (Gmail API, mismas credenciales que las facturas) =====
const erroresCorreo: string[] = [];
async function correo(destino: string, asunto: string, html: string): Promise<boolean> {
  if (!G_ID || !G_SECRET || !G_REFRESH || !destino) {
    erroresCorreo.push('faltan credenciales o destino (' + (!G_ID ? 'sin cliente ' : '') + (!G_REFRESH ? 'sin refresh ' : '') + (!destino ? 'sin correo' : '') + ')');
    return false;
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: G_ID, client_secret: G_SECRET, refresh_token: G_REFRESH, grant_type: 'refresh_token' }),
    });
    const t = await r.json();
    if (!t.access_token) { erroresCorreo.push('token: ' + JSON.stringify(t).slice(0, 120)); console.log('correo: sin token', JSON.stringify(t).slice(0, 150)); return false; }
    // Igual que en las facturas (que ya funciona): base64url SIN relleno ('=')
    const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
    const b64url = (s: string) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const envolver = (c: string) => (c.match(/.{1,76}/g) || []).join('\r\n');
    const cab = ['From: ' + G_FROM, 'To: ' + destino, 'Subject: =?UTF-8?B?' + b64(asunto) + '?=', 'MIME-Version: 1.0',
                 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64'].join('\r\n');
    const raw = b64url(cab + '\r\n\r\n' + envolver(b64(html)));
    const e = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + t.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    const d = await e.json();
    console.log('correo ->', destino, e.ok ? 'OK' : JSON.stringify(d).slice(0, 150));
    if (!e.ok) erroresCorreo.push('envio: ' + JSON.stringify(d).slice(0, 140));
    return e.ok;
  } catch (e) { console.log('correo err', String(e)); return false; }
}

// ===== WhatsApp =====
function esSinWhatsApp(d: any): string {
  const code = Number(d?.error?.code || 0);
  const msg = String(d?.error?.message || '');
  if (code === 131026 || code === 133010 || /not (a )?whatsapp|no whatsapp|not registered/i.test(msg)) return 'sin_whatsapp';
  if (code === 131047 || /re-engagement|24 hour|24-hour/i.test(msg)) return 'ventana_cerrada';
  return '';
}

async function marcarSinWhatsApp(tel: string, motivo: string) {
  try {
    await supabase.from('wa_telefonos').upsert({ telefono: normalizarTel(tel), tiene_whatsapp: false, motivo, detectado_en: new Date().toISOString() });
    await supabase.from('orders').update({ whatsapp_estado: 'sin_whatsapp' })
      .in('telefono_normalizado', [normalizarTel(tel)]).in('status', ['pendiente', 'pagado', 'efectivo']);
  } catch (e) { console.log('marcarSinWhatsApp', String(e)); }
}

type EnvioWA = { wamid: string | null; error: string };
async function enviarTexto(tel: string, texto: string, etiqueta = ''): Promise<EnvioWA> {
  if (!WA_TOKEN || !PHONE_ID) return { wamid: null, error: 'sin_token' };
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + PHONE_ID + '/messages', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizarTel(tel), type: 'text', text: { preview_url: false, body: texto } }),
    });
    const d = await r.json();
    const wamid = d?.messages?.[0]?.id ? String(d.messages[0].id) : null;
    const err = wamid ? '' : (esSinWhatsApp(d) || 'error_envio');
    console.log('TEXTO', etiqueta, '->', tel, wamid ? 'OK' : JSON.stringify(d).slice(0, 160));
    if (!wamid && err === 'sin_whatsapp') await marcarSinWhatsApp(tel, 'meta:' + String(d?.error?.code || ''));
    return { wamid, error: err };
  } catch (e) { console.log('error texto', String(e)); return { wamid: null, error: 'excepcion' }; }
}

async function enviarPlantilla(tel: string, plantilla: string, params: string[], etiqueta = ''): Promise<EnvioWA> {
  if (!WA_TOKEN || !PHONE_ID) return { wamid: null, error: 'sin_token' };
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + PHONE_ID + '/messages', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: normalizarTel(tel), type: 'template',
        template: { name: plantilla, language: { code: 'es' }, components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }] },
      }),
    });
    const d = await r.json();
    const wamid = d?.messages?.[0]?.id ? String(d.messages[0].id) : null;
    const err = wamid ? '' : (esSinWhatsApp(d) || 'error_envio');
    console.log('PLANTILLA', plantilla, '->', tel, etiqueta, wamid ? 'OK' : JSON.stringify(d).slice(0, 160));
    if (!wamid && err === 'sin_whatsapp') await marcarSinWhatsApp(tel, 'meta:' + String(d?.error?.code || ''));
    return { wamid, error: err };
  } catch (e) { console.log('error plantilla', String(e)); return { wamid: null, error: 'excepcion' }; }
}

async function ventanaAbierta(tel: string): Promise<boolean> {
  try {
    const desde = new Date(Date.now() - 24 * 3600000).toISOString();
    const { data } = await supabase.from('wa_mensajes').select('id')
      .eq('telefono', normalizarTel(tel)).eq('direccion', 'entrante').gte('creado_en', desde).limit(1);
    return !!(data && data.length);
  } catch (_e) { return false; }
}

async function registrarSaliente(wamid: string | null, tel: string, plantilla: string, ref: string, contenido = '') {
  if (!wamid) return;
  try {
    await supabase.from('wa_mensajes').insert({
      wa_message_id: wamid, telefono: normalizarTel(tel), direccion: 'saliente',
      atendido_por: 'pagos-noshow', order_reference: ref || null,
      texto: contenido || ('(plantilla: ' + plantilla + ')'),
    });
  } catch (e) { console.log('registrarSaliente', String(e)); }
}

// Envía por WhatsApp: texto libre si hay ventana; si no, plantilla; si no hay ninguna, correo
async function avisar(tel: string, opciones: { texto: string; plantilla?: string; params?: string[]; correo?: string; asunto?: string; html?: string; ref?: string; etiqueta: string }): Promise<string> {
  const { texto, plantilla, params = [], correo: mail, asunto, html, ref = '', etiqueta } = opciones;
  if (await ventanaAbierta(tel)) {
    const e = await enviarTexto(tel, texto, etiqueta);
    if (e.wamid) { await registrarSaliente(e.wamid, tel, 'texto-libre', ref, texto); return 'texto'; }
    if (e.error === 'sin_whatsapp') { /* sigue al correo */ }
  }
  if (plantilla) {
    const e = await enviarPlantilla(tel, plantilla, params, etiqueta);
    if (e.wamid) { await registrarSaliente(e.wamid, tel, plantilla, ref); return 'plantilla'; }
  }
  if (mail && html) {
    const ok = await correo(mail, asunto || 'BARATUSS — tu pedido', html);
    if (ok) return 'correo';
  }
  return 'no_enviado';
}

// ===== Wompi: enlace de pago nuevo (para el recordatorio) =====
async function enlaceWompi(ref: string, monto: number): Promise<string | null> {
  try {
    const r = await fetch('https://id.wompi.sv/connect/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: WOMPI_CLIENT_ID, client_secret: WOMPI_CLIENT_SECRET, audience: 'wompi_api' }),
    });
    const t = await r.json();
    if (!t.access_token) return null;
    const p = await fetch('https://api.wompi.sv/EnlacePago', {
      method: 'POST', headers: { 'authorization': 'Bearer ' + t.access_token, 'content-type': 'application/json' },
      body: JSON.stringify({
        identificadorEnlaceComercio: ref + '-R' + Date.now().toString().slice(-4),
        monto: Math.round(monto * 100) / 100,
        nombreProducto: 'BARATUSS - Pedido online',
        formaPago: { permitirTarjetaCreditoDebido: true, permitirPagoConPuntoAgricola: true, permitirPagoEnCuotasAgricola: false },
        configuracion: { urlRedirect: 'https://baratuss.github.io/?ref=' + ref, urlRetorno: 'https://baratuss.github.io/#tienda' },
      }),
    });
    const d = await p.json();
    const url = d?.urlEnlace || d?.url || null;
    console.log('enlace wompi', ref, url ? 'OK' : JSON.stringify(d).slice(0, 140));
    return url;
  } catch (e) { console.log('enlaceWompi err', String(e)); return null; }
}

// ===== mensajes (voz BARATUSS, aprobados por Cindy) =====
function msjPago1(nombre: string, producto: string, enlace: string): string {
  return '¡Hola ' + nombre + '! 😊 Tu pedido del *' + producto + '* quedó esperando el pago.\n\n'
    + '¿Te dio algún problema la tarjeta? Te dejo el enlace otra vez 👉 ' + enlace + '\n\n'
    + 'Y si preferís, podés pagar en efectivo al retirarlo 💛';
}
function msjPago2(nombre: string, producto: string): string {
  return 'Hola ' + nombre + ' 👋 Te escribo una última vez por tu *' + producto + '*.\n\n'
    + 'Si ya no lo querés, no hay ningún problema 🙂 — en 24 h se libera solo y vuelve a la tienda.\n\n'
    + 'Si sí lo querés, avisame y te lo dejo apartado 💛';
}
function msjCarrito(nombre: string, producto: string): string {
  return '¡Hola ' + nombre + '! 😊 Vi que estabas por llevarte el *' + producto + '* y quedó a medias…\n\n'
    + '¿Te ayudo a terminar? Si querés te lo dejo apartado un ratito 💛';
}
function msjNoShowEfectivo(nombre: string, punto: string, producto: string): string {
  return '¡Hola ' + nombre + '! 👋 Hoy te esperamos en ' + punto + ' y no te vimos.\n\n'
    + 'Tu *' + producto + '* te lo guardamos *48 horas*. ¿Qué preferís?\n'
    + '*1)* Te lo llevo al próximo Mié/Sáb\n'
    + '*2)* Cancelamos el pedido\n'
    + '*3)* Escribime al ' + CONTACTO_CINDY + ' 👩\n\n'
    + '_(Si querés asegurarla, avisame antes de las 48 h — puede que se venda a otra persona 💛)_';
}
function msjNoShowPagado(nombre: string, punto: string): string {
  return '¡Hola ' + nombre + '! 👋 Hoy no te pudimos ver en ' + punto + ', pero *tu pedido ya está pagado* así que no perdés nada 🙂\n\n'
    + 'Decime qué preferís:\n'
    + '*1)* Te lo guardo para el próximo punto\n'
    + '*2)* Te devuelvo el dinero\n'
    + '*3)* Te dejo el saldo a favor para otra compra 💛';
}
function htmlSimple(titulo: string, cuerpo: string): string {
  return '<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#3b2b28;">'
    + '<div style="background:#ff9686;color:#fff;padding:18px 22px;border-radius:14px 14px 0 0;font-size:19px;font-weight:700;">'
    + '🛍️ BARATUSS</div><div style="border:1px solid #ffe4de;border-top:none;border-radius:0 0 14px 14px;padding:22px;">'
    + '<h2 style="margin:0 0 12px;font-size:17px;color:#c2574a;">' + titulo + '</h2>'
    + '<div style="font-size:15px;line-height:1.6;">' + cuerpo.replace(/\n/g, '<br>') + '</div>'
    + '<p style="margin-top:22px;font-size:13px;color:#8a6b66;">Cualquier cosa escribinos al WhatsApp ' + TEL_NEGOCIO + ' 💛</p>'
    + '</div></div>';
}

// ========================================================================
// PASADA AUTOMÁTICA (la corre el cron cada 10 minutos)
// ========================================================================
async function revisar() {
  const log: string[] = [];
  const hace = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

  // ── (1) RECORDATORIOS DE PAGO (2 h y 24 h) ──────────────────────────
  try {
    const { data: sinPagar } = await supabase.from('orders')
      .select('id, reference, customer_name, customer_phone, customer_email, items, total, created_at, aviso_pago, payment_status, status, delivery_point, pago_expira_en')
      .in('payment_status', ['pendiente', 'creado', 'rechazado'])
      .not('status', 'in', '("cancelado","entregado","vencido","no-retirado")')
      .lte('created_at', hace(2))
      .order('created_at', { ascending: true })
      .limit(40);

    for (const o of sinPagar || []) {
      const avisos = (o.aviso_pago || {}) as Record<string, string>;
      const tel = o.customer_phone || '';
      const nombre = primerNombre(o.customer_name);
      const producto = productoDe(o.items || []);
      const horas = (Date.now() - new Date(o.created_at).getTime()) / 3600000;

      // Recordatorio 1 (a las 2 h)
      if (!avisos.r1 && horas >= 2 && !String(avisos.r1_fallo || '').includes('sin_whatsapp')) {
        const enlace = await enlaceWompi(o.reference, Number(o.total) || 0) || 'https://baratuss.github.io';
        const limite = fechaLimiteTexto(o);
        const via = await avisar(tel, {
          texto: msjPago1(nombre, producto, enlace),
          // Plantilla "de trámite" (utilidad): habla del pedido, la referencia y el plazo
          plantilla: ((globalThis as Record<string, unknown>)._usarPlantillaPago === true) ? 'pago_pendiente_baratuss_v2' : undefined,
          params: [o.reference, limite, enlace],
          correo: o.customer_email || undefined, asunto: 'Tu pedido en BARATUSS quedó esperando el pago',
          html: htmlSimple('Tu pedido te está esperando 💛', msjPago1(nombre, producto, enlace)),
          ref: o.reference, etiqueta: 'PAGO-1',
        });
        avisos.r1 = sello() + ' (' + via + ')';
        await supabase.from('orders').update({ aviso_pago: avisos }).eq('id', o.id);
        log.push('PAGO-1 ' + o.reference + ' -> ' + via);
        if (via === 'no_enviado') {
          await avisarTG('⚠️ No pude recordarle el pago a ' + o.customer_name + ' (' + tel + ')\n'
            + 'Pedido ' + o.reference + ' · $' + Number(o.total).toFixed(2)
            + '\nNo tiene WhatsApp y no dejó correo → conviene llamarlo 📞');
        }
      }

      // Recordatorio 2 (a las 24 h) — el último
      if (avisos.r1 && !avisos.r2 && horas >= 24) {
        const via = await avisar(tel, {
          texto: msjPago2(nombre, producto),
          plantilla: ((globalThis as Record<string, unknown>)._usarPlantillaPago === true) ? 'pago_pendiente_baratuss_v2' : undefined,
          params: [o.reference, fechaLimiteTexto(o), 'https://baratuss.github.io'],
          correo: o.customer_email || undefined, asunto: 'Último recordatorio de tu pedido en BARATUSS',
          html: htmlSimple('Último recordatorio 🙂', msjPago2(nombre, producto)),
          ref: o.reference, etiqueta: 'PAGO-2',
        });
        avisos.r2 = sello() + ' (' + via + ')';
        await supabase.from('orders').update({ aviso_pago: avisos }).eq('id', o.id);
        log.push('PAGO-2 ' + o.reference + ' -> ' + via);
      }
    }
  } catch (e) { log.push('err recordatorios: ' + String(e).slice(0, 90)); }

  // ── (2) VENCIMIENTO A LAS 48 H ──────────────────────────────────────
  try {
    const { data: venc } = await supabase.rpc('expirar_pedidos_sin_pagar', { p_horas: HORAS_VENCE });
    const n = Number(venc?.expirados || 0);
    if (n > 0) {
      const detalle = (venc?.pedidos || []).map((p: any) => '· ' + p.cliente + ' — ' + p.reference + ' ($' + Number(p.total || 0).toFixed(2) + ')').join('\n');
      await avisarTG('⌛ *' + n + ' pedido(s) sin pagar vencieron* (más de ' + HORAS_VENCE + ' h)\n' + detalle
        + '\n\n✅ El stock ya volvió a la tienda.');
      log.push('vencidos: ' + n);
      // aviso amable al cliente (solo si se puede)
      for (const p of venc?.pedidos || []) {
        if (!p.telefono) continue;
        await avisar(p.telefono, {
          texto: 'Hola ' + primerNombre(p.cliente) + ' 👋 Tu pedido *' + p.reference + '* se cerró porque quedó ' + HORAS_VENCE + ' h sin completar el pago, así que el producto volvió a la tienda.\n\nSi todavía lo querés, podés comprarlo de nuevo cuando quieras 💛',
          correo: undefined, ref: p.reference, etiqueta: 'PAGO-VENCIDO',
        });
      }
    }
  } catch (e) { log.push('err vencimiento: ' + String(e).slice(0, 90)); }

  // ── (3) RECUPERACIÓN DE CARRITO (Nivel B, UN mensaje) ───────────────
  try {
    const { data: carritos } = await supabase.from('carritos_abandonados')
      .select('telefono, nombre, items, total, creado_en')
      .is('avisado_en', null)
      .eq('convertido', false)
      .lte('creado_en', hace(0.5))     // 30 minutos
      .gte('creado_en', hace(48))
      .limit(20);

    for (const c of carritos || []) {
      // ¿Ya compró después? entonces no se le escribe nada
      const { data: compro } = await supabase.from('orders')
        .select('id').eq('telefono_normalizado', c.telefono).gte('created_at', c.creado_en).limit(1);
      if (compro && compro.length) {
        await supabase.from('carritos_abandonados').update({ convertido: true }).eq('telefono', c.telefono);
        continue;
      }
      const via = await avisar(c.telefono, {
        texto: msjCarrito(primerNombre(c.nombre || ''), productoDe(c.items || [])),
        correo: undefined, etiqueta: 'CARRITO',
      });
      await supabase.from('carritos_abandonados').update({ avisado_en: new Date().toISOString() }).eq('telefono', c.telefono);
      log.push('CARRITO ' + c.telefono + ' -> ' + via);
    }
    // limpieza: los datos se borran solos a los 30 días
    await supabase.from('carritos_abandonados').delete().lt('borrar_en', new Date().toISOString());
  } catch (e) { log.push('err carritos: ' + String(e).slice(0, 90)); }

  // ── (4) NO_SHOW: recordatorio a las 2 h y cierre/aviso a las 48 h ───
  try {
    const { data: casos } = await supabase.from('incidencias_entrega')
      .select('id, order_reference, customer_name, customer_phone, creado_en, estado, notas')
      .eq('tipo', 'no_show')
      .in('estado', ['esperando_cliente', 'esperando_cindy'])
      .order('id', { ascending: false })
      .limit(30);

    for (const c of casos || []) {
      const nombre = primerNombre(c.customer_name);
      const horas = (Date.now() - new Date(c.creado_en).getTime()) / 3600000;

      // Recordatorio amable a las 2 h (solo si hay ventana abierta: no queremos spam)
      if (c.estado === 'esperando_cliente' && horas >= 2 && horas < HORAS_VENCE && !(c.notas || '').includes('NS-RECORD')) {
        if (await ventanaAbierta(c.customer_phone)) {
          const e = await enviarTexto(c.customer_phone, 'Te dejo el mensaje de nuevo por si no lo viste 😊 ¿Te lo llevo al próximo Mié/Sáb, lo cancelamos, o preferís escribirme? 💛', 'NS-RECORD');
          if (e.wamid) await registrarSaliente(e.wamid, c.customer_phone, 'texto-libre', c.order_reference || '', 'recordatorio no-show');
        }
        await supabase.from('incidencias_entrega').update({ notas: ((c.notas || '') + '\n🔔 NS-RECORD ' + sello()).trim() }).eq('id', c.id);
      }

      // A las 48 h sin respuesta
      if (horas >= HORAS_VENCE) {
        const { data: o } = await supabase.from('orders')
          .select('reference, payment_status, status, total, customer_email, items, delivery_point')
          .eq('reference', c.order_reference).maybeSingle();
        if (!o) continue;
        const pagado = ['pagado', 'aprobado'].includes(String(o.payment_status));

        if (!pagado) {
          // Efectivo: se cierra y el producto vuelve a la tienda (cuenta para la 2ª vez)
          await supabase.rpc('cerrar_pedido_sin_venta', { p_ref: o.reference, p_motivo: 'no-retirado' });
          await supabase.from('incidencias_entrega')
            .update({ estado: 'no_retirado', resuelto_en: new Date().toISOString(), respuesta_cliente: 'sin_respuesta_48h' })
            .eq('id', c.id);
          const { data: cnt } = await supabase.rpc('no_shows_cliente', { p_telefono: c.customer_phone });
          const veces = Number(cnt?.no_shows || 0) + 1;
          await avisarTG('🚫 *No retiró y no respondió* (48 h)\n' + c.customer_name + ' · ' + c.customer_phone
            + '\nPedido ' + o.reference + ' · $' + Number(o.total || 0).toFixed(2)
            + '\n✅ El stock volvió a la tienda.'
            + (veces >= 2 ? '\n\n⚠️ *Es la ' + veces + 'ª vez* → la próxima compra va con *pago adelantado con tarjeta* 💳' : ''));
          await avisar(c.customer_phone, {
            texto: 'Hola ' + nombre + ' 👋 Cerramos tu pedido *' + o.reference + '* porque no pudimos coordinar la entrega y el producto volvió a la tienda.\n\nSi lo querés, volvé a comprarlo cuando quieras 💛',
            correo: o.customer_email || undefined, asunto: 'Tu pedido de BARATUSS volvió a la tienda',
            html: htmlSimple('Cerramos tu pedido', 'Cerramos tu pedido ' + o.reference + ' porque no pudimos coordinar la entrega.\nEl producto volvió a la tienda — si lo querés, podés comprarlo de nuevo cuando quieras 💛'),
            ref: o.reference, etiqueta: 'NS-CIERRE',
          });
          log.push('NS-CIERRE ' + o.reference);
        } else {
          // Ya pagó: NO se toca nada sin Cindy
          await supabase.from('incidencias_entrega').update({ estado: 'esperando_cindy' }).eq('id', c.id);
          if (!(c.notas || '').includes('NS-PAGADO')) {
            const aviso = '💰 *Cliente PAGÓ y no retiró* (48 h sin respuesta)\n' + c.customer_name + ' · ' + c.customer_phone
              + '\nPedido ' + o.reference + ' · $' + Number(o.total || 0).toFixed(2)
              + '\n\nDecidí vos: guardarlo / devolverle el dinero / darle crédito.\nPodés hacerlo desde el panel → Contingencias.';
            await avisarTG(aviso);
            await enviarTexto(CINDY_WA, aviso, 'NS-PAGADO-48H');
            await supabase.from('incidencias_entrega').update({ notas: ((c.notas || '') + '\n💰 NS-PAGADO ' + sello()).trim() }).eq('id', c.id);
            log.push('NS-PAGADO ' + o.reference);
          }
        }
      }
    }
  } catch (e) { log.push('err no-show: ' + String(e).slice(0, 90)); }

  // La plantilla de pago se usa SOLO si Cindy la autorizó (costo por mensaje).
  // Mientras esté en 'off', los recordatorios salen por ventana de 24 h o correo.
  const { data: cfg } = await supabase.from('config_operativa')
    .select('valor').eq('clave', 'recordatorio_pago_plantilla').maybeSingle();
  (globalThis as Record<string, unknown>)._usarPlantillaPago = String(cfg?.valor || 'off') === 'on';
  return { ok: true, log, plantilla_pago: String(cfg?.valor || 'off'), errores_correo: erroresCorreo.length ? erroresCorreo : undefined };
}

// ========================================================================
// ACCIONES
// ========================================================================
async function marcarNoShow(reference: string) {
  const { data: o } = await supabase.from('orders')
    .select('reference, customer_name, customer_phone, customer_email, items, total, payment_status, delivery_point, status')
    .eq('reference', reference).maybeSingle();
  if (!o) return json({ ok: false, error: 'pedido no encontrado' }, 404);
  if (['entregado', 'cancelado', 'vencido', 'no-retirado'].includes(String(o.status))) {
    return json({ ok: false, error: 'ese pedido ya está cerrado (' + o.status + ')' }, 400);
  }

  const pagado = ['pagado', 'aprobado'].includes(String(o.payment_status));
  const punto = String(o.delivery_point || 'el punto de entrega').replace(/^\w+\s—\s/, '');
  const nombre = primerNombre(o.customer_name);
  const producto = productoDe(o.items || []);

  // Marcar los despachos del pedido
  await supabase.from('despachos')
    .update({ estado_logistico: 'no-show', updated_at: new Date().toISOString() })
    .eq('order_reference', reference).not('estado_logistico', 'in', '("entregado","cancelado")');

  // Ficha del caso
  const { data: inc } = await supabase.from('incidencias_entrega').insert({
    order_reference: reference,
    customer_name: o.customer_name, customer_phone: o.customer_phone,
    tipo: 'no_show', motivo: pagado ? 'no retiró (ya pagado)' : 'no retiró (efectivo)',
    detalle: 'Marcado desde el panel el ' + sello(),
    estado: 'esperando_cliente',
    opciones_probadas: JSON.stringify(['menu enviado']),
  }).select('id').single();

  // Mensaje al cliente
  const texto = pagado ? msjNoShowPagado(nombre, punto) : msjNoShowEfectivo(nombre, punto, producto);
  const via = await avisar(o.customer_phone || '', {
    texto,
    correo: o.customer_email || undefined,
    asunto: 'Te esperamos y no te vimos — tu pedido BARATUSS',
    html: htmlSimple('No te vimos hoy 👋', texto),
    ref: reference, etiqueta: pagado ? 'NS-MENU-PAGADO' : 'NS-MENU',
  });

  // Aviso a Cindy
  const aviso = (pagado ? '💰 ' : '🚫 ') + '*No vino*: ' + o.customer_name + ' · ' + o.customer_phone
    + '\nPedido ' + reference + ' · $' + Number(o.total || 0).toFixed(2) + ' · ' + (pagado ? 'YA PAGADO' : 'efectivo')
    + '\nSe le mandó el menú (' + via + ').'
    + (pagado ? '\n\n⚠️ Ya pagó: si no responde en 48 h te aviso para decidir.' : '\n\nSi no responde en 48 h, el stock vuelve solo.');
  await avisarTG(aviso);
  await enviarTexto(CINDY_WA, aviso, 'NS-AVISO');

  return json({ ok: true, incidencia_id: inc?.id || null, pagado, via });
}

async function opcionNoShow(incidencia_id: number, opcion: string) {
  const { data: inc } = await supabase.from('incidencias_entrega').select('*').eq('id', incidencia_id).maybeSingle();
  if (!inc) return json({ ok: false, error: 'caso no encontrado' }, 404);
  const { data: o } = await supabase.from('orders').select('*').eq('reference', inc.order_reference).maybeSingle();
  if (!o) return json({ ok: false, error: 'pedido no encontrado' }, 404);

  const pagado = ['pagado', 'aprobado'].includes(String(o.payment_status));
  const nombre = primerNombre(o.customer_name);
  const op = String(opcion || '').replace(/\D/g, '');
  let hecho = '';

  if (op === '1') {
    // Reprogramar / guardar para el próximo punto
    await supabase.from('despachos')
      .update({ estado_logistico: 'pendiente-preparacion', prioridad: true, reprogramado_de: inc.motivo || 'no-show', updated_at: new Date().toISOString() })
      .eq('order_reference', o.reference).not('estado_logistico', 'in', '("entregado","cancelado")');
    await supabase.from('incidencias_entrega').update({
      estado: 'resuelto', opcion_cliente: 'reprogramar', respuesta_cliente: 'reprograma', resuelto_en: new Date().toISOString(),
    }).eq('id', incidencia_id);
    hecho = 'reprogramado con PRIORIDAD ⭐';
  } else if (op === '2') {
    // Cancelar (y si ya pagó, generar el reembolso para que Cindy lo pague en Wompi)
    await supabase.rpc('cerrar_pedido_sin_venta', { p_ref: o.reference, p_motivo: 'cancelado' });
    if (pagado) {
      await supabase.from('reembolsos').insert({
        order_reference: o.reference, incidencia_id: incidencia_id,
        customer_name: o.customer_name, customer_phone: o.customer_phone,
        monto: Number(o.total || 0), motivo: 'no retiró — pidió devolución', metodo: 'wompi', estado: 'solicitado',
      });
    }
    await supabase.from('incidencias_entrega').update({
      estado: 'resuelto', opcion_cliente: 'cancelar', respuesta_cliente: 'cancela', resuelto_en: new Date().toISOString(),
    }).eq('id', incidencia_id);
    hecho = pagado ? 'cancelado + reembolso solicitado (pagarlo en Wompi)' : 'cancelado, stock devuelto';
  } else if (op === '3') {
    if (pagado) {
      // Crédito para otra compra = cupón por el monto pagado
      const cod = 'BARATUSS-CR-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      await supabase.from('cupones').insert({
        codigo: cod, tipo: 'credito', valor: Number(o.total || 0), tope: Number(o.total || 0),
        cliente_telefono: o.customer_phone, origen: 'no_show', incidencia_id: incidencia_id,
        nivel: 4, aprobado_por: 'Cindy', notas: 'Crédito por pedido no retirado ' + o.reference,
      });
      await supabase.from('incidencias_entrega').update({
        estado: 'resuelto', opcion_cliente: 'credito', respuesta_cliente: 'credito',
        cupon_codigo: cod, cupon_descuento: Number(o.total || 0), resuelto_en: new Date().toISOString(),
      }).eq('id', incidencia_id);
      await avisar(o.customer_phone || '', {
        texto: '¡Listo, ' + nombre + '! 💛 Te dejé un *crédito de $' + Number(o.total || 0).toFixed(2) + '* para tu próxima compra.\n\nTu código es *' + cod + '* — lo escribís en el checkout y se te descuenta. Vale por 30 días.',
        correo: o.customer_email || undefined, asunto: 'Tu crédito BARATUSS',
        html: htmlSimple('Tu crédito está listo 🎟️', 'Te dejamos un crédito de $' + Number(o.total || 0).toFixed(2) + ' para tu próxima compra.\nCódigo: ' + cod + '\nVale por 30 días.'),
        ref: o.reference, etiqueta: 'NS-CREDITO',
      });
      hecho = 'crédito ' + cod + ' enviado';
    } else {
      // Efectivo: quiere hablar con Cindy
      await supabase.from('incidencias_entrega').update({
        estado: 'abierta', opcion_cliente: 'contactar', respuesta_cliente: 'quiere_hablar',
        notas: (String(inc.notas || '') + '\n📞 PIDIÓ HABLAR ' + sello()).trim(),
      }).eq('id', incidencia_id);
      hecho = 'quiere hablar con Cindy';
    }
  } else {
    return json({ ok: false, error: 'opción no válida' }, 400);
  }

  const aviso = '📩 *Respuesta del cliente (no-show)*\n' + o.customer_name + ' · ' + o.customer_phone
    + '\nPedido ' + o.reference + '\nEligió: *' + op + '* → ' + hecho;
  await avisarTG(aviso);
  await enviarTexto(CINDY_WA, aviso, 'NS-OPCION');

  return json({ ok: true, opcion: op, hecho, pagado });
}

// ¿La llamada es interna (cron / otro servicio)? Se acepta la clave del servicio o
// cualquier token con privilegios de servicio (se comprueba leyendo una tabla con RLS).
async function esLlamadaInterna(req: Request): Promise<boolean> {
  const auth = String(req.headers.get('Authorization') || '').trim();
  const key = String(req.headers.get('apikey') || '').trim();
  const tok = auth.replace(/^Bearer\s+/i, '') || key;
  if (!tok) return false;
  if (SERVICE_KEY && (tok === SERVICE_KEY || auth.includes(SERVICE_KEY))) return true;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/wa_telefonos?select=telefono&limit=1', {
      headers: { apikey: tok, Authorization: 'Bearer ' + tok },
    });
    return r.ok;
  } catch (_e) { return false; }
}

// ========================================================================
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const accion = String(body.accion || 'revisar');

    // Acciones automáticas: solo con la clave del servicio (las llama el cron)
    if (accion === 'revisar') {
      if (!(await esLlamadaInterna(req))) return json({ ok: false, error: 'no autorizado' }, 401);
      return json(await revisar());
    }

    if (accion === 'noshow') {
      if (!body.reference) return json({ ok: false, error: 'falta reference' }, 400);
      return await marcarNoShow(String(body.reference));
    }
    if (accion === 'noshow_opcion') {
      if (!body.incidencia_id) return json({ ok: false, error: 'falta incidencia_id' }, 400);
      return await opcionNoShow(Number(body.incidencia_id), String(body.opcion || ''));
    }
    if (accion === 'guardar-intento') {
      const tel = normalizarTel(String(body.telefono || ''));
      if (!tel || tel.length < 11) return json({ ok: false, error: 'telefono invalido' }, 400);
      const { data: ya } = await supabase.from('carritos_abandonados').select('telefono, avisado_en').eq('telefono', tel).maybeSingle();
      if (ya && ya.avisado_en) return json({ ok: true, omitido: 'ya avisado' });   // nunca más de 1 mensaje
      await supabase.from('carritos_abandonados').upsert({
        telefono: tel, nombre: body.nombre || null, items: body.items || [],
        total: Number(body.total || 0), actualizado_en: new Date().toISOString(),
      });
      return json({ ok: true, guardado: tel });
    }
    // Correo genérico (interno): lo usan otras funciones para avisos/notas de crédito
    if (accion === 'enviar-correo') {
      if (!(await esLlamadaInterna(req))) return json({ ok: false, error: 'no autorizado' }, 401);
      const ok = await correo(String(body.destino || ''), String(body.asunto || 'BARATUSS'), String(body.html || ''));
      return json({ ok, via: ok ? 'correo' : 'no_enviado', errores: erroresCorreo });
    }
    if (accion === 'consultar-cliente') {
      const tel = normalizarTel(String(body.telefono || ''));
      const { data: ns } = await supabase.rpc('no_shows_cliente', { p_telefono: tel });
      const { data: wa } = await supabase.from('wa_telefonos').select('tiene_whatsapp, motivo').eq('telefono', tel).maybeSingle();
      return json({ ok: true, ...(ns || {}), whatsapp: wa || null });
    }

    return json({ ok: false, error: 'acción desconocida: ' + accion }, 400);
  } catch (e) {
    console.log('ERROR pagos-noshow', String(e));
    return json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
});
