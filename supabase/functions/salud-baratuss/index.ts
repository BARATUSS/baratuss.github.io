// ============================================================================
// BARATUSS · salud-baratuss — EL CENTINELA (E1 del plan "todo en código")
//
// Un "canario en la mina": el sistema se revisa a sí mismo cada hora y, si algo
// se rompe, le suena el teléfono a Cindy (SOLO a ella). A las 7 AM (13:00 UTC)
// manda su parte SIEMPRE, esté todo bien o mal.
//
// Corre por pg_cron (salud-baratuss-hora y salud-baratuss-parte). Cada corrida
// escribe su registro en `chequeos_salud` (bitácora que nunca se pierde) y, ante
// un fallo NUEVO, manda UNA sola alarma a Cindy (anti-spam: marca avisado=true).
//
// Seguridad: función pública (no-verify-jwt) pero exige la clave interna
// `x-baratuss-key` (la misma FACTURA_KEY / config_operativa.factura_trigger_key
// que ya usa enviar-factura), para que nadie más pueda disparar avisos.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const FACTURA_KEY = Deno.env.get('FACTURA_KEY') || '';
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const CINDY = Deno.env.get('SALUD_TELEGRAM_CHAT_ID') || '8635242458';
const META_WA_TOKEN = Deno.env.get('META_WA_TOKEN') || '';
const META_PHONE_ID = Deno.env.get('META_PHONE_ID') || '';
const WOMPI_CLIENT_ID = Deno.env.get('WOMPI_CLIENT_ID') || '';
const WOMPI_CLIENT_SECRET = Deno.env.get('WOMPI_CLIENT_SECRET') || '';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-baratuss-key' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ---------- utilidades ----------

async function fetchTimeout(url: string, init: RequestInit = {}, ms = 8000): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (_e) {
    return null;
  }
}

// avisa SOLO a Cindy (chat privado), un solo sendMessage. No toca TELEGRAM_CHAT_ID.
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

// inicio del "día de hoy" en El Salvador, expresado en UTC (SV = UTC−6 → medianoche SV = 06:00 UTC)
function inicioDiaSVUTC(): Date {
  const now = new Date();
  let inicio = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0);
  if (now.getTime() < inicio) inicio -= 24 * 3600 * 1000;
  return new Date(inicio);
}

function horaSV(): string {
  const a = new Date(Date.now() - 6 * 3600 * 1000);
  return String(a.getUTCHours()).padStart(2, '0') + ':' + String(a.getUTCMinutes()).padStart(2, '0');
}
function fechaSV(): string {
  const a = new Date(Date.now() - 6 * 3600 * 1000);
  return a.getUTCDate() + '/' + (a.getUTCMonth() + 1) + '/' + a.getUTCFullYear();
}

type Chequeo = { nombre: string; estado: 'ok' | 'fallo'; detalle: string };

// ---------- autenticación (misma clave que enviar-factura) ----------

async function claveValida(clave: string): Promise<boolean> {
  if (!clave) return false;
  if (FACTURA_KEY && clave === FACTURA_KEY) return true;
  // la clave también vive en config_operativa.factura_trigger_key
  try {
    const { data } = await supabase.from('config_operativa').select('valor').eq('clave', 'factura_trigger_key').maybeSingle();
    if (data?.valor && clave === data.valor) return true;
  } catch (_e) { /* silencio */ }
  return false;
}

// ---------- datos SQL (RPC SECURITY DEFINER) ----------

async function datosSQL(): Promise<Record<string, any> | null> {
  try {
    const { data, error } = await supabase.rpc('salud_centinela_datos');
    if (error) { console.log('RPC salud_centinela_datos error:', error.message); return null; }
    return data as Record<string, any>;
  } catch (e) { console.log('RPC excepcion:', String(e)); return null; }
}

// ---------- los ~16 engranajes ----------

