// ============================================================================
// BARATUSS · verificar-codigo-wa · 24-sep-2026
// Confirma el código de 6 dígitos del teléfono. Compara el HASH (nunca el texto).
// · 10 min de vida · 3 intentos (al 3º se quema) · un solo uso (consumido_en).
// · Al acertar: graba el teléfono en verif_datos (índice único = un dueño).
// ============================================================================
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabase, normalizarTel, hashCodigo } from '../_shared/verificacion.ts';

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
    const codigo = String(b.codigo || '').replace(/\D/g, '');
    if (!tel || tel.length !== 11) return json({ ok: false, motivo: 'telefono_invalido' }, 400);
    if (codigo.length !== 6) return json({ ok: false, motivo: 'codigo_invalido' }, 400);

    const ahora = Date.now();

    // 1) Buscar el código activo (no consumido, no vencido, no quemado)
    const { data: cods } = await supabase.from('verif_codigos')
      .select('id, codigo_hash, intentos, max_intentos, expira_en')
      .eq('tipo', 'telefono').eq('dato', tel).is('consumido_en', null)
      .order('creado_en', { ascending: false }).limit(1);
    const c = cods && cods.length ? cods[0] : null;
    if (!c) return json({ ok: false, motivo: 'sin_codigo' });

    if (new Date(c.expira_en).getTime() < ahora) {
      return json({ ok: false, motivo: 'expirado', segundos_reenvio: 30 });
    }

    // 2) Comparar el HASH (nunca el texto en claro)
    const hash = await hashCodigo(codigo, tel);
    if (hash !== c.codigo_hash) {
      const nuevosIntentos = Number(c.intentos || 0) + 1;
      const quemado = nuevosIntentos >= Number(c.max_intentos || 3);
      await supabase.from('verif_codigos').update({ intentos: nuevosIntentos }).eq('id', c.id);
      if (quemado) return json({ ok: false, motivo: 'demasiados_intentos', intentos_restantes: 0 });
      return json({ ok: false, motivo: 'incorrecto', intentos_restantes: (Number(c.max_intentos || 3)) - nuevosIntentos });
    }

    // 3) Correcto → marcar consumido y verificado
    const nowISO = new Date().toISOString();
    await supabase.from('verif_codigos').update({ verificado_en: nowISO, consumido_en: nowISO }).eq('id', c.id);

    // 4) Grabar el teléfono en verif_datos (índice único = un dueño por número)
    const { data: existente } = await supabase.from('verif_datos')
      .select('id').eq('tipo', 'telefono').eq('dato', tel).is('revocado_en', null).maybeSingle();
    if (existente) {
      await supabase.from('verif_datos').update({ canal: 'whatsapp', verificado_en: nowISO }).eq('id', existente.id);
    } else {
      const { error: errIns } = await supabase.from('verif_datos').insert({
        tipo: 'telefono', dato: tel, canal: 'whatsapp', verificado_en: nowISO,
        cliente_id: String(b.cliente_id || '') || null,
      });
      if (errIns && errIns.code === '23505') return json({ ok: false, motivo: 'ya_registrado' });
      if (errIns) return json({ ok: false, motivo: 'error_db' }, 500);
    }

    return json({ ok: true, estado: 'verificado', telefono: tel });
  } catch (e) {
    console.log('ERROR verificar-codigo-wa', String(e));
    return json({ ok: false, motivo: 'error', detalle: String(e).slice(0, 200) }, 500);
  }
});
