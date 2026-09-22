// ============================================================================
// crear-pedido · NIVEL B (21-sep-2026) — el pedido lo arma el SERVIDOR
// ----------------------------------------------------------------------------
// El navegador SOLO manda QUÉ quiere: ids + cantidades + talla (sin precios,
// sin totales, sin envío, sin descuentos). Acá se busca el precio REAL en la
// base, se valida el cupón, se calcula el envío y el total, se verifica el
// stock y recién ahí se crea el pedido.
//
// Así nadie puede alterar el precio desde su navegador.
//
// Acciones:
//   (sin accion)   → crea el pedido
//   'cotizar'      → calcula y devuelve el desglose SIN crear nada (para mostrar)
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// --- Mismos números que la tienda (TIENEN que coincidir al centavo) ---------
const PRICE_FACTOR = 1.16955;   // 1.13 (IVA 13%) × 1.035 (comisión Wompi 3.50%)
const PRICE_FEE    = 0.25;      // $0.25 fija de Wompi
const C807_FEE     = 1.00;      // Retiro en agencia C807 (solo con tarjeta)
const MAX_POR_ITEM = 10;        // tope anti-abuso por producto
const MAX_ITEMS    = 20;        // tope anti-abuso de líneas

// Precio de venta al público: igual que finalPrice() de la tienda
function precioFinal(bruto: number): number {
  if (!bruto || bruto <= 0) return 0;
  const raw = Number(bruto) * PRICE_FACTOR + PRICE_FEE;
  return Math.ceil(raw * 20) / 20;      // redondeo hacia arriba al 0.05
}
const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Teléfono de El Salvador: 8 dígitos → 503XXXXXXXX
function normalizarTelefono(t: string): string | null {
  const d = String(t || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('503')) return d;
  if (d.length === 8) return '503' + d;
  return null;
}
const soloDigitos8 = (t: string) => String(t || '').replace(/\D/g, '').slice(-8);

function nuevaReferencia(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let sufijo = '';
  for (let i = 0; i < 6; i++) sufijo += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  return 'BAR-' + Date.now() + '-' + sufijo;
}

