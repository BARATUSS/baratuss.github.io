// ============================================================
// BARATUSS · FINANZAS — lógica del módulo (fetch a finanzas-api)
// Reutiliza la sesión de admin (baratuss_admin_session) y el
// mismo look de admin.html. Solo administradores.
// ============================================================

const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const ANON_KEY = 'sb_publishable_m85uJKNu8Izi5ujT8ukWWQ_XvEMOToA';
const FIN_URL = SUPABASE_URL + '/functions/v1/finanzas-api';

const $ = id => document.getElementById(id);

// ===== STATE =====
let session = JSON.parse(localStorage.getItem('baratuss_admin_session') || 'null');

// ===== HELPERS =====
function money(v) {
    const n = Number(v || 0);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money0(v) {
    const n = Number(v || 0);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v) {
    const n = Number(v || 0);
    return (n * 100).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%';
}
function hoy() {
    const d = new Date();
    const off = d.getTimezoneOffset() * 60000;
    const local = new Date(d.getTime() - off);
    return local.toISOString().slice(0, 10);
}
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(msg) {
    try {
        let t = $('fin-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'fin-toast';
            t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1a1a1a;color:#fff;padding:12px 20px;border-radius:12px;font-size:.85rem;z-index:9999;box-shadow:0 8px 30px rgba(0,0,0,.25);max-width:360px;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.display = 'block';
        clearTimeout(t._tm);
        t._tm = setTimeout(() => { t.style.display = 'none'; }, 4000);
    } catch (e) { }
}

// ===== API a finanzas-api =====
async function finApi(accion, body) {
    const headers = { 'apikey': ANON_KEY, 'Content-Type': 'application/json' };
    if (session && session.token) headers['Authorization'] = 'Bearer ' + session.token;
    const r = await fetch(FIN_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(Object.assign({ accion }, body || {}))
    });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok || !data || data.ok === false) {
        const msg = (data && (data.error || data.message)) || ('HTTP ' + r.status);
        throw new Error(msg);
    }
    return data;
}

// ===== TARJETAS =====
function card(label, value, sub, accent) {
    return '<div class="fin-card' + (accent ? ' fin-card--accent' : '') + '">'
        + '<div class="fin-card__label">' + esc(label) + '</div>'
        + '<div class="fin-card__value">' + value + '</div>'
        + (sub ? '<div class="fin-card__sub">' + esc(sub) + '</div>' : '')
        + '</div>';
}

// ===== LOGIN (reusa la sesión de admin) =====
async function entrarConSesion(token, user) {
    const profResp = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=is_admin,name,email&id=eq.' + user.id, {
        headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token }
    });
    const profiles = await profResp.json();
    const profile = profiles && profiles[0];
    if (!profile || !profile.is_admin) {
        $('fin-login-error').textContent = '❌ Esta cuenta no tiene permisos de administradora';
        return false;
    }
    session = { token, user, profile };
    localStorage.setItem('baratuss_admin_session', JSON.stringify(session));
    enterDashboard();
    return true;
}

async function pedirCodigo() {
    const email = ($('fin-email').value || '').trim();
    if (!email) { $('fin-login-error').textContent = '✍️ Escribí tu correo arriba primero'; return; }
    $('fin-login-error').textContent = '';
    $('fin-otp-box').style.display = '';
    $('fin-otp-aviso').textContent = '⏳ Mandando el código a ' + email + '...';
    try {
        const r = await fetch(SUPABASE_URL + '/auth/v1/otp', {
            method: 'POST',
            headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, create_user: false, options: { email_redirect_to: 'https://baratuss.github.io/finanzas.html' } })
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            $('fin-otp-aviso').textContent = '❌ ' + (d.msg || d.error_description || 'No se pudo mandar el código');
            return;
        }
        $('fin-otp-aviso').textContent = '📬 ¡Listo! Revisá ' + email + ' y escribí el código en el cuadrito de arriba ✅';
        try { $('fin-otp-code').focus(); } catch (e) { }
    } catch (e) {
        $('fin-otp-aviso').textContent = '❌ ' + e.message;
    }
}

