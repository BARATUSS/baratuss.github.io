// ============================================================
// BARATUSS · enviar-factura
// Envía por correo el documento (factura de consumidor final / CCF) de los pedidos
// que lo pidieron, y los marca como enviados (para que desaparezcan del panel).
//
// Cómo funciona: lee los pedidos pendientes de la base, arma el documento en HTML
// (formato de correo: tablas e inline styles), lo manda con la API de Gmail de la
// cuenta autorizada y marca factura_enviada_en = ahora.
//
// Seguridad: la función es pública (no-verify-jwt) pero exige la clave FACTURA_KEY
// en el encabezado x-baratuss-key, para que nadie más pueda disparar envíos.
// ============================================================
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const G_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const G_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const G_REFRESH = Deno.env.get('GOOGLE_REFRESH_TOKEN') || '';
const FACTURA_KEY = Deno.env.get('FACTURA_KEY') || '';
const REMITENTE = Deno.env.get('FACTURA_REMITENTE') || 'BARATUSS <cindyrubiomusic@gmail.com>';

const IVA = 0.13;
const EMISOR = {
  nombre: 'BARATUSS',
  razonSocial: 'Cindy Rubio — persona natural',
  nit: 'PENDIENTE',
  nrc: 'PENDIENTE',
  giro: 'Comercio al por menor de prendas de vestir, accesorios y cosméticos',
  direccion: 'San Salvador, El Salvador',
  telefono: '+503 6285 2631',
  correo: 'cindyrubiomusic@gmail.com',
  establecimiento: '0001',
  simulacion: true, // ← false cuando exista NRC + DTE autorizado
};

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function tokenGmail() {
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

function documentoHTML(o: Record<string, any>) {
  const total = Number(o.total || 0);
  const gravada = total / (1 + IVA);
  const iva = total - gravada;
  const esCCF = o.factura_tipo === 'ccf';
  const f = new Date(o.created_at || Date.now());
  const fechaTxt = f.toLocaleDateString('es-SV') + ' ' + f.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' });
  const correlativo = (EMISOR.simulacion ? 'SIM-' : '') + (esCCF ? 'CCF' : 'CF') + '-' + String(o.reference || '').slice(-6);
  const filas = (o.items || []).map((it: any) => {
    const sub = (it.price || 0) * (it.qty || 1);
    return `<tr>
      <td style="padding:6px 4px;border-bottom:1px dotted #eee;font-size:13px;">${it.qty || 1}</td>
      <td style="padding:6px 4px;border-bottom:1px dotted #eee;font-size:13px;">${it.name}${it.size ? ' · Talla ' + it.size : ''}<span style="color:#aaa;font-size:11px;"> · cód. #${it.id}</span></td>
      <td style="padding:6px 4px;border-bottom:1px dotted #eee;font-size:13px;text-align:right;white-space:nowrap;">$${((sub / (1 + IVA)) / (it.qty || 1)).toFixed(2)}</td>
      <td style="padding:6px 4px;border-bottom:1px dotted #eee;font-size:13px;text-align:right;white-space:nowrap;">$${(sub / (1 + IVA)).toFixed(2)}</td>
    </tr>`;
  }).join('');

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:640px;font-size:13px;">
  ${EMISOR.simulacion ? `<div style="background:#fff4e5;border:1px dashed #e0a04a;color:#a5620b;font-size:10px;font-weight:bold;letter-spacing:1px;text-align:center;padding:6px;border-radius:8px;margin-bottom:10px;">SIMULACIÓN — DOCUMENTO SIN VALOR FISCAL</div>` : ''}
  <table cellpadding="0" cellspacing="0" style="width:100%;border-bottom:2px solid #ff9686;padding-bottom:10px;">
    <tr>
      <td style="vertical-align:top;">
        <div style="font-size:22px;font-weight:bold;">${EMISOR.nombre}</div>
        <div style="color:#555;font-size:11px;line-height:1.5;">${EMISOR.razonSocial}<br>
        NIT: ${EMISOR.nit} · NRC: ${EMISOR.nrc}<br>
        Giro: ${EMISOR.giro}<br>
        Dirección: ${EMISOR.direccion}<br>
        Tel. ${EMISOR.telefono} · ${EMISOR.correo}<br>
        Establecimiento: ${EMISOR.establecimiento}</div>
      </td>
      <td style="vertical-align:top;text-align:right;">
        <div style="color:#c9553f;font-size:10px;font-weight:bold;">${esCCF ? 'COMPROBANTE DE CRÉDITO FISCAL' : 'FACTURA DE CONSUMIDOR FINAL'}</div>
        <div style="font-size:15px;font-weight:bold;margin:2px 0 5px;">N° ${correlativo}</div>
        <div style="color:#555;font-size:11px;line-height:1.5;">Fecha de emisión: ${fechaTxt}<br>
        Condición de pago: contado<br>
        Referencia interna: ${o.reference || '—'}</div>
      </td>
    </tr>
  </table>

  <div style="margin-top:12px;">
    <div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#999;margin-bottom:6px;">Datos del comprador</div>
    <table cellpadding="0" cellspacing="0" style="width:100%;font-size:12px;">
      <tr><td style="width:50%;padding:2px 0;vertical-align:top;"><span style="color:#999;font-size:10px;text-transform:uppercase;">Nombre</span><br>${o.factura_nombre || o.customer_name || 'Consumidor final'}</td>
          <td style="padding:2px 0;vertical-align:top;"><span style="color:#999;font-size:10px;text-transform:uppercase;">NIT</span><br>${esCCF ? (o.factura_nit || '—') : '—'}</td></tr>
      <tr><td style="padding:2px 0;vertical-align:top;"><span style="color:#999;font-size:10px;text-transform:uppercase;">NRC</span><br>${esCCF ? (o.factura_nrc || '—') : '—'}</td>
          <td style="padding:2px 0;vertical-align:top;"><span style="color:#999;font-size:10px;text-transform:uppercase;">Giro</span><br>${esCCF ? (o.factura_giro || '—') : '—'}</td></tr>
      <tr><td style="padding:2px 0;vertical-align:top;" colspan="2"><span style="color:#999;font-size:10px;text-transform:uppercase;">Dirección</span><br>${esCCF ? (o.factura_direccion || '—') : '—'}</td></tr>
      <tr><td style="padding:2px 0;vertical-align:top;"><span style="color:#999;font-size:10px;text-transform:uppercase;">Teléfono</span><br>${o.customer_phone || '—'}</td>
          <td style="padding:2px 0;vertical-align:top;"><span style="color:#999;font-size:10px;text-transform:uppercase;">Entrega</span><br>${o.delivery_point || '—'}</td></tr>
    </table>
  </div>

  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:14px;">
    <tr>
      <th style="font-size:10px;text-transform:uppercase;color:#888;text-align:left;border-bottom:1px solid #ddd;padding:5px 4px;">Cant.</th>
      <th style="font-size:10px;text-transform:uppercase;color:#888;text-align:left;border-bottom:1px solid #ddd;padding:5px 4px;">Descripción</th>
      <th style="font-size:10px;text-transform:uppercase;color:#888;text-align:right;border-bottom:1px solid #ddd;padding:5px 4px;">P. unitario</th>
      <th style="font-size:10px;text-transform:uppercase;color:#888;text-align:right;border-bottom:1px solid #ddd;padding:5px 4px;">Ventas gravadas</th>
    </tr>
    ${filas}
  </table>

  <table cellpadding="0" cellspacing="0" style="width:100%;margin-top:10px;border-top:2px solid #eee;">
    <tr><td style="padding:3px 0;font-size:13px;">Ventas gravadas</td><td style="padding:3px 0;font-size:13px;text-align:right;font-weight:bold;">$${gravada.toFixed(2)}</td></tr>
    <tr><td style="padding:3px 0;font-size:13px;">IVA 13% (incluido)</td><td style="padding:3px 0;font-size:13px;text-align:right;font-weight:bold;">$${iva.toFixed(2)}</td></tr>
    <tr><td style="padding:8px 0;font-size:15px;font-weight:bold;border-top:1px solid #eee;">Total a pagar</td><td style="padding:8px 0;font-size:15px;font-weight:bold;text-align:right;border-top:1px solid #eee;">$${total.toFixed(2)}</td></tr>
  </table>

  <div style="margin-top:14px;padding-top:8px;border-top:1px dashed #ddd;color:#888;font-size:10px;line-height:1.6;">
    El IVA (13%) ya está incluido en los precios. Documento generado electrónicamente el ${fechaTxt}.<br>
    ${EMISOR.simulacion
      ? '⚠️ Documento de PRUEBA del sistema de facturación: no tiene valor fiscal mientras el emisor no cuente con NRC y la autorización de Documentos Tributarios Electrónicos (DTE) del Ministerio de Hacienda.'
      : 'Entrega: por correo electrónico o en el punto de retiro.'}
  </div>
</div>`;
}

function cuerpoCorreo(o: Record<string, any>) {
  const esCCF = o.factura_tipo === 'ccf';
  return `<div style="background:#f7f7f7;padding:20px;">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:22px;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;letter-spacing:2px;margin-bottom:6px;">BARATUSS</div>
      <p style="font-size:14px;color:#333;margin:0 0 14px;">¡Hola ${o.factura_nombre || o.customer_name || ''}! 💖<br>
      Gracias por tu compra. Te dejamos tu <strong>${esCCF ? 'comprobante de crédito fiscal' : 'factura de consumidor final'}</strong>.</p>
      ${documentoHTML(o)}
      <p style="font-size:12px;color:#888;margin-top:18px;">Cualquier consulta, escribinos al <strong>+503 6285 2631</strong>.<br>BARATUSS · San Salvador, El Salvador</p>
    </div>
  </div>`;
}

async function enviarCorreo(accessToken: string, destinatario: string, asunto: string, html: string) {
  const mime = [
    `From: ${REMITENTE}`,
    `To: ${destinatario}`,
    `Subject: =?UTF-8?B?${b64(asunto)}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
  ].join('\r\n');

  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Gmail rechazó el envío: ' + JSON.stringify(d).slice(0, 250));
  return { id: d.id, threadId: d.threadId };
}

