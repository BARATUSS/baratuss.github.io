// ============================================================================
// BARATUSS · sync-finanzas (E3 del plan "todo en código")
//
// Migra la sincronización financiera que hoy corre en la PC (`sync_total.py`,
// cron cada 2 h) a la nube: lee la tabla `ventas` + concilia Wompi y escribe en
// la hoja de Google Sheets (mismo formato/tabs/rangos que sync_total.py), para
// que los "cuadros" se actualicen SOLOS al registrarse una venta.
//
// Tabs que escribe (idéntico a C:\proDUCKtive\sync_total.py, la versión que
// corre de verdad el cron):
//   · REVISAR          (historial permanente de discrepancias Wompi)
//   · CONCILIACIÓN     (resumen de enlaces creados/pagados vs órdenes)
//   · VENTAS           (cada venta entregada, desde la tabla `ventas`)
//   · COMPRAS + GASTOS (solo los encabezados; NO toca las filas del usuario)
//   · RESULTADO MENSUAL (utilidad por mes)
//   · FLUJO DE CAJA    (dinero real que entra y sale)
//
// Seguridad: función pública (no-verify-jwt) pero exige la clave interna
// x-baratuss-key (FACTURA_KEY / config_operativa.factura_trigger_key), igual
// que enviar-factura y salud-baratuss.
//
// OAuth de Google Sheets: refresca GOOGLE_REFRESH_TOKEN (mismo patrón que
// enviar-factura). Si algo falla, avisa a Cindy por Telegram.
// ============================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const FACTURA_KEY = Deno.env.get('FACTURA_KEY') || '';
const G_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const G_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const G_REFRESH = Deno.env.get('GOOGLE_REFRESH_TOKEN') || '';
const SHEET_ID = Deno.env.get('GOOGLE_SHEET_ID') || '';
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const CINDY = Deno.env.get('SALUD_TELEGRAM_CHAT_ID') || '8635242458';
const WOMPI_CLIENT_ID = Deno.env.get('WOMPI_CLIENT_ID') || '';
const WOMPI_CLIENT_SECRET = Deno.env.get('WOMPI_CLIENT_SECRET') || '';

const WOMPI_TOKEN_URL = 'https://id.wompi.sv/connect/token';
const WOMPI_API = 'https://api.wompi.sv';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-baratuss-key' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ---------- autenticación (misma clave que enviar-factura / salud-baratuss) ----------