async function verificarCodigo() {
    const email = ($('fin-email').value || '').trim();
    const code = ($('fin-otp-code').value || '').trim();
    if (!code) { $('fin-otp-aviso').textContent = '✍️ Escribí el código que te llegó al correo'; return; }
    $('fin-otp-aviso').textContent = '⏳ Entrando...';
    try {
        const r = await fetch(SUPABASE_URL + '/auth/v1/verify', {
            method: 'POST',
            headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'email', email: email, token: code })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.access_token) {
            $('fin-otp-aviso').textContent = '❌ ' + (d.msg || d.error_description || 'Código incorrecto o vencido');
            return;
        }
        const ok = await entrarConSesion(d.access_token, d.user);
        if (ok) $('fin-otp-aviso').textContent = '';
    } catch (e) {
        $('fin-otp-aviso').textContent = '❌ ' + e.message;
    }
}

// ===== CHECK SESSION =====
async function checkSession() {
    if (!session || !session.token) return;
    try {
        const ur = await fetch(SUPABASE_URL + '/auth/v1/user', {
            headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + session.token }
        });
        if (!ur.ok) throw new Error('sesion_invalida');
        const user = await ur.json();
        const profResp = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=is_admin,name,email&id=eq.' + user.id, {
            headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + session.token }
        });
        const profiles = await profResp.json();
        const profile = profiles && profiles[0];
        if (!profile || !profile.is_admin) throw new Error('no_admin');
        session = { token: session.token, user, profile };
        localStorage.setItem('baratuss_admin_session', JSON.stringify(session));
        enterDashboard();
    } catch (e) {
        session = null;
        localStorage.removeItem('baratuss_admin_session');
        $('fin-login').style.display = '';
        $('fin-dashboard').style.display = 'none';
    }
}

// ===== ENTER DASHBOARD =====
function enterDashboard() {
    $('fin-login').style.display = 'none';
    $('fin-dashboard').style.display = 'flex';
    $('fin-user-name').textContent = session?.profile?.name || 'Admin';
    loadResumen();
    irASeccion('dinero');
    // refrescar el bloque de revisión cada 60s
    setInterval(loadResumen, 60000);
}

// ===== NAVEGACIÓN =====
function irASeccion(nombre) {
    document.querySelectorAll('.admin-nav__item').forEach(i => {
        i.classList.toggle('active', i.dataset.section === nombre);
    });
    document.querySelectorAll('.admin-section').forEach(s => { s.style.display = 'none'; });
    const sec = $('section-' + nombre);
    if (sec) sec.style.display = '';

    if (nombre === 'dinero') loadResumen();
    if (nombre === 'ventas') loadVentas();
    if (nombre === 'inventario') loadInventario();
    if (nombre === 'gastos') loadGastos();
    if (nombre === 'negocio') loadNegocio();
    if (nombre === 'hacienda') loadHacienda();
    if (nombre === 'config') loadConfig();
}

// ===== ALERTAS =====
function seccionDeAlerta(texto) {
    const t = String(texto || '').toLowerCase();
    if (t.includes('compra')) return 'gastos';
    if (t.includes('gasto')) return 'gastos';
    return 'ventas';
}