async function pendientes() {
  const q = 'orders?select=reference,customer_name,customer_phone,customer_email,factura_tipo,factura_nombre,factura_nit,factura_nrc,factura_giro,factura_direccion,total,items,delivery_point,created_at'
    + '&factura_por_correo=eq.true&factura_enviada_en=is.null&factura_tipo=neq.ninguna&customer_email=not.is.null&order=created_at.asc&limit=20';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
  });
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error('No se pudieron leer los pedidos: ' + JSON.stringify(d).slice(0, 200));
  return d;
}

async function marcarEnviada(ref: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/orders?reference=eq.${encodeURIComponent(ref)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ factura_enviada_en: new Date().toISOString() }),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const clave = req.headers.get('x-baratuss-key') || '';
    if (!FACTURA_KEY || clave !== FACTURA_KEY) return json({ error: 'no autorizado' }, 401);

    let soloUna: string | null = null;
    try { const b = await req.json(); soloUna = b?.referencia || null; } catch (_e) { /* sin cuerpo */ }

    if (!G_ID || !G_SECRET || !G_REFRESH) return json({ error: 'faltan las credenciales de correo' }, 500);

    let lista = await pendientes();
    if (soloUna) lista = lista.filter((o: any) => o.reference === soloUna);
    if (!lista.length) return json({ ok: true, enviadas: 0, detalle: 'no había facturas pendientes' });

    const token = await tokenGmail();
    const resultados = [];
    for (const o of lista) {
      try {
        const esCCF = o.factura_tipo === 'ccf';
        const asunto = `Tu ${esCCF ? 'comprobante de crédito fiscal' : 'factura'} de BARATUSS · #${o.reference}`;
        const envio = await enviarCorreo(token, o.customer_email, asunto, cuerpoCorreo(o));
        await marcarEnviada(o.reference);
        resultados.push({ referencia: o.reference, para: o.customer_email, gmail_id: envio.id, ok: true });
      } catch (e) {
        resultados.push({ referencia: o.reference, para: o.customer_email, ok: false, error: String(e).slice(0, 200) });
      }
    }
    return json({ ok: true, enviadas: resultados.filter((r) => r.ok).length, resultados });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
