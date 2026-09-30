// ============================================================================
// BARATUSS · _shared/referidos.ts · 30-sep-2026
// Programa de amigas: cuando una clienta usa el código de una amiga, la amiga
// que RECOMENDÓ recibe un cupón de 10% (tope $5, 30 días). Se llama una sola vez
// por pedido (idempotente vía orders.referido_premiado).
// ============================================================================
import { supabase, normalizarTel, generarTokenCorto, enviarTexto } from './verificacion.ts';

const PORCENTAJE = 10;
const TOPE = 5;
const DIAS_VALIDEZ = 30;

export async function premiarReferidor(codigoReferido: string, refPedido: string, nombreAmiga: string) {
  if (!codigoReferido || !refPedido) return;
  try {
    // 1) ¿De quién es el código?
    const { data: duenio } = await supabase.from('profiles')
      .select('id, name, phone, email')
      .eq('codigo_referido', codigoReferido.toUpperCase())
      .maybeSingle();
    if (!duenio || !duenio.phone) return;   // sin teléfono no hay a quién avisar

    // 2) Idempotente: un solo premio por pedido.
    const { data: ya } = await supabase.from('orders')
      .select('id').eq('reference', refPedido).eq('referido_premiado', true).maybeSingle();
    if (ya) return;

    const codigoPremio = 'AMIG' + generarTokenCorto(6);
    const expira = new Date(Date.now() + DIAS_VALIDEZ * 86400000).toISOString();

    const { error: errCup } = await supabase.from('cupones').insert({
      codigo: codigoPremio,
      valor: PORCENTAJE,
      tope: TOPE,
      cliente_telefono: normalizarTel(duenio.phone),
      cliente_email: duenio.email || null,
      user_id: duenio.id,
      expira_en: expira,
      activo: true,
      acumulable: false,
      un_solo_uso: true,
      origen: 'referido',
    });
    if (errCup) { console.log('premio referido: error cupón', errCup.message); return; }

    await supabase.from('orders').update({ referido_premiado: true }).eq('reference', refPedido);

    const texto = '🎉 ¡' + (nombreAmiga ? nombreAmiga + ' ' : '') + 'usó tu código de amiga! 💛\n\n'
      + 'Te regalamos un cupón de *10% de descuento*:\n*' + codigoPremio + '*\n\n'
      + 'Usalo en tu próxima compra. ⏰ Vale ' + DIAS_VALIDEZ + ' días · tope $' + TOPE + ' · un solo uso.';
    await enviarTexto(normalizarTel(duenio.phone), texto, 'PREMIO_REFERIDO');
  } catch (e) {
    console.log('premio referido: excepción', String(e));
  }
}