function renderAlertas(data) {
    const block = $('fin-alertas-block');
    const list = $('fin-alertas-list');
    if (!data || !data.ok) return;
    const alertas = data.alertas || [];
    const nivel = data.nivel_global || (alertas.length ? 'amarillo' : 'verde');

    let html = '';
    if (nivel === 'verde') {
        html = '<div class="fin-alerta fin-alerta--verde"><span class="fin-alerta__icon">🟢</span>'
            + '<span class="fin-alerta__texto">Todo actualizado — no hay movimientos pendientes de revisar</span></div>';
    } else {
        html = '<div class="fin-alerta fin-alerta--' + (nivel === 'rojo' ? 'rojo' : 'amarillo') + '">'
            + '<span class="fin-alerta__icon">' + (nivel === 'rojo' ? '🔴' : '🟡') + '</span>'
            + '<span class="fin-alerta__texto"><strong>' + alertas.length + '</strong> movimiento' + (alertas.length === 1 ? '' : 's') + ' por revisar</span></div>';
        for (const a of alertas) {
            const ico = a.nivel === 'rojo' ? '🔴' : (a.nivel === 'amarillo' ? '🟡' : '🟢');
            html += '<div class="fin-alerta fin-alerta--' + (a.nivel === 'rojo' ? 'rojo' : (a.nivel === 'amarillo' ? 'amarillo' : 'verde')) + '">'
                + '<span class="fin-alerta__icon">' + ico + '</span>'
                + '<span class="fin-alerta__texto">' + esc(a.texto) + '</span>'
                + '<button class="fin-alerta__btn" data-seccion="' + esc(seccionDeAlerta(a.texto)) + '">Revisar</button></div>';
        }
    }
    list.innerHTML = html;
    block.style.display = '';
    list.querySelectorAll('.fin-alerta__btn').forEach(b => {
        b.addEventListener('click', () => irASeccion(b.dataset.seccion));
    });
}

// ===== DINERO =====
async function loadResumen() {
    try {
        const d = await finApi('resumen');
        renderAlertas(d);
        const tot = d.totales || {};
        $('dinero-cards').innerHTML =
            card('💵 Efectivo', money(d.dinero.efectivo), 'cobrado en efectivo', true)
            + card('💳 Tarjeta', money(d.dinero.tarjeta), 'cobrado con tarjeta')
            + card('💰 Total vendido', money(d.dinero.total), 'total bruto de todas las ventas')
            + card('✨ Utilidad', money(tot.utilidad), 'lo que te queda a vos', true);
        $('dinero-cards2').innerHTML =
            card('🧾 Venta neta', money(tot.venta_neta), 'sin IVA')
            + card('📦 Costo productos', money(tot.costo_productos), '')
            + card('🏷️ IVA cobrado', money(tot.iva), '')
            + card('🔢 Ventas', String(tot.conteo || 0), 'registradas');
    } catch (e) {
        $('dinero-cards').innerHTML = '<div class="fin-empty">❌ ' + esc(e.message) + '</div>';
    }
}

// ===== VENTAS =====
async function loadVentas() {
    try {
        const d = await finApi('ventas');
        const tot = d.totales || {};
        $('ventas-cards').innerHTML =
            card('💰 Total vendido', money(tot.total), '')
            + card('💵 Efectivo', money(tot.efectivo), '')
            + card('💳 Tarjeta', money(tot.tarjeta), '')
            + card('🧾 Ticket promedio', money(tot.ticket_promedio), 'por venta')
            + card('✨ Utilidad', money(tot.utilidad), '')
            + card('📦 Costo', money(tot.costo_productos), '')
            + card('🏷️ IVA', money(tot.iva), '')
            + card('💸 Comisión', money(tot.comision), 'Wompi');

        const ventas = d.ventas || [];
        if (!ventas.length) {
            $('ventas-list').innerHTML = '<div class="fin-empty">Todavía no hay ventas registradas</div>';
            return;
        }
        $('ventas-list').innerHTML = ventas.map(v => {
            const pill = (v.metodo_pago || '').toLowerCase() === 'tarjeta'
                ? '<span class="fin-pill fin-pill--tarjeta">Tarjeta</span>'
                : '<span class="fin-pill fin-pill--efectivo">Efectivo</span>';
            const nItems = Array.isArray(v.items) ? v.items.reduce((s, it) => s + (Number(it.qty) || 1), 0) : 0;
            return '<div class="fin-item">'
                + '<div class="fin-item__main">'
                + '<div class="fin-item__title">' + esc(v.cliente || '—') + '</div>'
                + '<div class="fin-item__meta">' + esc(v.order_reference || '') + ' · ' + esc(v.fecha_entrega || '') + ' · ' + nItems + ' art.' + '</div>'
                + '</div>'
                + pill
                + '<div class="fin-item__money">' + money(v.total_bruto) + '<small>utilidad ' + money(v.utilidad_neta) + '</small></div>'
                + '</div>';
        }).join('');
    } catch (e) {
        $('ventas-list').innerHTML = '<div class="fin-empty">❌ ' + esc(e.message) + '</div>';
    }
}

