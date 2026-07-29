import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const WOMPI_CLIENT_ID = 'ad59dd3e-5c32-476d-a864-4ff719f4e7b1'
const WOMPI_CLIENT_SECRET = '9c96e9c3-6a03-464d-90e1-c9e585686cc9'
const WOMPI_TOKEN_URL = 'https://id.wompi.sv/connect/token'
const WOMPI_API_URL = 'https://api.wompi.sv'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://lizybztwnlrlvsrmgnug.supabase.co'
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Get OAuth token from Wompi
async function getWompiToken(): Promise<string> {
  const response = await fetch(WOMPI_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: WOMPI_CLIENT_ID,
      client_secret: WOMPI_CLIENT_SECRET,
      audience: 'wompi_api'
    })
  })
  
  const data = await response.json()
  if (!response.ok) throw new Error(`Wompi auth error: ${data.error_description || data.error}`)
  return data.access_token
}

// Create payment link on Wompi
async function createWompiPayment(token: string, { reference, amount, customerEmail, customerName, redirectUrl, webhookUrl }: any) {
  const response = await fetch(`${WOMPI_API_URL}/EnlacePago`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      identificadorEnlaceComercio: reference,
      monto: amount,
      nombreProducto: 'BARATUSS - Pedido online',
      formaPago: {
        permitirTarjetaCreditoDebido: true,
        permitirPagoConPuntoAgricola: true,
        permitirPagoEnCuotasAgricola: false
      },
      configuracion: {
        urlRedirect: redirectUrl,
        urlRetorno: `${Deno.env.get('PUBLIC_SITE_URL') || 'https://baratuss.github.io'}/#tienda`,
        emailsNotificacion: 'cindyrubiomusic@gmail.com',
        urlWebhook: webhookUrl,
        notificarTransaccionCliente: true
      }
    })
  })
  
  const data = await response.json()
  if (!response.ok) throw new Error(`Wompi payment error: ${JSON.stringify(data)}`)
  return data
}

serve(async (req) => {
  const url = new URL(req.url)
  const path = url.pathname.replace('/wompi-checkout', '')

  try {
    // ===== CREATE PAYMENT =====
    if (req.method === 'POST' && path === '/create-payment') {
      const { items, total, userId, customerName, customerEmail } = await req.json()
      
      if (!items?.length) return new Response(JSON.stringify({ error: 'Carrito vacío' }), { status: 400 })
      
      const reference = `BAR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      
      // Get Wompi token
      const token = await getWompiToken()
      
      // Create payment in Wompi
      const payment = await createWompiPayment(token, {
        reference,
        amount: Math.round(total * 100) / 100,
        customerEmail: customerEmail || '',
        customerName: customerName || '',
        redirectUrl: `${Deno.env.get('PUBLIC_SITE_URL') || 'https://baratuss.github.io'}/?payment=result&reference=${reference}`,
        webhookUrl: `${Deno.env.get('PUBLIC_SITE_URL') || 'https://baratuss.github.io'}/api/wompi-webhook`
      })
      
      // Save order in database
      const orderData: any = {
        user_id: userId || null,
        items,
        total,
        status: 'pendiente',
        payment_status: 'pendiente',
        transaction_id: payment.idTransaccion || null
      }
      
      if (reference) orderData.reference = reference
      
      const { error: dbError } = await supabase.from('orders').insert(orderData)
      if (dbError) console.error('Error saving order:', dbError)
      
      return new Response(JSON.stringify({
        paymentUrl: payment.urlEnlace,
        paymentId: payment.idEnlace,
        reference,
        qrUrl: payment.urlQrCodeEnlace
      }), {
        headers: { 'content-type': 'application/json' }
      })
    }
    
    // ===== WEBHOOK =====
    if (req.method === 'POST' && path === '/webhook') {
      const payload = await req.json()
      console.log('Wompi webhook received:', JSON.stringify(payload))
      
      const transactionId = payload.idTransaccion
      const reference = payload.enlacePago?.identificadorEnlaceComercio
      const status = payload.esAprobada === 'true' ? 'aprobado' : 'rechazado'
      
      if (reference) {
        await supabase.from('orders')
          .update({
            payment_status: status,
            transaction_id: transactionId,
            payment_method: payload.formaPagoUtilizada || null,
            payment_date: new Date().toISOString(),
            status: status === 'aprobado' ? 'pagado' : 'rechazado'
          })
          .eq('reference', reference)
      }
      
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    }
    
    // ===== VERIFY PAYMENT =====
    if (req.method === 'GET' && path === '/verify') {
      const reference = url.searchParams.get('reference')
      if (!reference) return new Response(JSON.stringify({ error: 'Reference required' }), { status: 400 })
      
      const { data: order } = await supabase.from('orders')
        .select('payment_status, transaction_id, payment_method, status')
        .eq('reference', reference)
        .single()
      
      return new Response(JSON.stringify({ order }), {
        headers: { 'content-type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    
  } catch (error) {
    console.error('Error:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
