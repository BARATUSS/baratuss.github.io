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
      const { items, total, userId } = await req.json();
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
        transaction_id: payData.idTransaccion || null
      });

      return new Response(JSON.stringify({ paymentUrl: payData.urlEnlace, reference: ref }), { headers: corsHeaders });
    }

    // ===== WEBHOOK =====
    if (req.method === 'POST' && path === '/webhook') {
      const p = await req.json();
      const ref = p.enlacePago?.identificadorEnlaceComercio;
      if (ref) {
        await supabase.from('orders').update({
          payment_status: p.esAprobada === 'true' ? 'aprobado' : 'rechazado',
          transaction_id: p.idTransaccion,
          payment_method: p.formaPagoUtilizada || null,
          payment_date: new Date().toISOString(),
          status: p.esAprobada === 'true' ? 'pagado' : 'rechazado'
        }).eq('reference', ref);
      }
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: corsHeaders });
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