// ===== INVENTARIO =====
async function loadInventario() {
    try {
        const d = await finApi('inventario');
        const tot = d.totales || {};
        $('inventario-cards').innerHTML =
            card('📦 Valor a costo', money(tot.valor_costo), 'suma costo × stock')
            + card('🏷️ Valor a venta', money(tot.valor_venta), 'suma precio × stock')
            + card('📈 Margen potencial', pct(tot.margen), 'sobre el valor de venta', true)
            + card('🔢 Unidades', String(tot.unidades || 0), tot.productos_activos + ' productos activos');

        const sin = d.sin_movimiento || [];
        $('inventario-sin-movimiento').innerHTML = sin.length
            ? sin.map(p => itemProducto(p)).join('')
            : '<div class="fin-empty">Todos los productos con stock ya se vendieron al menos una vez 🎉</div>';

        const prod = d.productos || [];
        $('inventario-list').innerHTML = prod.length
            ? prod.map(p => itemProducto(p)).join('')
            : '<div class="fin-empty">Sin productos activos</div>';
    } catch (e) {
        $('inventario-list').innerHTML = '<div class="fin-empty">❌ ' + esc(e.message) + '</div>';
    }
}
function itemProducto(p) {
    return '<div class="fin-item">'
        + '<div class="fin-item__main">'
        + '<div class="fin-item__title">' + esc(p.name || '—') + '</div>'
        + '<div class="fin-item__meta">' + esc(p.sku || '') + (p.sku ? ' · ' : '') + esc(p.category || '') + '</div>'
        + '</div>'
        + '<span class="fin-pill fin-pill--muted">stock ' + (p.stock || 0) + '</span>'
        + '<div class="fin-item__money">' + money(p.sale_price) + '<small>costo ' + money(p.cost_price) + '</small></div>'
        + '</div>';
}

// ===== GASTOS Y COMPRAS =====
async function loadGastos() {
    await loadCompras();
    await loadGastosLista();
}
async function loadCompras() {
    try {
        const d = await finApi('compras');
        const tot = d.totales || {};
        $('compras-cards').innerHTML =
            card('🛍️ Total compras', money(tot.total_compras), tot.conteo + ' compras');
        const compras = d.compras || [];
        $('compras-list').innerHTML = compras.length
            ? compras.map(c => '<div class="fin-item">'
                + '<div class="fin-item__main">'
                + '<div class="fin-item__title">' + esc(c.producto || '—') + '</div>'
                + '<div class="fin-item__meta">' + esc(c.proveedor || '') + (c.proveedor ? ' · ' : '') + esc(c.fecha || '') + (c.documento ? ' · doc. ' + esc(c.documento) : '') + '</div>'
                + '</div>'
                + '<div class="fin-item__money">' + money(c.costo_total) + '<small>' + (c.cantidad || 1) + ' × ' + money(c.costo_unitario) + '</small></div>'
                + '</div>').join('')
            : '<div class="fin-empty">Todavía no hay compras registradas</div>';
    } catch (e) {
        $('compras-list').innerHTML = '<div class="fin-empty">❌ ' + esc(e.message) + '</div>';
    }
}
async function loadGastosLista() {
    try {
        const d = await finApi('gastos');
        const tot = d.totales || {};
        $('gastos-cards').innerHTML =
            card('🧾 Total gastos', money(tot.total_gastos), tot.conteo + ' gastos');
        const gastos = d.gastos || [];
        $('gastos-list').innerHTML = gastos.length
            ? gastos.map(g => '<div class="fin-item">'
                + '<div class="fin-item__main">'
                + '<div class="fin-item__title">' + esc(g.descripcion || g.categoria || '—') + '</div>'
                + '<div class="fin-item__meta">' + esc(g.categoria || '') + (g.categoria ? ' · ' : '') + esc(g.fecha || '') + (g.documento ? ' · doc. ' + esc(g.documento) : '') + '</div>'
                + '</div>'
                + '<div class="fin-item__money">' + money(g.monto) + '<small>' + esc(g.metodo_pago || '') + '</small></div>'
                + '</div>').join('')
            : '<div class="fin-empty">Todavía no hay gastos registrados</div>';
    } catch (e) {
        $('gastos-list').innerHTML = '<div class="fin-empty">❌ ' + esc(e.message) + '</div>';
    }
}