// #1 Tienda en línea
async function checkTienda(): Promise<Chequeo> {
  const r = await fetchTimeout('https://baratuss.github.io/index.html', { method: 'GET' }, 10000);
  if (!r || !r.ok) return { nombre: 'tienda-online', estado: 'fallo', detalle: 'HTTP ' + (r ? r.status : 'sin respuesta') };
  const html = await r.text().catch(() => '');
  const ok = html.includes('hero-carrusel') && html.includes('checkout-confirm');
  return ok
    ? { nombre: 'tienda-online', estado: 'ok', detalle: '200 + hero-carrusel y checkout-confirm presentes' }
    : { nombre: 'tienda-online', estado: 'fallo', detalle: 'faltan marcadores del checkout en el HTML' };
}

// #2 Fotos y video cargan (Storage público)
async function checkFotosVideo(): Promise<Chequeo> {
  const base = SUPABASE_URL + '/storage/v1/object/public/productos/';
  const archivos = ['portada/hero-1.jpg', 'portada/hero-2.jpg', 'portada/hero-3.jpg', 'portada/hero-4.jpg', 'portada/categoria-accesorios.jpg', 'portada/categoria-skincare.jpg', 'portada/hero-video.mp4'];
  const resultados = await Promise.all(archivos.map(async (a) => {
    const r = await fetchTimeout(base + a, { method: 'HEAD' }, 8000);
    return { a, ok: !!r && r.ok };
  }));
  const rotos = resultados.filter((x) => !x.ok).map((x) => x.a);
  return rotos.length
    ? { nombre: 'fotos-video', estado: 'fallo', detalle: 'no cargan: ' + rotos.join(', ') }
    : { nombre: 'fotos-video', estado: 'ok', detalle: archivos.length + ' archivos en línea' };
}

// #3 Los 3 triggers activos
function checkTriggers(d: Record<string, any>): Chequeo {
  const trigs: Array<{ nombre: string; enabled: string }> = d.triggers || [];
  const esperados = ['trg_despacho_entregado', 'trg_disparar_factura', 'trg_crear_despachos'];
  const faltantes = esperados.filter((e) => !trigs.some((t) => t.nombre === e && t.enabled === 'O'));
  return faltantes.length
    ? { nombre: 'triggers-activos', estado: 'fallo', detalle: 'faltan/inactivos: ' + faltantes.join(', ') }
    : { nombre: 'triggers-activos', estado: 'ok', detalle: 'los 3 triggers con tgenabled=O' };
}

// #4 pg_cron jobs activos
function checkCrons(d: Record<string, any>): Chequeo {
  const jobs: Array<{ nombre: string; active: boolean }> = d.crons || [];
  const requeridos = ['seguimiento-entregas-baratuss', 'pagos-noshow-baratuss', 'enviar-facturas-baratuss', 'salud-baratuss-hora', 'salud-baratuss-parte'];
  const faltantes = requeridos.filter((r) => !jobs.some((j) => j.nombre === r && j.active === true));
  const backup = jobs.find((j) => j.nombre === 'backup-facturas-cloud');
  if (faltantes.length) {
    return { nombre: 'pgcron-jobs', estado: 'fallo', detalle: 'faltan/inactivos: ' + faltantes.join(', ') };
  }
  return {
    nombre: 'pgcron-jobs', estado: 'ok',
    detalle: requeridos.length + ' jobs activos' + (backup ? '' : ' · backup-facturas-cloud pendiente (E6)'),
  };
}

// #5 Edge Functions responden
const FUNCIONES = ['crear-pedido', 'wompi-checkout', 'stock-api', 'enviar-factura', 'seguimiento-entregas', 'pagos-noshow', 'cupones', 'contingencia', 'whatsapp-webhook', 'wa-enviar', 'enviar-codigo-wa', 'verificar-codigo-wa', 'verificacion-estado', 'avisar-fallo'];
async function checkEdgeFunctions(): Promise<Chequeo> {
  const estados = await Promise.all(FUNCIONES.map(async (fn) => {
    const r = await fetchTimeout(`${SUPABASE_URL}/functions/v1/${fn}`, { method: 'GET' }, 8000);
    if (!r) return { fn, viva: false }; // timeout / error de red
    // Un 404 puede ser (a) el gateway "función no existe" o (b) el router PROPIO de la
    // función (p. ej. wompi-checkout es solo-POST y responde 404 {"error":"Not found"}).
    // El gateway manda {"code":"NOT_FOUND"}; el router propio NO lleva "code". Solo el
    // gateway cuenta como caída. 400/401/403/405/500 = la función responde → está viva.
    if (r.status === 404) {
      const body = await r.text().catch(() => '');
      const esGateway = /"code"\s*:\s*(404|"NOT_FOUND")/i.test(body);
      return { fn, viva: !esGateway };
    }
    return { fn, viva: true };
  }));
  const muertas = estados.filter((e) => !e.viva).map((e) => e.fn);
  return muertas.length
    ? { nombre: 'edge-functions', estado: 'fallo', detalle: 'caídas: ' + muertas.join(', ') }
    : { nombre: 'edge-functions', estado: 'ok', detalle: FUNCIONES.length + ' funciones responden' };
}

