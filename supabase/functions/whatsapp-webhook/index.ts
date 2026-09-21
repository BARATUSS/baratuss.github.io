// BARATUSS — Webhook de WhatsApp UNIFICADO
// Combina: (a) validación de firma de Meta (seguridad), (b) guardado en wa_mensajes (historial/bandeja),
// (c) DIRECTIVA DE MENSAJES aprobada por Leo: clasificar, responder dentro de la ventana gratis,
//     una sola respuesta por conversación, y derivar cambios/reclamos a decisión humana.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

const VERIFY_TOKEN = 'baratuss_wa_2026';           // pantalla de Meta (Configuración → Webhook)
const APP_SECRET = Deno.env.get('WHATSAPP_APP_SECRET') || '';
const WA_TOKEN = Deno.env.get('META_WA_TOKEN') || '';
const PHONE_ID = Deno.env.get('META_PHONE_ID') || '';

// ===== firma de Meta (X-Hub-Signature-256) =====
async function firmaValida(raw: string, header: string | null): Promise<boolean> {
  if (!APP_SECRET) return true;                 // sin secreto configurado no se valida
  if (!header || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === header.slice(7);
}

function extraerTexto(msg: any): string {
  return msg.text?.body
    || msg.button?.text
    || msg.interactive?.button_reply?.title
    || msg.interactive?.list_reply?.title
    || '[mensaje no textual]';
}

// ===== DIRECTIVA DE MENSAJES (ver documento DIRECTIVA_MENSAJES.md) =====
type Clase = 'confirmacion' | 'pregunta' | 'cambio' | 'otro';

function clasificar(texto: string, idBoton?: string): Clase {
  const t = ((idBoton || '') + ' ' + (texto || '')).toLowerCase().trim();
  const cambio = ['no puedo', 'cambiar', 'reprogram', 'otro dia', 'otro día', 'moveme', 'pasemos', 'no llego', 'mejor otro', 'no voy', 'necesito cambiar'];
  const confirmacion = ['gracias', 'ahí los espero', 'ahi los espero', 'los espero', 'ok', 'perfecto', 'sí', 'si', 'confirmo', 'confirmado', 'de acuerdo', 'dale', 'esta bien', 'está bien', 'excelente', 'muy amables', '👍', '✅', 'ahí estaré', 'ahi estare', 'estaré', 'estare'];
  const pregunta = ['?', '¿', 'cuando', 'cuándo', 'donde', 'dónde', 'hora', 'como llego', 'cómo llego', 'direccion', 'dirección'];
  for (const c of cambio) if (t.includes(c)) return 'cambio';
  for (const p of pregunta) if (t.includes(p)) return 'pregunta';
  for (const c of confirmacion) if (t.includes(c)) return 'confirmacion';
  return 'otro';
}

// ===== avisos a Telegram (grupo + privado de Leo) =====
async function avisarTelegram(texto: string) {
  const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
  const destinos = (Deno.env.get('TELEGRAM_CHAT_ID') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!tgToken || !destinos.length) return;
  for (const chatId of destinos) {
    try {
      await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true })
      });
    } catch (_e) { /* silencio */ }
  }
}

// Guarda un mensaje SALIENTE (para poder seguir su estado de entrega: sent/delivered/read/failed)
async function guardarSaliente(telefono: string, texto: string, wamid: string | null, tipo: string) {
  if (!wamid) return;
  try {
    await supabase.from('wa_mensajes').upsert({
      wa_message_id: wamid, telefono, texto, tipo, direccion: 'saliente',
      estado_entrega: 'sent', wa_timestamp: new Date().toISOString()
    }, { onConflict: 'wa_message_id', ignoreDuplicates: true });
  } catch (_e) { /* silencioso */ }
}

// ===== responder por WhatsApp (GRATIS: dentro de la ventana de 24h que abrió el cliente) =====
async function responderWhatsApp(telefono: string, texto: string): Promise<boolean> {
  if (!WA_TOKEN || !PHONE_ID) return false;
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: telefono, type: 'text', text: { body: texto } })
    });
    const d = await r.json();
    if (d?.messages?.[0]?.id) {
      await guardarSaliente(telefono, texto, d.messages[0].id, 'text');
      return true;
    }
    // Si Meta rechazo el envio, se registra el motivo
    if (d?.error) {
      await guardarSaliente(telefono, texto, 'ERROR-' + Date.now(), 'text');
      await avisarTelegram('⚠️ NO SE PUDO ENVIAR WHATSAPP\n\nA: +' + telefono +
        '\nMotivo: ' + (d.error.title || '') + ' — ' + (d.error.message || ''));
    }
    return false;
  } catch (_e) { return false; }
}

