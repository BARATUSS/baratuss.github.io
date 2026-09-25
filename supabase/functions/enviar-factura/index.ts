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
// Generación del código QR dentro de la función (sin servicios externos)
import QRCode from 'https://esm.sh/qrcode@1.5.3';
import { PDFDocument, rgb, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const G_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const G_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const G_REFRESH = Deno.env.get('GOOGLE_REFRESH_TOKEN') || '';
const FACTURA_KEY = Deno.env.get('FACTURA_KEY') || '';
const REMITENTE = Deno.env.get('FACTURA_REMITENTE') || 'BARATUSS <baratusses@gmail.com>';
const WA_TOKEN = Deno.env.get('META_WA_TOKEN') || '';
const WA_PHONE_ID = Deno.env.get('META_PHONE_ID') || '';

const IVA = 0.13;
const EMISOR = {
  nombre: 'BARATUSS',
  razonSocial: 'Cindy Rubio — persona natural',
  nit: 'PENDIENTE',
  nrc: 'PENDIENTE',
  giro: 'Comercio al por menor de prendas de vestir, accesorios y cosméticos',
  direccion: 'San Salvador, El Salvador',
  telefono: '+503 6285 2631',
  correo: 'baratusses@gmail.com',
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

// ============================================================
// QR → PNG sin dependencias (la librería qrcode necesita 'canvas' para hacer PNG,
// que no existe en el servidor; acá se arma el PNG a mano)
// ============================================================
const CID_QR = 'qr-documento@baratuss';
let _qrPng: Uint8Array | null = null;

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const enteroBE = (n: number) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
function unir(trozos: Uint8Array[]) {
  const total = trozos.reduce((s, t) => s + t.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const t of trozos) { out.set(t, p); p += t.length; }
  return out;
}
function bloque(tipo: string, datos: Uint8Array) {
  const t = new TextEncoder().encode(tipo);
  return unir([enteroBE(datos.length), t, datos, enteroBE(crc32(unir([t, datos])))]);
}

async function qrPng(texto: string, escala = 4, quiet = 4): Promise<Uint8Array> {
  const qr = (QRCode as any).create(texto, { errorCorrectionLevel: 'M' });
  const size: number = qr.modules.size;
  const datos: Uint8Array = qr.modules.data;
  const lado = (size + quiet * 2) * escala;
  const filas: Uint8Array[] = [];
  for (let y = 0; y < size + quiet * 2; y++) {
    const fila = new Uint8Array(1 + lado);
    for (let x = 0; x < size + quiet * 2; x++) {
      let oscuro = false;
      if (y >= quiet && y < quiet + size && x >= quiet && x < quiet + size) {
        oscuro = !!datos[(y - quiet) * size + (x - quiet)];
      }
      const v = oscuro ? 0 : 255;
      for (let k = 0; k < escala; k++) fila[1 + x * escala + k] = v;
    }
    for (let k = 0; k < escala; k++) filas.push(fila);   // repetir la fila hacia abajo
  }
  const crudo = unir(filas);
  const cs = new CompressionStream('deflate');
  const escritor = cs.writable.getWriter();
  escritor.write(crudo);
  escritor.close();
  const comprimido = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  const ihdr = unir([enteroBE(lado), enteroBE(lado), Uint8Array.from([8, 0, 0, 0, 0])]);
  return unir([
    Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    bloque('IHDR', ihdr),
    bloque('IDAT', comprimido),
    bloque('IEND', new Uint8Array(0)),
  ]);
}

// ============================================================
// QR compartido entre el comprobante HTML (correo) y el PDF (WhatsApp).
// Se arma UNA vez por pedido y queda en `_qrPng` para ambos medios.
// ============================================================
async function prepararQR(o: Record<string, any>): Promise<void> {
  const total = Number(o.total || 0);
  const esCCF = o.factura_tipo === 'ccf';
  const f = new Date(o.created_at || Date.now());
  const fechaTxt = f.toLocaleDateString('es-SV') + ' ' + f.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' });
  const correlativo = (EMISOR.simulacion ? 'SIM-' : '') + (esCCF ? 'CCF' : 'CF') + '-' + String(o.reference || '').slice(-6);
  _qrPng = null;
  try {
    const textoQR = [
      (esCCF ? 'COMPROBANTE DE CRÉDITO FISCAL' : 'FACTURA DE CONSUMIDOR FINAL') + ' — ' + EMISOR.nombre,
      'N°: ' + correlativo,
      'Fecha: ' + fechaTxt,
      'Emisor — NIT: ' + EMISOR.nit + ' / NRC: ' + EMISOR.nrc,
      'Receptor: ' + (o.factura_nombre || o.customer_name || 'Consumidor final'),
      'Total: $' + total.toFixed(2),
      'Referencia: ' + (o.reference || '—'),
      EMISOR.simulacion ? 'DOCUMENTO DE SIMULACIÓN — SIN VALOR FISCAL' : '',
    ].filter(Boolean).join('\n');
    _qrPng = await qrPng(textoQR, 4, 4);
  } catch (_e) { _qrPng = null; }
}

// ============================================================
// PDF de la factura (WhatsApp) — mismo contenido que el comprobante de correo,
// armado con pdf-lib (prolijo, no pixel-perfect al HTML). El QR se reutiliza
// desde `_qrPng` (embedPng). No lleva emojis: StandardFonts sólo soporta WinAnsi.
// ============================================================
async function generarPDF(o: Record<string, any>): Promise<Uint8Array> {
  const total = Number(o.total || 0);
  const gravada = total / (1 + IVA);
  const iva = total - gravada;
  const esCCF = o.factura_tipo === 'ccf';
  const f = new Date(o.created_at || Date.now());
  const fechaTxt = f.toLocaleDateString('es-SV') + ' ' + f.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' });
  const correlativo = (EMISOR.simulacion ? 'SIM-' : '') + (esCCF ? 'CCF' : 'CF') + '-' + String(o.reference || '').slice(-6);

  await prepararQR(o);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const W = 595.28, H = 841.89;
  const m = 48;
  const ancho = W - m * 2;

  const negro = rgb(0.13, 0.13, 0.13);
  const gris = rgb(0.35, 0.35, 0.35);
  const grisClaro = rgb(0.6, 0.6, 0.6);
  const rosa = rgb(0.78, 0.33, 0.25);
  const ambar = rgb(0.878, 0.627, 0.043);
  const ambarFondo = rgb(1, 0.957, 0.898);
  const ambarTexto = rgb(0.647, 0.384, 0.043);

  const partir = (t: string, fnt: any, s: number, max: number): string[] => {
    const palabras = String(t || '').split(' ');
    const lineas: string[] = [];
    let cur = '';
    for (const p of palabras) {
      const prueba = cur ? cur + ' ' + p : p;
      if (fnt.widthOfTextAtSize(prueba, s) > max && cur) { lineas.push(cur); cur = p; }
      else cur = prueba;
    }
    if (cur) lineas.push(cur);
    return lineas.length ? lineas : [''];
  };
  const dibujarDerecha = (t: string, xDerecha: number, yTop: number, s: number, fnt: any, c: any) => {
    page.drawText(t, { x: xDerecha - fnt.widthOfTextAtSize(t, s), y: yTop, size: s, font: fnt, color: c });
  };

  let y = H - 48;

  // Banner de simulación
  if (EMISOR.simulacion) {
    const alto = 24;
    page.drawRectangle({ x: m, y: y - alto, width: ancho, height: alto, color: ambarFondo, borderColor: ambar, borderWidth: 1 });
    const t = 'SIMULACIÓN — DOCUMENTO SIN VALOR FISCAL';
    const w = bold.widthOfTextAtSize(t, 10);
    page.drawText(t, { x: m + (ancho - w) / 2, y: y - alto + 7, size: 10, font: bold, color: ambarTexto });
    y -= alto + 22;
  }

  // Encabezado: emisor a la izquierda, N° de documento a la derecha
  const yHeader = y;
  page.drawText('BARATUSS', { x: m, y, size: 24, font: bold, color: negro });
  y -= 16;
  const datosEmisor = [
    EMISOR.razonSocial,
    'NIT: ' + EMISOR.nit + ' · NRC: ' + EMISOR.nrc,
    'Giro: ' + EMISOR.giro,
    'Dirección: ' + EMISOR.direccion,
    'Tel. ' + EMISOR.telefono + ' · ' + EMISOR.correo,
    'Establecimiento: ' + EMISOR.establecimiento,
  ];
  for (const l of datosEmisor) {
    for (const ln of partir(l, font, 9, 295)) { page.drawText(ln, { x: m, y, size: 9, font, color: gris }); y -= 13; }
  }

  const xDer = m + ancho - 185;
  page.drawText(esCCF ? 'COMPROBANTE DE CRÉDITO FISCAL' : 'FACTURA DE CONSUMIDOR FINAL', { x: xDer, y: yHeader, size: 9, font: bold, color: rosa });
  page.drawText('N° ' + correlativo, { x: xDer, y: yHeader - 18, size: 14, font: bold, color: negro });
  page.drawText('Fecha de emisión: ' + fechaTxt, { x: xDer, y: yHeader - 34, size: 8.5, font, color: gris });
  page.drawText('Condición de pago: contado', { x: xDer, y: yHeader - 47, size: 8.5, font, color: gris });
  page.drawText('Referencia: ' + (o.reference || '—'), { x: xDer, y: yHeader - 60, size: 8.5, font, color: gris });

  y -= 8;
  page.drawLine({ start: { x: m, y }, end: { x: W - m, y }, thickness: 1.5, color: rosa });
  y -= 22;

  // Datos del comprador (grilla de 2 columnas)
  page.drawText('DATOS DEL COMPRADOR', { x: m, y, size: 9, font: bold, color: grisClaro });
  y -= 16;
  const colW = ancho / 2 - 10;
  const dibujarCampo = (k: string, v: string, x: number, yTop: number) => {
    page.drawText(k.toUpperCase(), { x, y: yTop, size: 7.5, font: bold, color: grisClaro });
    let vy = yTop - 12;
    for (const ln of partir(v, font, 9.5, colW)) { page.drawText(ln, { x, y: vy, size: 9.5, font, color: negro }); vy -= 12; }
  };
  const g0 = y;
  dibujarCampo('Nombre', o.factura_nombre || o.customer_name || 'Consumidor final', m, g0);
  dibujarCampo('NIT', esCCF ? (o.factura_nit || '—') : '—', m + ancho / 2, g0);
  dibujarCampo('NRC', esCCF ? (o.factura_nrc || '—') : '—', m, g0 - 58);
  dibujarCampo('Giro', esCCF ? (o.factura_giro || '—') : '—', m + ancho / 2, g0 - 58);
  dibujarCampo('Dirección', esCCF ? (o.factura_direccion || '—') : '—', m, g0 - 116);
  dibujarCampo('Teléfono', o.customer_phone || '—', m + ancho / 2, g0 - 116);
  dibujarCampo('Entrega', o.delivery_point || '—', m, g0 - 174);
  y = g0 - 200;

  // Tabla de items
  const xCant = m;
  const xDesc = m + 38;
  const xUnit = m + 386;   // borde derecho de "P. unitario"
  const xGrav = W - m;     // borde derecho de "Ventas gravadas"
  let hy = y;
  page.drawText('Cant.', { x: xCant, y: hy, size: 8, font: bold, color: grisClaro });
  page.drawText('Descripción', { x: xDesc, y: hy, size: 8, font: bold, color: grisClaro });
  dibujarDerecha('P. unitario', xUnit, hy, 8, bold, grisClaro);
  dibujarDerecha('Ventas gravadas', xGrav, hy, 8, bold, grisClaro);
  page.drawLine({ start: { x: m, y: hy - 4 }, end: { x: W - m, y: hy - 4 }, thickness: 0.8, color: grisClaro });
  let iy = hy - 8;
  for (const it of (o.items || [])) {
    const qty = it.qty || 1;
    const sub = (it.price || 0) * qty;
    const unitario = sub / (1 + IVA) / qty;
    const subGravada = sub / (1 + IVA);
    const descripcion = (it.name || '') + (it.size ? ' · Talla ' + it.size : '') + ' · cód. #' + it.id;
    const lineas = partir(descripcion, font, 9, 240);
    const alto = Math.max(1, lineas.length) * 11 + 6;
    page.drawText(String(qty), { x: xCant, y: iy - 9, size: 9, font, color: negro });
    let dy = iy - 9;
    for (const ln of lineas) { page.drawText(ln, { x: xDesc, y: dy, size: 9, font, color: negro }); dy -= 11; }
    dibujarDerecha('$' + unitario.toFixed(2), xUnit, iy - 9, 9, font, negro);
    dibujarDerecha('$' + subGravada.toFixed(2), xGrav, iy - 9, 9, font, negro);
    iy -= alto;
    page.drawLine({ start: { x: m, y: iy }, end: { x: W - m, y: iy }, thickness: 0.5, color: rgb(0.93, 0.93, 0.93) });
  }
  y = iy - 16;

  // Totales (bloque a la derecha)
  const xEtiqueta = W - m - 220;
  const dibujarTotal = (k: string, v: string, yy: number, s: number, fnt: any) => {
    page.drawText(k, { x: xEtiqueta, y: yy, size: s, font: fnt, color: negro });
    dibujarDerecha(v, xGrav, yy, s, fnt, negro);
  };
  dibujarTotal('Ventas gravadas', '$' + gravada.toFixed(2), y, 11, font);
  y -= 18;
  dibujarTotal('IVA 13% (incluido)', '$' + iva.toFixed(2), y, 11, font);
  y -= 18;
  page.drawLine({ start: { x: xEtiqueta, y: y + 6 }, end: { x: xGrav, y: y + 6 }, thickness: 0.8, color: negro });
  dibujarTotal('Total a pagar', '$' + total.toFixed(2), y - 14, 14, bold);
  y -= 46;

  // Código QR
  if (_qrPng) {
    try {
      const img = await doc.embedPng(_qrPng);
      const ladoQR = 108;
      const xq = m + (ancho - ladoQR) / 2;
      page.drawImage(img, { x: xq, y: y - ladoQR, width: ladoQR, height: ladoQR });
      const tt = 'Escaneá para verificar este documento';
      page.drawText(tt, { x: m + (ancho - font.widthOfTextAtSize(tt, 9)) / 2, y: y - ladoQR - 16, size: 9, font, color: grisClaro });
      y -= ladoQR + 32;
    } catch (_e) { /* QR no embebido: el PDF sale sin QR */ }
  }

  // Pie legal
  const pie = EMISOR.simulacion
    ? 'Documento de PRUEBA del sistema de facturación: no tiene valor fiscal mientras el emisor no cuente con NRC y la autorización de DTE del Ministerio de Hacienda.'
    : 'El IVA (13%) ya está incluido en los precios.';
  for (const ln of partir(pie, font, 8.5, ancho)) { page.drawText(ln, { x: m, y, size: 8.5, font, color: grisClaro }); y -= 11; }

  return await doc.save();
}

async function documentoHTML(o: Record<string, any>) {
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

  // Código QR: en un DTE autorizado debe llevar el enlace oficial de consulta de Hacienda;
  // mientras no exista autorización, lleva los datos del documento. (Se comparte con el PDF.)
  await prepararQR(o);

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

  ${_qrPng ? `<div style="text-align:center;margin-top:16px;">
    <img src="cid:${CID_QR}" alt="Código QR del documento" width="120" height="120" style="width:120px;height:120px;border:1px solid #eee;border-radius:6px;">
    <div style="color:#999;font-size:10px;margin-top:4px;">Escaneá para verificar este documento</div>
  </div>` : ''}

  <div style="margin-top:14px;padding-top:8px;border-top:1px dashed #ddd;color:#888;font-size:10px;line-height:1.6;">
    El IVA (13%) ya está incluido en los precios. Documento generado electrónicamente el ${fechaTxt}.<br>
    ${EMISOR.simulacion
      ? '⚠️ Documento de PRUEBA del sistema de facturación: no tiene valor fiscal mientras el emisor no cuente con NRC y la autorización de Documentos Tributarios Electrónicos (DTE) del Ministerio de Hacienda.'
      : 'Entrega: por correo electrónico o en el punto de retiro.'}
  </div>
</div>`;
}

async function cuerpoCorreo(o: Record<string, any>) {
  const esCCF = o.factura_tipo === 'ccf';
  return `<div style="background:#f7f7f7;padding:20px;">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:22px;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;letter-spacing:2px;margin-bottom:6px;">BARATUSS</div>
      <p style="font-size:14px;color:#333;margin:0 0 14px;">¡Hola ${o.factura_nombre || o.customer_name || ''}! 💖<br>
      Gracias por tu compra. Te dejamos tu <strong>${esCCF ? 'comprobante de crédito fiscal' : 'factura de consumidor final'}</strong>.</p>
      ${await documentoHTML(o)}
      <p style="font-size:12px;color:#888;margin-top:18px;">Cualquier consulta, escribinos al <strong>+503 6285 2631</strong>.<br>BARATUSS · San Salvador, El Salvador</p>
      <p style="font-size:11px;color:#aaa;margin-top:10px;">¿Este correo te llegó a la carpeta de spam? Marcalo como <strong>"No es spam"</strong> una sola vez y los próximos comprobantes te van a llegar directo a la bandeja.</p>
    </div>
  </div>`;
}

// Versión en TEXTO SIMPLE del comprobante.
// Los filtros de spam castigan los correos que sólo traen HTML + imagen: un correo "normal"
// siempre lleva su versión de texto. Sin esto, las facturas caen en spam (probado 2026-09-23).
function textoPlano(o: Record<string, any>) {
  const total = Number(o.total || 0);
  const gravada = total / (1 + IVA);
  const iva = total - gravada;
  const esCCF = o.factura_tipo === 'ccf';
  const f = new Date(o.created_at || Date.now());
  const correlativo = (EMISOR.simulacion ? 'SIM-' : '') + (esCCF ? 'CCF' : 'CF') + '-' + String(o.reference || '').slice(-6);
  const lineas = (o.items || []).map((it: any) =>
    `  ${it.qty || 1} x ${it.name}${it.size ? ' (talla ' + it.size + ')' : ''} ... $${((it.price || 0) * (it.qty || 1)).toFixed(2)}`);

  return [
    `${esCCF ? 'COMPROBANTE DE CRÉDITO FISCAL' : 'FACTURA DE CONSUMIDOR FINAL'}`,
    `${EMISOR.nombre} — ${EMISOR.razonSocial}`,
    `NIT: ${EMISOR.nit} · NRC: ${EMISOR.nrc}`,
    `Dirección: ${EMISOR.direccion} · Tel: ${EMISOR.telefono}`,
    `Correo: ${EMISOR.correo}`,
    '',
    `N°: ${correlativo}`,
    `Fecha de emisión: ${f.toLocaleDateString('es-SV')} ${f.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' })}`,
    `Condición de pago: contado`,
    `Referencia: ${o.reference || '—'}`,
    '',
    'DATOS DEL COMPRADOR',
    `  Nombre: ${o.factura_nombre || o.customer_name || 'Consumidor final'}`,
    esCCF ? `  NIT: ${o.factura_nit || '—'} · NRC: ${o.factura_nrc || '—'}` : '',
    esCCF ? `  Giro: ${o.factura_giro || '—'}` : '',
    esCCF ? `  Dirección: ${o.factura_direccion || '—'}` : '',
    `  Teléfono: ${o.customer_phone || '—'} · Entrega: ${o.delivery_point || '—'}`,
    '',
    'DETALLE',
    ...lineas,
    '',
    `Ventas gravadas: $${gravada.toFixed(2)}`,
    `IVA 13% (incluido): $${iva.toFixed(2)}`,
    `TOTAL: $${total.toFixed(2)}`,
    '',
    EMISOR.simulacion
      ? 'Documento de PRUEBA del sistema de facturación: no tiene valor fiscal mientras el emisor no cuente con NRC y la autorización de DTE del Ministerio de Hacienda.'
      : 'El IVA (13%) ya está incluido en los precios.',
    '',
    'BARATUSS · San Salvador, El Salvador · +503 6285 2631',
    '¿Este correo te llegó a spam? Marcalo como "No es spam" y los próximos te llegan a la bandeja.',
  ].filter((l) => l !== '').join('\r\n');
}

// Envuelve en base64 y corta las líneas (los clientes de correo lo esperan así)
function envolverBase64(contenido: Uint8Array | string) {
  let s: string;
  if (typeof contenido === 'string') {
    s = contenido;
  } else {
    let t = '';
    for (let i = 0; i < contenido.length; i++) t += String.fromCharCode(contenido[i]);
    s = btoa(t);
  }
  return s.replace(/.{1,76}/g, (m) => m + '\r\n');
}

async function enviarCorreo(accessToken: string, destinatario: string, asunto: string, html: string, texto: string, qr: Uint8Array | null) {
  // Cabeceras completas: sin Message-ID ni Date, los filtros sospechan (probado: caía en spam).
  const cabeceras = [
    `From: ${REMITENTE}`,
    `To: ${destinatario}`,
    `Reply-To: ${EMISOR.correo}`,
    `Subject: =?UTF-8?B?${b64(asunto)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 10)}@baratuss>`,
    'MIME-Version: 1.0',
  ];
  // Estructura estándar de un correo con imagen:
  //   multipart/related
  //     ├── multipart/alternative  → versión TEXTO + versión HTML
  //     └── imagen del QR (por referencia)
  const limRel = '==BARATUSS-REL==';
  const limAlt = '==BARATUSS-ALT==';
  const parteTexto = [
    `--${limAlt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    envolverBase64(b64(texto)),
  ];
  const parteHtml = [
    `--${limAlt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    envolverBase64(b64(html)),
    `--${limAlt}--`,
    '',
  ];
  const trozos = [
    ...cabeceras,
    `Content-Type: multipart/related; boundary="${limRel}"`,
    '',
    `--${limRel}`,
    `Content-Type: multipart/alternative; boundary="${limAlt}"`,
    '',
    ...parteTexto,
    ...parteHtml,
  ];
  if (qr) {
    trozos.push(
      `--${limRel}`,
      'Content-Type: image/png; name="qr-documento.png"',
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${CID_QR}>`,
      'Content-Disposition: inline; filename="qr-documento.png"',
      '',
      envolverBase64(qr),
    );
  }
  trozos.push(`--${limRel}--`, '');
  const mime = trozos.join('\r\n');

  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime) }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Gmail rechazó el envío: ' + JSON.stringify(d).slice(0, 250));
  return { id: d.id, threadId: d.threadId };
}

// ============================================================
// Envío de la factura por WHATSAPP (TAREA 3 · 24-sep-2026)
// Primera versión: mensaje con el resumen del comprobante. El PDF/enlace al
// documento se suma cuando exista generación de PDF (DTE); hoy el comprobante
// vive como HTML de correo. Mismo patrón de envío que la verificación de tel.
// ============================================================
function normalizarTel(tel: string): string {
  let t = (tel || '').replace(/\D/g, '');
  if (t.startsWith('0')) t = '503' + t.slice(1);
  if (t.length === 8) t = '503' + t;
  return t;
}

async function ventanaAbierta(tel: string): Promise<boolean> {
  try {
    const desde = new Date(Date.now() - 24 * 3600000).toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/wa_mensajes?select=id&telefono=eq.${normalizarTel(tel)}&direccion=eq.entrante&creado_en=gte.${encodeURIComponent(desde)}&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
    });
    const d = await r.json();
    return Array.isArray(d) && d.length > 0;
  } catch (_e) { return false; }
}

async function enviarTextoWA(tel: string, texto: string): Promise<string | null> {
  if (!WA_TOKEN || !WA_PHONE_ID) return null;
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizarTel(tel), type: 'text', text: { preview_url: false, body: texto } }),
    });
    const d = await r.json();
    return d?.messages?.[0]?.id ? String(d.messages[0].id) : null;
  } catch (_e) { return null; }
}

// Sube el PDF a Meta como media y devuelve el media id (para type:'document').
// El campo `type` del multipart es el MIME del archivo (application/pdf); el
// `type:'document'` va en el MENSAJE, no en la subida del media.
async function subirMediaWA(pdf: Uint8Array, filename: string): Promise<string | null> {
  if (!WA_TOKEN || !WA_PHONE_ID) return null;
  try {
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', 'application/pdf');
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), filename);
    const r = await fetch('https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/media', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN },
      body: fd,
    });
    const d = await r.json();
    return d?.id ? String(d.id) : null;
  } catch (_e) { return null; }
}

async function enviarDocumentoWA(tel: string, mediaId: string, filename: string, caption: string): Promise<string | null> {
  if (!WA_TOKEN || !WA_PHONE_ID) return null;
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizarTel(tel),
        type: 'document',
        document: { id: mediaId, filename, caption },
      }),
    });
    const d = await r.json();
    return d?.messages?.[0]?.id ? String(d.messages[0].id) : null;
  } catch (_e) { return null; }
}

async function registrarSalienteWA(wamid: string, tel: string, ref: string, contenido: string) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/wa_mensajes`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ wa_message_id: wamid, telefono: normalizarTel(tel), direccion: 'saliente', atendido_por: 'enviar-factura', order_reference: ref || null, texto: contenido }),
    });
  } catch (_e) { /* no romper el envío por el registro */ }
}

