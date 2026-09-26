// ============================================================================
// BARATUSS · finanzas-api · Edge Function (Deno/TS)
// Módulo FINANZAS BARATUSS — lectura/escritura financiera vía service role.
//
// Autenticación (patrón esAdmin):
//   · service key (header apikey o Authorization) → se compara contra
//     SUPABASE_SERVICE_ROLE_KEY Y se comprueba con GET /auth/v1/admin/users
//     (HTTP 200 = service role).
//   · si no → JWT de usuario: GET /auth/v1/user + profiles.is_admin === true.
//   · si nada → 401 {ok:false, error:'no_autorizado'}.
//
// Todas las consultas a la base usan fetch directo a /rest/v1/ con la service
// key (las tablas compras/gastos tienen RLS sin políticas: solo service role).
// NO se expone ningún secreto. Responde SIEMPRE JSON {ok, ...}.
// ============================================================================

const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const mesHoy = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' }).slice(0, 7);

// ---------- fetch a la base con service role ----------
async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };
  if (method === 'POST' || method === 'PATCH' || method === 'PUT')
    headers['Prefer'] = 'return=representation';
  const opts: any = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  const texto = await r.text();
  let data: any = null;
  try { data = texto ? JSON.parse(texto) : null; } catch (_e) { data = null; }
  if (!r.ok) {
    const detalle = (data && (data.message || data.error || data.hint)) || ('HTTP ' + r.status);
    throw new Error(String(detalle));
  }
  return data;
}

