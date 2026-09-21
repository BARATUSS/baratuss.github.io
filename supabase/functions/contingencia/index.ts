// ========================================================================
// contingencia — CONTINGENCIAS DE ENTREGA (plan v1.2 aprobado por Cindy)
// 2026-09-18
//
// Acciones:
//   reportar        → abre la incidencia y avisa al cliente (Isabel / motorista / más tarde)
//   opcion_cliente  → registra qué eligió el cliente (reagendar | reembolso | mantener)
//   aprobar_nivel   → Cindy aprueba el nivel (1..5) y se genera el cupón
//   cancelar_enojo  → cancelación por enojo en efectivo: stock + disculpa + cupón 45% AUTOMÁTICO
//   reembolso_pagado→ Cindy ya pagó el reembolso (a mano en Wompi)
//   pedir_nivel     → reenvía a Cindy el menú de niveles por WhatsApp
//
// Reglas del negocio (NO cambiar sin autorización de Cindy):
//   · Escala: 1=10%/$5 · 2=20%/$8 · 3=30%/$12 · 4=45%/$15 · 5=sin compensación
//   · El cupón cubre SOLO producto (nunca el envío), un solo uso, 30 días, no acumulable
//   · Cindy aprueba SIEMPRE... excepto la cancelación por enojo, que ya es regla (45% automático)
// ========================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WA_TOKEN     = Deno.env.get('WHATSAPP_TOKEN') ?? Deno.env.get('WA_TOKEN') ?? '';
const PHONE_ID     = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') ?? Deno.env.get('WA_PHONE_ID') ?? '';
const TG_TOKEN     = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const TG_CHAT      = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
const CINDY_WA     = '50376626575';   // WhatsApp de Cindy (avisos operativos)

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Escala aprobada por Cindy (18-sep-2026)
const NIVELES: Record<number, { pct: number; tope: number; nombre: string }> = {
  1: { pct: 10, tope: 5,  nombre: 'Leve' },
  2: { pct: 20, tope: 8,  nombre: 'Moderado' },
  3: { pct: 30, tope: 12, nombre: 'Grave' },
  4: { pct: 45, tope: 15, nombre: 'Muy grave' },
  5: { pct: 0,  tope: 0,  nombre: 'Sin compensación' },
};
const NIVEL_ENOJO = 4;   // cancelación por enojo = siempre el mayor (45%)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function tel8(t: string): string {
  return String(t || '').replace(/\D/g, '').slice(-8);
}

function primerNombre(n: string): string {
  return (String(n || 'cliente').trim().split(/\s+/)[0] || 'cliente');
}

async function ahoraSV(): Promise<Date> {
  return new Date(Date.now() - 6 * 3600000);   // hora de El Salvador
}

async function sello(): Promise<string> {
  const h = await ahoraSV();
  return h.toISOString().slice(0, 16).replace('T', ' ');
}

// ===== WhatsApp =====
async function enviarTexto(tel: string, texto: string, etiqueta = ''): Promise<string | null> {
  if (!WA_TOKEN || !PHONE_ID) return null;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(tel).replace(/\D/g, ''),
        type: 'text',
        text: { preview_url: false, body: texto },
      }),
    });
    const d = await r.json();
    const wamid = d?.messages?.[0]?.id ? String(d.messages[0].id) : null;
    console.log('WA', etiqueta, wamid ? 'OK' : JSON.stringify(d).slice(0, 160));
    return wamid;
  } catch (e) {
    console.log('error WA', String(e));
    return null;
  }
}

async function registrarSaliente(wamid: string | null, tel: string, texto: string, ref = '') {
  if (!wamid) return;
  try {
    await supabase.from('wa_mensajes').insert({
      wa_message_id: wamid,
      telefono: String(tel).replace(/\D/g, ''),
      texto,
      tipo: 'text',
      direccion: 'saliente',
      order_reference: ref || null,
      atendido_por: 'contingencia',
    });
  } catch (_e) { /* silencioso */ }
}