// ===== Menú de ventanas DINÁMICO: solo muestra ventanas con cupo disponible =====
// Cupo: 20 entregas por ventana, contando TODOS los pedidos asignados (pendientes + confirmados).
const CUPO_POR_VENTANA = 20;
const VENTANAS_DEF = [
  { id: 'VEN_MIE_AM', titulo: 'Mie - Metrocentro', desc: '08:00 a 12:00' },
  { id: 'VEN_MIE_PM', titulo: 'Mie - Santa Rosa/Merliot', desc: '14:00 a 17:00' },
  { id: 'VEN_SAB_AM', titulo: 'Sab - Metrocentro', desc: '08:00 a 10:00' },
  { id: 'VEN_SAB_MD', titulo: 'Sab - Plaza Merliot', desc: '12:00 a 14:00' }
];

// Destino tal como se guarda en los despachos (para aplicar el cambio de ventana)
const DESTINOS_VENTANA: Record<string, string> = {
  'VEN_MIE_AM': 'Mié — Metrocentro (08:00-12:00)',
  'VEN_MIE_PM': 'Mié — Plaza Merliot (14:00-17:00)',
  'VEN_SAB_AM': 'Sáb — Metrocentro (08:00-10:00)',
  'VEN_SAB_MD': 'Sáb — Plaza Merliot (12:00-14:00)'
};

function proximaFecha(diaSemana: number, base: Date): Date {
  let dias = (diaSemana - base.getUTCDay() + 7) % 7;
  if (dias === 0) dias = 7;
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + dias));
}

// Fecha del bloque de entrega segun el texto del destino (Mié / Sáb) y la fecha del pedido
function fechaBloque(destino: string, createdAt: string): Date | null {
  const d = (destino || '').toLowerCase();
  let base = new Date(Date.now() - 6 * 3600000);   // hora local El Salvador
  if (createdAt) {
    const c = new Date(createdAt);
    if (!isNaN(c.getTime())) base = new Date(c.getTime() - 6 * 3600000);
  }
  if (d.includes('mié') || d.includes('mie')) return proximaFecha(3, base);  // 3 = miércoles
  if (d.includes('sáb') || d.includes('sab')) return proximaFecha(6, base);  // 6 = sábado
  return null;
}

function ventanaDe(destino: string): string | null {
  const d = (destino || '').toLowerCase();
  const esMie = d.includes('mié') || d.includes('mie');
  const esSab = d.includes('sáb') || d.includes('sab');
  if (esMie && d.includes('08:00-12:00')) return 'VEN_MIE_AM';
  if (esMie && d.includes('14:00-17:00')) return 'VEN_MIE_PM';
  if (esSab && d.includes('08:00-10:00')) return 'VEN_SAB_AM';
  if (esSab && d.includes('12:00-14:00')) return 'VEN_SAB_MD';
  return null;
}

// Ocupación real de cada ventana (todos los pedidos activos asignados)
async function ocupacionVentanas(): Promise<Record<string, number>> {
  const { data } = await supabase
    .from('despachos')
    .select('destino, estado_logistico')
    .neq('estado_logistico', 'entregado')
    .limit(500);
  const cuenta: Record<string, number> = {};
  for (const d of data || []) {
    const v = ventanaDe((d as any).destino);
    if (v) cuenta[v] = (cuenta[v] || 0) + 1;
  }
  return cuenta;
}

// Ventanas bloqueadas por conflictos con el calendario personal de Cindy (las carga un proceso en la PC)
async function ventanasBloqueadas(): Promise<Set<string>> {
  try {
    const { data } = await supabase.from('ventanas_bloqueadas').select('ventana_id');
    return new Set((data || []).map((x: any) => String(x.ventana_id)));
  } catch (_e) { return new Set(); }
}

