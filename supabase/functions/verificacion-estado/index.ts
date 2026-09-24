// ============================================================================
// BARATUSS · verificacion-estado · 24-sep-2026
// Consulta rápida del checkout: ¿está activa la verificación? ¿este teléfono
// ya está verificado? ¿le toca el 10% de bienvenida? (no revela de quién es).
// ============================================================================
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabase, normalizarTel } from '../_shared/verificacion.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const tel = normalizarTel(String(b.telefono || ''));
    const correo = String(b.correo || '').trim().toLowerCase();

    // Interruptor maestro
    const { data: cfg } = await supabase.from('config_operativa')
      .select('valor').eq('clave', 'plan_verificacion_clientes').maybeSingle();
    const interruptor = String(cfg?.valor || 'apagado') === 'activo' ? 'activo' : 'apagado';

    let telefonoVerificado = false;
    if (tel) {
      const { data: v } = await supabase.from('verif_datos')
        .select('id').eq('tipo', 'telefono').eq('dato', tel).is('revocado_en', null).maybeSingle();
      telefonoVerificado = !!v;
    }

    let correoVerificado = false;
    if (correo) {
      const { data: v } = await supabase.from('verif_datos')
        .select('id').eq('tipo', 'correo').eq('dato', correo).is('revocado_en', null).maybeSingle();
      correoVerificado = !!v;
    }

    let puedeBienvenida = false;
    if (tel && telefonoVerificado) {
      const { data: bj } = await supabase.from('bienvenidas').select('dato').eq('dato', tel).maybeSingle();
      puedeBienvenida = !bj;
    }

    return json({ ok: true, interruptor, telefono_verificado: telefonoVerificado, correo_verificado: correoVerificado, puede_bienvenida: puedeBienvenida });
  } catch (e) {
    console.log('ERROR verificacion-estado', String(e));
    return json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
});
