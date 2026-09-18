// BARATUSS — Seguimiento automático de entregas EN LA NUBE (no depende de ninguna PC)
// Corre por cron de Supabase cada 5 minutos. Envía: agradecimiento (plantilla), recordatorio
// día antes (mañana y tarde), confirmación 1h antes, resumen go/no-go a Cindy, y libera reservas.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);
const WA_TOKEN = Deno.env.get('META_WA_TOKEN') || '';
const PHONE_ID = Deno.env.get('META_PHONE_ID') || '';
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const TG_CHATS = (Deno.env.get('TELEGRAM_CHAT_ID') || '').split(',').map(s => s.trim()).filter(Boolean);
const CINDY_WA = '50376626575';   // WhatsApp de Cindy (avisos go/no-go)
const MS_DIA = 86400000;

// ===== utilidades =====
function ahoraSV(): Date { return new Date(Date.now() - 6 * 3600000); }  // hora local El Salvador

function normalizarTel(tel: string): string {
  let t = (tel || '').replace(/\D/g, '');
  if (t.startsWith('0')) t = '503' + t.slice(1);
  if (t.length === 8) t = '503' + t;
  return t;
}

// Devuelve el wamid (identificador del mensaje en Meta) o null si falló.
// El wamid es lo que permite después saber si el mensaje LLEGÓ (Meta manda el estado después).
async function enviarPlantilla(tel: string, plantilla: string, params: string[], etiqueta = ''): Promise<string | null> {
  if (!WA_TOKEN || !PHONE_ID) return null;
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: normalizarTel(tel), type: 'template',
        template: {
          name: plantilla, language: { code: 'es' },
          components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
        }
      })
    });
    const d = await r.json();
    const wamid = d?.messages?.[0]?.id ? String(d.messages[0].id) : null;
    console.log('PLANTILLA', plantilla, '->', tel, etiqueta, wamid ? 'OK' : JSON.stringify(d).slice(0, 180));
    return wamid;
  } catch (e) { console.log('error plantilla', String(e)); return null; }
}

// Registra el saliente en la bitácora con su wamid: así el webhook puede actualizar
// "entregado / leído / falló" cuando Meta manda el estado (sin esto no se sabe si llegó).
async function registrarSaliente(wamid: string | null, tel: string, plantilla: string, ref: string) {
  if (!wamid) return;
  try {
    await supabase.from('wa_mensajes').insert({
      wa_message_id: wamid,
      telefono: normalizarTel(tel),
      texto: '(plantilla: ' + plantilla + ')',
      tipo: 'template',
      direccion: 'saliente',
      order_reference: ref || null,
      atendido_por: 'seguimiento-entregas',
      estado_entrega: 'sent',
      wa_timestamp: new Date().toISOString()
    });
  } catch (_e) { /* no rompe el envío si falla el registro */ }
}

async function avisarTG(texto: string) {
  if (!TG_TOKEN) return;
  for (const chat of TG_CHATS) {
    try {
      await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true })
      });
    } catch (_e) { /* silencio */ }
  }
}

function proximaFecha(diaSemana: number, base: Date): Date {
  let dias = (diaSemana - base.getUTCDay() + 7) % 7;
  if (dias === 0) dias = 7;
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dias));
}

function fechaBloque(destino: string, createdAt: string): Date | null {
  const d = (destino || '').toLowerCase();
  let base = ahoraSV();
  if (createdAt) {
    const c = new Date(createdAt);
    if (!isNaN(c.getTime())) base = new Date(c.getTime() - 6 * 3600000);
  }
  if (d.includes('mié') || d.includes('mie')) return proximaFecha(3, base);   // 3 = miércoles
  if (d.includes('sáb') || d.includes('sab')) return proximaFecha(6, base);   // 6 = sábado
  return null;
}

function horaInicio(destino: string): number {
  const d = destino || '';
  if (d.includes('08:00')) return 8;
  if (d.includes('12:00')) return 12;
  if (d.includes('14:00')) return 14;
  return 8;
}

function fmtFecha(f: Date): string {
  const dd = String(f.getUTCDate()).padStart(2, '0');
  const mm = String(f.getUTCMonth() + 1).padStart(2, '0');
  return dd + '/' + mm + '/' + f.getUTCFullYear();
}

async function montoOrden(ref: string): Promise<string> {
  const { data } = await supabase.from('orders').select('total').eq('reference', ref).limit(1).maybeSingle();
  return data ? '$' + Number(data.total || 0).toFixed(2) : '—';
}