async function crearCompra() {
    const aviso = $('compra-aviso');
    aviso.textContent = '';
    const body = {
        proveedor: $('compra-proveedor').value.trim(),
        producto: $('compra-producto').value.trim(),
        fecha: $('compra-fecha').value || null,
        cantidad: Number($('compra-cantidad').value) || 1,
        costo_total: Number($('compra-costo-total').value) || 0,
        metodo_pago: $('compra-metodo').value,
        documento: $('compra-documento').value.trim(),
        nota: $('compra-nota').value.trim()
    };
    if (!body.producto) { aviso.textContent = '⚠️ Escribí el nombre del producto'; return; }
    if (!body.costo_total || body.costo_total <= 0) { aviso.textContent = '⚠️ El costo total debe ser mayor a 0'; return; }
    try {
        const btn = $('btn-compra-crear'); btn.disabled = true; btn.textContent = 'Guardando...';
        await finApi('compra_crear', body);
        aviso.textContent = '✅ Compra registrada';
        ['compra-proveedor', 'compra-producto', 'compra-documento', 'compra-nota'].forEach(i => { const el = $(i); if (el) el.value = ''; });
        $('compra-costo-total').value = ''; $('compra-cantidad').value = '1';
        await loadCompras();
        await loadResumen();
        btn.disabled = false; btn.textContent = 'Registrar compra';
    } catch (e) {
        const btn = $('btn-compra-crear'); btn.disabled = false; btn.textContent = 'Registrar compra';
        aviso.textContent = '❌ ' + e.message;
    }
}

async function crearGasto() {
    const aviso = $('gasto-aviso');
    aviso.textContent = '';
    const body = {
        categoria: $('gasto-categoria').value,
        descripcion: $('gasto-descripcion').value.trim(),
        fecha: $('gasto-fecha').value || null,
        monto: Number($('gasto-monto').value) || 0,
        metodo_pago: $('gasto-metodo').value,
        documento: $('gasto-documento').value.trim()
    };
    if (!body.monto || body.monto <= 0) { aviso.textContent = '⚠️ El monto debe ser mayor a 0'; return; }
    try {
        const btn = $('btn-gasto-crear'); btn.disabled = true; btn.textContent = 'Guardando...';
        await finApi('gasto_crear', body);
        aviso.textContent = '✅ Gasto registrado';
        ['gasto-descripcion', 'gasto-documento'].forEach(i => { const el = $(i); if (el) el.value = ''; });
        $('gasto-monto').value = ''; $('gasto-categoria').value = '';
        await loadGastosLista();
        await loadResumen();
        btn.disabled = false; btn.textContent = 'Registrar gasto';
    } catch (e) {
        const btn = $('btn-gasto-crear'); btn.disabled = false; btn.textContent = 'Registrar gasto';
        aviso.textContent = '❌ ' + e.message;
    }
}

