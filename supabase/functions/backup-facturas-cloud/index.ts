// ============================================================================
// BARATUSS · backup-facturas-cloud (E6 del plan "todo en código")
//
// Exporta a JSON las tablas `orders`, `ventas`, `cupones` y las `fac_*`
// (facturación) leyéndolas por PostgREST con la service key, y sube el JSON a
// un bucket PRIVADO `backups` de Supabase Storage.
//
// Reemplaza el cron de la PC "Backup facturas → Google Drive" (roto por OAuth).
//
// Al terminar escribe una fila en `chequeos_salud` con chequeo='backup-cloud'
// para que el centinela (salud-baratuss, chequeo #14) la detecte.
//
// Seguridad: función pública (no-verify-jwt) pero exige la clave interna
// x-baratuss-key (FACTURA_KEY / config_operativa.factura_trigger_key).
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const FACTURA_KEY = Deno.env.get('FACTURA_KEY') || '';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const BUCKET = 'backups';

// Tablas a respaldar, con su columna de orden para paginar de forma estable.
const TABLAS: Array<{ nombre: string; orden: string }> = [
  { nombre: 'orders', orden: 'id' },
  { nombre: 'ventas', orden: 'id' },
  { nombre: 'cupones', orden: 'codigo' },
  { nombre: 'fac_facturas', orden: 'id' },
  { nombre: 'fac_clientes', orden: 'id' },
  { nombre: 'fac_productos', orden: 'id' },
  { nombre: 'fac_serie', orden: 'tipo' },
  { nombre: 'fac_auditoria', orden: 'id' },
  { nombre: 'fac_config', orden: 'id' },
  { nombre: 'fac_recibidas', orden: 'id' },
];

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-baratuss-key' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function authHeaders(): Record<string, string> {
  return { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY };
}

async function claveValida(clave: string): Promise<boolean> {
  if (!clave) return false;
  if (FACTURA_KEY && clave === FACTURA_KEY) return true;
  try {
    const { data } = await supabase.from('config_operativa').select('valor').eq('clave', 'factura_trigger_key').maybeSingle();
    if (data?.valor && clave === data.valor) return true;
  } catch (_e) { /* silencio */ }
  return false;
}

// Lee una tabla completa por PostgREST, paginando de a 1000 filas.
async function leerTabla(tabla: string, orden: string): Promise<unknown[]> {
  const filas: unknown[] = [];
  const limit = 1000;
  let offset = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${tabla}?select=*&order=${orden}.asc&limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { headers: authHeaders() });
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error('lectura ' + tabla + ': ' + JSON.stringify(d).slice(0, 200));
    filas.push(...d);
    if (d.length < limit) break;
    offset += limit;
  }
  return filas;
}

async function existeBucket(nombre: string): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${nombre}`, { headers: authHeaders() });
  return r.ok;
}

async function crearBucket(nombre: string): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nombre, public: false }),
  });
  if (r.ok) return true;
  const d = await r.json().catch(() => ({}));
  return /already exists/i.test(String(d?.message || d?.error || ''));
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const clave = req.headers.get('x-baratuss-key') || '';
    if (!(await claveValida(clave))) return json({ error: 'no autorizado' }, 401);

    // 1) leer todas las tablas
    const datos: Record<string, unknown> = {};
    const conteos: Record<string, number> = {};
    for (const t of TABLAS) {
      try {
        const filas = await leerTabla(t.nombre, t.orden);
        datos[t.nombre] = filas;
        conteos[t.nombre] = filas.length;
      } catch (e) {
        datos[t.nombre] = { error: String(e).slice(0, 200) };
        conteos[t.nombre] = -1;
      }
    }

    const nombreArchivo = `backup_${stamp()}.json`;
    const payload = {
      generado: new Date().toISOString(),
      origen: 'backup-facturas-cloud',
      backup: nombreArchivo,
      conteos,
      tablas: datos,
    };

    // 2) asegurar el bucket privado `backups`
    if (!(await existeBucket(BUCKET))) {
      const creado = await crearBucket(BUCKET);
      if (!creado) return json({ ok: false, error: 'no se pudo crear el bucket ' + BUCKET }, 500);
    }

    // 3) subir el JSON
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${nombreArchivo}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: bytes,
    });
    if (!up.ok) {
      const d = await up.text().catch(() => '');
      return json({ ok: false, error: 'subida a Storage falló: HTTP ' + up.status + ' ' + d.slice(0, 200) }, 500);
    }

    // 4) marca para el centinela (chequeo #14)
    let marcado = false;
    try {
      const { error } = await supabase.from('chequeos_salud').insert({
        chequeo: 'backup-cloud',
        estado: 'ok',
        detalle: `${nombreArchivo} subido a bucket ${BUCKET} (${conteos['orders']} orders, ${conteos['ventas']} ventas)`,
        avisado: false,
      });
      marcado = !error;
      if (error) console.log('no se pudo escribir chequeos_salud:', error.message);
    } catch (e) {
      console.log('no se pudo escribir chequeos_salud:', String(e));
    }

    const objeto = `${BUCKET}/${nombreArchivo}`;
    return json({
      ok: true,
      bucket: BUCKET,
      archivo: nombreArchivo,
      objeto,
      bytes: bytes.length,
      conteos,
      marca_chequeos_salud: marcado,
    });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