// ---------- autenticación ----------
async function esAdmin(req: Request): Promise<{ ok: boolean; quien?: string }> {
  const auth = (req.headers.get('authorization') || '').trim();
  const token = auth.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7) : auth;
  const apikey = (req.headers.get('apikey') || '').trim();

  // 1) service key: coincidencia con el secret del entorno + admin/users (200 = service role)
  if (SERVICE_KEY && (apikey === SERVICE_KEY || token === SERVICE_KEY)) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY },
      });
      if (r.status === 200) return { ok: true, quien: 'service_role' };
    } catch (_e) { /* sigue */ }
    return { ok: false };
  }

  // 2) cualquier clave de service role válida (la comprobación real: admin/users 200)
  //    cubre claves legacy rotadas distintas del secret del entorno.
  const candidato = token || apikey;
  if (candidato && candidato !== SERVICE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1`, {
        headers: { apikey: candidato, Authorization: 'Bearer ' + candidato },
      });
      if (r.status === 200) return { ok: true, quien: 'service_role' };
    } catch (_e) { /* sigue */ }
  }

  // 3) JWT de usuario admin
  if (token) {
    try {
      const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
      });
      if (ur.ok) {
        const user = await ur.json();
        if (user && user.id) {
          const prof = await rest('GET', `profiles?select=is_admin,name,email&id=eq.${user.id}`);
          const p = Array.isArray(prof) ? prof[0] : null;
          if (p && p.is_admin === true) {
            return { ok: true, quien: p.name || p.email || user.email || 'admin' };
          }
        }
      }
    } catch (_e) { /* cae a no_autorizado */ }
  }
  return { ok: false };
}

// ---------- agregados de una lista de ventas ----------
function totalesVentas(ventas: any[]) {
  let efectivo = 0, tarjeta = 0, total = 0, utilidad = 0;
  let costo = 0, comision = 0, iva = 0, ventaNeta = 0, envio = 0;
  for (const v of ventas) {
    const bruto = num(v.total_bruto);
    total += bruto;
    utilidad += num(v.utilidad_neta);
    costo += num(v.costo_productos);
    comision += num(v.comision_wompi);
    iva += num(v.iva_incluido);
    ventaNeta += num(v.venta_neta);
    envio += num(v.gasto_envio);
    if ((v.metodo_pago || '').toLowerCase() === 'tarjeta') tarjeta += bruto;
    else efectivo += bruto;
  }
  const n = ventas.length;
  return {
    conteo: n,
    total: r2(total),
    efectivo: r2(efectivo),
    tarjeta: r2(tarjeta),
    utilidad: r2(utilidad),
    costo_productos: r2(costo),
    comision: r2(comision),
    iva: r2(iva),
    venta_neta: r2(ventaNeta),
    gasto_envio: r2(envio),
    ticket_promedio: n ? r2(total / n) : 0,
  };
}

// ---------- acciones ----------

async function accResumen() {
  const ventas = await rest('GET', 'ventas?select=*&order=fecha_entrega.desc,id.desc');
  const tot = totalesVentas(Array.isArray(ventas) ? ventas : []);

  // alertas: pagos Wompi (tarjeta pagada) sin fila en ventas
  const alertas: { nivel: string; texto: string }[] = [];
  try {
    const refs = new Set((Array.isArray(ventas) ? ventas : []).map((v) => v.order_reference));
    const pagos = await rest('GET',
      "orders?select=reference,total,customer_name,payment_date,status&payment_status=eq.pagado&payment_method=eq.tarjeta&order=payment_date.desc&limit=200");
    const sinVenta = (Array.isArray(pagos) ? pagos : []).filter((o) => o.reference && !refs.has(o.reference));
    if (sinVenta.length) {
      alertas.push({
        nivel: 'rojo',
        texto: `${sinVenta.length} pago${sinVenta.length === 1 ? '' : 's'} con tarjeta confirmado${sinVenta.length === 1 ? '' : 's'} sin venta registrada (${sinVenta.map((o) => o.reference).join(', ')})`,
      });
    }
  } catch (_e) { /* sin datos de orders */ }

  const arr = Array.isArray(ventas) ? ventas : [];
  const sinItems = arr.filter((v) => !Array.isArray(v.items) || v.items.length === 0);
  if (sinItems.length) {
    alertas.push({ nivel: 'amarillo', texto: `${sinItems.length} venta${sinItems.length === 1 ? '' : 's'} sin detalle de artículos` });
  }

  try {
    const compras = await rest('GET', 'compras?select=id,proveedor,producto,documento&documento=is.null');
    if (Array.isArray(compras) && compras.length) {
      alertas.push({ nivel: 'amarillo', texto: `${compras.length} compra${compras.length === 1 ? '' : 's'} sin documento` });
    }
  } catch (_e) { /* no hay datos */ }

  try {
    const gastos = await rest('GET', 'gastos?select=id,categoria,descripcion,documento&documento=is.null');
    if (Array.isArray(gastos) && gastos.length) {
      alertas.push({ nivel: 'amarillo', texto: `${gastos.length} gasto${gastos.length === 1 ? '' : 's'} sin documento` });
    }
  } catch (_e) { /* no hay datos */ }

  const nivelGlobal = alertas.some((a) => a.nivel === 'rojo') ? 'rojo' : (alertas.length ? 'amarillo' : 'verde');

  return {
    ok: true,
    dinero: { efectivo: tot.efectivo, tarjeta: tot.tarjeta, total: tot.total },
    totales: tot,
    alertas,
    nivel_global: nivelGlobal,
  };
}

async function accVentas() {
  const ventas = await rest('GET', 'ventas?select=*&order=fecha_entrega.desc,id.desc');
  const arr = Array.isArray(ventas) ? ventas : [];
  return { ok: true, ventas: arr, totales: totalesVentas(arr) };
}

async function accInventario() {
  const prod = await rest('GET',
    'inventory?select=id,sku,name,category,tipo,cost_price,sale_price,stock,badge&active=eq.true&order=name.asc');
  const arr = Array.isArray(prod) ? prod : [];

  let costo = 0, venta = 0, unidades = 0;
  for (const p of arr) {
    const s = num(p.stock);
    costo += num(p.cost_price) * s;
    venta += num(p.sale_price) * s;
    unidades += s;
  }
  const margen = venta > 0 ? (venta - costo) / venta : 0;

  // productos con stock > 0 pero sin venta (cruzamos con ventas.items[].id)
  let idsVendidos = new Set<number>();
  try {
    const ventas = await rest('GET', 'ventas?select=items');
    if (Array.isArray(ventas)) {
      for (const v of ventas) {
        const items = Array.isArray(v.items) ? v.items : [];
        for (const it of items) {
          if (it && it.id != null) idsVendidos.add(Number(it.id));
        }
      }
    }
  } catch (_e) { /* sin ventas */ }

  const sinMovimiento = arr.filter((p) => num(p.stock) > 0 && !idsVendidos.has(Number(p.id)));

  return {
    ok: true,
    productos: arr,
    sin_movimiento: sinMovimiento,
    totales: {
      unidades,
      valor_costo: r2(costo),
      valor_venta: r2(venta),
      margen: margen,
      productos_activos: arr.length,
    },
  };
}

async function accCompras() {
  const compras = await rest('GET', 'compras?select=*&order=fecha.desc,id.desc');
  const arr = Array.isArray(compras) ? compras : [];
  let total = 0;
  for (const c of arr) total += num(c.costo_total);
  return { ok: true, compras: arr, totales: { total_compras: r2(total), conteo: arr.length } };
}

async function accCompraCrear(body: any) {
  const proveedor = String(body.proveedor || '').trim();
  const producto = String(body.producto || '').trim();
  const costo_total = num(body.costo_total);
  if (!producto) return { ok: false, error: 'Falta el nombre del producto' };
  if (costo_total <= 0) return { ok: false, error: 'El costo total debe ser mayor a 0' };
  const cantidad = Math.max(1, Math.floor(num(body.cantidad) || 1));
  const costo_unitario = r2(costo_total / cantidad);
  const inventory_id = body.inventory_id != null && body.inventory_id !== '' ? Number(body.inventory_id) : null;

  const fila: any = {
    proveedor: proveedor || null,
    producto,
    inventory_id,
    cantidad,
    costo_total: r2(costo_total),
    costo_unitario,
    metodo_pago: body.metodo_pago ? String(body.metodo_pago) : null,
    documento: body.documento ? String(body.documento) : null,
    nota: body.nota ? String(body.nota) : null,
    creado_por: body.creado_por ? String(body.creado_por) : 'finanzas-api',
  };
  if (body.fecha) fila.fecha = String(body.fecha);

  const compra = await rest('POST', 'compras', fila);

  if (inventory_id) {
    try {
      const inv = await rest('GET', `inventory?select=id,stock&id=eq.${inventory_id}`);
      const p = Array.isArray(inv) ? inv[0] : null;
      if (p) {
        await rest('PATCH', `inventory?id=eq.${inventory_id}`, { stock: num(p.stock) + cantidad });
      }
    } catch (_e) { /* no rompe la compra si el stock falla */ }
  }

  return { ok: true, compra: Array.isArray(compra) ? compra[0] : compra };
}

async function accGastos() {
  const gastos = await rest('GET', 'gastos?select=*&order=fecha.desc,id.desc');
  const arr = Array.isArray(gastos) ? gastos : [];
  let total = 0;
  for (const g of arr) total += num(g.monto);
  return { ok: true, gastos: arr, totales: { total_gastos: r2(total), conteo: arr.length } };
}

async function accGastoCrear(body: any) {
  const monto = num(body.monto);
  if (monto <= 0) return { ok: false, error: 'El monto debe ser mayor a 0' };
  const fila: any = {
    categoria: body.categoria ? String(body.categoria) : null,
    descripcion: body.descripcion ? String(body.descripcion) : null,
    monto: r2(monto),
    metodo_pago: body.metodo_pago ? String(body.metodo_pago) : null,
    documento: body.documento ? String(body.documento) : null,
    creado_por: body.creado_por ? String(body.creado_por) : 'finanzas-api',
  };
  if (body.fecha) fila.fecha = String(body.fecha);
  const gasto = await rest('POST', 'gastos', fila);
  return { ok: true, gasto: Array.isArray(gasto) ? gasto[0] : gasto };
}

async function leerConfigFin() {
  const conf = await rest('GET', 'config_operativa?select=clave,valor,notas&clave=like.fin_*');
  const out: Record<string, string> = {};
  if (Array.isArray(conf)) for (const c of conf) if (c.clave) out[c.clave] = c.valor;
  return { conf, out };
}

async function accNegocio() {
  const ventas = await rest('GET', 'ventas?select=*&order=fecha_entrega.desc,id.desc');
  const arr = Array.isArray(ventas) ? ventas : [];
  const tot = totalesVentas(arr);

  const mes = mesHoy();
  let gastosMes = 0, gastosTotal = 0;
  try {
    const gastos = await rest('GET', 'gastos?select=fecha,monto');
    if (Array.isArray(gastos)) {
      for (const g of gastos) {
        const m = num(g.monto);
        gastosTotal += m;
        if (String(g.fecha || '').slice(0, 7) === mes) gastosMes += m;
      }
    }
  } catch (_e) { /* sin gastos */ }

  const ventasMes = arr.filter((v) => String(v.fecha_entrega || v.fecha_compra || '').slice(0, 7) === mes);
  const totMes = totalesVentas(ventasMes);
  const resultadoMes = totMes.venta_neta - totMes.costo_productos - totMes.comision - gastosMes;

  // margen de contribución (utilidad neta sobre venta neta)
  const margenContribucion = totMes.venta_neta > 0
    ? (totMes.venta_neta - totMes.costo_productos - totMes.comision) / totMes.venta_neta
    : 0;

  // top productos vendidos (agrupar ventas.items por name)
  const porProducto: Record<string, { qty: number; ingresos: number }> = {};
  for (const v of arr) {
    const items = Array.isArray(v.items) ? v.items : [];
    for (const it of items) {
      const name = String(it.name || 'sin nombre').trim();
      if (!name) continue;
      const qty = Math.max(1, Math.floor(num(it.qty) || 1));
      const price = num(it.price);
      if (!porProducto[name]) porProducto[name] = { qty: 0, ingresos: 0 };
      porProducto[name].qty += qty;
      porProducto[name].ingresos += price * qty;
    }
  }
  const top = Object.entries(porProducto)
    .map(([name, d]) => ({ name, qty: d.qty, ingresos: r2(d.ingresos) }))
    .sort((a, b) => b.ingresos - a.ingresos)
    .slice(0, 10);

  // evolución mensual
  const porMes: Record<string, any> = {};
  for (const v of arr) {
    const m = String(v.fecha_entrega || v.fecha_compra || '').slice(0, 7);
    if (!m) continue;
    if (!porMes[m]) porMes[m] = { mes: m, venta_neta: 0, utilidad: 0, ventas: 0 };
    porMes[m].venta_neta += num(v.venta_neta);
    porMes[m].utilidad += num(v.utilidad_neta);
    porMes[m].ventas += 1;
  }
  const evolucion = Object.values(porMes).sort((a: any, b: any) => (a.mes < b.mes ? -1 : 1));

  // punto de equilibrio
  const fijos = num((await leerConfigFin()).out.fin_punto_equilibrio_mensual);
  const peVentas = margenContribucion > 0 ? fijos / margenContribucion : null;

  return {
    ok: true,
    mes,
    resultado: {
      venta_neta: totMes.venta_neta,
      costo_productos: totMes.costo_productos,
      comision: totMes.comision,
      gastos_mes: r2(gastosMes),
      resultado_mes: r2(resultadoMes),
      margen_contribucion: margenContribucion,
      ticket_promedio: totMes.ticket_promedio,
      ventas_mes: totMes.conteo,
    },
    top_productos: top,
    evolucion_mensual: evolucion,
    punto_equilibrio: {
      gastos_fijos: fijos,
      ingreso_necesario: peVentas != null ? r2(peVentas) : null,
      ventas_necesarias: peVentas != null && totMes.ticket_promedio > 0
        ? Math.ceil(peVentas / totMes.ticket_promedio) : null,
    },
  };
}

async function accHacienda() {
  const ventas = await rest('GET', 'ventas?select=*&order=fecha_entrega.desc,id.desc');
  const arr = Array.isArray(ventas) ? ventas : [];
  const tot = totalesVentas(arr);

  let comprasTotal = 0, gastosTotal = 0;
  const porMes: Record<string, any> = {};
  for (const v of arr) {
    const m = String(v.fecha_entrega || v.fecha_compra || '').slice(0, 7);
    if (!m) continue;
    if (!porMes[m]) porMes[m] = { mes: m, venta_neta: 0, iva: 0, compras: 0, gastos: 0 };
    porMes[m].venta_neta += num(v.venta_neta);
    porMes[m].iva += num(v.iva_incluido);
  }
  try {
    const compras = await rest('GET', 'compras?select=fecha,costo_total');
    if (Array.isArray(compras)) {
      for (const c of compras) {
        const m = String(c.fecha || '').slice(0, 7);
        comprasTotal += num(c.costo_total);
        if (m) { if (!porMes[m]) porMes[m] = { mes: m, venta_neta: 0, iva: 0, compras: 0, gastos: 0 }; porMes[m].compras += num(c.costo_total); }
      }
    }
  } catch (_e) { /* sin compras */ }
  try {
    const gastos = await rest('GET', 'gastos?select=fecha,monto');
    if (Array.isArray(gastos)) {
      for (const g of gastos) {
        const m = String(g.fecha || '').slice(0, 7);
        gastosTotal += num(g.monto);
        if (m) { if (!porMes[m]) porMes[m] = { mes: m, venta_neta: 0, iva: 0, compras: 0, gastos: 0 }; porMes[m].gastos += num(g.monto); }
      }
    }
  } catch (_e) { /* sin gastos */ }

  const resumen = Object.values(porMes).sort((a: any, b: any) => (a.mes < b.mes ? -1 : 1));
  const { out } = await leerConfigFin();
  const tasa = num(out.fin_iva);

  return {
    ok: true,
    iva_tasa: tasa,
    iva_cobrado: tot.iva,
    ventas_netas: tot.venta_neta,
    compras: r2(comprasTotal),
    gastos: r2(gastosTotal),
    resumen_por_mes: resumen,
    aviso: 'Este cálculo es una preparación para tu declaración de IVA. Revisá los montos con tu contador antes de presentar la declaración oficial.',
  };
}

async function accConfig() {
  const { out } = await leerConfigFin();
  return { ok: true, config: out };
}

async function accConfigSet(body: any) {
  const claves = body.claves || body.config || {};
  if (!claves || typeof claves !== 'object') return { ok: false, error: 'Faltan las claves a guardar' };
  const permitidas = ['fin_iva', 'fin_comision_wompi_pct', 'fin_comision_wompi_fija', 'fin_punto_equilibrio_mensual', 'fin_ganancia_objetivo'];
  const aGuardar: any[] = [];
  for (const [k, v] of Object.entries(claves)) {
    if (!k.startsWith('fin_') || !permitidas.includes(k)) continue;
    aGuardar.push({ clave: k, valor: String(v), notas: null, actualizado_en: new Date().toISOString() });
  }
  if (!aGuardar.length) return { ok: false, error: 'No hay claves fin_* válidas para guardar' };
  await rest('POST', 'config_operativa', aGuardar);
  const { out } = await leerConfigFin();
  return { ok: true, config: out };
}

// ---------- handler principal ----------
async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  let body: any = {};
  try {
    if (req.method === 'POST') body = await req.json();
  } catch (_e) {
    return json({ ok: false, error: 'JSON inválido' }, 400);
  }

  const auth = await esAdmin(req);
  if (!auth.ok) return json({ ok: false, error: 'no_autorizado' }, 401);

  const accion = String(body.accion || '');

  try {
    switch (accion) {
      case 'resumen': return json(await accResumen());
      case 'ventas': return json(await accVentas());
      case 'inventario': return json(await accInventario());
      case 'compras': return json(await accCompras());
      case 'compra_crear': return json(await accCompraCrear(body));
      case 'gastos': return json(await accGastos());
      case 'gasto_crear': return json(await accGastoCrear(body));
      case 'negocio': return json(await accNegocio());
      case 'hacienda': return json(await accHacienda());
      case 'config': return json(await accConfig());
      case 'config_set': return json(await accConfigSet(body));
      default: return json({ ok: false, error: 'accion_desconocida' }, 400);
    }
  } catch (e: any) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}

Deno.serve(handler);
