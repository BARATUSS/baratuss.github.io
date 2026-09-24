import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verificacionActiva, telefonoVerificado, correoVerificado, bienvenidaYaUsada, normalizarTel } from '../_shared/verificacion.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

const WOMPI_CLIENT_ID = 'ad59dd3e-5c32-476d-a864-4ff719f4e7b1';
const WOMPI_CLIENT_SECRET = '9c96e9c3-6a03-464d-90e1-c9e585686cc9';

async function getWompiToken() {
  const r = await fetch('https://id.wompi.sv/connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: WOMPI_CLIENT_ID, client_secret: WOMPI_CLIENT_SECRET, audience: 'wompi_api' })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error);
  return d.access_token;
}

// Averigua de quién es una sesión (para el programa de referidos).
// Se pregunta a la API de autenticación: así el id que llega NO se puede falsificar.
async function usuarioDeToken(token: string): Promise<string> {
  if (!token) return '';
  try {
    const r = await fetch((Deno.env.get('SUPABASE_URL') || '') + '/auth/v1/user', {
      headers: { apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return '';
    const u = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    return u && u.id ? String(u.id) : '';
  } catch (_e) {
    return '';
  }
}

// ===== FASE 1 ENTREGAS: alta unificada de despachos =====
// Único punto de creación (webhook aprobado + efectivo vía /create-despachos).
// IDEMPOTENTE: si ya existen despachos para la orden, no duplica (Wompi reintenta ante timeout).
async function crearDespachos(ref: string, items: any[], datos: any) {
  // ✅ VERIFICACIÓN (2026-09-18): antes, si ya existía UNA tarjeta, se cortaba acá y NUNCA se
  // creaban las que faltaban → pedido sin seguimiento. Ahora se comparan una por una
  // (producto + talla) y se crean SOLO las que faltan.
  const { data: existentes } = await supabase.from('despachos')
    .select('inventory_id, talla')
    .eq('order_reference', ref);
  const clave = (id: any, talla: any) => String(id) + '|' + String(talla || '');
  const yaHay = new Set((existentes || []).map((d: any) => clave(d.inventory_id, d.talla)));
  const faltan = (items || []).filter((it: any) => !yaHay.has(clave(it.id, it.size || it.talla)));

  if (!faltan.length) {
    // Ya estaban todas: solo se avisa al seguimiento (es idempotente, no duplica mensajes)
    await avisarSeguimiento();
    return { duplicado: true, count: (existentes || []).length, creados: 0 };
  }

  for (const item of faltan) {
    await supabase.from('despachos').insert({
      order_reference: ref,
      inventory_id: item.id,
      qty: item.qty || 1,
      talla: item.size || item.talla || null,
      nombre_capturado: item.name || null,
      imagen_url: item.image || item.imagen || null,
      metodo_entrega: datos.delivery_type || 'retiro-punto',
      destino: datos.delivery_point || null,
      fecha_programada: null,
      // ⚠️ 2026-09-18: antes decía 'pendiente_confirmacion' (con guion bajo) y el panel
      // usa 'pendiente-preparacion' → esa tarjeta no aparecía en la lista de preparación.
      estado_logistico: 'pendiente-preparacion',
      customer_name: datos.customer_name || null,
      customer_phone: datos.customer_phone || null,
      visto: false
    });
  }
  // MEJORA: dispara el seguimiento AL INSTANTE (agradecimiento inmediato, sin esperar el cron de 5 min).
  // Si esto falla, el cron cada 5 minutos lo recupera igual.
  await avisarSeguimiento();

  return { creados: faltan.length, ya_existian: (existentes || []).length };
}

// Avisa a `seguimiento-entregas` para que evalúe y envíe lo que corresponda AHORA.
// Se llama en los dos caminos de `crearDespachos` (despachos nuevos y despachos ya existentes,
// estos últimos creados por el disparador de la base): si no, el mensaje salía recién a los 5 min.
// ⚠️ El aviso NO se espera: la tienda muestra el ticket en cuanto responde esta función, y enviar
// el mensaje tarda ~5 s. Con `waitUntil` la respuesta sale al instante y el envío sigue en segundo
// plano (si `EdgeRuntime` no existiera, se espera como antes para no perder el aviso).
async function avisarSeguimiento() {
  const aviso = fetch('https://lizybztwnlrlvsrmgnug.functions.supabase.co/seguimiento-entregas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).catch(() => { /* el cron de 5 minutos lo recupera */ });

  try {
    // @ts-ignore EdgeRuntime es propio de las Edge Functions de Supabase
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(aviso);
      return;
    }
  } catch (_e) { /* sigue abajo */ }
  await aviso;
}

serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace('/wompi-checkout', '');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ===== CREATE PAYMENT =====
    if (req.method === 'POST' && path === '/create-payment') {
      // ⚠️ El `total` (y el `deliveryFee`) que manda el navegador se IGNORAN a propósito:
      // el monto se calcula acá, en el servidor, igual que en crear-pedido.
      const { items, userId, deliveryType, deliveryPoint, customerName, customerPhone, token: tokenCliente,
              facturaTipo, facturaNombre, facturaNit, facturaNrc, facturaGiro, facturaDireccion, customerEmail, facturaPorCorreo, facturaPorWhatsapp,
              contactoPreferido, codigo, sesionToken, cuponCodigo } = await req.json();
      if (!items?.length) return new Response(JSON.stringify({ error: 'Carrito vacio' }), { status: 400, headers: corsHeaders });

      // 🔐 VERIFICACIÓN DE CLIENTES (24-sep-2026): hay que verificar AL MENOS un medio
      // (teléfono/WhatsApp O correo) ANTES de crear el enlace de pago. El 10% de
      // bienvenida sigue exigiendo teléfono verificado (regla de Cindy).
      const telVerif = normalizarTel(String(customerPhone || ''));
      const telVerificadoW = telVerif ? await telefonoVerificado(telVerif) : false;
      const correoVerif = String(customerEmail || '').trim() ? await correoVerificado(String(customerEmail || '').trim()) : false;
      if (await verificacionActiva()) {
        if (!telVerif || telVerif.length !== 11) {
          return new Response(JSON.stringify({ error: 'Necesitamos tu teléfono para confirmar el pedido', motivo: 'telefono_requerido' }), { status: 400, headers: corsHeaders });
        }
        if (!telVerificadoW && !correoVerif) {
          return new Response(JSON.stringify({ error: 'Antes de pagar, confirmá tu WhatsApp o tu correo 💗 (te mandamos un código de 6 números)', motivo: 'verificacion_requerida' }), { status: 409, headers: corsHeaders });
        }
      }

      // ===== PRECIOS DEL SERVIDOR (2026-09-23) =====
      // 🔒 ANTES: el monto del enlace de pago salía del body (`total`) → cualquiera podía
      // mandar $0.05 y pagar menos. AHORA: se lee el precio REAL en la base y se aplica la
      // MISMA fórmula de la tienda (idéntica a crear-pedido). Si no coincide al centavo,
      // el cliente vería un total y pagaría otro.
      const PRICE_FACTOR = 1.16955;   // 1.13 (IVA 13%) × 1.035 (comisión Wompi 3.50%)
      const PRICE_FEE    = 0.25;      // $0.25 fija de Wompi
      const C807_FEE     = 1.00;      // Retiro en agencia C807 (solo con tarjeta)
      const precioFinal = (bruto: number) => {
        if (!bruto || bruto <= 0) return 0;
        return Math.ceil((Number(bruto) * PRICE_FACTOR + PRICE_FEE) * 20) / 20;  // redondeo hacia arriba al 0.05
      };
      const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

      const ids = [...new Set((items || []).map((it: any) => Number(it.id)).filter((n: number) => Number.isFinite(n) && n > 0))];
      if (!ids.length) return new Response(JSON.stringify({ error: 'Los productos no son válidos' }), { status: 400, headers: corsHeaders });

      const { data: prods, error: errProds } = await supabase.from('inventory')
        .select('id, name, sale_price, stock, active, condition')
        .in('id', ids);
      if (errProds) return new Response(JSON.stringify({ error: 'No pudimos consultar los productos' }), { status: 500, headers: corsHeaders });

      const mapa = new Map<number, any>();
      for (const p of (prods || [])) mapa.set(Number(p.id), p);

      // Los items se reconstruyen del lado del servidor: id, cantidad, nombre y PRECIO reales.
      // Del navegador solo se conserva lo que NO es dinero (talla e imagen, para el ticket/despacho).
      const itemsServidor: any[] = [];
      let subtotalProductos = 0;
      for (const it of (items || [])) {
        const id = Number(it.id);
        const cant = Math.floor(Number(it.qty ?? 1));
        if (!Number.isFinite(id) || id <= 0) return new Response(JSON.stringify({ error: 'Producto no válido' }), { status: 400, headers: corsHeaders });
        if (!Number.isFinite(cant) || cant < 1) return new Response(JSON.stringify({ error: 'Cantidad no válida' }), { status: 400, headers: corsHeaders });
        const p = mapa.get(id);
        if (!p) return new Response(JSON.stringify({ error: 'Un producto ya no está disponible' }), { status: 400, headers: corsHeaders });
        if (p.active === false) return new Response(JSON.stringify({ error: 'Un producto ya no está a la venta' }), { status: 400, headers: corsHeaders });
        if (Number(p.stock || 0) < cant) {
          return new Response(JSON.stringify({ error: 'Se agotó: ' + String(p.name || 'un producto') }), { status: 409, headers: corsHeaders });
        }
        const precio = precioFinal(Number(p.sale_price || 0));
        if (precio <= 0) return new Response(JSON.stringify({ error: 'Un producto no tiene precio válido' }), { status: 409, headers: corsHeaders });

        subtotalProductos += precio * cant;
        const talla = it.size ?? it.talla ?? null;
        const imagen = it.image ?? it.imagen ?? null;
        itemsServidor.push({
          id, qty: cant, name: String(p.name || 'Producto'), price: precio,
          ...(talla ? { size: String(talla) } : {}),
          ...(p.condition ? { condition: String(p.condition) } : {}),
          ...(imagen ? { image: String(imagen) } : {}),
        });
      }
      subtotalProductos = money(subtotalProductos);

      // ===== ENVÍO (mismo criterio que la tienda, no se confía en el body) =====
      // Puntos de BARATUSS = gratis · Agencia C807 = $1.00 (solo con tarjeta)
      const tipoEntrega = String(deliveryType || 'retiro-punto');
      if (!['retiro-punto', 'retiro-c807'].includes(tipoEntrega)) {
        return new Response(JSON.stringify({ error: 'Forma de entrega no válida' }), { status: 400, headers: corsHeaders });
      }
      const envio = tipoEntrega === 'retiro-c807' ? C807_FEE : 0;

      // ===== CÓDIGO ÚNICO (cupón o referido): el SERVIDOR clasifica =====
      // Primero valida como CUPÓN (validar_cupon); si responde `no_existe`, lo prueba
      // como CÓDIGO DE AMIGA (profiles.codigo_referido). Nunca se confía en el descuento
      // del navegador: se recalcula desde los precios REALES de la base.
      let descuentoCupon = 0;
      let descuentoReferido = 0;
      let cuponAplicado: string | null = null;
      let referidoAplicado: string | null = null;
      const codigoUnico = String(codigo || cuponCodigo || '').trim().toUpperCase();
      if (codigoUnico) {
        // 1) ¿Es un cupón?
        const { data: val } = await supabase.rpc('validar_cupon', {
          p_codigo: codigoUnico,
          p_telefono: customerPhone || null,
          p_subtotal: subtotalProductos,
        });
        const esCupon = !!(val && val.ok === true);
        const cuponConError = !!(val && val.ok === false && String(val.motivo || '') !== 'no_existe');
        if (esCupon) {
          descuentoCupon = Number(val.descuento || 0);
          cuponAplicado = String(val.codigo || codigoUnico).toUpperCase();
          if (descuentoCupon > subtotalProductos) descuentoCupon = subtotalProductos;  // nunca menos que $0
        } else if (cuponConError) {
          const msg = val.motivo === 'vencido' ? 'Ese cupón ya venció'
            : val.motivo === 'ya_usado' ? 'Ese cupón ya fue usado'
            : val.motivo === 'no_corresponde' ? 'Ese cupón es de otro cliente'
            : val.motivo === 'inactivo' ? 'Ese cupón ya no está activo'
            : 'Ese cupón no es válido';
          return new Response(JSON.stringify({ error: msg, motivo: val.motivo }), { status: 400, headers: corsHeaders });
        } else {
          // no_existe → probar como CÓDIGO DE AMIGA (referido)
          const userId = await usuarioDeToken(String(sesionToken || '').trim());
          if (!userId) {
            return new Response(JSON.stringify({ error: 'Para usar el código de una amiga necesitás entrar a tu cuenta (o crearte una) 💛', motivo: 'requiere_cuenta' }), { status: 409, headers: corsHeaders });
          }
          const { data: duenio } = await supabase.from('profiles').select('id, name').eq('codigo_referido', codigoUnico).maybeSingle();
          if (!duenio) {
            return new Response(JSON.stringify({ error: 'Ese código no existe, revisalo 🔍', motivo: 'codigo_invalido' }), { status: 409, headers: corsHeaders });
          }
          if (String(duenio.id) === String(userId)) {
            return new Response(JSON.stringify({ error: 'No podés usar tu propio código 😊', motivo: 'codigo_propio' }), { status: 409, headers: corsHeaders });
          }
          const { count: previos } = await supabase.from('orders').select('id', { count: 'exact', head: true })
            .or(`user_id.eq.${userId},customer_phone.eq.${telVerif || customerPhone}`);
          if ((previos || 0) > 0) {
            return new Response(JSON.stringify({ error: 'El descuento por referido es solo para la primera compra 💛', motivo: 'no_es_primera_compra' }), { status: 409, headers: corsHeaders });
          }
          referidoAplicado = codigoUnico;
          descuentoReferido = money(Math.min(subtotalProductos * 0.10, 5));
        }
      }

      // 🎁 10% DE BIENVENIDA (24-sep-2026): solo en la 1ª compra de un teléfono
      // VERIFICADO y sin cupón ni referido (no se acumula; regla de Cindy: un solo descuento).
      let bienvenidaAplicada = false;
      let bienvenidaDescuento = 0;
      if (descuentoCupon === 0 && descuentoReferido === 0 && telVerificadoW && !(await bienvenidaYaUsada(telVerif))) {
        bienvenidaAplicada = true;
        bienvenidaDescuento = money(Math.min(subtotalProductos * 0.10, 5));
      }

      // ===== TOTAL (calculado acá, jamás con el `total` del navegador) =====
      const totalFinal = money(Math.max(0, subtotalProductos + envio - descuentoCupon - descuentoReferido - bienvenidaDescuento));
      if (totalFinal <= 0) {
        return new Response(JSON.stringify({ error: 'El total del pedido no puede ser $0' }), { status: 400, headers: corsHeaders });
      }

      const ref = 'BAR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      const token = await getWompiToken();

      const pay = await fetch('https://api.wompi.sv/EnlacePago', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          identificadorEnlaceComercio: ref,
          monto: Math.round(totalFinal * 100) / 100,
          nombreProducto: 'BARATUSS - Pedido online',
          formaPago: { permitirTarjetaCreditoDebido: true, permitirPagoConPuntoAgricola: true, permitirPagoEnCuotasAgricola: false },
          configuracion: {
            urlRedirect: 'https://baratuss.github.io/?ref=' + ref,
            urlRetorno: 'https://baratuss.github.io/#tienda',
            emailsNotificacion: 'cindyrubiomusic@gmail.com',
            urlWebhook: url.origin + '/wompi-checkout/webhook',
            notificarTransaccionCliente: true
          }
        })
      });

      const payData = await pay.json();
      if (!pay.ok) throw new Error(JSON.stringify(payData));

      await supabase.from('orders').insert({
        user_id: userId || null, items: itemsServidor, total: totalFinal, reference: ref,
        cupon_codigo: cuponAplicado, cupon_descuento: descuentoCupon || null,
        referido_por_codigo: referidoAplicado, referido_descuento: descuentoReferido > 0 ? descuentoReferido : null,
        status: 'pendiente', payment_status: 'pendiente',
        transaction_id: payData.idTransaccion || null,
        delivery_type: tipoEntrega,
        delivery_fee: envio,
        contacto_preferido: contactoPreferido || 'whatsapp',
        // PLAN 2 (19-sep-2026): teléfono normalizado (para avisos y búsquedas) y
        // vencimiento a las 48 h si el pago con tarjeta no se completa.
        telefono_normalizado: String(customerPhone || '').replace(/\D/g, '').length === 8
          ? '503' + String(customerPhone || '').replace(/\D/g, '')
          : String(customerPhone || '').replace(/\D/g, ''),
        pago_expira_en: new Date(Date.now() + 48 * 3600000).toISOString(),
        delivery_point: deliveryPoint || null,
        customer_name: customerName || null,
        customer_phone: customerPhone || null,
        // Documento tributario elegido por el cliente (ejercicio de facturación)
        factura_tipo: facturaTipo || 'ninguna',
        factura_nombre: facturaNombre || null,
        factura_nit: facturaNit || null,
        factura_nrc: facturaNrc || null,
        factura_giro: facturaGiro || null,
        factura_direccion: facturaDireccion || null,
        customer_email: customerEmail || null,
        factura_por_correo: facturaPorCorreo || false,
        factura_por_whatsapp: facturaPorWhatsapp || false,
        // 🔐 VERIFICACIÓN (24-sep-2026): deja rastro del estado y del 10% de bienvenida.
        telefono_verificado: telVerificadoW,
        correo_verificado: correoVerif,
        verificacion_estado: (telVerificadoW || correoVerif) ? 'verificado' : 'pendiente',
        bienvenida_aplicada: bienvenidaAplicada,
        descuento_bienvenida: bienvenidaDescuento,
        stock_reservado: true
      });

      // ✅ VENTA ATÓMICA de stock al confirmar el pedido (función en la base, imposible de pisar)
      // Si el producto ya se vendió o lo tiene reservado otro cliente → se rechaza el pago.
      // 🔧 ARREGLO 2026-09-23: antes se le agregaba '-' + ref, y por eso NO coincidía con la
      // reserva de 5 minutos que la propia clienta hizo al abrir el carrito → el sistema
      // respondía "reservada_por_otro" y rechazaba el 100% de los pagos con tarjeta.
      // Ahora usa el mismo token que crear-pedido (el del carrito, o la referencia si no vino).
      const tokenSesion = tokenCliente || ref;
      // ✅ VENTA ATÓMICA (2026-09-18): todo-o-nada con la misma función de la base.
      // Antes se vendía producto por producto y, si uno fallaba, los anteriores quedaban
      // vendidos sin pedido (stock desaparecido). Ya no hace falta el bucle de devolución.
      {
        const { data: venta } = await supabase.rpc('vender_carrito', {
          p_items: (itemsServidor || []).map((it: any) => ({ id: Number(it.id), qty: Number(it.qty || 1) })),
          p_token: tokenSesion,
        });
        if (!venta?.ok) {
          // ⚠️ Se borra el pedido Y sus despachos: el disparador de la base ya había creado el
          // despacho al registrar el pedido. Si quedaba suelto (huérfano), aparecía en el panel
          // como entrega activa, ensuciaba las métricas y podía generar mensajes de una compra
          // que nunca existió (bug real detectado el 2026-09-17).
          await supabase.from('despachos').delete().eq('order_reference', ref);
          await supabase.from('orders').delete().eq('reference', ref);
          return new Response(JSON.stringify({
            error: venta?.motivo === 'reservada_por_otro'
              ? 'Otra persona está comprando este producto ahora mismo. Probá en unos minutos.'
              : 'Uno de los productos acaba de venderse.'
          }), { status: 409, headers: corsHeaders });
        }
      }

      // 🎁 Registrar el 10% de bienvenida (una sola vez por teléfono verificado).
      // Con el pedido creado y el stock vendido; si algo falló antes, no se graba.
      if (bienvenidaAplicada) {
        try {
          await supabase.from('bienvenidas').upsert(
            { dato: telVerif, order_reference: ref, usado_en: new Date().toISOString() },
            { onConflict: 'dato' },
          );
        } catch (_e) { /* no bloquea el pago */ }
      }

      return new Response(JSON.stringify({ paymentUrl: payData.urlEnlace, reference: ref }), { headers: corsHeaders });
    }

    // ===== WEBHOOK =====
    if (req.method === 'POST' && path === '/webhook') {
      const p = await req.json();
      const ref = p.enlacePago?.identificadorEnlaceComercio;
      const aprobado = p.esAprobada === 'true';
      if (ref) {
        const { data: order } = await supabase.from('orders').select('items, stock_reservado').eq('reference', ref).single();
        const items = order?.items || [];

        if (aprobado) {
          await supabase.from('orders').update({
            payment_status: 'aprobado',
            transaction_id: p.idTransaccion,
            payment_method: p.formaPagoUtilizada || null,
            payment_date: new Date().toISOString(),
            status: 'pagado'
          }).eq('reference', ref);
          // Si el pedido NO reservó stock al crearse (pedido anterior al fix),
          // descontar aquí al aprobarse
          if (!order?.stock_reservado) {
            // Venta atómica (todo-o-nada) para pedidos viejos que no reservaron stock
            await supabase.rpc('vender_carrito', {
              p_items: (items || []).map((it: any) => ({ id: Number(it.id), qty: Number(it.qty || 1) })),
              p_token: 'webhook-' + ref,
            });
            await supabase.from('orders').update({ stock_reservado: true }).eq('reference', ref);
          }

          // 🎟️ Si el pedido usó un cupón, se marca como USADO (una sola vez, atómico)
          try {
            const { data: oc } = await supabase.from('orders').select('cupon_codigo').eq('reference', ref).maybeSingle();
            if (oc?.cupon_codigo) {
              await supabase.rpc('usar_cupon', { p_codigo: oc.cupon_codigo, p_reference: ref });
            }
          } catch (eCup) { console.log('error cupon webhook', String(eCup)); }

          // ===== FASE 1 ENTREGAS: alta de despachos al aprobarse el pago =====
          // (un registro por producto — cada uno es un paquete a preparar/entregar)
          const { data: orderFull } = await supabase.from('orders')
            .select('delivery_type, delivery_point, delivery_fee, customer_name, customer_phone')
            .eq('reference', ref).single();
          if (orderFull) {
            await crearDespachos(ref, items, orderFull);
          }
        } else {
          await supabase.from('orders').update({
            payment_status: 'rechazado',
            transaction_id: p.idTransaccion,
            payment_method: p.formaPagoUtilizada || null,
            payment_date: new Date().toISOString(),
            status: 'rechazado',
            stock_reservado: false
          }).eq('reference', ref);
          // ❌ Pago rechazado → DEVOLVER el stock reservado (función atómica)
          if (order?.stock_reservado) {
            for (const item of items) {
              const qty = item.qty || 1;
              await supabase.rpc('devolver_stock', { p_id: Number(item.id), p_qty: qty });
            }
          }
        }
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: corsHeaders });
    }

    // ===== CREATE DESPACHOS (efectivo / uso general) =====
    // Alta unificada vía EF (service role) — evita depender de policies RLS de insert
    if (req.method === 'POST' && path === '/create-despachos') {
      const { reference, items, deliveryType, deliveryPoint, customerName, customerPhone } = await req.json();
      if (!reference || !items?.length) {
        return new Response(JSON.stringify({ error: 'reference e items requeridos' }), { status: 400, headers: corsHeaders });
      }
      const result = await crearDespachos(reference, items, {
        delivery_type: deliveryType || 'retiro-punto',
        delivery_point: deliveryPoint || null,
        customer_name: customerName || null,
        customer_phone: customerPhone || null
      });
      return new Response(JSON.stringify(result), { headers: corsHeaders });
    }

    // ===== VERIFY =====
    if (req.method === 'GET' && path === '/verify') {
      const ref = url.searchParams.get('ref');
      if (!ref) return new Response(JSON.stringify({ error: 'No reference' }), { status: 400, headers: corsHeaders });
      const { data } = await supabase.from('orders').select('*').eq('reference', ref).single();
      return new Response(JSON.stringify({ order: data || null }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