async function enviarWALista(telefono: string, nombre: string): Promise<boolean> {
  const cuenta = await ocupacionVentanas();
  const bloqueadas = await ventanasBloqueadas();
  const libres = VENTANAS_DEF.filter(v => !bloqueadas.has(v.id) && (cuenta[v.id] || 0) < CUPO_POR_VENTANA);

  // Todas llenas: no se ofrece nada, se avisa al equipo
  if (!libres.length) {
    await responderWhatsApp(telefono, 'Hola ' + nombre + ', por ahora estamos al tope de lugares en todas las ventanas 🙏 Te avisamos apenas se libere uno.');
    await avisarTelegram('⚠️ TODAS LAS VENTANAS LLENAS\n\nUn cliente pidió reprogramar (+' + telefono + ') y no hay cupo.\nRevisar si se abre un bloque extra o se lo llama.');
    return false;
  }

  const rows = libres.map(v => ({ id: v.id, title: v.titulo.slice(0, 24), description: v.desc }));
  try {
    const r = await fetch('https://graph.facebook.com/v21.0/' + PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: telefono, type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: 'Reprogramar entrega' },
          body: { text: 'Hola ' + nombre + ', elegí la ventana que te sirva y avisamos para confirmarla:' },
          footer: { text: 'BARATUSS' },
          action: { button: 'Ver ventanas', sections: [{ title: 'Ventanas con lugar', rows }] }
        }
      })
    });
    const d = await r.json();
    return !!d?.messages;
  } catch (_e) { return false; }
}

