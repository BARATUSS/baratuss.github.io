// BARATUSS — API de stock: reserva de 5 min y venta atómica (Fase 1+2 entregas)
// Endpoints: POST /stock-api/reservar | /stock-api/vender | /stock-api/liberar
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'metodo_no_permitido' }, 405);

  const ruta = new URL(req.url).pathname.split('/').filter(Boolean).pop() || '';
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* sin body */ }

  // ===== RESERVAR (5 minutos para el cliente que llego primero) =====
  if (ruta === 'reservar') {
    const items = Array.isArray(body.items) ? body.items : [];
    const token = String(body.token || '');
    const minutos = Number(body.minutos) || 5;
    if (!items.length || !token) return json({ ok: false, error: 'faltan_datos' });

    for (const it of items) {
      const { data, error } = await supabase.rpc('reservar_stock', {
        p_id: Number(it.id), p_qty: Number(it.qty || 1), p_token: token, p_minutos: minutos
      });
      if (error) return json({ ok: false, motivo: 'error', detalle: error.message });
      if (!data?.ok) {
        // Liberar lo que este cliente ya habia reservado en esta operacion
        await supabase.from('inventory').update({ reservado_hasta: null, reservado_token: null }).eq('reservado_token', token);
        return json({ ok: false, motivo: data?.motivo || 'no_disponible', producto: it.id });
      }
    }
    const expira = new Date(Date.now() + minutos * 60000).toISOString();
    return json({ ok: true, minutos, expira });
  }

  // ===== VENDER (descuento definitivo, atomico) =====
  if (ruta === 'vender') {
    const items = Array.isArray(body.items) ? body.items : [];
    const token = String(body.token || '');
    if (!items.length) return json({ ok: false, error: 'faltan_datos' });

    // ✅ VENTA ATÓMICA (2026-09-18): todo-o-nada en una sola operación de la base.
    // Antes se vendía producto por producto: si uno fallaba, los anteriores quedaban
    // vendidos SIN pedido → productos desaparecidos del catálogo (Escenario 2, punto 1).
    const { data: atom, error: errAtom } = await supabase.rpc('vender_carrito', {
      p_items: items.map((i: any) => ({ id: Number(i.id), qty: Number(i.qty || 1) })),
      p_token: token
    });
    if (!errAtom && atom) return json(atom);

    // Respaldo: si la función nueva no estuviera disponible, se mantiene el camino viejo
    for (const it of items) {
      const { data, error } = await supabase.rpc('vender_stock', {
        p_id: Number(it.id), p_qty: Number(it.qty || 1), p_token: token
      });
      if (error) return json({ ok: false, motivo: 'error', detalle: error.message });
      if (!data?.ok) return json({ ok: false, motivo: data?.motivo || 'no_disponible', producto: it.id });
    }
    return json({ ok: true });
  }

  // ===== LIBERAR reservas vencidas (para el proceso automatico) =====
  // ===== LIBERAR =====
  // Con items + token: suelta LA reserva de ese carrito (cuando el cliente quita un producto).
  // Sin datos: mantiene el comportamiento anterior (limpia las reservas vencidas).
  if (ruta === 'liberar') {
    const items = Array.isArray(body.items) ? body.items : [];
    const token = String(body.token || '');
    if (items.length && token) {
      let liberadas = 0;
      for (const it of items) {
        const { data } = await supabase.rpc('liberar_mi_reserva', {
          p_id: Number(it.id), p_token: token,
        });
        if (data && data.ok) liberadas += Number(data.liberadas || 0);
      }
      return json({ ok: true, liberadas: liberadas });
    }
    const { data, error } = await supabase.rpc('liberar_reservas_vencidas');
    if (error) return json({ ok: false, detalle: error.message });
    return json({ ok: true, liberadas: data });
  }

  return json({ ok: false, error: 'ruta_desconocida' }, 404);
});
