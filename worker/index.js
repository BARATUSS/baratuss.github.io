const WOMPI_CLIENT_ID = 'ad59dd3e-5c32-476d-a864-4ff719f4e7b1';
const WOMPI_CLIENT_SECRET = '9c96e9c3-6a03-464d-90e1-c9e585686cc9';
const WOMPI_TOKEN_URL = 'https://id.wompi.sv/connect/token';
const WOMPI_API_URL = 'https://api.wompi.sv';
const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxpenlienR3bmxybHZzcm1nbnVnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTI2NjIzNCwiZXhwIjoyMTAwODQyMjM0fQ.dTbQ59O1RxqE_SPAOq2R1Af5x-5hmWKZdxceBjKKIL4';
async function getWompiToken() {
  const r = await fetch(WOMPI_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: WOMPI_CLIENT_ID, client_secret: WOMPI_CLIENT_SECRET, audience: 'wompi_api' }) });
  const d = await r.json();
  if (!r.ok) throw new Error('Auth: ' + (d.error_description || d.error));
  return d.access_token;
}
async function createPayment(token, ref, amount, redirect) {
  const r = await fetch(WOMPI_API_URL + '/EnlacePago', { method: 'POST', headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ identificadorEnlaceComercio: ref, monto: amount, nombreProducto: 'BARATUSS', formaPago: { permitirTarjetaCreditoDebido: true, permitirPagoConPuntoAgricola: true, permitirPagoEnCuotasAgricola: false }, configuracion: { urlRedirect: redirect, urlRetorno: 'https://baratuss.github.io/#tienda', emailsNotificacion: 'cindyrubiomusic@gmail.com', urlWebhook: 'https://baratuss-pay.alejandro-palacios.workers.dev/webhook', notificarTransaccionCliente: true } }) });
  const d = await r.json();
  if (!r.ok) throw new Error('Pay: ' + JSON.stringify(d));
  return d;
}
async function supabaseFetch(url, opts) {
  const h = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', ...opts?.headers };
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + url, { ...opts, headers: h });
  return r.ok ? (opts?.raw ? r : await r.json().catch(() => null)) : null;
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      if (request.method === 'POST' && path === '/create-payment') {
        const { items, total, userId } = await request.json();
        if (!items?.length) return new Response(JSON.stringify({ error: 'vacio' }), { status: 400, headers: cors });
        const ref = 'BAR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const token = await getWompiToken();
        const pay = await createPayment(token, ref, Math.round(total * 100) / 100, 'https://baratuss.github.io/?ref=' + ref);
        await supabaseFetch('orders', { method: 'POST', body: JSON.stringify({ user_id: userId || null, items, total, reference: ref, status: 'pendiente', payment_status: 'pendiente', transaction_id: pay.idTransaccion || null }) });
        return new Response(JSON.stringify({ paymentUrl: pay.urlEnlace, paymentId: pay.idEnlace, reference: ref, qrUrl: pay.urlQrCodeEnlace }), { headers: cors });
      }
      if (request.method === 'POST' && path === '/webhook') {
        const p = await request.json();
        const ref = p.enlacePago?.identificadorEnlaceComercio;
        if (ref) await supabaseFetch('orders?reference=eq.' + encodeURIComponent(ref), { method: 'PATCH', body: JSON.stringify({ payment_status: p.esAprobada === 'true' ? 'aprobado' : 'rechazado', transaction_id: p.idTransaccion, payment_method: p.formaPagoUtilizada || null, payment_date: new Date().toISOString(), status: p.esAprobada === 'true' ? 'pagado' : 'rechazado' }) });
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: cors });
      }
      if (request.method === 'GET' && path === '/verify') {
        const ref = url.searchParams.get('ref');
        if (!ref) return new Response(JSON.stringify({ error: 'no ref' }), { status: 400, headers: cors });
        const data = await supabaseFetch('orders?reference=eq.' + encodeURIComponent(ref) + '&select=*');
        return new Response(JSON.stringify({ order: data?.[0] || null }), { headers: cors });
      }
      return new Response(JSON.stringify({ error: '404' }), { status: 404, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }
};
