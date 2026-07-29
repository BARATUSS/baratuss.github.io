const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ===== CONFIG =====
const WOMPI_CLIENT_ID = 'ad59dd3e-5c32-476d-a864-4ff719f4e7b1';
const WOMPI_CLIENT_SECRET = '9c96e9c3-6a03-464d-90e1-c9e585686cc9';
const WOMPI_TOKEN_URL = 'https://id.wompi.sv/connect/token';
const WOMPI_API_URL = 'https://api.wompi.sv';

const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxpenlienR3bmxybHZzcm1nbnVnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTI2NjIzNCwiZXhwIjoyMTAwODQyMjM0fQ.dTbQ59O1RxqE_SPAOq2R1Af5x-5hmWKZdxceBjKKIL4';

const SITE_URL = process.env.SITE_URL || 'https://baratuss.github.io';

// ===== WOMPI AUTH =====
async function getWompiToken() {
  const r = await fetch(WOMPI_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: WOMPI_CLIENT_ID,
      client_secret: WOMPI_CLIENT_SECRET,
      audience: 'wompi_api'
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error);
  return d.access_token;
}

// ===== SUPABASE HELPER =====
async function supabase(method, endpoint, body) {
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + endpoint, opts);
  const data = await r.json().catch(() => null);
  return { ok: r.ok, data, status: r.status };
}

// ===== CREATE PAYMENT =====
app.post('/create-payment', async (req, res) => {
  try {
    const { items, total, userId } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Carrito vacio' });

    const ref = 'BAR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const token = await getWompiToken();

    const pay = await fetch(WOMPI_API_URL + '/EnlacePago', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        identificadorEnlaceComercio: ref,
        monto: Math.round(total * 100) / 100,
        nombreProducto: 'BARATUSS - Pedido online',
        formaPago: {
          permitirTarjetaCreditoDebido: true,
          permitirPagoConPuntoAgricola: true,
          permitirPagoEnCuotasAgricola: false
        },
        configuracion: {
          urlRedirect: SITE_URL + '/?ref=' + ref,
          urlRetorno: SITE_URL + '/#tienda',
          emailsNotificacion: 'cindyrubiomusic@gmail.com',
          urlWebhook: SITE_URL + '/api/webhook',
          notificarTransaccionCliente: true
        }
      })
    });

    const payData = await pay.json();
    if (!pay.ok) throw new Error(JSON.stringify(payData));

    await supabase('POST', 'orders', {
      user_id: userId || null,
      items,
      total,
      reference: ref,
      status: 'pendiente',
      payment_status: 'pendiente',
      transaction_id: payData.idTransaccion || null
    });

    res.json({ paymentUrl: payData.urlEnlace, reference: ref });
  } catch (e) {
    console.error('Create payment error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== WEBHOOK =====
app.post('/webhook', async (req, res) => {
  try {
    const p = req.body;
    console.log('Webhook received:', JSON.stringify(p));
    
    const ref = p.enlacePago?.identificadorEnlaceComercio;
    if (ref) {
      await supabase('PATCH', 'orders?reference=eq.' + encodeURIComponent(ref), {
        payment_status: p.esAprobada === 'true' ? 'aprobado' : 'rechazado',
        transaction_id: p.idTransaccion,
        payment_method: p.formaPagoUtilizada || null,
        payment_date: new Date().toISOString(),
        status: p.esAprobada === 'true' ? 'pagado' : 'rechazado'
      });
    }
    res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.status(200).json({ status: 'ok' }); // Always return 200 to Wompi
  }
});

// ===== VERIFY =====
app.get('/verify', async (req, res) => {
  try {
    const ref = req.query.ref;
    if (!ref) return res.status(400).json({ error: 'No reference' });
    const { data } = await supabase('GET', 'orders?reference=eq.' + encodeURIComponent(ref) + '&select=*');
    res.json({ order: data?.[0] || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== HEALTH =====
app.get('/', (req, res) => res.json({ status: 'BARATUSS API OK' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('BARATUSS API running on port', PORT));