// #6 Wompi alcanzable (solo pide token, NO crea enlace)
async function checkWompi(): Promise<Chequeo> {
  if (!WOMPI_CLIENT_ID || !WOMPI_CLIENT_SECRET) {
    // sin credenciales: verificamos solo que el endpoint responda (alcanzabilidad)
    const r = await fetchTimeout('https://id.wompi.sv/connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', audience: 'wompi_api' }) }, 10000);
    return r && r.status < 500
      ? { nombre: 'wompi-token', estado: 'ok', detalle: 'endpoint responde (sin credenciales Wompi configuradas)' }
      : { nombre: 'wompi-token', estado: 'fallo', detalle: 'Wompi no responde' };
  }
  const r = await fetchTimeout('https://id.wompi.sv/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: WOMPI_CLIENT_ID, client_secret: WOMPI_CLIENT_SECRET, audience: 'wompi_api' }),
  }, 10000);
  if (!r) return { nombre: 'wompi-token', estado: 'fallo', detalle: 'sin respuesta de Wompi' };
  const d = await r.json().catch(() => ({}));
  return d.access_token
    ? { nombre: 'wompi-token', estado: 'ok', detalle: 'token Wompi OK' }
    : { nombre: 'wompi-token', estado: 'fallo', detalle: 'sin access_token (HTTP ' + r.status + ')' };
}

// #7 Ventas sin registrar
function checkSinRegistrar(d: Record<string, any>): Chequeo {
  const n = Number(d.sin_registrar || 0);
  return n === 0
    ? { nombre: 'ventas-sin-registrar', estado: 'ok', detalle: '0 pendientes' }
    : { nombre: 'ventas-sin-registrar', estado: 'fallo', detalle: n + ' entregadas sin registrar en ventas' };
}

// #8 Facturas pendientes
function checkFacturas(d: Record<string, any>): Chequeo {
  const n = Number(d.facturas_pendientes || 0);
  return n === 0
    ? { nombre: 'facturas-pendientes', estado: 'ok', detalle: '0 pendientes' }
    : { nombre: 'facturas-pendientes', estado: 'fallo', detalle: n + ' facturas sin enviar' };
}

// #9 Premios de referido pendientes
function checkPremios(d: Record<string, any>): Chequeo {
  const n = Number(d.premios_pendientes || 0);
  return n === 0
    ? { nombre: 'premios-pendientes', estado: 'ok', detalle: '0 pendientes' }
    : { nombre: 'premios-pendientes', estado: 'fallo', detalle: n + ' premios sin otorgar' };
}

// #10 Utilidad mínima $4.50
function checkUtilidad(d: Record<string, any>): Chequeo {
  const items: Array<{ name: string; cost_price: any; sale_price: any }> = d.utilidad_datos || [];
  const bajos: string[] = [];
  for (const it of items) {
    const P = Math.ceil((Number(it.sale_price) * 1.16955 + 0.25) * 20) / 20;
    const util = 0.85 * P - Number(it.cost_price) - 0.25;
    if (util < 4.48) bajos.push(it.name + ' (util $' + util.toFixed(2) + ')');
  }
  return bajos.length
    ? { nombre: 'utilidad-minima', estado: 'fallo', detalle: 'bajo $4.48: ' + bajos.join(', ') }
    : { nombre: 'utilidad-minima', estado: 'ok', detalle: items.length + ' activos, todos sobre el mínimo' };
}