// ===== MI NEGOCIO =====
async function loadNegocio() {
    try {
        const d = await finApi('negocio');
        const r = d.resultado || {};
        const pe = d.punto_equilibrio || {};
        $('negocio-cards').innerHTML =
            card('✨ Resultado del mes', money(r.resultado_mes), esc('venta neta − costo − comisión − gastos'), true)
            + card('🧾 Venta neta del mes', money(r.venta_neta), r.ventas_mes + ' ventas')
            + card('📦 Costo productos', money(r.costo_productos), '')
            + card('💸 Gastos del mes', money(r.gastos_mes), '')
            + card('💳 Comisión', money(r.comision), '');
        $('negocio-cards2').innerHTML =
            card('📈 Margen de contribución', pct(r.margen_contribucion), 'de cada venta neta')
            + card('⚖️ Punto de equilibrio', pe.ingreso_necesario != null ? money(pe.ingreso_necesario) : '—', pe.gastos_fijos != null ? 'gastos fijos ' + money(pe.gastos_fijos) : '')
            + card('🛍️ Ventas para el equilibrio', pe.ventas_necesarias != null ? String(pe.ventas_necesarias) : '—', 'al mes, aprox.');

        const top = d.top_productos || [];
        $('negocio-top').innerHTML = top.length
            ? top.map(t => '<div class="fin-item">'
                + '<div class="fin-item__main"><div class="fin-item__title">' + esc(t.name) + '</div>'
                + '<div class="fin-item__meta">' + t.qty + ' vendido' + (t.qty === 1 ? '' : 's') + '</div></div>'
                + '<div class="fin-item__money">' + money(t.ingresos) + '</div></div>').join('')
            : '<div class="fin-empty">Todavía no hay productos vendidos</div>';

        const ev = d.evolucion_mensual || [];
        $('negocio-evolucion').innerHTML = ev.length
            ? ev.map(m => '<tr><td>' + esc(m.mes) + '</td><td class="num">' + m.ventas + '</td><td class="num">' + money(m.venta_neta) + '</td><td class="num">' + money(m.utilidad) + '</td></tr>').join('')
            : '<tr><td colspan="4" class="fin-empty">Sin datos</td></tr>';
    } catch (e) {
        $('negocio-cards').innerHTML = '<div class="fin-empty">❌ ' + esc(e.message) + '</div>';
    }
}

// ===== HACIENDA =====
async function loadHacienda() {
    try {
        const d = await finApi('hacienda');
        $('hacienda-cards').innerHTML =
            card('🏷️ IVA cobrado', money(d.iva_cobrado), pct(d.iva_tasa) + ' de IVA', true)
            + card('🧾 Ventas netas', money(d.ventas_netas), 'sin IVA')
            + card('🛍️ Compras', money(d.compras), '')
            + card('💸 Gastos', money(d.gastos), '');
        $('hacienda-aviso').textContent = '⚠️ ' + (d.aviso || '');
        const rs = d.resumen_por_mes || [];
        $('hacienda-tabla').innerHTML = rs.length
            ? rs.map(m => '<tr><td>' + esc(m.mes) + '</td><td class="num">' + money(m.venta_neta) + '</td><td class="num">' + money(m.iva) + '</td><td class="num">' + money(m.compras) + '</td><td class="num">' + money(m.gastos) + '</td></tr>').join('')
            : '<tr><td colspan="5" class="fin-empty">Sin datos</td></tr>';
    } catch (e) {
        $('hacienda-cards').innerHTML = '<div class="fin-empty">❌ ' + esc(e.message) + '</div>';
    }
}

// ===== CONFIGURACIÓN =====
const CONFIG_CAMPOS = [
    { clave: 'fin_iva', label: 'IVA (tasa, ej. 0.13)', hint: '13%' },
    { clave: 'fin_comision_wompi_pct', label: 'Comisión Wompi (%)', hint: '3.5%' },
    { clave: 'fin_comision_wompi_fija', label: 'Comisión Wompi fija ($)', hint: '$0.25' },
    { clave: 'fin_punto_equilibrio_mensual', label: 'Punto de equilibrio mensual ($)', hint: '$1,725' },
    { clave: 'fin_ganancia_objetivo', label: 'Ganancia objetivo (sobre costo)', hint: '1.0 = 100%' }
];

async function loadConfig() {
    try {
        const d = await finApi('config');
        const cfg = d.config || {};
        $('config-grid').innerHTML = CONFIG_CAMPOS.map(c => {
            const val = cfg[c.clave] != null ? cfg[c.clave] : '';
            return '<label>' + esc(c.label) + ' <small style="font-weight:400;color:var(--gray-400)">' + esc(c.hint) + '</small>'
                + '<input type="text" id="cfg-' + esc(c.clave) + '" value="' + esc(val) + '"></label>';
        }).join('');
    } catch (e) {
        $('config-grid').innerHTML = '<div class="fin-empty">❌ ' + esc(e.message) + '</div>';
    }
}

