// ============================================================================
// BARATUSS · _shared/verificacion.ts · 24-sep-2026
// Helpers compartidos del sistema de verificación de clientes (correo + WhatsApp).
// Se reutiliza el patrón de pagos-noshow (ventanaAbierta, esSinWhatsApp,
// marcarSinWhatsApp, enviarTexto, enviarPlantilla, registrarSaliente) SIN tocar
// el original.
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const WA_TOKEN = Deno.env.get('META_WA_TOKEN') || '';
const PHONE_ID = Deno.env.get('META_PHONE_ID') || '';

export const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// 🔐 Pepita secreta del hash de códigos. NO vive en la base.
export const PEPPER = 'eeb76803176b31e947c3c2ff08e103deff874c726b7264b1e90dbfb60d016bbc';

// ===== utilidades =====
export function normalizarTel(tel: string): string {
  let t = (tel || '').replace(/\D/g, '');
  if (t.startsWith('0')) t = '503' + t.slice(1);
  if (t.length === 8) t = '503' + t;
  return t;
}

// Código de 6 dígitos impredecible (crypto, no Math.random)
export function generarCodigo6(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => String(x % 10)).join('');
}

export async function sha256Hex(txt: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// sha256(codigo + ':' + dato + ':' + PEPPER) — nunca se guarda el código en claro
export function hashCodigo(codigo: string, dato: string): Promise<string> {
  return sha256Hex(codigo + ':' + dato + ':' + PEPPER);
}

// Huella no reversible de la IP (para limitar por IP sin guardar la IP)
export function hashIP(ip: string): Promise<string> {
  if (!ip) return Promise.resolve('');
  return sha256Hex(ip + ':' + PEPPER);
}

// ===== WhatsApp (patrón copiado de pagos-noshow) =====
export function esSinWhatsApp(d: any): string {
  const code = Number(d?.error?.code || 0);
  const msg = String(d?.error?.message || '');
  if (code === 131026 || code === 133010 || /not (a )?whatsapp|no whatsapp|not registered/i.test(msg)) return 'sin_whatsapp';
  if (code === 131047 || /re-engagement|24 hour|24-hour/i.test(msg)) return 'ventana_cerrada';
  return '';
}

export async function marcarSinWhatsApp(tel: string, motivo: string) {
  try {
    await supabase.from('wa_telefonos').upsert({ telefono: normalizarTel(tel), tiene_whatsapp: false, motivo, detectado_en: new Date().toISOString() });
  } catch (e) { console.log('marcarSinWhatsApp', String(e)); }
}

export type EnvioWA = { wamid: string | null; error: string };
export async function enviarTexto(tel: string, texto: string, etiqueta = ''): Promise<EnvioWA> {
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

export async function enviarPlantilla(tel: string, plantilla: string, params: string[], etiqueta = ''): Promise<EnvioWA> {
  if (!WA_TOKEN || !PHONE_ID) return { wamid: null, error: 'sin_token' };
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + PHONE_ID + '/messages', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: normalizarTel(tel), type: 'template',
        template: { name: plantilla, language: { code: 'es' }, components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] },
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

export async function ventanaAbierta(tel: string): Promise<boolean> {
  try {
    const desde = new Date(Date.now() - 24 * 3600000).toISOString();
    const { data } = await supabase.from('wa_mensajes').select('id')
      .eq('telefono', normalizarTel(tel)).eq('direccion', 'entrante').gte('creado_en', desde).limit(1);
    return !!(data && data.length);
  } catch (_e) { return false; }
}

export async function registrarSaliente(wamid: string | null, tel: string, plantilla: string, ref: string, contenido = '') {
  if (!wamid) return;
  try {
    await supabase.from('wa_mensajes').insert({
      wa_message_id: wamid, telefono: normalizarTel(tel), direccion: 'saliente',
      atendido_por: 'enviar-codigo-wa', order_reference: ref || null,
      texto: contenido || ('(plantilla: ' + plantilla + ')'),
    });
  } catch (e) { console.log('registrarSaliente', String(e)); }
}

// ===== Reglas de negocio (usadas por crear-pedido y wompi-checkout) =====
// ¿El interruptor de verificación está ACTIVO?
export async function verificacionActiva(): Promise<boolean> {
  const { data } = await supabase.from('config_operativa')
    .select('valor').eq('clave', 'plan_verificacion_clientes').maybeSingle();
  return String(data?.valor || 'apagado') === 'activo';
}

// ¿Este teléfono ya está verificado?
export async function telefonoVerificado(tel: string): Promise<boolean> {
  const { data } = await supabase.from('verif_datos')
    .select('id').eq('tipo', 'telefono').eq('dato', tel).is('revocado_en', null).maybeSingle();
  return !!data;
}

// ¿Ya usó su 10% de bienvenida este teléfono? (PK de bienvenidas = teléfono)
export async function bienvenidaYaUsada(tel: string): Promise<boolean> {
  const { data } = await supabase.from('bienvenidas').select('dato').eq('dato', tel).maybeSingle();
  return !!data;
}