async function claveValida(clave: string): Promise<boolean> {
  if (!clave) return false;
  if (FACTURA_KEY && clave === FACTURA_KEY) return true;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/config_operativa?select=valor&clave=eq.factura_trigger_key`, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
    });
    const d = await r.json();
    if (Array.isArray(d) && d.length && d[0].valor && clave === d[0].valor) return true;
  } catch (_e) { /* silencio */ }
  return false;
}

// ---------- aviso a Cindy por Telegram (patrón avisarCindy) ----------

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

// ---------- Google Sheets (OAuth refresh token) ----------

async function tokenGoogle(): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: G_ID, client_secret: G_SECRET,
      refresh_token: G_REFRESH, grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('No se pudo obtener el permiso de Google: ' + JSON.stringify(d).slice(0, 200));
  return d.access_token as string;
}

async function sheetsGet(token: string, range: string): Promise<any[][]> {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new Error('Sheets get ' + range + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return d.values || [];
}

async function sheetsUpdate(token: string, range: string, values: any[][]): Promise<void> {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!r.ok) throw new Error('Sheets update ' + range + ': ' + (await r.text()).slice(0, 200));
}

async function sheetsClear(token: string, range: string): Promise<void> {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new Error('Sheets clear ' + range + ': ' + (await r.text()).slice(0, 200));
}

async function sheetTitles(token: string): Promise<string[]> {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new Error('Sheets meta: ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return (d.sheets || []).map((s: any) => s.properties.title);
}

async function ensureSheet(token: string, title: string): Promise<void> {
  const titles = await sheetTitles(token);
  if (titles.includes(title)) return;
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  if (!r.ok) throw new Error('Sheets addSheet ' + title + ': ' + (await r.text()).slice(0, 200));
}

// ---------- Supabase PostgREST ----------

async function sbGet(path: string): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
  });
  if (!r.ok) throw new Error('Supabase ' + path + ': ' + (await r.text()).slice(0, 200));
  return await r.json();
}

// ---------- Wompi (misma lógica que sync_total.py) ----------

async function getWompiToken(): Promise<string> {
  const r = await fetch(WOMPI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: WOMPI_CLIENT_ID,
      client_secret: WOMPI_CLIENT_SECRET,
      audience: 'wompi_api',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Wompi token: ' + JSON.stringify(d).slice(0, 200));
  return d.access_token;
}

async function fetchWompiPagos(): Promise<any[]> {
  const token = await getWompiToken();
  const pagos: any[] = [];
  let pagina = 1;
  while (true) {
    let resp: any;
    try {
      const r = await fetch(`${WOMPI_API}/EnlacePago?paginaActual=${pagina}&cantidadPorPagina=50`, {
        headers: { Authorization: 'Bearer ' + token },
      });
      resp = await r.json();
    } catch (e) {
      break; // error de red: salir
    }
    const resultado = resp?.resultado || [];
    pagos.push(...resultado);
    if (pagos.length >= (resp?.totalDeElementos || 0) || !resultado.length) break;
    pagina += 1;
  }
  return pagos;
}

// ---------- conciliación (idéntica a sync_total.py) ----------

function conciliar(orders: any[], pagos: any[]) {
  const pagosPorRef: Record<string, any> = {};
  for (const p of pagos) {
    const ref = p.nombreEnlace || '';
    const t = p.transaccionCompra || {};
    const estado = t.estado || 'SIN_PAGO';
    const transacciones = p.transacciones || [];
    pagosPorRef[ref] = {
      ref,
      monto: p.monto || 0,
      estado,
      id_transaccion: t.id || (transacciones.length ? transacciones[0].id : null),
      fecha: t.fechaCreacion || (transacciones.length ? transacciones[0].fechaCreacion : null),
      es_pagado: (p.cantidadPagosExitosos || 0) > 0 || (estado !== null && estado !== 'SIN_PAGO'),
    };
  }
  const ordersPorRef: Record<string, any> = {};
  for (const o of orders) if (o.reference) ordersPorRef[o.reference] = o;

  const discrepancias: any[] = [];
  for (const o of orders) {
    const ref = o.reference || String(o.id || '').slice(0, 8);
    const metodo = o.payment_method || 'desconocido';
    const total = Number(o.total || 0);
    if (metodo === 'efectivo') continue;
    const pw = pagosPorRef[ref];
    if (!pw) {
      discrepancias.push({ referencia: ref, tipo: 'Pedido sin enlace Wompi', detalle: `Orden $${total.toFixed(2)} sin enlace en Wompi`, monto: total, fecha: (o.created_at || '').slice(0, 10) });
    } else if (!pw.es_pagado) {
      discrepancias.push({ referencia: ref, tipo: 'Enlace creado, sin pago', detalle: `Orden $${total.toFixed(2)} — Wompi no registra pago`, monto: total, fecha: (o.created_at || '').slice(0, 10) });
    } else if (Math.abs(total - Number(pw.monto || 0)) > 0.01) {
      discrepancias.push({ referencia: ref, tipo: 'Monto difiere', detalle: `Orden $${total.toFixed(2)} vs Wompi $${Number(pw.monto).toFixed(2)}`, monto: total, fecha: (o.created_at || '').slice(0, 10) });
    }
  }
  for (const ref of Object.keys(pagosPorRef)) {
    const pw = pagosPorRef[ref];
    if (!(ref in ordersPorRef) && pw.es_pagado) {
      discrepancias.push({ referencia: ref, tipo: 'Pago Wompi sin pedido', detalle: `Pago $${Number(pw.monto).toFixed(2)} sin orden en tienda`, monto: Number(pw.monto || 0), fecha: (pw.fecha || '').slice(0, 10) });
    }
  }
  const enlaces_creados = pagos.length;
  const enlaces_pagados = pagos.filter((p) => (p.cantidadPagosExitosos || 0) > 0).length;
  return { discrepancias, enlaces_creados, enlaces_pagados };
}

// ---------- REVISAR (historial permanente) ----------

async function actualizarHistorialRevisar(token: string, discrepancias: any[]): Promise<number> {
  await ensureSheet(token, 'REVISAR');
  let filas = await sheetsGet(token, 'REVISAR!A1:G500');
  if (!filas.length || filas[0].slice(0, 4).join('|') !== 'Fecha|Referencia|Tipo|Detalle') {
    filas = [['Fecha', 'Referencia', 'Tipo', 'Detalle', 'Monto', 'Estado', 'Visto el']];
  }
  const existentes = new Set<string>();
  for (const f of filas.slice(1)) if (f.length > 1) existentes.add(f[1]);
  let nuevas = 0;
  const hoy = new Date().toISOString().slice(0, 10);
  for (const d of discrepancias) {
    if (!existentes.has(d.referencia)) {
      filas.push([hoy, d.referencia, d.tipo, d.detalle, d.monto, 'PENDIENTE', '']);
      existentes.add(d.referencia);
      nuevas += 1;
    } else {
      for (const f of filas.slice(1)) {
        if (f.length > 1 && f[1] === d.referencia && (f.length < 6 || f[5] === 'PENDIENTE')) {
          f[5] = 'VISTA';
          if (f.length > 6) f[6] = hoy;
        }
      }
    }
  }
  await sheetsClear(token, 'REVISAR!A1:G500');
  await sheetsUpdate(token, 'REVISAR!A1', filas);
  return nuevas;
}

// ---------- CONCILIACIÓN (resumen) ----------

async function actualizarConciliacion(token: string, discrepancias: any[], enlaces_creados: number, enlaces_pagados: number, n_orders: number): Promise<void> {
  await ensureSheet(token, 'CONCILIACIÓN');
  await sheetsClear(token, 'CONCILIACIÓN!A1:G60');
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const valores = [
    ['CONCILIACIÓN BARATUSS — actualizado automáticamente'],
    ['Fecha', now],
    ['', ''],
    ['Enlaces Wompi creados', enlaces_creados],
    ['Enlaces Wompi pagados', enlaces_pagados],
    ['Órdenes en tienda', n_orders],
    ['Discrepancias detectadas', discrepancias.length],
    ['', ''],
    ['Las discrepancias quedan en la hoja REVISAR (historial permanente).'],
    ['Para resolver una: cámbiale el Estado a RESUELTO.'],
  ];
  await sheetsUpdate(token, 'CONCILIACIÓN!A1', valores);
}

// ---------- VENTAS (la hoja de los "cuadros") ----------

async function actualizarVentas(token: string): Promise<number> {
  const ventas = await sbGet('ventas?select=*&order=fecha_entrega.desc,id.desc&limit=1000');
  const lista = Array.isArray(ventas) ? ventas : [];
  await ensureSheet(token, 'VENTAS');
  const filas: any[][] = [
    ['VENTAS ENTREGADAS — se registran al marcar ENTREGADO el pedido'],
    ['Fecha entrega', 'Referencia', 'Cliente', 'Método', 'Total cobrado', 'IVA incluido', 'Venta neta', 'Costo productos', 'Comisión Wompi', 'Gasto envío', 'Utilidad neta'],
  ];
  for (const v of lista) {
    filas.push([
      v.fecha_entrega || '', v.order_reference || '', v.cliente || '', v.metodo_pago || '',
      Number(v.total_bruto || 0), Number(v.iva_incluido || 0), Number(v.venta_neta || 0),
      Number(v.costo_productos || 0), Number(v.comision_wompi || 0), Number(v.gasto_envio || 0),
      Number(v.utilidad_neta || 0),
    ]);
  }
  filas.push(['', '', '', '', '', '', '', '', '', '', '']);
  if (lista.length) {
    const ultima = 2 + lista.length;
    filas.push(['', '', '', 'TOTALES',
      `=SUM(E3:E${ultima})`, `=SUM(F3:F${ultima})`, `=SUM(G3:G${ultima})`, `=SUM(H3:H${ultima})`,
      `=SUM(I3:I${ultima})`, `=SUM(J3:J${ultima})`, `=SUM(K3:K${ultima})`,
    ]);
  } else {
    filas.push(['', '', '', 'TOTALES', 0, 0, 0, 0, 0, 0, 0]);
  }
  await sheetsClear(token, 'VENTAS!A1:K1000');
  await sheetsUpdate(token, 'VENTAS!A1', filas);
  // formato de MONEDA en las columnas de dinero (E..K): siguen siendo NÚMEROS,
  // así los SUMIFS del RESULTADO MENSUAL funcionan (igual que sync_total.py).
  try {
    const metaR = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    const meta = await metaR.json();
    const sid = meta.sheets.find((s: any) => s.properties.title === 'VENTAS')?.properties.sheetId;
    if (sid !== undefined) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ repeatCell: {
          range: { sheetId: sid, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: 11 },
          cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' } } },
          fields: 'userEnteredFormat.numberFormat',
        } }] }),
      });
    }
  } catch (e) {
    console.log('(aviso: no se pudo aplicar el formato de moneda:', String(e).slice(0, 80), ')');
  }
  return lista.length;
}

// ---------- COMPRAS + GASTOS (solo encabezados) ----------

async function arreglarComprasGastos(token: string): Promise<void> {
  await ensureSheet(token, 'COMPRAS');
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('COMPRAS!A1:G3')}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [
      ['REGISTRO DE COMPRAS DE INVENTARIO — anotá cada compra en la fila 4 y siguientes'],
      ['TOTAL COMPRAS', '', '', '', '=SUM(E4:E1000)', '', ''],
      ['Fecha', 'Proveedor', 'Producto', 'Cantidad', 'Costo total', 'Categoría', 'Nota'],
    ] }),
  });
  await ensureSheet(token, 'GASTOS');
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('GASTOS!A1:E3')}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [
      ['REGISTRO DE GASTOS OPERATIVOS — anotá cada gasto en la fila 4 y siguientes'],
      ['TOTAL GASTOS', '', '', '=SUM(D4:D1000)', ''],
      ['Fecha', 'Categoría', 'Descripción', 'Monto', 'Método pago'],
    ] }),
  });
}

// ---------- RESULTADO MENSUAL ----------

async function actualizarResultadoMensual(token: string): Promise<void> {
  await ensureSheet(token, 'RESULTADO MENSUAL');
  await sheetsClear(token, 'RESULTADO MENSUAL!A1:J30');
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const rm: any[][] = [
    ['RESULTADO MENSUAL — ventas ENTREGADAS del año 2026'],
    ['Cómo se calcula: Venta neta (sin IVA) − Costo de productos − Comisión Wompi − Gastos operativos = Utilidad neta'],
    ['', '', '', '', '', '', '', '', '', ''],
    ['Mes', 'Total cobrado', 'IVA cobrado (por pagar)', 'Venta neta', 'Costo productos', 'Comisión Wompi', 'Utilidad bruta', 'Gastos operativos', 'Utilidad neta', 'Acumulado'],
  ];
  for (let i = 1; i <= 12; i++) {
    const row = i + 4;
    const cr1 = `VENTAS!A:A,">="&DATE(2026,${i},1),VENTAS!A:A,"<"&DATE(2026,${i + 1},1)`;
    const cr2 = `GASTOS!A:A,">="&DATE(2026,${i},1),GASTOS!A:A,"<"&DATE(2026,${i + 1},1)`;
    rm.push([
      meses[i - 1],
      `=SUMIFS(VENTAS!E:E,${cr1})`,
      `=SUMIFS(VENTAS!F:F,${cr1})`,
      `=SUMIFS(VENTAS!G:G,${cr1})`,
      `=SUMIFS(VENTAS!H:H,${cr1})`,
      `=SUMIFS(VENTAS!I:I,${cr1})`,
      `=D${row}-E${row}`,
      `=SUMIFS(GASTOS!D:D,${cr2})`,
      `=G${row}-F${row}-H${row}`,
      `=IF(ROW()=5,I${row},I${row}+J${row - 1})`,
    ]);
  }
  rm.push([]);
  rm.push(['TOTAL', '=SUM(B5:B16)', '=SUM(C5:C16)', '=SUM(D5:D16)', '=SUM(E5:E16)', '=SUM(F5:F16)', '=SUM(G5:G16)', '=SUM(H5:H16)', '=SUM(I5:I16)', '']);
  await sheetsUpdate(token, 'RESULTADO MENSUAL!A1', rm);
}

// ---------- FLUJO DE CAJA ----------

async function actualizarFlujoCaja(token: string): Promise<void> {
  await ensureSheet(token, 'FLUJO DE CAJA');
  await sheetsClear(token, 'FLUJO DE CAJA!A1:H30');
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const fc: any[][] = [
    ['FLUJO DE CAJA — dinero REAL que entra y sale (ventas entregadas)'],
    ['Entradas: venta neta menos comisión de Wompi. Salidas: compras de inventario + gastos operativos.'],
    ['', '', '', '', '', '', ''],
    ['Mes', 'Entradas (ventas netas)', 'Comisión pagada', 'Salidas (compras)', 'Salidas (gastos)', 'Flujo del mes', 'Caja acumulada'],
  ];
  for (let i = 1; i <= 12; i++) {
    const row = i + 4;
    const cv = `VENTAS!A:A,">="&DATE(2026,${i},1),VENTAS!A:A,"<"&DATE(2026,${i + 1},1)`;
    const cc = `COMPRAS!A:A,">="&DATE(2026,${i},1),COMPRAS!A:A,"<"&DATE(2026,${i + 1},1)`;
    const cg = `GASTOS!A:A,">="&DATE(2026,${i},1),GASTOS!A:A,"<"&DATE(2026,${i + 1},1)`;
    fc.push([
      meses[i - 1],
      `=SUMIFS(VENTAS!G:G,${cv})`,
      `=SUMIFS(VENTAS!I:I,${cv})`,
      `=SUMIFS(COMPRAS!E:E,${cc})`,
      `=SUMIFS(GASTOS!D:D,${cg})`,
      `=B${row}-C${row}-D${row}-E${row}`,
      `=IF(ROW()=5,F${row},F${row}+G${row - 1})`,
    ]);
  }
  await sheetsUpdate(token, 'FLUJO DE CAJA!A1', fc);
}

// ---------- handler ----------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const clave = req.headers.get('x-baratuss-key') || '';
    if (!(await claveValida(clave))) return json({ error: 'no autorizado' }, 401);

    if (!SHEET_ID) return json({ error: 'falta GOOGLE_SHEET_ID' }, 500);

    // Token de Google una sola vez; si falla, aviso y salgo (todo lo demás depende de él).
    let gtoken: string;
    try {
      gtoken = await tokenGoogle();
    } catch (e) {
      await avisarCindy('⚠️ *sync-finanzas:* no pude obtener el permiso de Google Sheets.\n\n(' + String(e).slice(0, 200) + ')\n\n→ El refresh token de Google puede no tener el permiso de Hojas de cálculo (spreadsheets).');
      return json({ ok: false, error: 'token google: ' + String(e).slice(0, 200) }, 500);
    }

    const errores: string[] = [];
    let nVentas = 0, nDiscrepancias = 0, enlC = 0, enlP = 0, nOrdenes = 0, nuevas = 0;

    // bloque 1: conciliación Wompi vs tienda (REVISAR + CONCILIACIÓN)
    try {
      const pagos = await fetchWompiPagos();
      let orders = await sbGet('orders?select=*&order=created_at.desc&limit=1000');
      if (!Array.isArray(orders)) orders = [];
      const res = conciliar(orders, pagos);
      nDiscrepancias = res.discrepancias.length;
      enlC = res.enlaces_creados;
      enlP = res.enlaces_pagados;
      nOrdenes = orders.length;
      nuevas = await actualizarHistorialRevisar(gtoken, res.discrepancias);
      await actualizarConciliacion(gtoken, res.discrepancias, enlC, enlP, nOrdenes);
    } catch (e) {
      errores.push('conciliación: ' + String(e).slice(0, 200));
    }

    // bloque 2: ventas entregadas (VENTAS)
    try {
      nVentas = await actualizarVentas(gtoken);
    } catch (e) {
      errores.push('ventas: ' + String(e).slice(0, 200));
    }

    // bloque 3: estados financieros (COMPRAS · GASTOS · RESULTADO MENSUAL · FLUJO DE CAJA)
    try {
      await arreglarComprasGastos(gtoken);
      await actualizarResultadoMensual(gtoken);
      await actualizarFlujoCaja(gtoken);
    } catch (e) {
      errores.push('estados: ' + String(e).slice(0, 200));
    }

    if (errores.length) {
      await avisarCindy('⚠️ *sync-finanzas* — algo falló al actualizar la hoja de finanzas:\n\n' + errores.map((x) => '· ' + x).join('\n'));
      return json({ ok: false, errores, ventas: nVentas, discrepancias: nDiscrepancias });
    }

    return json({ ok: true, ventas: nVentas, discrepancias: nDiscrepancias, enlaces_creados: enlC, enlaces_pagados: enlP, nuevas_revisar: nuevas });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