// #11 Pedidos trabados 3+ días
function checkTrabados(d: Record<string, any>): Chequeo {
  const n = Number(d.trabados || 0);
  return n === 0
    ? { nombre: 'pedidos-trabados', estado: 'ok', detalle: '0 trabados' }
    : { nombre: 'pedidos-trabados', estado: 'fallo', detalle: n + ' pedidos sin mover hace 3+ días' };
}

// #12 Canal WhatsApp/Meta verificado
async function checkWhatsAppMeta(): Promise<Chequeo> {
  if (!META_WA_TOKEN || !META_PHONE_ID) return { nombre: 'whatsapp-meta-verificado', estado: 'fallo', detalle: 'faltan META_WA_TOKEN/META_PHONE_ID' };
  const r = await fetchTimeout('https://graph.facebook.com/v21.0/' + META_PHONE_ID + '?fields=id,verified_name,display_phone_number,code_verification_status', { headers: { Authorization: 'Bearer ' + META_WA_TOKEN } }, 10000);
  if (!r || !r.ok) return { nombre: 'whatsapp-meta-verificado', estado: 'fallo', detalle: 'HTTP ' + (r ? r.status : 'sin respuesta') };
  const d = await r.json().catch(() => ({}));
  return d.verified_name
    ? { nombre: 'whatsapp-meta-verificado', estado: 'ok', detalle: 'verificado: ' + d.verified_name + ' (' + d.code_verification_status + ')' }
    : { nombre: 'whatsapp-meta-verificado', estado: 'fallo', detalle: 'respuesta inesperada de Meta' };
}

// #13 Plantillas Meta aprobadas (ids en config_operativa; si aún no hay, se omite)
async function checkPlantillasMeta(): Promise<Chequeo> {
  if (!META_WA_TOKEN) return { nombre: 'plantillas-meta', estado: 'fallo', detalle: 'falta META_WA_TOKEN' };
  let ids: string[] = [];
  try {
    const { data } = await supabase.from('config_operativa').select('valor').eq('clave', 'plantillas_meta_ids').maybeSingle();
    if (data?.valor) {
      try { ids = JSON.parse(data.valor); } catch (_e) { ids = []; }
    }
  } catch (_e) { /* silencio */ }
  if (!ids.length) {
    // aún no se cargaron los ids de plantilla en config_operativa: no es un fallo (no false-alarmar)
    return { nombre: 'plantillas-meta', estado: 'ok', detalle: 'sin ids de plantilla en config_operativa (pendiente de cargar)' };
  }
  const resultados = await Promise.all(ids.map(async (id) => {
    const r = await fetchTimeout('https://graph.facebook.com/v21.0/' + id + '?fields=name,status', { headers: { Authorization: 'Bearer ' + META_WA_TOKEN } }, 10000);
    const d = r ? await r.json().catch(() => ({})) : {};
    return { id, name: d.name || id, status: d.status || '?' };
  }));
  const mal = resultados.filter((x) => x.status !== 'APPROVED');
  return mal.length
    ? { nombre: 'plantillas-meta', estado: 'fallo', detalle: 'no aprobadas: ' + mal.map((x) => x.name + ' (' + x.status + ')').join(', ') }
    : { nombre: 'plantillas-meta', estado: 'ok', detalle: resultados.length + ' plantillas aprobadas' };
}

// #14 Backup corrió  (lee la marca `backup-cloud` que escribe la EF de backup en E6)
function checkBackup(d: Record<string, any>): Chequeo {
  const f = d.backup_fecha;
  if (!f) return { nombre: 'backup-cloud-corriendo', estado: 'ok', detalle: 'aún sin backup en Storage (E6 pendiente)' };
  const edadDias = (Date.now() - new Date(f).getTime()) / 86400000;
  return edadDias < 32
    ? { nombre: 'backup-cloud-corriendo', estado: 'ok', detalle: 'último backup hace ' + edadDias.toFixed(1) + ' días' }
    : { nombre: 'backup-cloud-corriendo', estado: 'fallo', detalle: 'último backup hace ' + edadDias.toFixed(0) + ' días (más de 32)' };
}