serve(async (req) => {
  const url = new URL(req.url);

  // ===== VERIFICACION DE META (GET) =====
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // ===== MENSAJES ENTRANTES (POST) =====
  if (req.method === 'POST') {
    const raw = await req.text();
    const firma = req.headers.get('x-hub-signature-256');
    // Modo de prueba interno: permite simular mensajes sin firma de Meta (header x-test-key)
    const TEST_KEY = Deno.env.get('WA_TEST_KEY') || '';
    const testKeyRecibida = req.headers.get('x-test-key') || '';
    const esPrueba = !!TEST_KEY && testKeyRecibida === TEST_KEY;
    if (!esPrueba && !(await firmaValida(raw, firma))) {
      return new Response(JSON.stringify({ ok: false, error: 'firma invalida' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      const body = JSON.parse(raw || '{}');
      let guardados = 0, cruzados = 0, respondidos = 0, errores = 0;

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id || null;
          const displayPhone = value.metadata?.display_phone_number || null;

          const contactos: Record<string, string | null> = {};
          for (const c of value.contacts || []) {
            contactos[String(c.wa_id || '')] = c.profile?.name || null;
          }

          // ===== MEJORA: registrar los ESTADOS DE ENTREGA de los mensajes salientes =====
          for (const st of (value.statuses || [])) {
            const estado = String(st.status || '');
            const err = (st.errors && st.errors[0]) || null;
            const motivo = err ? ((err.title || '') + ': ' + (err.error_data?.details || err.message || '')) : null;
            try {
              await supabase.from('wa_mensajes').update({
                estado_entrega: estado,
                error_entrega: motivo,
                entregado_en: (estado === 'delivered' || estado === 'read') ? new Date().toISOString() : null
              }).eq('wa_message_id', String(st.id || ''));
            } catch (_e) { /* silencioso */ }
            if (estado === 'failed') {
              await avisarTelegram('⚠️ MENSAJE NO ENTREGADO POR WHATSAPP\n\nA: +' + (st.recipient_id || '?') +
                '\nMotivo: ' + (motivo || 'desconocido') +
                '\n\n(Verificar si ese número tiene WhatsApp activo)');
            }
          }

          for (const msg of value.messages || []) {
            const tel = String(msg.from || '');
            const texto = extraerTexto(msg);
            const ts = msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null;
            const ult8 = tel.slice(-8);

            // ANTI-ABUSO: máximo 10 mensajes por hora por cliente (protege el sistema)
            try {
              const hace1h = new Date(Date.now() - 3600000).toISOString();
              const { count } = await supabase.from('wa_mensajes')
                .select('id', { count: 'exact', head: true })
                .eq('telefono', tel).eq('direccion', 'entrante').gte('wa_timestamp', hace1h);
              if ((count || 0) > 10) {
                await avisarTelegram('⚠️ EXCESO DE MENSAJES DE UN CLIENTE\n\nNúmero: +' + tel +
                  '\nMensajes en la última hora: ' + count + '\n(No se respondió automáticamente)');
                errores++;
                continue;
              }
            } catch (_e) { /* si el control falla, no se bloquea al cliente */ }

            // 1) Despacho activo de ese cliente
            const { data: desp } = await supabase
              .from('despachos')
              .select('id, notas, estado_logistico, customer_phone, customer_name, destino, order_reference')
              .ilike('customer_phone', '%' + ult8 + '%')
              .neq('estado_logistico', 'entregado')
              .order('id', { ascending: false })
              .limit(1)
              .maybeSingle();

            // 2) Guardar SIEMPRE el mensaje (historial + bandeja del panel)
            // ⚠️ ANTI-DUPLICADO (arreglo 2026-09-18): si este mensaje YA está en la bitácora,
            // no se procesa de nuevo. Meta reintenta entregas el mismo mensaje y, sin esto,
            // el cliente recibía DOS veces la misma respuesta automática.
            if (msg.id) {
              const { data: yaEsta } = await supabase
                .from('wa_mensajes').select('id').eq('wa_message_id', String(msg.id)).limit(1);
              if (yaEsta && yaEsta.length > 0) {
                console.log('mensaje repetido ignorado:', msg.id);
                continue;
              }
            }

            const { error: errIns } = await supabase.from('wa_mensajes').upsert({
              wa_message_id: msg.id || null,
              telefono: tel,
              nombre_perfil: contactos[tel] ?? null,
              texto,
              tipo: msg.type || 'text',
              direccion: 'entrante',
              phone_number_id: phoneNumberId,
              display_phone_number: displayPhone,
              order_reference: (desp as any)?.order_reference || null,
              despacho_id: (desp as any)?.id || null,
              wa_timestamp: ts
            }, { onConflict: 'wa_message_id', ignoreDuplicates: true });
            if (errIns) errores++; else guardados++;

            // ================== CONTINGENCIAS DE ENTREGA (plan v1.2) ==================
            // Se atiende ANTES que el resto: si el mensaje es una respuesta al menú de
            // recuperación (cliente) o al menú de niveles (Cindy), se maneja acá y se corta.
            try {
              const t8 = String(tel).replace(/\D/g, '');
              const limpio = String(texto || '').trim().toLowerCase();
              const opcionId = String(msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id || '');
              const CONT_URL = 'https://lizybztwnlrlvsrmgnug.functions.supabase.co/contingencia';
              const PAGOS_URL = 'https://lizybztwnlrlvsrmgnug.functions.supabase.co/pagos-noshow';
              const llamarCont = async (payload: Record<string, unknown>) => {
                try {
                  await fetch(CONT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '') },
                    body: JSON.stringify(payload),
                  });
                } catch (e) { console.log('error contingencia', String(e)); }
              };

              // (a) CINDY aprueba un nivel (1..5)
              if (t8 === '50376626575') {
                const n = parseInt(limpio.replace(/[^1-5]/g, '').slice(0, 1), 10);
                if (n >= 1 && n <= 5) {
                  const { data: pend } = await supabase.from('incidencias_entrega').select('id')
                    .eq('estado', 'esperando_aprobacion').order('id', { ascending: false }).limit(1);
                  if (pend && pend.length) {
                    await llamarCont({ accion: 'aprobar_nivel', incidencia_id: pend[0].id, nivel: n });
                    await avisarTelegram('🎚️ Nivel ' + n + ' aprobado por Cindy (caso #' + pend[0].id + ')');
                    continue;
                  }
                }
              }

              // (b) CLIENTE elige del menú de recuperación (1/2/3 o palabras)
              let opcion = '';
              if (opcionId.startsWith('cont_')) opcion = opcionId.slice(5);
              else if (/^1\b/.test(limpio) || limpio.includes('reagend')) opcion = 'reagendar';
              else if (/^2\b/.test(limpio) || limpio.includes('reembolso') || limpio.includes('devolu')) opcion = 'reembolso';
              else if (/^3\b/.test(limpio) || limpio.includes('mantener') || limpio.includes('cupon') || limpio.includes('cupón')) opcion = 'mantener';

              if (opcion) {
                const { data: abiertas } = await supabase.from('incidencias_entrega').select('id, tipo, estado')
                  .eq('customer_phone', t8).in('estado', ['abierta', 'esperando_cliente'])
                  .order('id', { ascending: false }).limit(1);
                if (abiertas && abiertas.length) {
                  const caso = abiertas[0];

                  // (b2) MENÚ DEL NO_SHOW (plan 3): 1 reprogramar · 2 cancelar · 3 hablar con Cindy/crédito
                  if (String(caso.tipo) === 'no_show') {
                    const opNS = (/^1\b/.test(limpio) || limpio.includes('reagend') || limpio.includes('guard') || limpio.includes('proximo') || limpio.includes('próximo')) ? '1'
                      : (/^2\b/.test(limpio) || limpio.includes('cancel') || limpio.includes('devolu') || limpio.includes('ya no')) ? '2'
                      : (/^3\b/.test(limpio) || limpio.includes('hablar') || limpio.includes('llamar') || limpio.includes('credito') || limpio.includes('crédito') || limpio.includes('saldo')) ? '3'
                      : '';
                    if (opNS) {
                      try {
                        await fetch(PAGOS_URL, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '') },
                          body: JSON.stringify({ accion: 'noshow_opcion', incidencia_id: caso.id, opcion: opNS }),
                        });
                      } catch (eNS) { console.log('error noshow opcion', String(eNS)); }
                      await responderWhatsApp(t8, opNS === '3'
                        ? '¡Listo! 🙌 Cindy te escribe en un ratito 💛'
                        : '¡Recibido! 🙌 Ya lo estoy coordinando — te confirmo en un ratito 💛');
                      await avisarTelegram('🚫 Cliente eligió la opción *' + opNS + '* en el caso NO-SHOW #' + caso.id);
                      continue;
                    }
                  }

                  // (b3) AJUSTE DE PEDIDO (escenario 3): 1 = devolución · 2 = crédito
                  if (String(caso.tipo) === 'ajuste') {
                    const opAj = (/^1\b/.test(limpio) || limpio.includes('devol') || limpio.includes('devolu') || limpio.includes('dinero') || limpio.includes('reembol')) ? '1'
                      : (/^2\b/.test(limpio) || limpio.includes('credito') || limpio.includes('crédito') || limpio.includes('saldo') || limpio.includes('cupon') || limpio.includes('cupón')) ? '2'
                      : '';
                    if (opAj) {
                      try {
                        await fetch(CONT_URL, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '') },
                          body: JSON.stringify({ accion: 'ajuste_opcion', incidencia_id: caso.id, opcion: opAj }),
                        });
                      } catch (eAj) { console.log('error ajuste opcion', String(eAj)); }
                      await responderWhatsApp(t8, opAj === '1'
                        ? '¡Listo! 💛 Cindy procesa la devolución y te aviso apenas esté 🙂'
                        : '¡Listo! 💛 Te mandé el crédito con su código para tu próxima compra 🎟️');
                      await avisarTelegram('✂️ Cliente eligió la opción *' + opAj + '* en el ajuste #' + caso.id);
                      continue;
                    }
                  }

                  // (b) CONTINGENCIA (planes anteriores)
                  await llamarCont({ accion: 'opcion_cliente', incidencia_id: caso.id, opcion, telefono: t8 });
                  await responderWhatsApp(t8, '¡Recibido! 🙌 Le paso tu elección a Cindy y te confirmo en un ratito 💛');
                  await avisarTelegram('💬 Cliente eligió *' + opcion + '* en el caso #' + caso.id);
                  continue;
                }
              }
            } catch (eCont) { console.log('error bloque contingencias', String(eCont)); }

            if (!desp) {
              await avisarTelegram('📩 MENSAJE DE WHATSAPP (sin pedido asociado)\n\nDe: +' + tel + '\nMensaje: "' + texto + '"');
              // Aunque no haya pedido, si pide cambiar le mostramos las ventanas (no lo dejamos sin respuesta)
              const idSinPedido = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '';
              if (clasificar(texto, idSinPedido) === 'cambio') {
                await enviarWALista(tel, 'cliente');
              }
              continue;
            }

            // 3) Clasificar y actuar según la DIRECTIVA
            const idInteractivo = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '';
            let notas = ((desp as any).notas as string) || '';
            const nombre = String((desp as any).customer_name || 'cliente').split(' ')[0];
            const destino = (desp as any).destino || 'tu punto de entrega';
            const sello = new Date().toISOString().slice(0, 16).replace('T', ' ');
            const primeraRespuesta = !notas.includes('RESP-OK');

            // 3a) ELECCIÓN DE VENTANA → revalida cupo y decide: automático (caso seguro) o aprobación humana
            if (idInteractivo.startsWith('VEN_')) {
              const elegida = VENTANAS_DEF.find(v => v.id === idInteractivo);
              const tituloVent = elegida ? (elegida.titulo + ' (' + elegida.desc + ')') : idInteractivo;
              const destinoNuevo = DESTINOS_VENTANA[idInteractivo] || tituloVent;
              const cuenta = await ocupacionVentanas();
              const ocupada = (cuenta[idInteractivo] || 0) >= CUPO_POR_VENTANA;

              if (ocupada) {
                notas += '\n⚠️ VENTANA LLENA ' + sello + ': ' + tituloVent;
                await supabase.from('despachos').update({ notas: notas.trim().slice(-4000), visto: false }).eq('id', (desp as any).id);
                await responderWhatsApp(tel, 'Uy ' + nombre + ', esa ventana se acaba de llenar 😮 Te muestro las que todavía tienen lugar:');
                await enviarWALista(tel, nombre);
                await avisarTelegram('⚠️ VENTANA LLENA al elegir\n\nCliente: ' + (desp as any).customer_name +
                  '\nQuería: ' + tituloVent + '\n(Se le ofrecieron las disponibles)');
                continue;
              }

              // ===== ¿Caso seguro para aprobar automáticamente? =====
              // 1) NO debe haber reprogramado antes (ni automática ni manual)  2) el bloque actual NO es hoy
              const yaReprogramo = notas.includes('VENTANA CAMBIADA') ||
                                   notas.includes('VENTANA SOLICITADA') ||
                                   notas.includes('Ventana pedida');
              const primeraVez = !yaReprogramo;
              const fechaActual = fechaBloque(destino, (desp as any).created_at);
              const hoySV = new Date(Date.now() - 6 * 3600000);
              const bloqueHoy = fechaActual !== null &&
                fechaActual.toISOString().slice(0, 10) === hoySV.toISOString().slice(0, 10);
              const bloqueadasV = await ventanasBloqueadas();
              const automatico = primeraVez && !bloqueHoy && !bloqueadasV.has(idInteractivo);

              if (automatico) {
                // ✅ APROBACIÓN AUTOMÁTICA (caso seguro): se cambia la ventana y se avisa
                notas += '\n✅ VENTANA CAMBIADA (auto) ' + sello + ': ' + destinoNuevo;
                await supabase.from('despachos').update({
                  destino: destinoNuevo, notas: notas.trim().slice(-4000), visto: false
                }).eq('id', (desp as any).id);
                cruzados++;
                await responderWhatsApp(tel, '¡Listo ' + nombre + '! 🙌 Tu entrega quedó reprogramada para ' +
                  destinoNuevo + '. Te esperamos. Cualquier cosa, escribinos por acá.');
                await avisarTelegram('✅ REPROGRAMACIÓN APROBADA AUTOMÁTICAMENTE\n\nPedido: ' +
                  (desp as any).order_reference + '\nCliente: ' + (desp as any).customer_name +
                  '\nDe: ' + destino + '\nA: ' + destinoNuevo +
                  '\nCupo de la ventana nueva: ' + (cuenta[idInteractivo] || 0) + '/' + CUPO_POR_VENTANA +
                  '\n(Cliente notificado. Sin acción requerida.)');
                continue;
              }

              // 🙋 Requiere aprobación humana (última hora, segunda vez o conflicto)
              notas += '\n🔄 VENTANA SOLICITADA ' + sello + ': ' + tituloVent;
              await supabase.from('despachos').update({ notas: notas.trim().slice(-4000), visto: false }).eq('id', (desp as any).id);
              cruzados++;
              await responderWhatsApp(tel, '¡Listo ' + nombre + '! Anotamos tu preferencia: ' +
                tituloVent + '. Te confirmamos el cambio en breve. 🙌');
              await avisarTelegram('🔄 SOLICITUD DE REPROGRAMACIÓN — REQUIERE APROBACIÓN\n\nPedido: ' +
                (desp as any).order_reference + '\nCliente: ' + (desp as any).customer_name +
                '\nDe: ' + destino + '\nA: ' + tituloVent +
                '\nCupo de esa ventana: ' + (cuenta[idInteractivo] || 0) + '/' + CUPO_POR_VENTANA +
                (bloqueHoy ? '\n⚠️ Es para HOY (última hora)' : '') +
                (!primeraVez ? '\n⚠️ Ya había reprogramado antes' : '') +
                '\n\n(Decidir con Cindy antes de confirmar)');
              continue;
            }

            const clase = clasificar(texto, idInteractivo);

            // Marcas de respuesta por TIPO (una consulta o un cambio siempre merecen respuesta,
            // aunque ya se haya respondido antes una cortesía)
            const respondidoConf = notas.includes('RESP-CONF') || notas.includes('RESP-OK');
            const respondidoPreg = notas.includes('PREG-RESP');

            if (clase === 'confirmacion') {
              if (!notas.includes('✅ CONF')) notas += '\n✅ CONF ' + sello + ': ' + texto;
              if (!respondidoConf) {
                const ok = await responderWhatsApp(tel,
                  '¡Gracias a vos, ' + nombre + '! 🛍️ Te esperamos: ' + destino +
                  '. Cualquier cosa que necesites, escribinos por acá. ¡Que la disfrutes!');
                if (ok) { notas += '\n📤 RESP-CONF ' + sello; respondidos++; }
              }
              await supabase.from('despachos').update({ notas: notas.trim().slice(-4000), visto: false }).eq('id', (desp as any).id);
              cruzados++;
              await avisarTelegram('✅ CLIENTE CONFIRMÓ' + (respondidoConf ? '' : ' (respuesta enviada)') +
                '\n\nPedido: ' + (desp as any).order_reference + '\nCliente: ' + (desp as any).customer_name +
                '\nMensaje: "' + texto + '"');

            } else if (clase === 'pregunta') {
              notas += '\n💬 PREG ' + sello + ': ' + texto;
              // MEJORA: las consultas SIEMPRE reciben respuesta (no las bloquea un agradecimiento previo)
              if (!respondidoPreg) {
                const ok = await responderWhatsApp(tel,
                  'Hola ' + nombre + ' 👋 Tu entrega de BARATUSS está programada para ' + destino +
                  '. Si necesitás cambiarla, respondé *CAMBIAR* y te ayudamos.');
                if (ok) { notas += '\n📤 PREG-RESP ' + sello; respondidos++; }
              }
              await supabase.from('despachos').update({ notas: notas.trim().slice(-4000), visto: false }).eq('id', (desp as any).id);
              cruzados++;
              await avisarTelegram('❓ CONSULTA DE CLIENTE' + (respondidoPreg ? '' : ' (respondida)') +
                '\n\nPedido: ' + (desp as any).order_reference + '\nCliente: ' + (desp as any).customer_name +
                '\nMensaje: "' + texto + '"');

            } else if (clase === 'cambio') {
              notas += '\n🔄 REPROG ' + sello + ': ' + texto;
              // Menú de ventanas: se envía la primera vez, y se reenvía si el cliente insiste (pudo perderlo). Máximo 2 envíos.
              const enviosMenu = (notas.match(/📤 MENU-VENT/g) || []).length;
              const vecesPideCambio = (notas.match(/🔄 REPROG/g) || []).length;
              if (enviosMenu === 0 || (vecesPideCambio >= 3 && enviosMenu < 2)) {
                const okLista = await enviarWALista(tel, nombre);
                if (okLista) notas += '\n📤 MENU-VENT ' + sello;
              }
              await supabase.from('despachos').update({ notas: notas.trim().slice(-4000), visto: false }).eq('id', (desp as any).id);
              cruzados++;
              await avisarTelegram('🔄 CLIENTE PIDE REPROGRAMAR — REQUIERE APROBACIÓN\n\nPedido: ' +
                (desp as any).order_reference + '\nCliente: ' + (desp as any).customer_name +
                '\nMensaje: "' + texto + '"\n\n(No se respondió automáticamente: espera decisión de Cindy/Leo)');

            } else {
              notas += '\n💬 MSG ' + sello + ': ' + texto;
              await supabase.from('despachos').update({ notas: notas.trim().slice(-4000), visto: false }).eq('id', (desp as any).id);
              cruzados++;
              await avisarTelegram('💬 MENSAJE DE CLIENTE\n\nPedido: ' + (desp as any).order_reference +
                '\nCliente: ' + (desp as any).customer_name + '\nMensaje: "' + texto + '"');
            }
          }
        }
      }

      return new Response(JSON.stringify({ ok: true, guardados, cruzados, respondidos, errores }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      // Siempre 200 para que Meta no reintente en bucle
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Method not allowed', { status: 405 });
});