// ¿El cliente escribió en las últimas 24 h? (si sí, se le puede escribir texto libre)
async function ventanaAbierta(tel: string): Promise<boolean> {
  try {
    const desde = new Date(Date.now() - 24 * 3600000).toISOString();
    const { data } = await supabase.from('wa_mensajes').select('id')
      .eq('telefono', String(tel).replace(/\D/g, ''))
      .eq('direccion', 'entrante')
      .gte('creado_en', desde).limit(1);
    return !!(data && data.length);
  } catch (_e) { return false; }
}

async function avisarTelegram(texto: string) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: texto, parse_mode: 'Markdown' }),
    });
    return r.ok;
  } catch (_e) { return false; }
}

// ===== Cupones =====
function nuevoCodigo(nivel: number): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin caracteres confusos
  let x = '';
  for (let i = 0; i < 4; i++) x += abc[Math.floor(Math.random() * abc.length)];
  return `BARATUSS-C${nivel}-` + x;
}

async function crearCupon(opts: {
  nivel: number; telefono: string; email?: string | null; origen: string;
  incidencia_id?: number | null; referencia?: string | null;
}) {
  const n = NIVELES[opts.nivel] ?? NIVELES[2];
  if (n.pct <= 0) return null;                     // nivel 5 = sin cupón
  const codigo = nuevoCodigo(opts.nivel);
  const { error } = await supabase.from('cupones').insert({
    codigo,
    tipo: 'porcentaje_producto',
    valor: n.pct,
    tope: n.tope,
    cliente_telefono: opts.telefono || null,
    cliente_email: opts.email || null,
    origen: opts.origen,
    incidencia_id: opts.incidencia_id ?? null,
    nivel: opts.nivel,
    aprobado_por: opts.origen === 'cancelacion_enojo' ? 'regla: enojo = 45%' : 'cindy',
    expira_en: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  if (error) { console.log('error cupon', error.message); return null; }
  return { codigo, pct: n.pct, tope: n.tope, referencia: opts.referencia ?? null };
}

async function datosPedido(ref: string) {
  const { data } = await supabase.from('orders')
    .select('reference, items, total, delivery_fee, delivery_point, customer_name, customer_phone, customer_email, payment_status, payment_method, status')
    .eq('reference', ref).limit(1);
  return data && data[0] ? data[0] : null;
}

async function guardarIncidencia(fila: Record<string, unknown>) {
  const { data, error } = await supabase.from('incidencias_entrega').insert(fila).select('id');
  if (error) { console.log('error incidencia', error.message); return null; }
  return data?.[0]?.id ?? null;
}

async function actualizarIncidencia(id: number, cambios: Record<string, unknown>) {
  await supabase.from('incidencias_entrega')
    .update({ ...cambios, actualizado_en: new Date().toISOString() }).eq('id', id);
}

// ========================================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let b: any = {};
  try { b = await req.json(); } catch (_e) { /* sin body */ }
  const accion = String(b.accion || '');
  console.log('contingencia:', accion);

  try {
    // ---------------------------------------------------------------
    // REPORTAR contingencia
    // ---------------------------------------------------------------
    if (accion === 'reportar') {
      const ref = String(b.reference || '');
      const motivo = String(b.motivo || 'imprevisto');
      const detalle = String(b.detalle || '');
      const ped = await datosPedido(ref);
      if (!ped) return json({ ok: false, error: 'pedido_no_existe' });

      const nombre = primerNombre(ped.customer_name);
      const tel = String(ped.customer_phone || '').replace(/\D/g, '');
      const s = await sello();

      const { data: cfg } = await supabase.from('config_operativa')
        .select('clave, valor').in('clave', ['isabel_nombre', 'isabel_telefono', 'motorista_nombre', 'motorista_telefono']);
      const c: Record<string, string> = {};
      for (const f of cfg || []) c[f.clave] = f.valor || '';
      const isabelTel = (c['isabel_telefono'] || '').replace(/\D/g, '');
      const isabelNom = c['isabel_nombre'] || 'Isabel';
      const motTel = (c['motorista_telefono'] || '').replace(/\D/g, '');

      const incId = await guardarIncidencia({
        order_reference: ref, customer_name: ped.customer_name, customer_phone: tel,
        tipo: 'contingencia', motivo, detalle,
        opciones_probadas: [
          { opcion: 'isabel', resultado: 'avisado', cuando: s, telefono: isabelTel || null },
          { opcion: 'motorista', resultado: 'reserva', cuando: s, telefono: motTel || null },
          { opcion: 'cindy_mas_tarde', resultado: 'reserva', cuando: s },
        ],
        entregador: 'isabel', entregador_nombre: isabelNom, entregador_telefono: isabelTel || null,
        estado: 'esperando_cliente',
      });

      // El despacho entra en estado de contingencia (no se mandan recordatorios de la fecha vieja)
      await supabase.from('despachos')
        .update({ estado_logistico: 'contingencia', notas: (b.notas_previas || '') + `\n⚠️ CONTINGENCIA ${s}: ${motivo}` })
        .eq('order_reference', ref);

      // Aviso AUTOMÁTICO al cliente (disculpa + opciones)
      const texto = `Hola ${nombre} 💛 Te escribo con una novedad de tu pedido *${ref}*.\n\n`
        + `Se me presentó un imprevisto y no voy a poder entregártelo yo en el horario de siempre 😔 `
        + `Pero *no te voy a dejar sin tu pedido*: lo tiene *${isabelNom}*, que te lo lleva *al mismo lugar y a la misma hora*.\n\n`
        + (isabelTel ? `📞 Su número: ${isabelTel}\n` : '')
        + `\nSi te queda más cómodo otro momento, escribime *CAMBIAR* y te muestro las opciones. `
        + `Cualquier cosa, respondé este mensaje 🙏 ¡Perdoná la molestia de verdad!`;
      const wamid = (await ventanaAbierta(tel)) ? await enviarTexto(tel, texto, 'CONTINGENCIA') : null;
      await registrarSaliente(wamid, tel, texto, ref);

      await avisarTelegram(
        `⚠️ *CONTINGENCIA ABIERTA*\n\n📦 ${ref}\n👤 ${ped.customer_name || ''}${tel ? ' · ' + tel : ''}\n`
        + `🔎 Motivo: ${motivo}${detalle ? ' — ' + detalle : ''}\n`
        + `👩 Entregador propuesto: ${isabelNom}${isabelTel ? ' (' + isabelTel + ')' : ''}\n\n`
        + (wamid ? '✅ Se avisó automático al cliente.' : '⚠️ No se pudo avisar al cliente por WhatsApp (fuera de la ventana de 24 h): avisale vos.'));
      await enviarTexto(CINDY_WA,
        `⚠️ CONTINGENCIA en ${ref}\n👤 ${ped.customer_name || ''}\n🔎 ${motivo}\n`
        + `👩 ${isabelNom} ${isabelTel}\n\n` + (wamid ? '✅ El cliente ya fue avisado.' : '⚠️ Avisale vos al cliente (WhatsApp cerrado).'),
        'AVISO-CINDY');

      return json({ ok: true, incidencia_id: incId, avisado_cliente: !!wamid, whatsapp: wamid });
    }

    // ---------------------------------------------------------------
    // OPCIÓN ELEGIDA POR EL CLIENTE (reagendar | reembolso | mantener)
    // ---------------------------------------------------------------
    if (accion === 'opcion_cliente') {
      const opcion = String(b.opcion || '');
      let incId = Number(b.incidencia_id || 0);
      if (!incId && b.telefono) {
        const { data } = await supabase.from('incidencias_entrega').select('id')
          .eq('customer_phone', String(b.telefono).replace(/\D/g, ''))
          .in('estado', ['abierta', 'esperando_cliente', 'esperando_aprobacion'])
          .order('id', { ascending: false }).limit(1);
        incId = data?.[0]?.id ?? 0;
      }
      if (!incId) return json({ ok: false, error: 'sin_incidencia' });

      const { data: inc } = await supabase.from('incidencias_entrega').select('*').eq('id', incId).limit(1);
      const i = inc?.[0];
      await actualizarIncidencia(incId, { opcion_cliente: opcion, estado: 'esperando_aprobacion' });

      // Aviso a Cindy con el MENÚ DE NIVELES para que apruebe
      const menu = `🎚️ *Elegí el nivel para aprobar*\n\n1️⃣ Leve 10% (tope $5)\n2️⃣ Moderado 20% ($8)\n`
        + `3️⃣ Grave 30% ($12)\n4️⃣ Muy grave 45% ($15)\n5️⃣ Sin compensación\n\n`
        + `_Respondé solo el número._`;
      await avisarTelegram(`📋 CLIENTE ELIGIÓ: *${opcion}*\n📦 ${i?.order_reference || ''}\n👤 ${i?.customer_name || ''}\n\n${menu}`);
      const wamid = await enviarTexto(CINDY_WA,
        `📋 ${i?.customer_name || 'Cliente'} eligió: ${opcion.toUpperCase()} (pedido ${i?.order_reference || ''})\n\n` + menu, 'MENU-NIVEL');
      await registrarSaliente(wamid, CINDY_WA, `MENU NIVELES (${opcion})`, i?.order_reference || '');

      return json({ ok: true, incidencia_id: incId, menu_enviado: !!wamid });
    }

    // ---------------------------------------------------------------
    // APROBAR NIVEL (Cindy) → genera el cupón y cierra
    // ---------------------------------------------------------------
    if (accion === 'aprobar_nivel') {
      const incId = Number(b.incidencia_id || 0);
      const nivel = Number(b.nivel || 0);
      if (!incId || !NIVELES[nivel]) return json({ ok: false, error: 'datos' });
      const { data: inc } = await supabase.from('incidencias_entrega').select('*').eq('id', incId).limit(1);
      const i = inc?.[0];
      if (!i) return json({ ok: false, error: 'incidencia_no_existe' });

      let cupon: any = null;
      if (NIVELES[nivel].pct > 0) {
        const ped = i.order_reference ? await datosPedido(i.order_reference) : null;
        cupon = await crearCupon({
          nivel, telefono: i.customer_phone || '', email: ped?.customer_email || null,
          origen: i.tipo === 'cancelacion_enojo' ? 'cancelacion_enojo' : 'contingencia',
          incidencia_id: incId, referencia: i.order_reference,
        });
      }

      await actualizarIncidencia(incId, {
        nivel_aprobado: nivel, aprobado_por: 'cindy',
        cupon_codigo: cupon?.codigo ?? null,
        estado: 'resuelta', resuelto_en: new Date().toISOString(),
        opciones_probadas: [
          ...(Array.isArray(i.opciones_probadas) ? i.opciones_probadas : []),
          { opcion: 'nivel_' + nivel, resultado: NIVELES[nivel].nombre, cuando: await sello(), aprobado_por: 'cindy' },
        ],
      });

      const nombre = primerNombre(i.customer_name);
      if (cupon) {
        const texto = `¡Listo, ${nombre}! 🎁 Tu cupón es *${cupon.codigo}*: *${cupon.pct}% de descuento* `
          + `en el producto que quieras (hasta $${cupon.tope}).\n\n`
          + `✔️ Un solo uso ✔️ Vence en 30 días ✔️ No acumulable ✔️ No aplica al envío\n\n`
          + `Escribilo en el checkout cuando compres 💖 ¡Gracias por la paciencia!`;
        const wamid = await enviarTexto(String(i.customer_phone || ''), texto, 'CUPON');
        await registrarSaliente(wamid, String(i.customer_phone || ''), texto, i.order_reference || '');
      }

      if (i.opcion_cliente === 'reembolso') {
        await supabase.from('reembolsos').insert({
          order_reference: i.order_reference, incidencia_id: incId,
          customer_name: i.customer_name, customer_phone: i.customer_phone,
          monto: Number(b.monto || 0), motivo: i.motivo, metodo: b.metodo || 'wompi',
          estado: 'solicitado',
        });
      }

      await avisarTelegram(`✅ *Caso cerrado* (nivel ${nivel} · ${NIVELES[nivel].nombre})\n`
        + `📦 ${i.order_reference || ''}\n👤 ${i.customer_name || ''}\n`
        + (cupon ? `🎁 Cupón ${cupon.codigo} enviado (${cupon.pct}% · tope $${cupon.tope})` : '🚫 Sin compensación'));

      return json({ ok: true, nivel, cupon: cupon?.codigo ?? null });
    }

    // ---------------------------------------------------------------
    // CANCELACIÓN POR ENOJO (efectivo) → todo en un paso, cupón 45% AUTOMÁTICO
    // ---------------------------------------------------------------
    if (accion === 'cancelar_enojo') {
      const ref = String(b.reference || '');
      const detalle = String(b.detalle || '');
      const ped = await datosPedido(ref);
      if (!ped) return json({ ok: false, error: 'pedido_no_existe' });
      const s = await sello();
      const nombre = primerNombre(ped.customer_name);
      const tel = String(ped.customer_phone || '').replace(/\D/g, '');

      // 1) Devolver el stock
      let devueltos = 0;
      for (const it of (ped.items || [])) {
        const { error } = await supabase.rpc('devolver_stock', { p_id: Number(it.id), p_qty: Number(it.qty || 1) });
        if (!error) devueltos++;
      }

      // 2) Cancelar pedido y despachos (los despachos dejan de estar activos)
      await supabase.from('despachos').update({
        estado_logistico: 'cancelado',
        notas: (b.notas_previas || '') + `\n🚫 CANCELADO POR ENOJO ${s}`,
      }).eq('order_reference', ref);
      await supabase.from('orders').update({ status: 'cancelado', updated_at: new Date().toISOString() }).eq('reference', ref);

      // 3) Ficha del caso (regla ya pre-aprobada por Cindy)
      const incId = await guardarIncidencia({
        order_reference: ref, customer_name: ped.customer_name, customer_phone: tel,
        tipo: 'cancelacion_enojo', motivo: String(b.motivo || 'cliente canceló enojado'),
        detalle, entregador: 'cindy',
        opciones_probadas: [{ opcion: 'cancelar', resultado: 'stock devuelto (' + devueltos + ')', cuando: s }],
        estado: 'esperando_aprobacion', aprobado_por: 'regla: enojo = 45%',
      });

      // 4) Cupón del 45% AUTOMÁTICO (regla del negocio)
      const cupon = await crearCupon({
        nivel: NIVEL_ENOJO, telefono: tel, email: ped.customer_email || null,
        origen: 'cancelacion_enojo', incidencia_id: incId, referencia: ref,
      });

      // 5) Disculpa + cupón al cliente
      const texto = `${nombre}, te debo una disculpa sincera 🙏 No estuvo bien lo que pasó y lo lamento de verdad.\n\n`
        + `Ya *cancelamos la venta* (no se te cobra nada y el producto volvió a estar disponible).\n\n`
        + (cupon ? `Para tu *próxima compra* te dejo un cupón de *${cupon.pct}% de descuento* 🎁\n`
          + `Código: *${cupon.codigo}* (hasta $${cupon.tope})\n`
          + `✔️ Un solo uso ✔️ 30 días ✔️ No aplica al envío\n\n` : '')
        + `Gracias por la paciencia, y ojalá te pueda atender mejor la próxima 💖`;
      const wamid = (await ventanaAbierta(tel)) ? await enviarTexto(tel, texto, 'ENOJO-DISCULPA') : null;
      await registrarSaliente(wamid, tel, texto, ref);

      if (cupon) {
        await actualizarIncidencia(incId, {
          nivel_aprobado: NIVEL_ENOJO, cupon_codigo: cupon.codigo,
          estado: 'resuelta', resuelto_en: new Date().toISOString(),
        });
      }

      await avisarTelegram(
        `🚫 *CANCELACIÓN POR ENOJO*\n\n📦 ${ref}\n👤 ${ped.customer_name || ''}${tel ? ' · ' + tel : ''}\n`
        + `💵 Total: $${Number(ped.total || 0).toFixed(2)}\n📦 Stock devuelto: ${devueltos} producto(s)\n`
        + `🎁 Cupón automático: ${cupon ? cupon.codigo + ' (45%)' : 'no se pudo crear'}\n`
        + (detalle ? `📝 ${detalle}\n` : '')
        + (wamid ? '✅ Cliente avisado con la disculpa.' : '⚠️ Avisale vos al cliente (WhatsApp cerrado).'));
      await enviarTexto(CINDY_WA,
        `🚫 Cancelaste la venta ${ref} por enojo.\n📦 Stock devuelto: ${devueltos}\n`
        + `🎁 Cupón 45% generado: ${cupon?.codigo || 'ERROR'}\n` + (wamid ? '✅ Cliente ya avisado.' : '⚠️ Avisale vos.'),
        'AVISO-ENOJO');

      return json({ ok: true, incidencia_id: incId, stock_devuelto: devueltos, cupon: cupon?.codigo ?? null });
    }

    // ---------------------------------------------------------------
    // Reembolso ya pagado a mano (Cindy lo hizo en Wompi)
    // ---------------------------------------------------------------
    // ===== ESCENARIO 3 · AJUSTE DE PEDIDO (aprobado 20-sep-2026) =====
    // Se saca del pedido el producto que no se puede entregar: vuelve el stock, su
    // tarjeta queda "no disponible", el total se recalcula y, si ya pagó, el cliente
    // elige entre devolución o crédito.
    if (accion === 'ajustar') {
      const ref = String(b.reference || '');
      const items = Array.isArray(b.items) ? b.items : [];
      const motivo = String(b.motivo || 'no disponible');
      if (!ref || !items.length) return json({ ok: false, error: 'faltan datos' }, 400);

      const o = await datosPedido(ref);
      if (!o) return json({ ok: false, error: 'pedido no encontrado' }, 404);

      const { data: rpc } = await supabase.rpc('ajustar_pedido', { p_ref: ref, p_items: items, p_motivo: motivo });
      if (!rpc || rpc.ok === false) return json({ ok: false, error: (rpc && rpc.motivo) || 'no se pudo ajustar' }, 400);

      const pagado = ['pagado', 'aprobado'].includes(String(o.payment_status));
      const nombre = primerNombre(o.customer_name);
      const dif = Number(rpc.descontado || 0);
      const nuevo = Number(rpc.total_nuevo || 0);
      const antes = Number(rpc.total_anterior || 0);
      const prod = items.map((i: { name?: string; id?: number }) => i.name || ('producto #' + i.id)).join(', ');
      const todoFuera = nuevo <= 0.01;

      const incId = await guardarIncidencia({
        order_reference: ref,
        customer_name: o.customer_name, customer_phone: o.customer_phone,
        tipo: 'ajuste', motivo: motivo,
        detalle: 'Producto(s): ' + prod + ' · descontado $' + dif.toFixed(2) + ' · total $' + antes.toFixed(2) + ' → $' + nuevo.toFixed(2) + (todoFuera ? ' (pedido completo)' : ''),
        estado: pagado && !todoFuera ? 'esperando_cliente' : 'resuelto',
        reembolso_monto: dif,
        opciones_probadas: JSON.stringify(items),
      });

      // Mensaje al cliente
      const texto = todoFuera
        ? ('¡Hola ' + nombre + '! 😊 Te cuento algo de tu pedido: el *' + prod + '* se nos dañó justo antes de la entrega 😔\n\n'
           + 'Por eso damos de baja el pedido completo' + (pagado ? ' y te devolvemos el dinero 💛' : ' (no llegaste a pagarlo).') + '\n\nPerdoná el inconveniente, ya te escribo para ver cómo lo resolvemos 💛')
        : (pagado
          ? ('¡Hola ' + nombre + '! 😊 Te cuento algo de tu pedido: el *' + prod + '* se nos dañó justo antes de la entrega 😔\n\n'
             + 'Como eso ya lo tenías pagado, decime qué preferís:\n'
             + '*1)* Te devuelvo la diferencia (*$' + dif.toFixed(2) + '*) · *2)* Te dejo un crédito por $' + dif.toFixed(2) + ' para tu próxima compra 💛')
          : ('¡Hola ' + nombre + '! 😊 Te cuento algo de tu pedido: el *' + prod + '* se nos dañó justo antes de la entrega 😔 '
             + 'Por eso lo sacamos y te queda un total de *$' + nuevo.toFixed(2) + '* en vez de $' + antes.toFixed(2) + '.\n\n'
             + 'El resto de tu pedido va normal 📅 ¿Te parece bien? Cualquier cosa escribime 💛'));

      await enviarTexto(o.customer_phone, texto, 'AJUSTE');

      // Si no queda nada por entregar: el pedido se cierra (y se registra el reembolso si pagó)
      if (todoFuera) {
        await supabase.from('orders').update({ status: 'cancelado', updated_at: new Date().toISOString() }).eq('reference', ref);
        await supabase.from('despachos').update({ estado_logistico: 'cancelado', updated_at: new Date().toISOString() })
          .eq('order_reference', ref).neq('estado_logistico', 'no-disponible');
        if (pagado) {
          await supabase.from('reembolsos').insert({
            order_reference: ref, incidencia_id: incId, customer_name: o.customer_name,
            customer_phone: o.customer_phone, monto: Number(antes.toFixed(2)),
            motivo: 'producto no disponible — pedido completo', metodo: 'wompi', estado: 'solicitado',
          });
        }
      }

      const aviso = '✂️ *Ajuste de pedido*: ' + o.customer_name + ' · ' + o.customer_phone
        + '\nPedido ' + ref + '\nSe sacó: ' + prod + '\nDescontado: $' + dif.toFixed(2) + ' · Total nuevo: $' + nuevo.toFixed(2)
        + (todoFuera ? '\n\n⚠️ Se dio de baja el pedido completo.' : (pagado ? '\n\n💳 Ya estaba pagado: le mandé el menú (1 devolución / 2 crédito).' : '\n\n✅ Sin plata de por medio: paga el total ajustado al retirar.'));
      await avisarTelegram(aviso);
      await enviarTexto(CINDY_WA, aviso, 'AJUSTE-AVISO');

      return json({ ok: true, incidencia_id: incId, descontado: dif, total_nuevo: nuevo, pagado, todo_fuera: todoFuera });
    }

    // El cliente eligió qué hacer con la diferencia (1 = devolución · 2 = crédito)
    if (accion === 'ajuste_opcion') {
      const incId = Number(b.incidencia_id || 0);
      const op = String(b.opcion || '');
      if (!incId) return json({ ok: false, error: 'falta incidencia_id' }, 400);
      const { data: inc } = await supabase.from('incidencias_entrega').select('*').eq('id', incId).limit(1);
      const i = inc && inc[0];
      if (!i) return json({ ok: false, error: 'caso no encontrado' }, 404);
      const o = await datosPedido(i.order_reference);
      const dif = Number(i.reembolso_monto || 0);
      const nombre = primerNombre(i.customer_name);

      if (op === '1') {
        await supabase.from('reembolsos').insert({
          order_reference: i.order_reference, incidencia_id: incId, customer_name: i.customer_name,
          customer_phone: i.customer_phone, monto: dif, motivo: 'ajuste de pedido — pidió devolución',
          metodo: 'wompi', estado: 'solicitado',
        });
        await actualizarIncidencia(incId, { estado: 'resuelto', opcion_cliente: 'reembolso', respuesta_cliente: 'devolucion', resuelto_en: new Date().toISOString() });
        await enviarTexto(i.customer_phone, '¡Listo, ' + nombre + '! 💛 Te devolvemos *$' + dif.toFixed(2) + '* por el producto que no pudimos entregar. Cindy lo procesa y te aviso apenas esté 🙂💛', 'AJUSTE-DEV');
        await avisarTelegram('💸 *Reembolso por ajuste*: ' + i.customer_name + ' · $' + dif.toFixed(2) + '\nPedido ' + i.order_reference + '\nPagarlo a mano en Wompi y marcarlo en Contingencias.');
        await enviarTexto(CINDY_WA, '💸 *Devolución pedida* (ajuste)\n' + i.customer_name + ' · $' + dif.toFixed(2) + '\nPedido ' + i.order_reference + '\n→ Pagala en Wompi y marcala en el panel.', 'AJUSTE-DEV-C');
      } else if (op === '2') {
        const codigo = nuevoCodigo(2);
        await supabase.from('cupones').insert({
          codigo, tipo: 'credito', valor: dif, tope: dif, cliente_telefono: i.customer_phone,
          origen: 'ajuste', incidencia_id: incId, aprobado_por: 'cindy',
          expira_en: new Date(Date.now() + 30 * 86400000).toISOString(),
        });
        await actualizarIncidencia(incId, { estado: 'resuelto', opcion_cliente: 'credito', respuesta_cliente: 'credito', cupon_codigo: codigo, cupon_descuento: dif, resuelto_en: new Date().toISOString() });
        await enviarTexto(i.customer_phone, '¡Listo, ' + nombre + '! 💛 Te dejé un *crédito de $' + dif.toFixed(2) + '* para tu próxima compra.\n\nTu código es *' + codigo + '* — lo escribís en el checkout y se te descuenta. Vale 30 días 🙂', 'AJUSTE-CR');
        await avisarTelegram('🎟️ *Crédito entregado* (ajuste): ' + i.customer_name + ' · $' + dif.toFixed(2) + ' · código ' + codigo);
        await enviarTexto(CINDY_WA, '🎟️ Cliente eligió *crédito* por el ajuste\n' + i.customer_name + ' · $' + dif.toFixed(2) + '\nCódigo ' + codigo, 'AJUSTE-CR-C');
      } else {
        return json({ ok: false, error: 'opción no válida' }, 400);
      }

      // 🧾 NOTA DE CRÉDITO por correo (decisión 4a): constancia del ajuste
      if (o && o.customer_email && dif > 0) {
        const nota = '<div style="font-family:system-ui,sans-serif;max-width:560px;color:#3b2b28;">'
          + '<h2 style="color:#c2574a;margin:0 0 10px;">Nota de crédito — BARATUSS</h2>'
          + '<p>Cliente: <b>' + (i.customer_name || '') + '</b><br>Pedido: <b>' + i.order_reference + '</b><br>Fecha: ' + (await sello()) + '</p>'
          + '<p>Por el producto que no pudimos entregar, se ajustó tu pedido por un monto de <b>$' + dif.toFixed(2) + '</b> '
          + (op === '1' ? '(se te devuelve el dinero)' : '(acreditado para tu próxima compra)') + '.</p>'
          + '<p style="font-size:13px;color:#8a6b66;">Este documento respalda el ajuste de tu pedido. Cualquier duda, escribinos al WhatsApp 6285-2631 💛</p></div>';
        try {
          await fetch('https://lizybztwnlrlvsrmgnug.functions.supabase.co/pagos-noshow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SERVICE_KEY },
            body: JSON.stringify({ accion: 'enviar-correo', destino: o.customer_email, asunto: 'Nota de crédito de tu pedido ' + i.order_reference, html: nota }),
          });
        } catch (e) { console.log('nota de credito: no se pudo enviar', String(e)); }
      }

      return json({ ok: true, opcion: op, monto: dif });
    }

    if (accion === 'reembolso_pagado') {
      const id = Number(b.reembolso_id || 0);
      if (!id) return json({ ok: false, error: 'datos' });
      await supabase.from('reembolsos').update({
        estado: 'pagado', pagado_en: new Date().toISOString(), aprobado_por: 'cindy',
      }).eq('id', id);
      await actualizarIncidencia(Number(b.incidencia_id || 0), { estado: 'resuelta', resuelto_en: new Date().toISOString() });
      return json({ ok: true });
    }

    // ---------------------------------------------------------------
    // Reenviar a Cindy el menú de niveles
    // ---------------------------------------------------------------
    if (accion === 'pedir_nivel') {
      const incId = Number(b.incidencia_id || 0);
      const { data: inc } = await supabase.from('incidencias_entrega').select('*').eq('id', incId).limit(1);
      const i = inc?.[0];
      if (!i) return json({ ok: false, error: 'incidencia_no_existe' });
      const texto = `🎚️ *${i.customer_name || 'Cliente'}* eligió: ${(i.opcion_cliente || 'sin elegir').toUpperCase()}\n`
        + `📦 ${i.order_reference || ''}\n\n1️⃣ Leve 10%\n2️⃣ Moderado 20%\n3️⃣ Grave 30%\n4️⃣ Muy grave 45%\n5️⃣ Sin compensación\n\n_Respondé el número._`;
      const wamid = await enviarTexto(CINDY_WA, texto, 'MENU-NIVEL');
      await registrarSaliente(wamid, CINDY_WA, texto, i.order_reference || '');
      return json({ ok: true, menu_enviado: !!wamid });
    }

    return json({ ok: false, error: 'accion_desconocida', accion }, 400);
  } catch (e) {
    console.log('ERROR contingencia:', String(e));
    return json({ ok: false, error: String(e).slice(0, 300) });
  }
});