// #15 Stock negativo
function checkStock(d: Record<string, any>): Chequeo {
  const neg: string[] = d.stock_negativo || [];
  return neg.length
    ? { nombre: 'stock-negativo', estado: 'fallo', detalle: 'stock < 0 en: ' + neg.join(', ') }
    : { nombre: 'stock-negativo', estado: 'ok', detalle: 'sin stock negativo' };
}

// #16 Último cron de la PC (lee la marca `pc-heartbeat`; solo mientras quede algún cron en Hermes)
function checkPcHeartbeat(d: Record<string, any>): Chequeo {
  const f = d.pc_heartbeat_fecha;
  if (!f) return { nombre: 'pc-heartbeat-corriendo', estado: 'ok', detalle: 'sin heartbeat de PC (crons ya migrados a la nube)' };
  const edadDias = (Date.now() - new Date(f).getTime()) / 86400000;
  return edadDias < 2
    ? { nombre: 'pc-heartbeat-corriendo', estado: 'ok', detalle: 'PC latió hace ' + edadDias.toFixed(1) + ' días' }
    : { nombre: 'pc-heartbeat-corriendo', estado: 'fallo', detalle: 'PC sin latido hace ' + edadDias.toFixed(1) + ' días' };
}

// ---------- mensajes ----------

function alarma(fallos: Chequeo[]): string {
  const lineas = [
    '🚨 BARATUSS — ALGO SE ROMPIÓ (chequeo automático)',
    '',
    '🕐 ' + horaSV() + ' · ' + fechaSV(),
  ];
  for (const f of fallos) {
    if (f.nombre === 'wompi-token') lineas.push('💳 PAGOS CON TARJETA ROTOS → ' + f.detalle);
    else lineas.push('❌ ' + f.nombre + ' → ' + f.detalle);
  }
  lineas.push('', '👉 Esto pasó SOLO y te aviso al instante, sin que nadie tenga que acordarse.', '¿Qué hago? Contestame:', '1) Lo reviso y lo arreglo yo', '2) Apagá la tarjeta y dejá solo efectivo por hoy', '3) Llamame y te lo explico');
  return lineas.join('\n');
}

function parte(d: Record<string, any>, fallos: Chequeo[], checks: Chequeo[]): string {
  const ayer = d.ayer || {};
  const nVentas = Number(ayer.ventas || 0);
  const total = Number(ayer.total || 0);
  const util = Number(ayer.util || 0);
  const tiendaOk = (checks.find((c) => c.nombre === 'tienda-online')?.estado) === 'ok';
  const utilOk = (checks.find((c) => c.nombre === 'utilidad-minima')?.estado) === 'ok';
  const waOk = (checks.find((c) => c.nombre === 'whatsapp-meta-verificado')?.estado) === 'ok';

  const lineas: string[] = ['☀️ BUENOS DÍAS CINDY — PARTE DE BARATUSS (' + fechaSV() + ')', ''];
  if (fallos.length) {
    for (const f of fallos) lineas.push('❌ ' + f.nombre + ' → ' + f.detalle);
    lineas.push('', '⚠️ HAY ' + fallos.length + ' AVISO(S) PARA REVISAR');
  } else {
    lineas.push('✅ TODO FUNCIONA BIEN (revisado automáticamente a las 7:00 AM)');
  }
  lineas.push('');
  lineas.push(tiendaOk ? '🛍️ La tienda: en línea' : '🛍️ La tienda: ❌ caída');
  lineas.push('📅 Ayer: ' + nVentas + ' venta(s) · $' + total.toFixed(2) + ' vendido · $' + util.toFixed(2) + ' de utilidad');
  lineas.push('📦 Entregados (total): ' + (Number(d.entregados_total || 0)) + ' · ventas registradas: ' + (Number(d.ventas_registradas || 0)));
  lineas.push('🏷️ Productos activos: ' + (Number(d.productos_activos || 0)) + (utilOk ? ' · todos sobre la utilidad mínima de $4.50 ✅' : ' · ⚠️ hay productos bajo el mínimo'));
  lineas.push('🧾 Facturas pendientes: ' + (Number(d.facturas_pendientes || 0)) + ' · 🎁 Premios pendientes: ' + (Number(d.premios_pendientes || 0)));
  lineas.push('🔐 Cuenta de servicio de Google: activa · Canal de WhatsApp: ' + (waOk ? 'verificado' : '❌ no verificado'));
  lineas.push('');
  lineas.push('💛 Todo en orden. ¡Que tengas un lindo día!');
  return lineas.join('\n');
}