async function guardarConfig() {
    const aviso = $('config-aviso');
    aviso.textContent = '';
    const claves = {};
    for (const c of CONFIG_CAMPOS) {
        const el = $('cfg-' + c.clave);
        if (el) claves[c.clave] = el.value.trim();
    }
    try {
        const btn = $('btn-config-save'); btn.disabled = true; btn.textContent = 'Guardando...';
        await finApi('config_set', { claves });
        aviso.textContent = '✅ Guardado';
        await loadResumen();
        btn.disabled = false; btn.textContent = 'Guardar';
    } catch (e) {
        const btn = $('btn-config-save'); btn.disabled = false; btn.textContent = 'Guardar';
        aviso.textContent = '❌ ' + e.message;
    }
}

// ===== EVENTOS =====
function bindEvents() {
    $('fin-login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true; btn.textContent = 'Ingresando...';
        $('fin-login-error').textContent = '';
        try {
            const resp = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
                method: 'POST',
                headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: $('fin-email').value, password: $('fin-password').value })
            });
            const data = await resp.json();
            if (!resp.ok || !data.access_token) {
                $('fin-login-error').textContent = '❌ ' + (data.error_description || data.msg || 'Credenciales inválidas');
                btn.disabled = false; btn.textContent = 'Ingresar';
                return;
            }
            const ok = await entrarConSesion(data.access_token, data.user);
            if (!ok) { btn.disabled = false; btn.textContent = 'Ingresar'; }
        } catch (err) {
            $('fin-login-error').textContent = '❌ Error: ' + err.message;
            btn.disabled = false; btn.textContent = 'Ingresar';
        }
    });

    $('fin-otp-btn').addEventListener('click', pedirCodigo);
    $('fin-otp-verify').addEventListener('click', verificarCodigo);
    $('fin-otp-code').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); verificarCodigo(); } });

    $('fin-logout').addEventListener('click', () => {
        session = null;
        localStorage.removeItem('baratuss_admin_session');
        location.reload();
    });

    document.querySelectorAll('.admin-nav__item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            irASeccion(item.dataset.section);
        });
    });

    // subtabs compras/gastos
    $('tab-compras').addEventListener('click', () => {
        $('tab-compras').classList.add('active'); $('tab-gastos').classList.remove('active');
        $('panel-compras').style.display = ''; $('panel-gastos').style.display = 'none';
    });
    $('tab-gastos').addEventListener('click', () => {
        $('tab-gastos').classList.add('active'); $('tab-compras').classList.remove('active');
        $('panel-gastos').style.display = ''; $('panel-compras').style.display = 'none';
    });

    $('btn-compra-crear').addEventListener('click', crearCompra);
    $('btn-gasto-crear').addEventListener('click', crearGasto);
    $('btn-config-save').addEventListener('click', guardarConfig);

    // fechas por defecto
    $('compra-fecha').value = hoy();
    $('gasto-fecha').value = hoy();
}

window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) ? e.reason.message : String(e.reason || 'error');
    showToast('❌ No se pudo completar: ' + msg);
});

// Si el enlace del correo vuelve con los datos en la dirección, entra solo ✅
(async function entrarPorEnlace() {
    try {
        const h = window.location.hash || '';
        if (h.indexOf('access_token=') < 0) return;
        const p = new URLSearchParams(h.substring(1));
        const token = p.get('access_token');
        if (!token) return;
        const ur = await fetch(SUPABASE_URL + '/auth/v1/user', {
            headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token }
        });
        if (!ur.ok) return;
        const user = await ur.json();
        await entrarConSesion(token, user);
        history.replaceState(null, '', window.location.pathname);
    } catch (e) { }
})();

// ===== ARRANQUE =====
bindEvents();
checkSession();