async function marcar(despId: number, notas: string, marca: string) {
  const nuevas = ((notas || '') + '\n' + marca).trim().slice(-4000);
  await supabase.from('despachos').update({ notas: nuevas }).eq('id', despId);
  return nuevas;
}

// Marca TODOS los despachos del mismo pedido (un pedido con varios productos = varios despachos,
// pero el cliente debe recibir UN solo mensaje por pedido)
async function marcarPedido(ref: string, notas: string, marca: string) {
  const nuevas = ((notas || '') + '\n' + marca).trim().slice(-4000);
  if (ref) await supabase.from('despachos').update({ notas: nuevas }).eq('order_reference', ref);
  return nuevas;
}

// ANTI-DUPLICADO ATÓMICO: reclama el pedido ANTES de enviar.
// Un solo UPDATE ... WHERE notas NOT LIKE '%MARCA%' RETURNING id: si dos ejecuciones coinciden
// (dos relojes, o el aviso instantáneo del checkout + el reloj), solo UNA escribe filas.
// La que recibe 0 filas NO envía. Así la carrera queda cerrada en la base, no en el código.
async function reclamarPedido(ref: string, notas: string, marca: string, guarda: string): Promise<boolean> {
  if (!ref) return false;
  const nuevas = ((notas || '') + '\n' + marca).trim().slice(-4000);
  const { data, error } = await supabase.from('despachos')
    .update({ notas: nuevas })
    .eq('order_reference', ref)
    .or('notas.is.null,notas.not.like.%' + guarda + '%')
    .select('id');
  if (error) { console.log('reclamo error', guarda, JSON.stringify(error).slice(0, 150)); return false; }
  return !!(data && data.length);
}

// Si el envío falla después de reclamar, se devuelve la marca para que el próximo ciclo reintente
async function devolverReclamo(ref: string, notas: string) {
  if (!ref) return;
  await supabase.from('despachos').update({ notas }).eq('order_reference', ref);
}

