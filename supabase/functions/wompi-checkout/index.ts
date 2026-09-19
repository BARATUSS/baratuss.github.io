import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
      const { items, total, userId, deliveryType, deliveryFee, deliveryPoint, customerName, customerPhone, token: tokenCliente,
              facturaTipo, facturaNombre, facturaNit, facturaNrc, facturaGiro, facturaDireccion, customerEmail, facturaPorCorreo,
              cuponCodigo } = await req.json();
      if (!items?.length) return new Response(JSON.stringify({ error: 'Carrito vacio' }), { status: 400, headers: corsHeaders });

      // ===== CUPÓN (2026-09-18): se valida y se aplica EN EL SERVIDOR =====
      // Nunca se confía en el descuento que manda el navegador: se recalcula desde los items.
      // Reglas: solo producto (el envío no lleva descuento), un solo uso, con tope.
      let descuentoCupon = 0;
      let cuponAplicado: string | null = null;
      const subtotalProductos = (items || []).reduce(
        (s: number, it: any) => s + Number(it.price || 0) * Number(it.qty || 1), 0);
      if (cuponCodigo) {
        const { data: val } = await supabase.rpc('validar_cupon', {
          p_codigo: String(cuponCodigo),
          p_telefono: customerPhone || null,
          p_subtotal: subtotalProductos,
        });
        if (!val?.ok) {
          const msg = val?.motivo === 'vencido' ? 'Ese cupón ya venció'
            : val?.motivo === 'ya_usado' ? 'Ese cupón ya fue usado'
            : val?.motivo === 'no_corresponde' ? 'Ese cupón es de otro cliente'
            : 'Ese cupón no es válido';
          return new Response(JSON.stringify({ error: msg }), { status: 400, headers: corsHeaders });
        }
        descuentoCupon = Number(val.descuento || 0);
        cuponAplicado = String(val.codigo || cuponCodigo).toUpperCase();
      }
      const totalFinal = cuponAplicado
        ? Math.round((subtotalProductos + Number(deliveryFee || 0) - descuentoCupon) * 100) / 100
        : total;

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
        user_id: userId || null, items, total: totalFinal, reference: ref,
        cupon_codigo: cuponAplicado, cupon_descuento: descuentoCupon || null,
        status: 'pendiente', payment_status: 'pendiente',
        transaction_id: payData.idTransaccion || null,
        delivery_type: deliveryType || 'retiro-punto',
        delivery_fee: deliveryFee || 0,
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
        stock_reservado: true
      });

      // ✅ VENTA ATÓMICA de stock al confirmar el pedido (función en la base, imposible de pisar)
      // Si el producto ya se vendió o lo tiene reservado otro cliente → se rechaza el pago.
      const tokenSesion = String(tokenCliente || 'checkout') + '-' + ref;
      // ✅ VENTA ATÓMICA (2026-09-18): todo-o-nada con la misma función de la base.
      // Antes se vendía producto por producto y, si uno fallaba, los anteriores quedaban
      // vendidos sin pedido (stock desaparecido). Ya no hace falta el bucle de devolución.
      {
        const { data: venta } = await supabase.rpc('vender_carrito', {
          p_items: (items || []).map((it: any) => ({ id: Number(it.id), qty: Number(it.qty || 1) })),
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