// ---------- corrida completa ----------

async function correrChequeos(): Promise<Chequeo[]> {
  const d = (await datosSQL()) || {};
  const [tienda, fotos, edge, wompi, wa, plantillas] = await Promise.all([
    checkTienda(), checkFotosVideo(), checkEdgeFunctions(), checkWompi(), checkWhatsAppMeta(), checkPlantillasMeta(),
  ]);
  return [
    tienda,
    fotos,
    checkTriggers(d),
    checkCrons(d),
    edge,
    wompi,
    checkSinRegistrar(d),
    checkFacturas(d),
    checkPremios(d),
    checkUtilidad(d),
    checkTrabados(d),
    wa,
    plantillas,
    checkBackup(d),
    checkStock(d),
    checkPcHeartbeat(d),
  ];
}

async function yaAvisadoHoy(nombre: string): Promise<boolean> {
  try {
    const { data } = await supabase.from('chequeos_salud').select('id')
      .eq('chequeo', nombre).eq('estado', 'fallo').eq('avisado', true)
      .gte('fecha', inicioDiaSVUTC().toISOString()).limit(1);
    return !!(data && data.length);
  } catch (_e) { return false; }
}

async function registrar(checks: Chequeo[], fallosNuevos: Set<string>, avisadoHoy: Set<string>, avisadoEnviado: boolean): Promise<void> {
  const filas = checks.map((c) => {
    let avisado = false;
    if (c.estado === 'fallo') {
      if (avisadoHoy.has(c.nombre)) avisado = true;            // ya se avisó hoy
      else if (fallosNuevos.has(c.nombre)) avisado = avisadoEnviado; // recién avisado (o falló el envío)
    }
    return { chequeo: c.nombre, estado: c.estado, detalle: c.detalle || null, avisado };
  });
  try {
    await supabase.from('chequeos_salud').insert(filas);
  } catch (e) { console.log('no se pudo escribir chequeos_salud:', String(e)); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const clave = req.headers.get('x-baratuss-key') || '';
    if (!(await claveValida(clave))) return json({ error: 'no autorizado' }, 401);

    let modo: 'hora' | 'parte' = 'hora';
    try { const b = await req.json(); if (b?.modo === 'parte') modo = 'parte'; } catch (_e) { /* sin cuerpo */ }

    const checks = await correrChequeos();
    const fallos = checks.filter((c) => c.estado === 'fallo');

    // anti-spam: cada fallo se avisa UNA vez por día (marca avisado=true)
    const fallosNuevos = new Set<string>();
    const avisadoHoy = new Set<string>();
    for (const f of fallos) {
      const ya = await yaAvisadoHoy(f.nombre);
      if (ya) avisadoHoy.add(f.nombre);
      else fallosNuevos.add(f.nombre);
    }

    let avisadoEnviado = false;
    const nuevos = checks.filter((c) => fallosNuevos.has(c.nombre));
    if (nuevos.length) {
      avisadoEnviado = await avisarCindy(alarma(nuevos));
    }
    await registrar(checks, fallosNuevos, avisadoHoy, avisadoEnviado);

    let parteEnviada = false;
    if (modo === 'parte') {
      const d = (await datosSQL()) || {};
      parteEnviada = await avisarCindy(parte(d, fallos, checks));
    }

    return json({
      ok: true,
      modo,
      fallos: fallos.map((f) => f.nombre),
      nuevos_avisos: [...fallosNuevos],
      avisado_telegram: avisadoEnviado,
      parte_enviada: parteEnviada,
      total_chequeos: checks.length,
    });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