function resumenWhatsApp(o: Record<string, any>): string {
  const total = Number(o.total || 0);
  const esCCF = o.factura_tipo === 'ccf';
  const f = new Date(o.created_at || Date.now());
  const fecha = f.toLocaleDateString('es-SV') + ' ' + f.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' });
  const lineas = (o.items || []).slice(0, 8).map((it: any) =>
    `  · ${it.qty || 1}× ${it.name}${it.size ? ' (talla ' + it.size + ')' : ''} — $${((it.price || 0) * (it.qty || 1)).toFixed(2)}`).join('\n');
  const resto = (o.items || []).length > 8 ? '\n  · …' : '';
  return [
    '🧾 ' + (esCCF ? 'Comprobante de crédito fiscal' : 'Factura') + ' de BARATUSS 💛',
    'Pedido: ' + (o.reference || '—'),
    'Fecha: ' + fecha,
    '',
    lineas + resto,
    '',
    'Total: $' + total.toFixed(2),
    'IVA (13%) incluido en los precios.',
    '',
    'Gracias por tu compra 💖',
    'BARATUSS · San Salvador · +503 6285 2631',
  ].join('\n');
}

// Filtro común de "cuándo" (regla de Cindy). Cada medio (correo/WhatsApp) suma
// su propio "quién" (customer_email / customer_phone). Devuelve los pedidos con
// el campo `factura_medio` ya resuelto para que el bucle principal sepa a dónde.
async function pendientes() {
  // ⚠️ REGLA DE CINDY (23-sep-2026) sobre CUÁNDO se manda la factura:
  //    💳 Tarjeta  → SOLO cuando el pago YA CAYÓ (payment_status = 'pagado'/'aprobado')
  //    💵 Efectivo → SOLO cuando el pedido se marca ENTREGADO (status = 'entregado')
  //    NUNCA antes. Esta condición es la ÚNICA fuente de verdad del envío.
  const sel = 'reference,customer_name,customer_phone,customer_email,factura_tipo,factura_nombre,factura_nit,factura_nrc,factura_giro,factura_direccion,total,items,delivery_point,created_at,status';
  const cuando = 'factura_enviada_en=is.null&factura_tipo=neq.ninguna'
    + '&or=(and(payment_method.eq.tarjeta,payment_status.in.(pagado,aprobado)),status.eq.entregado)'
    + '&order=created_at.asc&limit=20';

  const leer = async (filtro: string) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=${sel}&${filtro}&${cuando}`, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
    });
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  };

  const porCorreo = await leer('factura_por_correo=eq.true&customer_email=not.is.null');
  const porWhatsApp = await leer('factura_por_whatsapp=eq.true&customer_phone=not.is.null');
  return [
    ...porCorreo.map((o: any) => ({ ...o, factura_medio: 'correo' })),
    ...porWhatsApp.map((o: any) => ({ ...o, factura_medio: 'whatsapp' })),
  ];
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

    let lista = await pendientes();
    if (soloUna) lista = lista.filter((o: any) => o.reference === soloUna);
    if (!lista.length) return json({ ok: true, enviadas: 0, detalle: 'no había facturas pendientes' });

    if (!G_ID || !G_SECRET || !G_REFRESH) {
      // Las credenciales de correo sólo son obligatorias si hay facturas POR CORREO;
      // las de WhatsApp no las necesitan.
      const hayCorreo = (lista || []).some((o: any) => o.factura_medio === 'correo');
      if (hayCorreo) return json({ error: 'faltan las credenciales de correo' }, 500);
    }

    const hayCorreo = (lista || []).some((o: any) => o.factura_medio === 'correo');
    const token = hayCorreo ? await tokenGmail() : null;

    const resultados = [];
    for (const o of lista) {
      const medio = o.factura_medio === 'whatsapp' ? 'whatsapp' : 'correo';
      try {
        if (medio === 'whatsapp') {
          const tel = normalizarTel(String(o.customer_phone || ''));
          if (!tel) { resultados.push({ referencia: o.reference, medio, ok: false, error: 'sin teléfono' }); continue; }
          // Mismo patrón que la verificación de tel: sin ventana de 24 h el mensaje
          // se pierde (re-engagement). No marcamos enviada → se reintenta cuando la
          // clienta vuelva a escribir.
          if (!(await ventanaAbierta(tel))) {
            resultados.push({ referencia: o.reference, medio, ok: false, error: 'sin ventana 24h (se reintenta)' }); continue;
          }
          // 1) PDF real (documento). 2) Si la generación/subida falla, texto simple.
          let wamid: string | null = null;
          let tipo = 'texto';
          const filename = 'factura-' + (o.reference || 'x') + '.pdf';
          try {
            const pdf = await generarPDF(o);
            const mediaId = await subirMediaWA(pdf, filename);
            if (mediaId) {
              const wid = await enviarDocumentoWA(tel, mediaId, filename, '🧾 Tu factura de BARATUSS 💛');
              if (wid) { wamid = wid; tipo = 'documento'; }
              else console.error('[enviar-factura] Meta rechazó el documento para ' + tel);
            } else {
              console.error('[enviar-factura] No se pudo subir el PDF como media para ' + tel);
            }
          } catch (e) {
            console.error('[enviar-factura] Fallo generando/subiendo el PDF (' + tel + '): ' + String(e).slice(0, 200));
          }
          if (!wamid) {
            // Fallback: el resumen de texto de siempre, para no perder la factura.
            wamid = await enviarTextoWA(tel, resumenWhatsApp(o));
            tipo = 'texto';
          }
          if (!wamid) { resultados.push({ referencia: o.reference, medio, ok: false, error: 'no se pudo enviar' }); continue; }
          const contenido = tipo === 'documento' ? '[PDF] ' + filename + '\n' + resumenWhatsApp(o) : resumenWhatsApp(o);
          await registrarSalienteWA(wamid, tel, o.reference, contenido);
          await marcarEnviada(o.reference);
          resultados.push({ referencia: o.reference, medio, para: tel, ok: true, tipo });
        } else {
          const esCCF = o.factura_tipo === 'ccf';
          const asunto = `Tu ${esCCF ? 'comprobante de crédito fiscal' : 'factura'} de BARATUSS · #${o.reference}`;
          const envio = await enviarCorreo(token!, o.customer_email, asunto, await cuerpoCorreo(o), textoPlano(o), _qrPng);
          await marcarEnviada(o.reference);
          resultados.push({ referencia: o.reference, medio, para: o.customer_email, gmail_id: envio.id, ok: true });
        }
      } catch (e) {
        resultados.push({ referencia: o.reference, medio, ok: false, error: String(e).slice(0, 200) });
      }
    }
    return json({ ok: true, enviadas: resultados.filter((r) => r.ok).length, resultados });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
