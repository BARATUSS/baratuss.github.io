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
  const { count } = await supabase.from('despachos')
    .select('id', { count: 'exact', head: true })
    .eq('order_reference', ref);
  if ((count ?? 0) > 0) return { duplicado: true, count };
  for (const item of items) {
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
      estado_logistico: 'pendiente_confirmacion',
      customer_name: datos.customer_name || null,
      customer_phone: datos.customer_phone || null,
      visto: false
    });
  }
  return { creados: items.length };
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
      const { items, total, userId, deliveryType, deliveryFee, deliveryPoint, customerName, customerPhone, token: tokenCliente } = await req.json();
      if (!items?.length) return new Response(JSON.stringify({ error: 'Carrito vacio' }), { status: 400, headers: corsHeaders });

      const ref = 'BAR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      const token = await getWompiToken();

      const pay = await fetch('https://api.wompi.sv/EnlacePago', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          identificadorEnlaceComercio: ref,
          monto: Math.round(total * 100) / 100,
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
        user_id: userId || null, items, total, reference: ref,
        status: 'pendiente', payment_status: 'pendiente',
        transaction_id: payData.idTransaccion || null,
        delivery_type: deliveryType || 'retiro-punto',
        delivery_fee: deliveryFee || 0,
        delivery_point: deliveryPoint || null,
        customer_name: customerName || null,
        customer_phone: customerPhone || null,
        stock_reservado: true
      });

      // ✅ VENTA ATÓMICA de stock al confirmar el pedido (función en la base, imposible de pisar)
      // Si el producto ya se vendió o lo tiene reservado otro cliente → se rechaza el pago.
      const tokenSesion = String(tokenCliente || 'checkout') + '-' + ref;
      for (const item of items) {
        const qty = item.qty || 1;
        const { data: venta } = await supabase.rpc('vender_stock', { p_id: Number(item.id), p_qty: qty, p_token: tokenSesion });
        if (!venta?.ok) {
          // Liberar lo que sí se alcanzó a vender de este pedido
          for (const ya of items) {
            if (ya.id === item.id) break;
            await supabase.rpc('devolver_stock', { p_id: Number(ya.id), p_qty: ya.qty || 1 });
          }
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
            for (const item of items) {
              const qty = item.qty || 1;
              await supabase.rpc('vender_stock', { p_id: Number(item.id), p_qty: qty, p_token: 'webhook-' + ref });
            }
            await supabase.from('orders').update({ stock_reservado: true }).eq('reference', ref);
          }

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