const MOTIVOS_CUPON: Record<string, string> = {
  no_existe: 'Ese código no existe',
  inactivo: 'Ese cupón ya no está activo',
  ya_usado: 'Ese cupón ya fue usado',
  vencido: 'Ese cupón ya venció',
  no_corresponde: 'Ese cupón es de otro cliente',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch (_e) { /* sin body */ }

  const accion = String(b.accion || 'crear').toLowerCase();
  const cotizar = accion === 'cotizar';

  // ---------------------------------------------------------------- 1) DATOS
  const itemsEntrada = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  const cli = (b.cliente ?? {}) as Record<string, unknown>;
  const ent = (b.entrega ?? {}) as Record<string, unknown>;
  const fac = (b.factura ?? {}) as Record<string, unknown>;

  if (!itemsEntrada.length) return json({ ok: false, error: 'El pedido no tiene productos' }, 400);
  if (itemsEntrada.length > MAX_ITEMS) return json({ ok: false, error: 'Demasiados productos en un solo pedido' }, 400);

  const nombre = String(cli.nombre || '').trim();
  if (nombre.length < 2) return json({ ok: false, error: 'Falta el nombre' }, 400);

  const telefono = normalizarTelefono(String(cli.telefono || ''));
  if (!telefono) return json({ ok: false, error: 'Necesitamos un teléfono de contacto válido (8 dígitos)' }, 400);

  const usaWhatsapp = cli.usa_whatsapp === undefined ? true : !!cli.usa_whatsapp;
  const correo = String(cli.correo || '').trim();
  if (!usaWhatsapp && !correo) return json({ ok: false, error: 'Como no usás WhatsApp, necesitamos tu correo electrónico' }, 400);
  if (correo && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(correo)) return json({ ok: false, error: 'El correo no parece válido' }, 400);

  // Token del carrito de la clienta: sirve para reconocer SU reserva de 5 minutos como propia
  const tokenCarrito = String(b.token || '').trim();

  const tipoEntrega = String(ent.tipo || 'retiro-punto');
  if (!['retiro-punto', 'retiro-c807'].includes(tipoEntrega)) return json({ ok: false, error: 'Forma de entrega no válida' }, 400);
  const punto = String(ent.punto || (tipoEntrega === 'retiro-c807' ? 'Agencia C807' : 'Punto BARATUSS')).trim();

  const metodo = String(b.metodo || 'efectivo').toLowerCase();
  if (metodo !== 'efectivo') return json({ ok: false, error: 'Por acá solo se crean pedidos en efectivo (la tarjeta tiene su propio camino)' }, 400);
  // C807 es SOLO con tarjeta (regla de la tienda)
  if (tipoEntrega === 'retiro-c807') return json({ ok: false, error: 'El retiro en C807 es solo con pago por tarjeta' }, 400);

  const tipoFactura = String(fac.tipo || 'ninguna').toLowerCase();
  if (!['ninguna', 'consumidor', 'ccf'].includes(tipoFactura)) return json({ ok: false, error: 'Tipo de comprobante no válido' }, 400);
  if (tipoFactura === 'ccf') {
    for (const campo of ['nombre', 'nit', 'nrc', 'giro', 'direccion']) {
      if (!String(fac[campo] || '').trim()) return json({ ok: false, error: 'Para el comprobante de crédito fiscal faltan datos (' + campo + ')' }, 400);
    }
  }

  // ------------------------------------------------- 2) PRECIOS REALES + STOCK
  const ids = [...new Set(itemsEntrada.map((i) => Number(i.id)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return json({ ok: false, error: 'Los productos no son válidos' }, 400);

  const { data: prods, error: errProds } = await supabase
    .from('inventory')
    .select('id, name, sale_price, stock, active, condition, sizes, reservado_hasta, reservado_token')
    .in('id', ids);
  if (errProds) return json({ ok: false, error: 'No pudimos consultar los productos' }, 500);

  const mapa = new Map<number, Record<string, unknown>>();
  for (const p of (prods ?? [])) mapa.set(Number(p.id), p as Record<string, unknown>);

  const items: Record<string, unknown>[] = [];
  const paraVender: { id: number; qty: number }[] = [];
  let subtotal = 0;

  for (const it of itemsEntrada) {
    const id = Number(it.id);
    const cant = Math.floor(Number(it.qty ?? 1));
    if (!Number.isFinite(id) || id <= 0) return json({ ok: false, error: 'Producto no válido' }, 400);
    if (!Number.isFinite(cant) || cant < 1) return json({ ok: false, error: 'Cantidad no válida' }, 400);
    if (cant > MAX_POR_ITEM) return json({ ok: false, error: 'Máximo ' + MAX_POR_ITEM + ' unidades por producto' }, 400);

    const p = mapa.get(id);
    if (!p) return json({ ok: false, error: 'Un producto ya no está disponible', motivo: 'no_existe', producto: id }, 409);
    if (p.active === false) return json({ ok: false, error: 'Un producto ya no está a la venta', motivo: 'no_existe', producto: id }, 409);
    if (Number(p.stock || 0) < cant) {
      return json({ ok: false, error: 'Se agotó: ' + String(p.name || 'un producto'), motivo: 'sin_stock', producto: id }, 409);
    }
    const reservadoHasta = p.reservado_hasta ? new Date(String(p.reservado_hasta)).getTime() : 0;
    const reservaActiva = reservadoHasta > Date.now() && String(p.reservado_token || '') !== '';
    // Se rechaza SOLO si la reserva es de otra persona (la propia se respeta ✅)
    if (reservaActiva && String(p.reservado_token) !== tokenCarrito) {
      return json({ ok: false, error: 'Alguien está comprando: ' + String(p.name || 'un producto') + '. Probá en unos minutos 🙏', motivo: 'reservada_por_otro', producto: id }, 409);
    }

    const talla = it.talla ?? it.size ?? null;
    const precio = precioFinal(Number(p.sale_price || 0));
    if (precio <= 0) return json({ ok: false, error: 'Un producto no tiene precio válido', motivo: 'sin_precio', producto: id }, 409);

    subtotal += precio * cant;
    items.push({
      id,
      qty: cant,
      name: String(p.name || 'Producto'),
      price: precio,
      ...(talla ? { size: String(talla) } : {}),
      ...(p.condition ? { condition: String(p.condition) } : {}),
    });
    paraVender.push({ id, qty: cant });
  }
  subtotal = money(subtotal);

  // ---------------------------------------------------------------- 3) CUPÓN
  let descuento = 0;
  let cuponCodigo: string | null = null;
  const cuponPedido = String(b.cupon || (b.cupon_codigo ?? '') || '').trim();
  if (cuponPedido) {
    const { data: vc, error: errCupon } = await supabase.rpc('validar_cupon', {
      p_codigo: cuponPedido,
      p_telefono: telefono,
      p_subtotal: subtotal,
    });
    if (errCupon) return json({ ok: false, error: 'No pudimos validar el cupón' }, 500);
    const r = vc as Record<string, unknown> | null;
    if (!r || r.ok === false) {
      return json({
        ok: false,
        error: MOTIVOS_CUPON[String(r?.motivo || '')] || 'Ese cupón no es válido',
        motivo: r?.motivo ?? 'invalido',
      }, 409);
    }
    descuento = money(Number(r.descuento || 0));
    cuponCodigo = String(r.codigo || cuponPedido).toUpperCase();
    if (descuento > subtotal) descuento = subtotal;   // nunca menos que $0
  }

  // ---------------------------------------------------------------- 4) ENVÍO
  // Puntos de BARATUSS = gratis · C807 = $1.00 (solo tarjeta, ya bloqueado arriba)
  const envio = 0;

  // ---------------------------------------------------------------- 5) TOTAL
  const total = money(Math.max(0, subtotal + envio - descuento));
  if (total <= 0) return json({ ok: false, error: 'El total del pedido no puede ser $0' }, 400);

  const desglose = {
    items: items.map((i) => ({ id: i.id, nombre: i.name, talla: i.size ?? null, qty: i.qty, precio: i.price })),
    subtotal,
    envio,
    descuento,
    cupon_codigo: cuponCodigo,
    total,
    telefono,
  };

  // Si solo querían cotizar (mostrar el desglose), no se crea nada
  if (cotizar) return json({ ok: true, cotizacion: true, ...desglose });

  // ------------------------------------------------------------ 6) REFERENCIA
  const referencia = nuevaReferencia();

  // ------------------------------------------------------------ 7) PEDIDO
  const pedido: Record<string, unknown> = {
    reference: referencia,
    items,
    total,
    status: 'pendiente',
    payment_status: 'efectivo',
    payment_method: 'efectivo',
    delivery_type: tipoEntrega,
    delivery_fee: envio,
    delivery_point: punto,
    customer_name: nombre,
    customer_phone: telefono,
    telefono_normalizado: telefono,
    contacto_preferido: usaWhatsapp ? 'whatsapp' : 'correo',
    cupon_codigo: cuponCodigo,
    cupon_descuento: descuento > 0 ? descuento : null,
    factura_tipo: tipoFactura,
    factura_por_correo: !!fac.por_correo,
  };
  if (correo) pedido.customer_email = correo;
  if (tipoFactura === 'ccf' || tipoFactura === 'consumidor') {
    pedido.factura_nombre  = String(fac.nombre || nombre);
    pedido.factura_nit     = fac.nit ? String(fac.nit) : null;
    pedido.factura_nrc     = fac.nrc ? String(fac.nrc) : null;
    pedido.factura_giro    = fac.giro ? String(fac.giro) : null;
    pedido.factura_direccion = fac.direccion ? String(fac.direccion) : null;
  }
  if (b.user_id) pedido.user_id = String(b.user_id);

  const { error: errIns } = await supabase.from('orders').insert(pedido);
  if (errIns) return json({ ok: false, error: 'No pudimos guardar el pedido: ' + errIns.message }, 500);

  // ------------------------------------------------- 8) APARTAR EL STOCK
  // Descuenta el stock de una sola vez (todo o nada). Si algo falla, se borra el pedido.
  // Usamos el token del carrito (o la referencia si no vino): así vender_carrito reconoce
  // la reserva de 5 minutos que la propia clienta hizo como suya.
  const { data: venta, error: errVenta } = await supabase.rpc('vender_carrito', {
    p_items: paraVender,
    p_token: tokenCarrito || referencia,
  });
  const v = venta as Record<string, unknown> | null;
  if (errVenta || !v || v.ok === false) {
    await supabase.from('orders').delete().eq('reference', referencia);
    const motivo = String(v?.motivo || (errVenta ? errVenta.message : ''));
    const idFallo = Number(v?.producto || 0);
    const nombreFallo = idFallo ? String(mapa.get(idFallo)?.name || 'un producto') : 'un producto';
    if (motivo === 'sin_stock') return json({ ok: false, error: 'Se agotó: ' + nombreFallo, motivo: 'sin_stock', producto: idFallo }, 409);
    if (motivo === 'reservada_por_otro') return json({ ok: false, error: 'Alguien está comprando: ' + nombreFallo, motivo: 'reservada_por_otro', producto: idFallo }, 409);
    return json({ ok: false, error: 'No pudimos apartar el producto', motivo: motivo || 'error_stock' }, 409);
  }

  // -------------------------------------------- 9) MARCAR EL CUPÓN COMO USADO
  // Se hace acá (servidor) para que nadie pueda reutilizar el mismo cupón.
  if (cuponCodigo) {
    const { data: uso, error: errUso } = await supabase.rpc('usar_cupon', {
      p_codigo: cuponCodigo,
      p_reference: referencia,
    });
    const u = uso as Record<string, unknown> | null;
    if (errUso || !u || u.ok === false) {
      // No se pudo marcar el cupón: devolvemos todo (stock + pedido) para no dejar un descuento sin respaldo
      for (const it of paraVender) {
        await supabase.rpc('devolver_stock', { p_id: it.id, p_qty: it.qty });
      }
      await supabase.from('orders').delete().eq('reference', referencia);
      return json({ ok: false, error: 'No pudimos aplicar el cupón. Probá de nuevo 🙏', motivo: 'cupon_no_aplicado' }, 409);
    }
  }

  // Aviso interno (Telegram) — opcional, silencioso si no está configurado
  try {
    const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
    const TG_CHAT  = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
    if (TG_TOKEN && TG_CHAT) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT,
          parse_mode: 'Markdown',
          text: `🛒 *Pedido en efectivo creado por el servidor*\n📦 ${referencia}\n👤 ${nombre} · ${telefono}\n`
            + `🧮 Total calculado: $${total.toFixed(2)}` + (descuento > 0 ? ` (cupón −$${descuento.toFixed(2)})` : ''),
        }),
      });
    }
  } catch (_e) { /* silencio */ }

  return json({
    ok: true,
    reference: referencia,
    ...desglose,
    stock_apartado: true,
  });
});