// ===== proceso principal =====
serve(async (_req) => {
  const hoy = ahoraSV();
  const hoyStr = fmtFecha(hoy);
  const hora = hoy.getUTCHours();
  const resumen = new Map<string, { total: number; conf: number; destino: string }>();
  const log: string[] = [];

  // 0. Liberar reservas vencidas (libera productos que nadie terminó de comprar)
  try {
    const { data } = await supabase.rpc('liberar_reservas_vencidas');
    if (data) log.push('reservas liberadas: ' + data);
  } catch (_e) { /* silencio */ }

  const { data: despachos } = await supabase
    .from('despachos')
    .select('id, order_reference, customer_name, customer_phone, destino, notas, estado_logistico, created_at')
    .neq('estado_logistico', 'entregado')
    .order('id', { ascending: false })
    .limit(50);

  // ANTI-DUPLICADO: un pedido con varios productos genera varios despachos,
  // pero el cliente debe recibir UN solo mensaje por pedido y por tipo.
  const pedidosAgrad = new Set<string>();
  const pedidosRecAM = new Set<string>();
  const pedidosRecPM = new Set<string>();
  const pedidosConf1h = new Set<string>();
  for (const d of despachos || []) {
    const n = d.notas || '';
    const r = d.order_reference || '';
    if (!r) continue;
    if (n.includes('AGRAD')) pedidosAgrad.add(r);
    if (n.includes('RECORD-AM')) pedidosRecAM.add(r);
    if (n.includes('RECORD-PM')) pedidosRecPM.add(r);
    if (n.includes('CONF-1H')) pedidosConf1h.add(r);
  }

  for (const d of despachos || []) {
    const tel = d.customer_phone;
    const notas0 = d.notas || '';
    const notas = notas0;
    const nombre = String(d.customer_name || 'cliente').split(' ')[0];
    const ref = d.order_reference || '';
    const destino = d.destino || 'tu punto de entrega';
    const fecha = fechaBloque(destino, d.created_at);
    if (!tel || !fecha) continue;
    const fechaStr = fmtFecha(fecha);
    const hi = horaInicio(destino);
    const sello = hoy.toISOString().slice(0, 16).replace('T', ' ');

    // (1) AGRADECIMIENTO (uno solo por PEDIDO, aunque tenga varios productos)
    if (!notas.includes('AGRAD') && !pedidosAgrad.has(ref)) {
      const monto = await montoOrden(ref);
      if (await reclamarPedido(ref, notas, '📤 AGRAD ' + sello, 'AGRAD')) {
        const wamid = await enviarPlantilla(tel, 'pedido_confirmado_baratuss', [nombre, ref, monto], 'AGRADECIMIENTO');
        if (wamid) {
          await registrarSaliente(wamid, tel, 'pedido_confirmado_baratuss', ref);
          pedidosAgrad.add(ref);
          log.push('AGRAD -> ' + tel);
        } else {
          await devolverReclamo(ref, notas);
          log.push('AGRAD FALLO (se reintenta) -> ' + tel);
        }
      }
    }

    // (2) RECORDATORIO el día antes (mañana y tarde)
    const difDias = Math.round((fecha.getTime() - new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate())).getTime()) / MS_DIA);
    if (difDias === 1) {
      if (hora < 12 && !notas.includes('RECORD-AM') && !pedidosRecAM.has(ref)) {
        if (await reclamarPedido(ref, notas, '📤 RECORD-AM ' + sello, 'RECORD-AM')) {
          const wamid = await enviarPlantilla(tel, 'recordatorio_entrega_baratuss', [nombre, fechaStr, destino], 'RECORD-AM');
          if (wamid) {
            await registrarSaliente(wamid, tel, 'recordatorio_entrega_baratuss', ref);
            pedidosRecAM.add(ref);
            log.push('RECORD-AM -> ' + tel);
          } else {
            await devolverReclamo(ref, notas);
            log.push('RECORD-AM FALLO (se reintenta) -> ' + tel);
          }
        }
      } else if (hora >= 14 && !notas.includes('RECORD-PM') && !pedidosRecPM.has(ref)) {
        if (await reclamarPedido(ref, notas, '📤 RECORD-PM ' + sello, 'RECORD-PM')) {
          const wamid = await enviarPlantilla(tel, 'recordatorio_entrega_baratuss', [nombre, fechaStr, destino], 'RECORD-PM');
          if (wamid) {
            await registrarSaliente(wamid, tel, 'recordatorio_entrega_baratuss', ref);
            pedidosRecPM.add(ref);
            log.push('RECORD-PM -> ' + tel);
          } else {
            await devolverReclamo(ref, notas);
            log.push('RECORD-PM FALLO (se reintenta) -> ' + tel);
          }
        }
      }
    }

    // (3) CONFIRMACIÓN 1 hora antes (mismo día) — una sola por PEDIDO
    if (fechaStr === hoyStr && !notas.includes('CONF-1H') && !pedidosConf1h.has(ref)) {
      const minutos = (hi - hora) * 60;
      if (minutos >= 0 && minutos <= 60) {
        if (await reclamarPedido(ref, notas, '📤 CONF-1H ' + sello, 'CONF-1H')) {
          const wamid = await enviarPlantilla(tel, 'recordatorio_entrega_baratuss', [nombre, 'HOY ' + destino, destino], 'CONFIRMACION-1H');
          if (wamid) {
            await registrarSaliente(wamid, tel, 'recordatorio_entrega_baratuss', ref);
            pedidosConf1h.add(ref);
            log.push('CONF-1H -> ' + tel);
          } else {
            await devolverReclamo(ref, notas);
            log.push('CONF-1H FALLO (se reintenta) -> ' + tel);
          }
        }
      }
    }

    // (4) Datos para el go/no-go
    const clave = fechaStr + '|' + hi + '|' + destino;
    const r = resumen.get(clave) || { total: 0, conf: 0, destino };
    r.total++;
    if (notas.includes('✅ CONF')) r.conf++;
    resumen.set(clave, r);
  }

  // (5) Go/no-go a Cindy (día de la entrega, a las 7 y a las 13)
  for (const [clave, r] of resumen.entries()) {
    const [fechaStr, hiStr] = clave.split('|');
    const hi = Number(hiStr);
    if (fechaStr !== hoyStr) continue;
    const esManana = hi === 8 && hora === 7;
    const esTarde = hi === 14 && hora === 13;
    if (!esManana && !esTarde) continue;
    const aviso = '📋 BARATUSS — bloque de ' + (esManana ? 'hoy (mañana)' : 'hoy (tarde)') + ': ' +
      r.total + ' pedido(s), ' + r.conf + ' confirmado(s).\n' + r.destino + '\n' +
      (r.conf > 0 ? '✅ SÍ vas: hay clientes confirmados.' : '❌ Dejá el bloque: nadie confirmó (ahorrás el viaje).');
    const wamid = await enviarPlantilla(CINDY_WA, 'pedido_listo_retiro_baratuss', ['Cindy', 'resumen del día', r.destino], 'GO/NO-GO');
    await registrarSaliente(wamid, CINDY_WA, 'pedido_listo_retiro_baratuss', '');
    await avisarTG(aviso);
    log.push('go/no-go enviado: ' + clave);
  }

  return new Response(JSON.stringify({ ok: true, despachos: (despachos || []).length, log }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
});
