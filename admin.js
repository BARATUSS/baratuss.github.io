// ============================================================
// BARATUSS — Panel de Administración (versión fetch directo)
// ============================================================

const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const ANON_KEY = 'sb_publishable_m85uJKNu8Izi5ujT8ukWWQ_XvEMOToA';

const $ = id => document.getElementById(id);

// ===== STATE =====
let session = JSON.parse(localStorage.getItem('baratuss_admin_session') || 'null');
let inventory = [];
let orders = [];
let selectedIds = new Set();

// ===== API HELPERS (fetch directo, sin librería CDN) =====
// ⚠️ IMPORTANTE: antes esta función devolvía la respuesta SIN revisar si la operación
// había fallado → el panel mostraba "✅" aunque el guardado hubiera fallado (así quedó
// imposible marcar una entrega durante semanas). Ahora, si la base rechaza algo, LANZA
// el error con el motivo real para que se vea en pantalla.
async function api(method, path, body) {
    const headers = { 'apikey': ANON_KEY, 'Content-Type': 'application/json' };
    if (session?.token) headers['Authorization'] = 'Bearer ' + session.token;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
    if (r.status === 204) return null;
    const texto = await r.text();
    let data = null;
    try { data = texto ? JSON.parse(texto) : null; } catch (e) { data = null; }
    if (!r.ok) {
        const detalle = (data && (data.message || data.error || data.hint)) || texto || ('HTTP ' + r.status);
        const err = new Error(detalle);
        err.status = r.status;
        throw err;
    }
    return data;
}

// Cualquier error que se escape se muestra igual (nada de fallos silenciosos)
window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) ? e.reason.message : String(e.reason || 'error');
    if (typeof showToast === 'function') showToast('❌ No se pudo completar: ' + msg);
});

// ===== PRICING (misma fórmula que la tienda) =====
const PRICE_FACTOR = 1.16955;  // 1.13 × 1.035 (IVA 13% + comisión Wompi 3.50%)
const PRICE_FEE = 0.25;
function finalPrice(price) {
    if (!price) return 0;
    const raw = Number(price) * PRICE_FACTOR + PRICE_FEE;
    // Redondear al 0.05 más cercano hacia arriba: 7.52 → 7.55
    return Math.ceil(raw * 20) / 20;
}

// ══════════════════════════════════════════════════════════════════
// 🔑 ENTRAR CON UN CÓDIGO AL CORREO (23-sep-2026) — sin contraseñas ✅
// Cindy lo pidió para poder entrar con sus dos correos (el personal
// y el oficial del negocio). Sirve para cualquier cuenta ADMIN ✅
// ══════════════════════════════════════════════════════════════════
async function entrarConSesion(token, user) {
    const profResp = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=is_admin,name,email&id=eq.' + user.id, {
        headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token }
    });
    const profiles = await profResp.json();
    const profile = profiles && profiles[0];
    if (!profile || !profile.is_admin) {
        $('admin-login-error').textContent = '❌ Esta cuenta no tiene permisos de administradora';
        return false;
    }
    session = { token, user, profile };
    localStorage.setItem('baratuss_admin_session', JSON.stringify(session));
    enterDashboard();
    return true;
}

async function pedirCodigo() {
    const email = ($('admin-email').value || '').trim();
    if (!email) { $('admin-login-error').textContent = '✍️ Escribí tu correo arriba primero'; return; }
    $('admin-login-error').textContent = '';
    $('admin-otp-box').style.display = '';
    $('admin-otp-aviso').textContent = '⏳ Mandando el código a ' + email + '...';
    try {
        const r = await fetch(SUPABASE_URL + '/auth/v1/otp', {
            method: 'POST',
            headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: email, create_user: false,
                options: { email_redirect_to: 'https://baratuss.github.io/admin.html' }
            })
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            $('admin-otp-aviso').textContent = '❌ ' + (d.msg || d.error_description || 'No se pudo mandar el código');
            return;
        }
        $('admin-otp-aviso').textContent = '📬 ¡Listo! Revisá ' + email + ' y escribí el código en el cuadrito de arriba ✅';
        try { $('admin-otp-code').focus(); } catch (e) { }
    } catch (e) {
        $('admin-otp-aviso').textContent = '❌ ' + e.message;
    }
}

async function verificarCodigo() {
    const email = ($('admin-email').value || '').trim();
    const code = ($('admin-otp-code').value || '').trim();
    if (!code) { $('admin-otp-aviso').textContent = '✍️ Escribí el código que te llegó al correo'; return; }
    $('admin-otp-aviso').textContent = '⏳ Entrando...';
    try {
        const r = await fetch(SUPABASE_URL + '/auth/v1/verify', {
            method: 'POST',
            headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'email', email: email, token: code })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.access_token) {
            $('admin-otp-aviso').textContent = '❌ ' + (d.msg || d.error_description || 'Código incorrecto o vencido');
            return;
        }
        const ok = await entrarConSesion(d.access_token, d.user);
        if (ok) $('admin-otp-aviso').textContent = '';
    } catch (e) {
        $('admin-otp-aviso').textContent = '❌ ' + e.message;
    }
}

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

// Botones del ingreso con código ✅
try {
    const _b1 = $('admin-otp-btn'); if (_b1) _b1.addEventListener('click', pedirCodigo);
    const _b2 = $('admin-otp-verify'); if (_b2) _b2.addEventListener('click', verificarCodigo);
    const _c1 = $('admin-otp-code');
    if (_c1) _c1.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); verificarCodigo(); } });
} catch (e) { }

// ===== LOGIN FORM =====
$('admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Ingresando...';
    $('admin-login-error').textContent = '';

    try {
        // 1. Login directo
        const resp = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
            method: 'POST',
            headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: $('admin-email').value, password: $('admin-password').value })
        });
        const data = await resp.json();

        if (!resp.ok || !data.access_token) {
            $('admin-login-error').textContent = '❌ ' + (data.error_description || data.msg || 'Credenciales inválidas');
            btn.disabled = false; btn.textContent = 'Ingresar';
            return;
        }

        // 2. Verificar admin
        const token = data.access_token;
        const user = data.user;
        const profResp = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=is_admin,name,email&id=eq.' + user.id, {
            headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + token }
        });
        const profiles = await profResp.json();
        const profile = profiles?.[0];

        if (!profile || !profile.is_admin) {
            $('admin-login-error').textContent = '❌ Esta cuenta no tiene permisos de administradora';
            btn.disabled = false; btn.textContent = 'Ingresar';
            return;
        }

        // 3. Guardar sesión y entrar
        session = { token, user, profile };
        localStorage.setItem('baratuss_admin_session', JSON.stringify(session));
        enterDashboard();
    } catch (err) {
        console.error('Login error:', err);
        $('admin-login-error').textContent = '❌ Error: ' + err.message;
        btn.disabled = false; btn.textContent = 'Ingresar';
    }
});

// ===== ENTER DASHBOARD =====
function enterDashboard() {
    $('admin-login').style.display = 'none';
    $('admin-dashboard').style.display = 'flex';
    $('admin-user-name').textContent = session?.profile?.name || 'Admin';
    loadInventory();
    loadOrders();
    loadStats();
    // Cargar salidas en background (para badge de notificación) sin cambiar de sección
    loadSalidasSilencioso();
    // Badge de mensajes de WhatsApp sin leer
    cargarBadgeWaSilencioso();
    cargarBadgeContingencias();
    // Verificar nuevos pedidos cada 45 segundos → notificación en menú
    setInterval(loadSalidasSilencioso, 45000);
    setInterval(cargarBadgeWaSilencioso, 45000);
    setInterval(cargarBadgeContingencias, 60000);
}
async function loadSalidasSilencioso() {
    try {
        // Si estoy viendo una sección que usa despachos completos, recargar completo
        const visible = document.querySelector('.admin-section:not([style*="none"])');
        const sec = visible ? visible.id : '';
        if (sec === 'section-salidas') { await loadSalidas(); return; }
        if (sec === 'section-despachos') { await loadDespachos(); return; }
        if (sec === 'section-preparar') {
            // Si Cindy está seleccionando artículos, NO refrescar (le borraba los check)
            if (prepSelected.size > 0) return;
            await loadPreparar();
            return;
        }
        // En otra sección: solo consulta ligera para el badge
        const data = await api('GET', 'despachos?select=id,order_reference,destino,estado_logistico,visto&limit=300');
        if (Array.isArray(data)) {
            despachos = data;
            actualizarBadgeSalidas();
        }
    } catch (e) {}
}

// ===== LOGOUT =====
$('admin-logout').addEventListener('click', () => {
    session = null;
    localStorage.removeItem('baratuss_admin_session');
    location.reload();
});

// ===== NAV =====
document.querySelectorAll('.admin-nav__item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.admin-nav__item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        document.querySelectorAll('.admin-section').forEach(s => s.style.display = 'none');
        $('section-' + item.dataset.section).style.display = '';
        if (item.dataset.section === 'pedidos') loadOrders();
        if (item.dataset.section === 'despachos') loadDespachos();
        if (item.dataset.section === 'salidas') loadSalidas();
        if (item.dataset.section === 'preparar') loadPreparar();
        if (item.dataset.section === 'whatsapp') loadWhatsApp();
        if (item.dataset.section === 'contingencias') loadContingencias();
        if (item.dataset.section === 'resumen') loadStats();
        if (item.dataset.section === 'agenda') cargarAgenda();
    });
});

// ══════════════════════════════════════════════════════════════════
// 📇 AGENDA DE CLIENTAS (23-sep-2026 · Etapa 1)
// Arma una ficha por clienta juntando lo que YA estaba guardado:
//   · tabla "ventas"  → las compras reales (total, utilidad, punto, pago)
//   · tabla "orders"  → el detalle de cada pedido (qué se llevó)
// NO se creó nada nuevo en la base de datos ✅
// ══════════════════════════════════════════════════════════════════
let agendaClientas = [];
let agendaPedidos = {};

function agMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }
function agEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function agTel8(t) {
    const d = String(t || '').replace(/\D/g, '');
    return d.length > 8 ? d.slice(-8) : d;
}
function agFecha(iso) {
    if (!iso) return '—';
    const M = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const f = new Date(iso);
    if (isNaN(f)) return '—';
    return f.getDate() + '-' + M[f.getMonth()] + '-' + f.getFullYear();
}

async function cargarAgenda() {
    const tbody = $('agenda-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;padding:22px;">Cargando…</td></tr>';
    try {
        const res = await Promise.all([
            api('GET', 'ventas?select=order_reference,cliente,telefono,punto_entrega,metodo_pago,total_bruto,utilidad_neta,fecha_compra&order=fecha_compra.desc&limit=3000'),
            api('GET', 'orders?select=reference,customer_name,customer_phone,customer_city,delivery_point,payment_method,total,status,payment_status,created_at,items,como_nos_conocio,conocio_detalle&order=created_at.desc&limit=3000'),
            api('GET', 'profiles?select=id,name,email,phone,codigo_referido')
        ]);
        const ventas = Array.isArray(res[0]) ? res[0] : [];
        const pedidos = Array.isArray(res[1]) ? res[1] : [];
        const cuentas = Array.isArray(res[2]) ? res[2] : [];
        // 🎁 El código de referido sale de la CUENTA de la clienta (solo tienen cuenta ✅)
        const codigos = {};
        cuentas.forEach(c => {
            const t8 = agTel8(c.phone);
            if (t8 && c.codigo_referido) codigos[t8] = c.codigo_referido;
            if (c.email && c.codigo_referido) codigos[String(c.email).toLowerCase()] = c.codigo_referido;
        });

        agendaPedidos = {};
        pedidos.forEach(p => { agendaPedidos[p.reference] = p; });

        const mapa = {};
        ventas.forEach(v => {
            const t8 = agTel8(v.telefono);
            if (!t8) return;
            if (!mapa[t8]) {
                mapa[t8] = { tel8: t8, nombre: v.cliente || 'Clienta', compras: 0, total: 0,
                             puntos: {}, metodos: {}, ultima: null, refs: [] };
            }
            const c = mapa[t8];
            c.compras += 1;
            c.total += Number(v.total_bruto) || 0;
            if (v.punto_entrega) c.puntos[v.punto_entrega] = (c.puntos[v.punto_entrega] || 0) + 1;
            if (v.metodo_pago) c.metodos[v.metodo_pago] = (c.metodos[v.metodo_pago] || 0) + 1;
            if (v.fecha_compra && (!c.ultima || new Date(v.fecha_compra) > new Date(c.ultima))) c.ultima = v.fecha_compra;
            if (v.order_reference) c.refs.push(v.order_reference);
        });

        const masComun = (o) => {
            let mejor = '', max = 0;
            Object.keys(o || {}).forEach(k => { if (o[k] > max) { max = o[k]; mejor = k; } });
            return mejor;
        };
        // "¿Cómo nos conoció?" = la respuesta más reciente que dejó (si la dejó ✅)
        const conocido = {};
        pedidos.forEach(p => {
            const t8 = agTel8(p.customer_phone);
            if (t8 && p.como_nos_conocio && !conocido[t8]) {
                conocido[t8] = { como: p.como_nos_conocio, detalle: p.conocio_detalle || '' };
            }
        });
        const ETIQUETA_CONOCIO = { redes: 'Redes sociales', amiga: 'Una amiga se la recomendó', otro: 'Otra forma' };

        agendaClientas = Object.keys(mapa).map(k => {
            const c = mapa[k];
            const co = conocido[k] || {};
            return { tel8: c.tel8, nombre: c.nombre, compras: c.compras, total: c.total,
                     punto: masComun(c.puntos), metodo: masComun(c.metodos),
                     ultima: c.ultima, refs: c.refs,
                     conocio: co.como ? (ETIQUETA_CONOCIO[co.como] || co.como) : '',
                     conocioDetalle: co.detalle || '',
                     codigo: codigos[c.tel8] || '' };
        }).sort((a, b) => b.total - a.total);

        renderAgenda();
    } catch (e) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#c0392b;padding:22px;">❌ ' + agEsc(e.message) + '</td></tr>';
    }
}

function renderAgenda() {
    const q = String(($('ag-buscar') || {}).value || '').toLowerCase().trim();
    const qNum = q.replace(/\D/g, '');
    const lista = !q ? agendaClientas : agendaClientas.filter(c =>
        String(c.nombre).toLowerCase().indexOf(q) >= 0 || (qNum && String(c.tel8).indexOf(qNum) >= 0));
    const tbody = $('agenda-tbody');
    if (!tbody) return;

    const compras = agendaClientas.reduce((s, c) => s + c.compras, 0);
    const vendido = agendaClientas.reduce((s, c) => s + c.total, 0);
    if ($('ag-clientas')) $('ag-clientas').textContent = agendaClientas.length;
    if ($('ag-compras')) $('ag-compras').textContent = compras;
    if ($('ag-vendido')) $('ag-vendido').textContent = agMoney(vendido);
    if ($('ag-ticket')) $('ag-ticket').textContent = agMoney(compras ? vendido / compras : 0);

    if (!lista.length) {
        tbody.innerHTML = agendaClientas.length
            ? '<tr><td colspan="8" style="text-align:center;color:#999;padding:22px;">🔍 No encontré ninguna clienta con eso</td></tr>'
            : '<tr><td colspan="8" style="text-align:center;color:#999;padding:22px;">Todavía no hay ventas registradas ✅<br><span style="font-size:.85rem;">Acá van a aparecer solas cuando se registren ventas ✅</span></td></tr>';
        return;
    }
    tbody.innerHTML = lista.map(c => {
        const wa = c.tel8 ? '503' + c.tel8 : '';
        return '<tr>'
            + '<td><strong>' + agEsc(c.nombre) + '</strong>' + (c.compras >= 3 ? ' ⭐' : '') + '</td>'
            + '<td>' + agEsc(c.tel8 || '—') + '</td>'
            + '<td>' + c.compras + '</td>'
            + '<td><strong>' + agMoney(c.total) + '</strong></td>'
            + '<td>' + agFecha(c.ultima) + '</td>'
            + '<td>' + agEsc(c.punto || '—') + '</td>'
            + '<td>' + agEsc(c.metodo || '—') + '</td>'
            + '<td style="white-space:nowrap;">'
            + '<button class="admin-btn admin-btn--ghost" style="padding:5px 9px;font-size:.72rem;width:auto;" onclick="verClienta(\'' + agEsc(c.tel8) + '\')">Ver historial</button>'
            + (wa ? ' <a class="admin-btn admin-btn--ghost" style="padding:5px 9px;font-size:.72rem;width:auto;text-decoration:none;" target="_blank" href="https://wa.me/' + wa + '?text=' + encodeURIComponent('¡Hola ' + c.nombre + '! 😊 Te escribo de BARATUSS 💛') + '">💬</a>' : '')
            + '</td></tr>';
    }).join('');
}

function verClienta(tel8) {
    const c = agendaClientas.find(x => x.tel8 === tel8);
    const caja = $('agenda-detalle');
    if (!c || !caja) return;
    const filas = (c.refs || []).map(r => {
        const p = agendaPedidos[r] || {};
        let items = '—';
        if (Array.isArray(p.items)) {
            items = p.items.map(i => (i.qty || i.cantidad || 1) + '× ' + (i.name || i.nombre || i.product || '')).join(' · ');
        } else if (p.items) { items = String(p.items); }
        return '<tr><td>' + agFecha(p.created_at) + '</td><td>' + agEsc(items) + '</td>'
            + '<td>' + agEsc(p.delivery_point || c.punto || '—') + '</td>'
            + '<td>' + agMoney(p.total) + '</td>'
            + '<td>' + agEsc(p.status || '') + (p.payment_status ? ' · ' + agEsc(p.payment_status) : '') + '</td></tr>';
    }).join('');
    caja.style.display = '';
    caja.innerHTML = '<div style="background:#fff;border-radius:12px;padding:18px;box-shadow:0 2px 12px rgba(0,0,0,.07);">'
        + '<h2 style="margin:0 0 6px;font-size:1.15rem;">📇 ' + agEsc(c.nombre) + '</h2>'
        + '<p style="color:#666;margin:0 0 14px;">Teléfono <strong>' + agEsc(c.tel8) + '</strong> · '
        + c.compras + ' compra' + (c.compras === 1 ? '' : 's') + ' · Total <strong>' + agMoney(c.total) + '</strong>'
        + (c.punto ? ' · Suele retirar en <strong>' + agEsc(c.punto) + '</strong>' : '') + '</p>'
        + (c.codigo ? '<p style="color:#666;margin:0 0 14px;">🎁 Su código para recomendar: <strong style="letter-spacing:1px;">' + agEsc(c.codigo) + '</strong> <span style="color:#999;">(10% para la amiga)</span></p>' : '')
        + (c.conocio ? '<p style="color:#666;margin:0 0 14px;">📝 Nos conoció por: <strong>' + agEsc(c.conocio) + '</strong>'
            + (c.conocioDetalle ? ' <span style="color:#999;">(' + agEsc(c.conocioDetalle) + ')</span>' : '') + '</p>' : '')
        + '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>'
        + '<th>Fecha</th><th>Qué se llevó</th><th>Punto</th><th>Total</th><th>Estado</th></tr></thead><tbody>'
        + (filas || '<tr><td colspan="5" style="color:#999;padding:14px;">Sin detalle del pedido</td></tr>')
        + '</tbody></table></div>'
        + '<button class="admin-btn admin-btn--ghost" style="margin-top:14px;width:auto;" onclick="document.getElementById(\'agenda-detalle\').style.display=\'none\'">Cerrar</button>'
        + '</div>';
    caja.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ===== INVENTORY =====
async function loadInventory() {
    const data = await api('GET', 'inventory?select=*&order=id.desc');
    if (Array.isArray(data)) { inventory = data; renderInventory(); }
}

function renderInventory() {
    const search = $('inventory-search').value.toLowerCase();
    const catFilter = $('inventory-category').value;
    const tipoFilter = $('inventory-tipo').value;

    const filtered = inventory.filter(p => {
        const matchSearch = !search || p.name.toLowerCase().includes(search) || (p.sku || '').toLowerCase().includes(search);
        const matchCat = !catFilter || p.category === catFilter;
        const matchTipo = !tipoFilter || p.tipo === tipoFilter;
        return matchSearch && matchCat && matchTipo;
    });

    if (filtered.length === 0) {
        $('inventory-body').innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#999;">No hay productos</td></tr>';
        return;
    }

    $('inventory-body').innerHTML = filtered.map(p => `
        <tr class="${selectedIds.has(p.id) ? 'admin-row--selected' : ''}">
            <td><input type="checkbox" class="row-check" data-id="${p.id}" ${selectedIds.has(p.id) ? 'checked' : ''}></td>
            <td class="admin-mono">${p.sku || '—'}</td>
            <td>
                ${p.image_url
                    ? `<img src="${p.image_url}" alt="${p.name}" class="admin-thumb" onerror="this.style.display='none'">`
                    : `<span class="admin-thumb admin-thumb--emoji ${p.img_class || 'p-1'}">${p.emoji || '🛍️'}</span>`}
                <strong>${p.name}</strong> ${p.active === false ? '<span class="admin-badge admin-badge--rechazado">oculto</span>' : ''}
            </td>
            <td>
                <span class="admin-badge admin-badge--cat">${capitalize(p.category)}</span>
                ${p.colors ? `<br><span class="admin-colors-row">${p.colors.split(',').map(c => `<span class="admin-color-dot" title="${c.trim()}" style="background:${colorHex(c.trim())}"></span>`).join('')}</span>` : ''}
            </td>
            <td><span class="admin-badge ${p.tipo === 'usado' ? 'admin-badge--usado' : 'admin-badge--nuevo'}">${p.tipo}</span></td>
            <td>$${Number(p.cost_price || 0).toFixed(2)}</td>
            <td>$${Number(p.sale_price || 0).toFixed(2)}</td>
            <td><strong style="color:var(--accent-dark);">$${finalPrice(p.sale_price).toFixed(2)}</strong></td>
            <td><span class="admin-stock ${p.stock <= 3 ? 'admin-stock--low' : ''}">${p.stock}</span></td>
            <td class="admin-actions">
                <button class="admin-icon-btn" onclick="editProduct(${p.id})" title="Editar"><i class="fas fa-edit"></i></button>
                <button class="admin-icon-btn admin-icon-btn--danger" onclick="deleteProduct(${p.id})" title="Eliminar"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    // Eventos de checkboxes de fila
    document.querySelectorAll('.row-check').forEach(cb => {
        cb.addEventListener('change', () => {
            const id = parseInt(cb.dataset.id);
            if (cb.checked) selectedIds.add(id);
            else selectedIds.delete(id);
            updateBatchUI();
            cb.closest('tr').classList.toggle('admin-row--selected', cb.checked);
        });
    });
    updateBatchUI();
}

// ===== SELECCIÓN POR LOTES =====
function updateBatchUI() {
    const batch = $('admin-batch');
    $('batch-count').textContent = selectedIds.size + ' seleccionado' + (selectedIds.size !== 1 ? 's' : '');
    batch.style.display = selectedIds.size > 0 ? 'flex' : 'none';
    // Actualizar estado del checkbox "select all"
    const checkboxes = document.querySelectorAll('.row-check');
    const allChecked = checkboxes.length > 0 && [...checkboxes].every(cb => cb.checked);
    $('select-all').checked = allChecked;
}

// Select all
$('select-all').addEventListener('change', () => {
    const checked = $('select-all').checked;
    document.querySelectorAll('.row-check').forEach(cb => {
        cb.checked = checked;
        const id = parseInt(cb.dataset.id);
        if (checked) selectedIds.add(id);
        else selectedIds.delete(id);
        cb.closest('tr').classList.toggle('admin-row--selected', checked);
    });
    updateBatchUI();
});

// Batch: ocultar
$('batch-hide').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    await api('PATCH', 'inventory?id=in.(' + ids.join(',') + ')', { active: false, updated_at: new Date().toISOString() });
    showToast('👁️ ' + ids.length + ' producto(s) oculto(s)');
    selectedIds.clear();
    loadInventory();
});

// Batch: mostrar
$('batch-show').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    await api('PATCH', 'inventory?id=in.(' + ids.join(',') + ')', { active: true, updated_at: new Date().toISOString() });
    showToast('👁️ ' + ids.length + ' producto(s) visible(s)');
    selectedIds.clear();
    loadInventory();
});

// Batch: eliminar
$('batch-delete').addEventListener('click', async () => {
    if (selectedIds.size === 0) return;
    if (!confirm('¿Eliminar ' + selectedIds.size + ' producto(s)?')) return;
    const ids = [...selectedIds];
    await api('DELETE', 'inventory?id=in.(' + ids.join(',') + ')');
    showToast('🗑️ ' + ids.length + ' producto(s) eliminado(s)');
    selectedIds.clear();
    loadInventory();
    loadStats();
});

// Batch: limpiar selección
$('batch-clear').addEventListener('click', () => {
    selectedIds.clear();
    document.querySelectorAll('.row-check').forEach(cb => cb.checked = false);
    updateBatchUI();
    renderInventory();
});

// ===== FILTERS =====
['inventory-search', 'inventory-category', 'inventory-tipo'].forEach(id => {
    $(id).addEventListener('input', renderInventory);
    $(id).addEventListener('change', renderInventory);
});

// ===== MODAL PRODUCTO =====
$('btn-add-product').addEventListener('click', () => openProductModal());
$('product-modal-close').addEventListener('click', closeProductModal);
$('product-modal-cancel').addEventListener('click', closeProductModal);
$('product-modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('product-modal-overlay')) closeProductModal();
});

function openProductModal(product) {
    $('product-modal-title').textContent = product ? 'Editar producto' : 'Nuevo producto';
    $('product-id').value = product?.id || '';
    $('product-name').value = product?.name || '';
    $('product-sku').value = product?.sku || '';
    $('product-category').value = product?.category || 'ropa';
    $('product-tipo').value = product?.tipo || 'nuevo';
    $('product-cost').value = product?.cost_price || '';
    $('product-sale').value = product?.sale_price || '';
    $('product-stock').value = product?.stock || 1;
    $('product-emoji').value = product?.emoji || '';
    $('product-badge').value = product?.badge || '';
    $('product-img-class').value = product?.img_class || 'p-1';
    $('product-active').value = product?.active === false ? 'false' : 'true';
    $('product-sizes').value = Array.isArray(product?.sizes) ? product.sizes.join(', ') : '';
    $('product-description').value = product?.description || '';
    $('product-condition').value = product?.condition || '';
    // Colores
    const colors = product?.colors ? product.colors.split(',').map(c => c.trim()).filter(Boolean) : [];
    if (colors.length > 0) {
        document.querySelector('input[name="color-mode"][value="list"]').checked = true;
        $('color-list').style.display = '';
        document.querySelectorAll('.color-check').forEach(cb => {
            cb.checked = colors.includes(cb.value);
        });
    } else {
        document.querySelector('input[name="color-mode"][value="na"]').checked = true;
        $('color-list').style.display = 'none';
        document.querySelectorAll('.color-check').forEach(cb => cb.checked = false);
    }
    // Fotos existentes
    selectedImageFiles = [];
    existingImages = Array.isArray(product?.images) ? product.images.filter(Boolean) : [];
    if (!existingImages.length && product?.image_url) existingImages = [product.image_url];
    existingImageUrl = existingImages[0] || null;
    $('product-image').value = '';
    if (existingImageUrl) {
        $('product-image-preview-img').src = existingImageUrl;
        $('product-image-preview-img').style.display = '';
        $('product-image-preview-empty').style.display = 'none';
    } else {
        $('product-image-preview-img').style.display = 'none';
        $('product-image-preview-empty').style.display = '';
    }
    // Miniaturas de las existentes
    const thumbs = $('product-image-thumbs');
    thumbs.innerHTML = '';
    existingImages.forEach((url, i) => {
        const el = document.createElement('img');
        el.src = url;
        el.style.cssText = 'width:52px;height:52px;object-fit:cover;border-radius:6px;border:2px solid #ddd;';
        el.title = (i === 0 ? 'Principal' : 'Foto ' + (i + 1));
        thumbs.appendChild(el);
    });
    updateSalePreview();
    $('product-modal-overlay').style.display = 'flex';
}

// Radio color-mode: mostrar/ocultar lista
document.querySelectorAll('input[name="color-mode"]').forEach(r => {
    r.addEventListener('change', () => {
        $('color-list').style.display = document.querySelector('input[name="color-mode"]:checked').value === 'list' ? '' : 'none';
    });
});

// Vista previa en vivo: cuánto paga el cliente (con desglose completo)
function updateSalePreview() {
    const sale = parseFloat($('product-sale').value) || 0;
    const iva = Math.round((sale * 0.13) * 100) / 100;              // IVA 13% sobre precio base
    const subtotal = Math.round((sale * 1.13) * 100) / 100;         // base + IVA
    const comision = Math.round((subtotal * 0.035) * 100) / 100;    // Wompi 3.50% sobre (base+IVA)
    const total = finalPrice(sale);                                 // redondeado a 0.05
    $('sale-preview').innerHTML =
        `<div style="background:#fff3f0;border:1px solid #ff9686;border-radius:8px;padding:8px 10px;margin-top:6px;line-height:1.5;">` +
        `<strong>💰 El cliente pagará: $${total.toFixed(2)}</strong> ` +
        `<span style="font-size:.85em;opacity:.8;">(redondeado de $${(subtotal + comision + PRICE_FEE).toFixed(2)})</span><br>` +
        `<span style="font-size:.85em;opacity:.75;">` +
        `Precio base: $${sale.toFixed(2)} · IVA 13%: $${iva.toFixed(2)} · ` +
        `Comisión Wompi 3.50%: $${comision.toFixed(2)}` +
        (PRICE_FEE > 0 ? ` · Tarifa: $${PRICE_FEE.toFixed(2)}` : '') +
        `</span></div>`;
}
$('product-sale').addEventListener('input', updateSalePreview);

// Vista previa de la foto seleccionada
let selectedImageFiles = [];       // archivos nuevos seleccionados
let existingImageUrl = null;       // foto principal actual (edición)
let existingImages = [];           // todas las fotos actuales (edición)

function previewProductImage(input) {
    const files = [...(input.files || [])];
    if (!files.length) return;
    selectedImageFiles = files;
    const reader = new FileReader();
    reader.onload = (e) => {
        $('product-image-preview-img').src = e.target.result;
        $('product-image-preview-img').style.display = '';
        $('product-image-preview-empty').style.display = 'none';
    };
    reader.readAsDataURL(files[0]);
    // Miniaturas de las seleccionadas
    const thumbs = $('product-image-thumbs');
    thumbs.innerHTML = '';
    files.forEach((f, i) => {
        const r = new FileReader();
        r.onload = (e2) => {
            const el = document.createElement('img');
            el.src = e2.target.result;
            el.style.cssText = 'width:52px;height:52px;object-fit:cover;border-radius:6px;border:2px solid #ff9686;';
            el.title = f.name + (i === 0 ? ' (principal)' : '');
            thumbs.appendChild(el);
        };
        r.readAsDataURL(f);
    });
}

// Subir todas las fotos seleccionadas a Supabase Storage
async function uploadProductImage() {
    if (!selectedImageFiles.length) return existingImages.length ? existingImages : (existingImageUrl || null);
    if (!session?.token) return null;
    const urls = [];
    try {
        for (const file of selectedImageFiles) {
            const ext = file.name.split('.').pop() || 'jpg';
            const filename = 'prod-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
            const resp = await fetch(SUPABASE_URL + '/storage/v1/object/productos/' + filename, {
                method: 'POST',
                headers: {
                    'apikey': ANON_KEY,
                    'Authorization': 'Bearer ' + session.token,
                    'Content-Type': file.type || 'image/jpeg'
                },
                body: file
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.message || 'Error subiendo foto');
            }
            urls.push(SUPABASE_URL + '/storage/v1/object/public/productos/' + filename);
        }
        // Si hay fotos existentes y solo agregamos nuevas: las nuevas van después de las existentes
        const base = existingImages.length ? existingImages : (existingImageUrl ? [existingImageUrl] : []);
        return [...base, ...urls];
    } catch (e) {
        console.error('Upload error:', e);
        showToast('❌ No se pudo subir la foto: ' + e.message);
        return existingImages.length ? existingImages : (existingImageUrl || null);
    }
}

// Eliminar foto anterior si se reemplaza (limpieza opcional)
function removeOldImageIfReplaced(oldUrl, newUrl) {
    if (!oldUrl || !newUrl || oldUrl === newUrl || !session?.token) return;
    try {
        const path = oldUrl.split('/object/public/productos/')[1];
        if (path) {
            fetch(SUPABASE_URL + '/storage/v1/object/productos/' + path, {
                method: 'DELETE',
                headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + session.token }
            }).catch(() => {});
        }
    } catch (e) { console.log('No se pudo limpiar foto vieja:', e.message); }
}

function closeProductModal() {
    $('product-modal-overlay').style.display = 'none';
    $('product-form').reset();
}

$('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Guardando...';
    const id = $('product-id').value;
    
    // Subir fotos primero (si hay)
    const images = await uploadProductImage();
    if (selectedImageFiles.length && !images) {
        btn.disabled = false; btn.textContent = 'Guardar';
        return;
    }
    
    const data = {
        name: $('product-name').value,
        sku: $('product-sku').value || null,
        category: $('product-category').value,
        tipo: $('product-tipo').value,
        cost_price: parseFloat($('product-cost').value) || 0,
        sale_price: parseFloat($('product-sale').value) || 0,
        stock: parseInt($('product-stock').value) || 0,
        emoji: $('product-emoji').value || '🛍️',
        badge: $('product-badge').value || null,
        img_class: $('product-img-class').value || 'p-1',
        sizes: $('product-sizes').value ? $('product-sizes').value.split(',').map(s => s.trim()).filter(Boolean) : null,
        description: $('product-description').value || null,
        condition: $('product-condition').value || null,
        active: $('product-active').value === 'true',
        colors: document.querySelector('input[name="color-mode"]:checked').value === 'list'
            ? [...document.querySelectorAll('.color-check:checked')].map(cb => cb.value).join(', ')
            : null,
        updated_at: new Date().toISOString()
    };
    if (images) {
        const arr = Array.isArray(images) ? images : [images];
        data.images = arr;
        data.image_url = arr[0];  // primera foto = principal (compatibilidad)
    }

    let ok;
    if (id) {
        const old = inventory.find(p => p.id === parseInt(id));
        if (old?.image_url && selectedImageFiles.length) removeOldImageIfReplaced(old.image_url, Array.isArray(images) ? images[0] : images);
        const r = await api('PATCH', 'inventory?id=eq.' + id, data);
        ok = r === null || !r?.error;
    } else {
        const r = await api('POST', 'inventory', data);
        ok = !r?.error;
    }

    btn.disabled = false; btn.textContent = 'Guardar';
    if (!ok) { showToast('❌ Error al guardar'); return; }
    showToast(id ? '✅ Producto actualizado' : '✅ Producto creado');
    selectedImageFiles = [];
    existingImages = [];
    existingImageUrl = null;
    closeProductModal();
    loadInventory();
    loadStats();
});

async function editProduct(id) {
    const product = inventory.find(p => p.id === id);
    if (product) openProductModal(product);
}

async function deleteProduct(id) {
    if (!confirm('¿Eliminar este producto?')) return;
    await api('DELETE', 'inventory?id=eq.' + id);
    showToast('🗑️ Producto eliminado');
    loadInventory();
    loadStats();
}

// ===== ORDERS =====
async function loadOrders() {
    const data = await api('GET', 'orders?select=*&order=created_at.desc&limit=50');
    if (Array.isArray(data)) { orders = data; renderOrders(); }
}

function renderOrders() {
    if (orders.length === 0) {
        $('orders-body').innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:#999;">No hay pedidos</td></tr>';
        return;
    }
    $('orders-body').innerHTML = orders.map(o => {
        const items = (o.items || []).map(i => `${i.name} ×${i.qty}`).join(', ');
        const payStatus = o.payment_status || 'pendiente';
        const isCash = o.payment_method === 'efectivo';
        const delivery = o.delivery_type === 'domicilio'
            ? `🏠 Domicilio${o.delivery_fee ? ` (+$${Number(o.delivery_fee).toFixed(2)})` : ''}`
            : o.delivery_type === 'retiro' ? '🏪 Retiro' : '';
        const customer = (o.customer_name ? `${o.customer_name}<br><small>📱 ${o.customer_phone || ''}</small>` : '') +
            (o.customer_address ? `<br><small>📍 ${o.customer_address}, ${o.customer_city || ''}</small>` : '');
        // PLAN 2: se puede marcar PAGADO cualquier pedido que todavía no esté pago
        // (por ejemplo, un pedido con tarjeta que el cliente decidió pagar en efectivo al retirar)
        const canMarkPaid = payStatus !== 'pagado' && payStatus !== 'aprobado'
            && o.status !== 'cancelado' && o.status !== 'entregado' && o.status !== 'vencido'
            && o.status !== 'no-retirado';
        const canCancel = (payStatus !== 'pagado' && payStatus !== 'aprobado') || o.status === 'cancelado';
        return `
        <tr>
            <td class="admin-mono">${o.reference || o.id?.slice(0, 8) || '—'}</td>
            <td>${items || '—'}</td>
            <td>$${Number(o.total).toFixed(2)}</td>
            <td><span class="admin-badge admin-badge--${o.status || 'pendiente'}">${capitalize(o.status || 'pendiente')}</span></td>
            <td>
                <span class="admin-badge ${isCash ? 'admin-badge--efectivo' : 'admin-badge--aprobado'}">${isCash ? '💵 Efectivo' : capitalize(payStatus)}</span>
                ${o.requiere_pago_adelantado ? '<br><span class="admin-badge" style="background:#fff4e5;color:#8a5a1f;">💳 Pago adelantado</span>' : ''}
                ${String(o.whatsapp_estado || '') === 'sin_whatsapp' ? '<br><span class="admin-badge" style="background:#fdecea;color:#b9453a;">📵 Sin WhatsApp</span>' : ''}
                ${delivery ? `<br><small style="color:#888;">${delivery}</small>` : ''}
            </td>
            <td>${customer || new Date(o.created_at).toLocaleDateString('es-SV')}</td>
            <td>
                <small style="color:#aaa;">${new Date(o.created_at).toLocaleDateString('es-SV')}</small>
                ${canMarkPaid ? `<br><button class="admin-btn admin-btn--primary" style="width:auto;padding:6px 10px;font-size:0.75rem;margin-top:6px;" onclick="markCashPaid('${o.id}')">✅ Marcar pagado</button>` : ''}
                ${canCancel ? `<br><button class="admin-btn admin-btn--danger" style="width:auto;padding:6px 10px;font-size:0.75rem;margin-top:4px;" onclick="cancelOrder('${o.id}')">❌ Cancelar y devolver stock</button>` : ''}
                ${!['cancelado', 'entregado', 'vencido', 'no-retirado'].includes(o.status) ? `<br><button class="admin-btn admin-btn--ghost" style="width:auto;padding:6px 10px;font-size:0.75rem;margin-top:4px;" onclick="abrirAjuste('${o.reference}')">✂️ Ajustar pedido</button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

// Cancelar pedido: devolver stock al inventario
async function cancelOrder(id) {
    if (!confirm('¿Cancelar este pedido y DEVOLVER el stock al inventario?')) return;
    const order = orders.find(o => o.id === id);
    if (!order) return;
    try {
        // Devolver stock por cada ítem
        for (const item of (order.items || [])) {
            const qty = item.qty || 1;
            const r = await api('GET', 'inventory?select=stock&id=eq.' + item.id);
            const rows = Array.isArray(r) ? r : [];
            const current = rows.length ? (Number(rows[0].stock) || 0) : 0;
            await api('PATCH', 'inventory?id=eq.' + item.id, {
                stock: current + qty,
                updated_at: new Date().toISOString()
            });
        }
        // Marcar pedido como cancelado
        await api('PATCH', 'orders?id=eq.' + id, {
            status: 'cancelado',
            updated_at: new Date().toISOString()
        });
        showToast('✅ Pedido cancelado, stock devuelto');
    } catch (e) {
        showToast('❌ Error al cancelar: ' + (e.message || e));
    }
    loadOrders();
    loadInventory();
    loadStats();
}

// Marcar pedido (efectivo) como PAGADO y ENTREGADO → registra la venta en finanzas
async function markCashPaid(id) {
    const o = (orders || []).find(x => x.id === id);
    if (!confirm('¿Marcar este pedido como PAGADO y ENTREGADO?\n\nSe registrará la venta en finanzas (IVA, costo y utilidad).')) return;
    try {
        await api('POST', 'rpc/entregar_pedido', { p_ref: o ? o.reference : null });
    } catch (e) {
        showToast('❌ No se pudo marcar: ' + e.message);
        return;
    }
    showToast('✅ Pedido entregado · 💰 venta registrada en finanzas');
    await loadOrders();
    await loadStats();
}

// ===== STATS =====
async function loadStats() {
    $('stat-products').textContent = inventory.length;
    const invValue = inventory.reduce((sum, p) => sum + (Number(p.sale_price) || 0) * (p.stock || 0), 0);
    $('stat-inventory-value').textContent = '$' + invValue.toFixed(2);

    if (orders.length === 0) await loadOrders();
    $('stat-orders').textContent = orders.length;
    $('stat-paid').textContent = orders.filter(o => o.payment_status === 'aprobado' || o.status === 'pagado').length;

    const lowStock = inventory.filter(p => p.stock <= 3);
    if (lowStock.length > 0) {
        $('stock-alert').innerHTML = `<h4>⚠️ Stock bajo</h4>${lowStock.map(p => `<p>${p.name} — quedan ${p.stock}</p>`).join('')}`;
        $('stock-alert').style.display = '';
    } else {
        $('stock-alert').style.display = 'none';
    }

    await loadMetricas();
    await loadFacturasPendientes();
}

// ===== MÉTRICAS DE ENTREGA Y WHATSAPP (vista metricas_resumen, solo sesión admin) =====
async function loadMetricas() {
    try {
        const data = await api('GET', 'metricas_resumen?select=*');
        const m = Array.isArray(data) ? data[0] : data;
        if (!m) return;
        const set = (id, v) => { const el = $(id); if (el) el.textContent = (v === null || v === undefined) ? '0' : v; };
        set('m-pedidos-activos', m.pedidos_activos);
        set('m-confirmaron', m.clientes_confirmaron);
        set('m-agradecimientos', m.agradecimientos);
        set('m-recordatorios', m.recordatorios);
        set('m-conf1h', m.confirmaciones_1h);
        set('m-reprog-auto', m.reprogramaciones_auto);
        set('m-reprog-pend', m.reprogramaciones_pendientes);
        set('m-bloqueadas', m.ventanas_bloqueadas);
        set('m-recibidos', m.mensajes_recibidos);
        set('m-enviados', m.mensajes_enviados);
        set('m-entregados', m.mensajes_entregados);
        set('m-fallidos', m.mensajes_fallidos);
        const sello = $('m-actualizado');
        if (sello) sello.textContent = 'Actualizado ' + new Date().toLocaleTimeString();
    } catch (_e) { /* si falla, el resumen general no se debe romper */ }
}

// ===== FACTURAS Y COMPROBANTES PEDIDOS POR EL CLIENTE =====
// Mismos datos del emisor que la tienda (scripts.js → EMISOR): si se cambian allá, cambiar acá.
const EMISOR_PANEL = {
    nombre: 'BARATUSS',
    razonSocial: 'Cindy Rubio — persona natural',
    nit: 'PENDIENTE',
    nrc: 'PENDIENTE',
    giro: 'Comercio al por menor de prendas de vestir, accesorios y cosméticos',
    direccion: 'San Salvador, El Salvador',
    telefono: '+503 6285 2631',
    correo: 'baratusses@gmail.com',
    establecimiento: '0001',
    simulacion: true,
};
const IVA_PANEL = 0.13;
let _facturasPendientes = [];

async function loadFacturasPendientes() {
    const cont = $('facturas-lista');
    try {
        const data = await api('GET', 'orders?select=reference,customer_name,customer_phone,customer_email,factura_tipo,factura_nombre,factura_nit,factura_nrc,factura_giro,factura_direccion,factura_por_correo,factura_enviada_en,total,items,delivery_point,created_at&factura_por_correo=eq.true&factura_enviada_en=is.null&order=created_at.desc&limit=40');
        _facturasPendientes = Array.isArray(data) ? data : [];
        const chip = $('f-pendientes');
        if (chip) chip.textContent = _facturasPendientes.length + (_facturasPendientes.length === 1 ? ' pendiente' : ' pendientes');
        if (!cont) return;
        if (!_facturasPendientes.length) {
            cont.innerHTML = '<p class="facturas-hint">✅ No hay facturas pendientes de enviar.</p>';
            return;
        }
        cont.innerHTML = _facturasPendientes.map((o, i) => {
            const esCCF = o.factura_tipo === 'ccf';
            return `<div class="factura-item">
                <div class="factura-item__info">
                    <strong>${esCCF ? '🏢 Comprobante de crédito fiscal' : '🧾 Factura de consumidor final'} · #${o.reference}</strong>
                    <span>${o.factura_nombre || o.customer_name || '—'} · 📧 ${o.customer_email || '(sin correo)'}</span>
                    <span>$${Number(o.total || 0).toFixed(2)} · ${new Date(o.created_at).toLocaleString('es-SV')}</span>
                </div>
                <div class="factura-item__acciones">
                    <button type="button" class="admin-btn admin-btn--ghost" onclick="verFacturaPanel(${i})">🧾 Ver documento</button>
                    <a class="admin-btn admin-btn--ghost" href="${correoLinkFactura(o)}">📧 Preparar correo</a>
                    <button type="button" class="admin-btn admin-btn--ghost" onclick="copiarCorreoFactura(${i})">📋 Copiar correo y texto</button>
                    <button type="button" class="admin-btn admin-btn--primary" onclick="marcarFacturaEnviada('${o.reference}')">✅ Ya la envié</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        if (cont) cont.innerHTML = '<p class="facturas-hint">No se pudieron cargar: ' + e.message + '</p>';
    }
}

function correoLinkFactura(o) {
    const que = o.factura_tipo === 'ccf' ? 'comprobante de crédito fiscal' : 'factura de consumidor final';
    const asunto = 'Tu ' + que + ' de BARATUSS · ' + o.reference;
    const cuerpo = [
        'Hola ' + (o.factura_nombre || o.customer_name || '') + ',',
        '',
        '¡Gracias por tu compra en BARATUSS! 💖',
        'Te adjuntamos tu ' + que + ' (adjuntá el PDF que sale del botón "Ver documento" → Imprimir / Guardar PDF).',
        '',
        'Pedido: ' + o.reference,
        'Total: $' + Number(o.total || 0).toFixed(2),
        'Entrega: ' + (o.delivery_point || 'por coordinar'),
        '',
        'Cualquier cosa escribinos al +503 6285 2631.',
        'BARATUSS',
    ].join('\n');
    return 'mailto:' + encodeURIComponent(o.customer_email || '')
        + '?subject=' + encodeURIComponent(asunto)
        + '&body=' + encodeURIComponent(cuerpo);
}

function documentoPanelHTML(o) {
    const total = Number(o.total || 0);
    const gravada = total / (1 + IVA_PANEL);
    const iva = total - gravada;
    const esCCF = o.factura_tipo === 'ccf';
    const f = new Date(o.created_at || Date.now());
    const fechaTxt = f.toLocaleDateString('es-SV') + ' ' + f.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' });
    const correlativo = 'SIM-' + (esCCF ? 'CCF' : 'CF') + '-' + String(o.reference || '').slice(-6);
    const filas = (o.items || []).map(it => {
        const sub = (it.price || 0) * (it.qty || 1);
        return `<tr>
            <td class="num">${it.qty || 1}</td>
            <td>${it.name}${it.size ? ' · Talla ' + it.size : ''}<span class="mini"> · cód. #${it.id}</span></td>
            <td class="num">$${((sub / (1 + IVA_PANEL)) / (it.qty || 1)).toFixed(2)}</td>
            <td class="num">$${(sub / (1 + IVA_PANEL)).toFixed(2)}</td>
        </tr>`;
    }).join('');

    // Código QR (mismo criterio que la tienda: datos del documento mientras no haya DTE autorizado)
    let qrHtml = '';
    try {
        if (typeof qrcode === 'function') {
            const q = qrcode(0, 'M');
            q.addData([
                (esCCF ? 'COMPROBANTE DE CRÉDITO FISCAL' : 'FACTURA DE CONSUMIDOR FINAL') + ' — ' + EMISOR_PANEL.nombre,
                'N°: ' + correlativo,
                'Fecha: ' + fechaTxt,
                'Emisor — NIT: ' + EMISOR_PANEL.nit + ' / NRC: ' + EMISOR_PANEL.nrc,
                'Receptor: ' + (o.factura_nombre || o.customer_name || 'Consumidor final'),
                'Total: $' + total.toFixed(2),
                'Referencia: ' + (o.reference || '—'),
                EMISOR_PANEL.simulacion ? 'DOCUMENTO DE SIMULACIÓN — SIN VALOR FISCAL' : '',
            ].filter(Boolean).join('\n'));
            q.make();
            qrHtml = `<div class="factura__qr">${q.createSvgTag({ cellSize: 3, margin: 1 })}<small>Escaneá para verificar este documento</small></div>`;
        }
    } catch (e) { qrHtml = ''; }

    return `
    ${EMISOR_PANEL.simulacion ? '<div class="factura__simulacion">SIMULACIÓN — DOCUMENTO SIN VALOR FISCAL</div>' : ''}
    <div class="factura__cabecera">
        <div class="factura__emisor">
            <div class="factura__emisor-nombre">${EMISOR_PANEL.nombre}</div>
            <div class="factura__dato">${EMISOR_PANEL.razonSocial}</div>
            <div class="factura__dato">NIT: ${EMISOR_PANEL.nit} · NRC: ${EMISOR_PANEL.nrc}</div>
            <div class="factura__dato">Giro: ${EMISOR_PANEL.giro}</div>
            <div class="factura__dato">Dirección: ${EMISOR_PANEL.direccion}</div>
            <div class="factura__dato">Tel. ${EMISOR_PANEL.telefono} · ${EMISOR_PANEL.correo}</div>
            <div class="factura__dato">Establecimiento: ${EMISOR_PANEL.establecimiento}</div>
        </div>
        <div class="factura__tipo-caja">
            <div class="factura__tipo">${esCCF ? 'COMPROBANTE DE CRÉDITO FISCAL' : 'FACTURA DE CONSUMIDOR FINAL'}</div>
            <div class="factura__numero">N° ${correlativo}</div>
            <div class="factura__dato">Fecha de emisión: ${fechaTxt}</div>
            <div class="factura__dato">Condición de pago: contado</div>
            <div class="factura__dato">Referencia interna: ${o.reference || '—'}</div>
        </div>
    </div>
    <div class="factura__bloque">
        <div class="factura__titulo">Datos del comprador</div>
        <div class="factura__grid">
            <div><span>Nombre</span>${o.factura_nombre || o.customer_name || 'Consumidor final'}</div>
            <div><span>NIT</span>${esCCF ? (o.factura_nit || '—') : '—'}</div>
            <div><span>NRC</span>${esCCF ? (o.factura_nrc || '—') : '—'}</div>
            <div><span>Giro</span>${esCCF ? (o.factura_giro || '—') : '—'}</div>
            <div class="ancho"><span>Dirección</span>${esCCF ? (o.factura_direccion || '—') : '—'}</div>
            <div class="ancho"><span>Correo</span>${o.customer_email || '—'}</div>
            <div><span>Teléfono</span>${o.customer_phone || '—'}</div>
            <div><span>Entrega</span>${o.delivery_point || '—'}</div>
        </div>
    </div>
    <table class="factura__tabla">
        <thead><tr><th>Cant.</th><th>Descripción</th><th class="num">P. unitario</th><th class="num">Ventas gravadas</th></tr></thead>
        <tbody>${filas}</tbody>
    </table>
    <div class="factura__totales">
        <div><span>Ventas gravadas</span><strong>$${gravada.toFixed(2)}</strong></div>
        <div><span>IVA 13% (incluido)</span><strong>$${iva.toFixed(2)}</strong></div>
        <div class="total"><span>Total a pagar</span><strong>$${total.toFixed(2)}</strong></div>
    </div>
    ${qrHtml}

    <div class="factura__pie">
        El IVA (13%) ya está incluido en los precios. Documento generado electrónicamente el ${fechaTxt}.
        ${EMISOR_PANEL.simulacion
            ? '⚠️ Documento de PRUEBA del sistema de facturación: no tiene valor fiscal mientras el emisor no cuente con NRC y la autorización de Documentos Tributarios Electrónicos (DTE) del Ministerio de Hacienda.'
            : 'Entrega: por correo electrónico o en el punto de retiro.'}
    </div>`;
}

function copiarCorreoFactura(i) {
    const o = _facturasPendientes[i];
    if (!o) return;
    const que = o.factura_tipo === 'ccf' ? 'comprobante de crédito fiscal' : 'factura de consumidor final';
    const texto = 'Para: ' + (o.customer_email || '(el cliente no dejó correo)')
        + '\nAsunto: Tu ' + que + ' de BARATUSS · #' + o.reference
        + '\n\nHola ' + (o.factura_nombre || o.customer_name || '') + ','
        + '\n\n¡Gracias por tu compra en BARATUSS! 💖'
        + '\nTe adjuntamos tu ' + que + ' (adjuntá el PDF que sale de "Ver documento" → Imprimir).'
        + '\n\nPedido: ' + o.reference
        + '\nTotal: $' + Number(o.total || 0).toFixed(2)
        + '\nEntrega: ' + (o.delivery_point || 'por coordinar')
        + '\n\nCualquier cosa escribinos al +503 6285 2631.'
        + '\nBARATUSS';
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto)
            .then(() => showToast('📋 Copiado: pegalo en tu correo y adjuntá el PDF'))
            .catch(() => showToast('⚠️ No se pudo copiar solo: usá "Preparar correo"'));
    } else {
        showToast('⚠️ Este navegador no permite copiar solo: usá "Preparar correo"');
    }
}

function verFacturaPanel(i) {
    const o = _facturasPendientes[i];
    if (!o) return;
    const doc = $('factura-doc');
    if (doc) doc.innerHTML = documentoPanelHTML(o);
    const hint = $('factura-hint');
    if (hint) hint.textContent = o.customer_email
        ? 'Después de guardar el PDF, usá "Preparar correo" para enviárselo a ' + o.customer_email
        : 'Este pedido no dejó correo: coordiná el envío con el cliente por WhatsApp.';
    const m = $('factura-modal');
    if (m) m.style.display = 'flex';
}

function cerrarFacturaPanel() {
    const m = $('factura-modal');
    if (m) m.style.display = 'none';
}

async function marcarFacturaEnviada(ref) {
    try {
        await api('PATCH', 'orders?reference=eq.' + encodeURIComponent(ref), { factura_enviada_en: new Date().toISOString() });
        showToast('✅ Factura marcada como enviada');
        cerrarFacturaPanel();
        await loadFacturasPendientes();
    } catch (e) {
        showToast('❌ No se pudo marcar: ' + e.message);
    }
}

(function initFacturasPanel() {
    const c = $('factura-modal-close');
    if (c) c.addEventListener('click', cerrarFacturaPanel);
    const m = $('factura-modal');
    if (m) m.addEventListener('click', (e) => { if (e.target === m) cerrarFacturaPanel(); });
    const p = $('factura-print');
    if (p) p.addEventListener('click', () => window.print());
})();

// ===== HELPERS =====
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Color nombre → hex (para los puntitos)
function colorHex(name) {
    const map = {
        'negro': '#1a1a1a', 'blanco': '#f5f5f5', 'gris': '#9e9e9e', 'rojo': '#e74c3c',
        'azul': '#2980b9', 'verde': '#27ae60', 'amarillo': '#f1c40f', 'rosado': '#ff9686',
        'morado': '#8e44ad', 'naranja': '#e67e22', 'marrón': '#6d4c41', 'beige': '#d7c4a3'
    };
    return map[name.toLowerCase()] || '#cccccc';
}

function showToast(msg) {
    const toast = $('admin-toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ===== INIT =====
(async function init() {
    // Verificar que la sesión guardada SIGUE SIENDO VÁLIDA (token vivo)
    if (session?.token) {
        try {
            const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
                headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + session.token }
            });
            if (r.ok) {
                const user = await r.json();
                if (user?.id) {
                    // Sesión válida → verificar que siga siendo admin
                    const profResp = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=is_admin,name,email&id=eq.' + user.id, {
                        headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + session.token }
                    });
                    const profiles = await profResp.json().catch(() => []);
                    const profile = Array.isArray(profiles) ? profiles[0] : null;
                    if (profile?.is_admin) {
                        session = { token: session.token, user, profile };
                        localStorage.setItem('baratuss_admin_session', JSON.stringify(session));
                        enterDashboard();
                        return;
                    }
                }
            }
        } catch (e) { /* sesión inválida → ir a login */ }
        // Token muerto o sin permisos → limpiar y pedir login
        session = null;
        localStorage.removeItem('baratuss_admin_session');
    }
    // Sin sesión válida → mostrar login
    $('admin-login').style.display = '';
    $('admin-dashboard').style.display = 'none';
})();

// ============================================================
// BARATUSS — SISTEMA DE LOGÍSTICA (Despachos, Salidas, Preparar)
// ============================================================

const ESTADOS_LABEL = {
    'pendiente-preparacion': '⏳ Pendiente de preparación',
    'en-preparacion': '🔨 En preparación',
    'listo': '✅ Listo',
    'salio': '🚚 Salió',
    'entregado': '📦 Entregado/Enviado',
    // ===== CONTINGENCIAS (plan v1.2 · 2026-09-18) =====
    'contingencia': '⚠️ En contingencia',
    'no-show': '🚫 No vino',
    'no-disponible': '✂️ No disponible',
    'no-retirado': '🚫 No retirado',
    'vencido': '⌛ Vencido',
    'reprogramado': '🔄 Reprogramado',
    'reembolsado': '💸 Reembolsado',
    'cancelado': '🚫 Cancelado'
};
const ESTADOS_NEXT = {
    'pendiente-preparacion': 'en-preparacion',
    'en-preparacion': 'listo',
    'listo': 'salio',
    'salio': 'entregado',
    // Un despacho reprogramado vuelve al flujo normal desde "listo"
    'reprogramado': 'listo'
};

// Mapeo destino -> salida logística
function salidaKey(destino) {
    const d = (destino || '').toLowerCase();
    if (d.includes('c807')) return 'c807';
    if (d.includes('merliot')) return 'merliot';
    if (d.includes('metrocentro')) return 'metrocentro';
    if (d.includes('santa tecla') || d.includes('paseo el carmen') || d.includes('la skina') || d.includes('casa matriz')) return 'santatecla';
    return 'otro';
}
const SALIDA_INFO = {
    'c807': { icon: '📦', titulo: 'C807 — Jueves por la mañana', detalle: 'Llevás los paquetes a la agencia C807; ellos contactan al cliente cuando llega a destino.' },
    'merliot': { icon: '🛍️', titulo: 'Plaza Merliot — Jueves 5:00–7:00 PM', detalle: 'Entrega en Plaza Merliot.' },
    'metrocentro': { icon: '🏬', titulo: 'Metrocentro — Sábado 10:00 AM–12:00 PM', detalle: 'Entrega en Food Court de Metrocentro.' },
    'santatecla': { icon: '🏡', titulo: 'Santa Tecla — Entrega personal coordinada', detalle: 'Coordinar con el cliente por WhatsApp al 7662-6575.' },
    'otro': { icon: '📍', titulo: 'Entrega coordinada', detalle: 'Coordinar directamente con el cliente.' }
};

let despachos = [];
let logFilter = 'todos';
let prepFilter = 'pendiente-preparacion';
let prepSelected = new Set();

// ===== ESTADOS DE PAGO (plan 2 · 19-sep-2026) =====
// El panel lee los despachos sin mirar si el pedido está pagado. Acá se trae el pago
// de cada pedido para: (1) NO mostrar sin pagar en "Preparar", (2) poner la etiqueta
// naranja en Despachos, (3) avisar cuando al cliente le falta el teléfono.
let _pagoPorRef = {};
const SIN_PAGAR = ['pendiente', 'creado', 'rechazado'];
async function cargarEstadosPago() {
    try {
        const d = await api('GET', 'orders?select=reference,payment_status,status,customer_phone,telefono_normalizado,whatsapp_estado,total&order=created_at.desc&limit=200');
        _pagoPorRef = {};
        (Array.isArray(d) ? d : []).forEach(o => { _pagoPorRef[o.reference] = o; });
    } catch (_e) { _pagoPorRef = {}; }
}
function pagoDe(ref) { return _pagoPorRef[ref] || {}; }
function estaSinPagar(ref) { return SIN_PAGAR.includes(String(pagoDe(ref).payment_status || '')); }
function telDe(ref, fallback) {
    const p = pagoDe(ref);
    return String(p.telefono_normalizado || p.customer_phone || fallback || '').replace(/\D/g, '');
}
async function entregarTodoDe(ref) { return entregarTodo(ref); }

// ===== CARGAR DESPACHOS =====
async function loadDespachos() {
    await cargarEstadosPago();
    const data = await api('GET', 'despachos?select=*&order=created_at.desc&limit=200');
    despachos = Array.isArray(data) ? data : [];
    renderDespachos();
}
function renderDespachos() {
    renderProximaSalida();
    const body = $('despachos-body');
    const filtrados = logFilter === 'todos' ? despachos : despachos.filter(d => d.estado_logistico === logFilter);
    if (!filtrados.length) {
        body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#999;">No hay despachos aquí</td></tr>';
        return;
    }
    body.innerHTML = filtrados.map(d => {
        const estado = d.estado_logistico || 'pendiente-preparacion';
        const next = ESTADOS_NEXT[estado];
        const isTerminal = estado === 'entregado';
        const foto = d.imagen_url
            ? '<img src="' + d.imagen_url + '" style="width:38px;height:38px;object-fit:cover;border-radius:8px;" onerror="this.remove()">'
            : '🛍️';
        const accion = !isTerminal && next
            ? '<button class="admin-btn admin-btn--primary" style="padding:5px 10px;font-size:.72rem;width:auto;" onclick="avanzarDespacho(' + d.id + ')">' + ESTADOS_LABEL[next] + '</button>'
            : '<span style="color:#27ae60;">✔</span>';
        // 📦 ENTREGADO DIRECTO (2026-09-19): un solo toque entrega TODO el pedido y registra la
        // venta (antes había que avanzar estado por estado, y Cindy no encontraba cómo marcarlo).
        const btnEntregar = (estado !== 'entregado' && estado !== 'cancelado')
            ? '<button class="admin-btn admin-btn--primary" style="padding:5px 8px;font-size:.7rem;width:auto;margin-left:4px;" '
              + 'title="Marcar TODO el pedido como entregado y registrar la venta en finanzas" '
              + 'onclick="entregarTodo(\'' + (d.order_reference || '') + '\')">📦 Entregado</button>'
            : '';
        // 🚫 Cancelación por enojo (efectivo): devuelve el stock, disculpa al cliente y cupón 45% automático
        const btnEnojo = (estado !== 'entregado' && estado !== 'cancelado')
            ? '<button class="admin-btn admin-btn--danger" style="padding:5px 8px;font-size:.7rem;width:auto;margin-left:4px;" '
              + 'title="El cliente no quiere el producto: cancela la venta, devuelve el stock y le manda disculpa + cupón 45%" '
              + 'onclick="cancelarPorEnojo(\'' + (d.order_reference || '') + '\')">🚫 Canceló</button>'
            : '';
        // ── ETIQUETAS DEL PLAN 2 (19-sep-2026) ──
        const pago = pagoDe(d.order_reference);
        const tagSinPagar = estaSinPagar(d.order_reference)
            ? '<br><span class="admin-badge" style="background:#fff4e5;color:#8a5a1f;border:1px solid #ffd8a8;">⏳ Sin pagar — no preparar</span>'
            : '';
        const tel = telDe(d.order_reference, d.customer_phone);
        const tagSinTel = !tel
            ? '<br><span class="admin-badge" style="background:#fdecea;color:#b9453a;">⚠️ Sin teléfono — no se puede coordinar</span>'
            : '';
        const tagSinWa = String(pago.whatsapp_estado || '') === 'sin_whatsapp'
            ? '<br><span class="admin-badge" style="background:#fdecea;color:#b9453a;">📵 Sin WhatsApp — llamarlo</span>'
            : '';
        const btnLlamar = tel
            ? '<a class="admin-btn admin-btn--ghost" style="padding:5px 8px;font-size:.7rem;width:auto;margin-left:4px;text-decoration:none;" '
              + 'title="Llamar al cliente" href="tel:+' + tel + '">📞</a>'
            : '';
        const cerrado = ['entregado', 'cancelado', 'vencido', 'no-retirado'].includes(estado);
        // 📍 CASO 2 (22-sep-2026): cambiar el punto de entrega
        //  · si el paquete NO ha salido → "📍 Punto" (se cambia y se avisa a la clienta)
        //  · si YA salió → "📣 No vayas" (se le avisa para que no vaya y se pasa a la próxima salida)
        const refFila = String(d.order_reference || '');
        const destinoFila = String(d.destino || '').replace(/'/g, '');
        const btnPunto = cerrado ? ''
            : (estado === 'salio'
                ? '<button class="admin-btn admin-btn--danger" style="padding:5px 8px;font-size:.7rem;width:auto;margin-left:4px;" '
                  + 'title="El paquete ya salió: avisale a la clienta que no vaya y se pasa a la próxima salida" '
                  + 'onclick="avisarNoVayas(\'' + refFila + '\')">📣 No vayas</button>'
                : '<button class="admin-btn admin-btn--ghost" style="padding:5px 8px;font-size:.7rem;width:auto;margin-left:4px;" '
                  + 'title="La clienta pidió otro punto de entrega: se cambia y se le avisa por WhatsApp" '
                  + 'onclick="cambiarPunto(\'' + refFila + '\', \'' + destinoFila + '\')">📍 Punto</button>');
        // 🚫 NO VINO (plan 3): registra el caso, avisa al cliente y aplica las 48 h
        const btnNoShow = !cerrado
            ? '<button class="admin-btn admin-btn--danger" style="padding:5px 8px;font-size:.7rem;width:auto;margin-left:4px;" '
              + 'title="El cliente no llegó a retirar: se le manda el menú de opciones y tiene 48 h para responder" '
              + 'onclick="marcarNoVino(\'' + (d.order_reference || '') + '\')">🚫 No vino</button>'
            : '';
        return '<tr>' +
            '<td><strong>' + (d.order_reference || '') + '</strong>' + tagSinPagar + '</td>' +
            '<td style="min-width:200px;"><div style="display:flex;align-items:center;gap:10px;">' + foto +
                '<div><div><strong>' + (d.nombre_capturado || 'Artículo') + '</strong> ×' + (d.qty || 1) + '</div>' +
                '<div style="font-size:.72rem;color:#999;">#' + (d.inventory_id || '') + '</div></div></div></td>' +
            '<td>' + (d.talla || '—') + '</td>' +
            '<td>' + (d.customer_name || '—') + tagSinTel + tagSinWa + '</td>' +
            '<td>' + fmtEntrega(d.metodo_entrega) + '</td>' +
            '<td style="max-width:180px;">' + (d.destino || '—') + '</td>' +
            '<td><span class="log-estado log-estado--' + estado + '">' + ESTADOS_LABEL[estado] + '</span></td>' +
            '<td>' + accion + btnEntregar + btnPunto + btnNoShow + btnEnojo + btnLlamar + '</td>' +
        '</tr>';
    }).join('');
}
function fmtEntrega(t) {
    const s = (t || '').replace('retiro-', '');
    if (s === 'c807') return 'C807';
    if (s === 'punto') return 'Punto BARATUSS';
    if (s === 'domicilio') return 'Domicilio';
    return s || '—';
}

// ✂️ AJUSTAR PEDIDO (escenario 3 · 20-sep-2026): sacar el producto que no se puede entregar.
// Devuelve el stock, su tarjeta queda "no disponible", se recalcula el total y —si ya pagó—
// el cliente elige entre devolución o crédito.
function abrirAjuste(ref) {
    const o = (orders || []).find(x => x.reference === ref);
    if (!o) { showToast('❌ No encontré el pedido'); return; }
    const items = o.items || [];
    if (!items.length) { showToast('❌ El pedido no tiene productos'); return; }

    const filas = items.map((it, i) =>
        '<label style="display:flex;gap:10px;align-items:flex-start;padding:10px;border:1.5px solid #ffd9d2;border-radius:12px;margin-bottom:8px;cursor:pointer;">'
        + '<input type="checkbox" class="ajuste-item" data-idx="' + i + '" style="width:auto;margin-top:4px;">'
        + '<div><b>' + (it.name || 'Producto') + '</b> ×' + (it.qty || 1) + (it.size ? ' · Talla ' + it.size : '')
        + '<br><small style="color:#8a6b66;">$' + (Number(it.price) || 0).toFixed(2) + ' c/u</small></div></label>').join('');

    const d = document.createElement('div');
    d.id = 'ajuste-overlay';
    d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    d.innerHTML = '<div style="background:#fff;border-radius:16px;max-width:520px;width:100%;max-height:88vh;overflow:auto;padding:22px;">'
        + '<h3 style="margin:0 0 6px;">✂️ Ajustar pedido</h3>'
        + '<p style="font-size:.82rem;color:#8a6b66;margin:0 0 14px;">Pedido <b>' + ref + '</b> · Total actual <b>$' + (Number(o.total) || 0).toFixed(2) + '</b><br>'
        + 'Marcá el producto que <b>no se puede entregar</b> 👇</p>'
        + filas
        + '<label style="display:block;font-size:.82rem;font-weight:600;margin:12px 0 6px;">¿Qué pasó?</label>'
        + '<select id="ajuste-motivo" style="width:100%;padding:9px;border-radius:10px;border:1.5px solid #ffd9d2;">'
        + '<option value="se dañó">Se dañó o se manchó</option><option value="se perdió">Se perdió</option>'
        + '<option value="no está">No lo encuentro</option><option value="otro">Otro motivo</option></select>'
        + '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">'
        + '<button class="admin-btn admin-btn--ghost" id="ajuste-cancelar" style="width:auto;">Cancelar</button>'
        + '<button class="admin-btn admin-btn--danger" id="ajuste-ok" style="width:auto;">Quitar del pedido</button>'
        + '</div></div>';
    document.body.appendChild(d);
    $('ajuste-cancelar').addEventListener('click', () => d.remove());
    $('ajuste-ok').addEventListener('click', () => ejecutarAjuste(ref, items, d));
}

async function ejecutarAjuste(ref, items, overlay) {
    const marcados = [...document.querySelectorAll('.ajuste-item:checked')].map(c => items[Number(c.dataset.idx)]);
    if (!marcados.length) { showToast('📝 Marcá al menos un producto'); return; }
    const motivo = ($('ajuste-motivo') && $('ajuste-motivo').value) || 'no disponible';
    const nombres = marcados.map(i => i.name || 'producto').join(', ');
    const monto = marcados.reduce((s, i) => s + (Number(i.price) || 0) * (i.qty || 1), 0);
    if (!confirm('¿Sacar del pedido ' + nombres + '?\n\nSe devuelve el stock y el total baja $' + monto.toFixed(2) + '.')) return;
    try {
        const r = await fetch(SUPABASE_URL + '/functions/v1/contingencia', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ((session && session.token) || ANON_KEY) },
            body: JSON.stringify({
                accion: 'ajustar', reference: ref, motivo,
                items: marcados.map(i => ({ id: i.id, qty: i.qty || 1, talla: i.size || i.talla || null, name: i.name || null }))
            })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        showToast('✂️ Ajustado · total nuevo $' + Number(d.total_nuevo || 0).toFixed(2) + (d.pagado ? ' · cliente elige devolución o crédito 💛' : ''));
    } catch (e) {
        showToast('❌ No se pudo ajustar: ' + e.message);
        return;
    }
    if (overlay) overlay.remove();
    loadOrders();
    loadDespachos();
    loadContingencias();
    loadStats();
}

// 🚫 NO VINO (plan 3 · 19-sep-2026): el cliente no llegó a retirar.
// Se registra el caso, se le manda el menú (reprogramar / cancelar / hablar con Cindy)
// y tiene 48 h para responder. Si no responde: el stock vuelve solo.
// ============================================================
// 📍 CASO 2 (22-sep-2026) — CAMBIAR EL PUNTO DE ENTREGA
// ============================================================
// Puntos de entrega con su día y horario (se muestran al cambiar el punto)
const PUNTOS_ENTREGA = [
    { val: 'Plaza Merliot',   destino: 'Jue — Plaza Merliot (17:00-19:00)' },
    { val: 'Metrocentro',     destino: 'Sáb — Metrocentro (10:00-12:00)' },
    { val: 'Casa Matriz',     destino: 'Coordinar — Casa Matriz Santa Tecla' },
    { val: 'Paseo El Carmen', destino: 'Coordinar — Paseo El Carmen' },
    { val: 'C.C. La Skina',   destino: 'Coordinar — C.C. La Skina' },
    { val: 'Santa Tecla',     destino: 'Coordinar — Santa Tecla (personal)' },
    { val: 'Domicilio',       destino: 'Domicilio (motorista) — $2.50' },
];
function destinoPara(punto) {
    const p = PUNTOS_ENTREGA.find(x => x.val === punto);
    return p ? p.destino : punto;
}
function cambiarPunto(ref, destinoActual) {
    if (!ref) return;
    let ov = document.getElementById('punto-modal');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'punto-modal';
        ov.className = 'admin-modal-overlay';
        ov.style.display = 'none';
        ov.innerHTML = '<div class="admin-modal" style="width:460px;">'
            + '<div class="admin-modal__header"><h3>📍 Cambiar punto de entrega</h3>'
            + '<button class="admin-modal__close" onclick="document.getElementById(\'punto-modal\').style.display=\'none\'"><i class="fas fa-times"></i></button></div>'
            + '<div style="padding:18px 22px;">'
            + '<p style="margin:0 0 12px;color:#666;font-size:.85rem;">Pedido <strong id="punto-ref"></strong><br>'
            + 'Punto actual: <strong id="punto-actual"></strong></p>'
            + '<label style="font-size:.78rem;color:#666;">Nuevo punto</label>'
            + '<select id="punto-nuevo" style="width:100%;padding:10px;margin:6px 0 14px;border:1px solid #ddd;border-radius:8px;font-size:.9rem;">'
            + PUNTOS_ENTREGA.map(p => '<option value="' + p.val + '">' + p.val + ' · ' + p.destino + '</option>').join('')
            + '</select>'
            + '<label style="font-size:.78rem;color:#666;">Motivo (opcional)</label>'
            + '<input id="punto-motivo" placeholder="Ej: la clienta pidió otro punto" style="width:100%;padding:10px;margin:6px 0 16px;border:1px solid #ddd;border-radius:8px;font-size:.9rem;">'
            + '<button class="admin-btn" style="width:100%;" onclick="confirmarCambioPunto()">✅ Cambiar y avisar a la clienta</button>'
            + '<p style="font-size:.72rem;color:#999;margin:10px 0 0;">Se le avisa por WhatsApp y queda registrado. '
            + 'Si el paquete <strong>ya salió</strong>, el sistema te avisa para que no vaya.</p>'
            + '</div></div>';
        document.body.appendChild(ov);
    }
    document.getElementById('punto-ref').textContent = ref;
    document.getElementById('punto-actual').textContent = destinoActual || '—';
    document.getElementById('punto-motivo').value = '';
    ov.dataset.ref = ref;
    ov.style.display = 'flex';
}
async function confirmarCambioPunto() {
    const ov = document.getElementById('punto-modal');
    const ref = ov.dataset.ref;
    const punto = document.getElementById('punto-nuevo').value;
    const motivo = (document.getElementById('punto-motivo').value || '').trim();
    if (!punto) { showToast('Elegí el punto nuevo'); return; }
    ov.style.display = 'none';
    showToast('📍 Cambiando el punto...');
    try {
        const r = await fetch(SUPABASE_URL + '/functions/v1/contingencia', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY,
                       'Authorization': 'Bearer ' + ((session && session.token) || ANON_KEY) },
            body: JSON.stringify({ accion: 'cambiar_punto', reference: ref, nuevo_punto: punto,
                                   nuevo_destino: destinoPara(punto), motivo: motivo })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) {
            if (d.motivo === 'ya_salio') {
                alert('⚠️ El paquete YA SALIÓ a entrega.\n\nAvisale a la clienta que no vaya: usá el botón "📣 No vayas".');
            }
            throw new Error(d.error || ('HTTP ' + r.status));
        }
        showToast('✅ Punto cambiado a ' + d.destino + ' · se le avisó a la clienta');
    } catch (e) {
        showToast('❌ ' + e.message);
    }
    loadDespachos();
}
// 📣 El paquete ya salió: avisarle a la clienta que NO vaya
async function avisarNoVayas(ref) {
    if (!ref) return;
    if (!confirm('¿Avisarle a la clienta del pedido ' + ref + ' que NO vaya al punto?\n\n'
        + 'Se le manda un WhatsApp avisándole que el paquete ya salió y que se pasa a la próxima salida.')) return;
    try {
        const r = await fetch(SUPABASE_URL + '/functions/v1/contingencia', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY,
                       'Authorization': 'Bearer ' + ((session && session.token) || ANON_KEY) },
            body: JSON.stringify({ accion: 'cambiar_punto', reference: ref, solo_avisar: true,
                                   motivo: 'el paquete ya había salido' })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        showToast('📣 Aviso enviado · se pasa a la próxima salida');
    } catch (e) {
        showToast('❌ ' + e.message);
    }
    loadDespachos();
}

async function marcarNoVino(ref) {
    if (!ref) return;
    if (!confirm('¿El cliente NO vino a retirar el pedido ' + ref + '?\n\n'
        + 'Se le va a enviar el menú de opciones (reprogramar / cancelar / hablar con Cindy) '
        + 'y tiene 48 horas para responder. Si no responde, el producto vuelve a la tienda.')) return;
    try {
        const r = await fetch(SUPABASE_URL + '/functions/v1/pagos-noshow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ((session && session.token) || ANON_KEY) },
            body: JSON.stringify({ accion: 'noshow', reference: ref })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        showToast('🚫 Caso registrado · ' + (d.pagado ? 'AVISADO: ya pagó, te toca decidir 💰' : 'menú enviado al cliente, 48 h'));
    } catch (e) {
        showToast('❌ No se pudo registrar: ' + e.message);
        return;
    }
    loadDespachos();
    loadContingencias();
}

// 📦 Entregar TODO el pedido de una vez (registra la venta en finanzas)
async function entregarTodo(ref) {
    if (!ref) return;
    if (!confirm('¿Marcar TODO el pedido ' + ref + ' como ENTREGADO?\n\n'
        + 'Se registra la venta en finanzas (IVA, costo, comisión y utilidad).')) return;
    try {
        await api('POST', 'rpc/entregar_pedido', { p_ref: ref });
        showToast('✅ Entregado · 💰 venta registrada en finanzas');
    } catch (e) {
        if (e.status === 401) { showToast('🔒 Tu sesión expiró — volvé a entrar al panel'); return; }
        showToast('❌ No se pudo marcar entregado: ' + e.message);
        return;
    }
    loadDespachos();
    loadStats();
    cargarBadgeContingencias();
}

// Avanzar estado logístico (acción manual, nunca automática)
async function avanzarDespacho(id) {
    const d = despachos.find(x => x.id === id);
    if (!d) return;
    const actual = d.estado_logistico || 'pendiente-preparacion';
    const next = ESTADOS_NEXT[actual];
    if (!next) return;
    if (!confirm('¿Marcar como "' + ESTADOS_LABEL[next] + '"?\n\n' + d.nombre_capturado + ' — ' + d.order_reference)) return;
    try {
        await api('PATCH', 'despachos?id=eq.' + id, { estado_logistico: next, updated_at: new Date().toISOString() });
    } catch (e) {
        if (e.status === 401) { showToast('🔒 Tu sesión expiró — volvé a entrar al panel'); return; }
        showToast('❌ No se pudo actualizar: ' + e.message);
        return;
    }
    if (next === 'entregado') {
        // El registro de la venta lo hace la base de datos (IVA, costo, comisión, utilidad)
        showToast('✅ Entregado · 💰 venta registrada en finanzas');
        try { await loadOrders(); } catch (e) { /* la vista de pedidos se refresca sola */ }
        try { await loadStats(); } catch (e) { /* opcional */ }
    } else {
        showToast('✅ Despacho actualizado: ' + ESTADOS_LABEL[next]);
    }
    loadDespachos();
}

// Filtros de la tabla Despachos
document.querySelectorAll('.log-filter').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        logFilter = btn.dataset.logFilter;
        renderDespachos();
    });
});

// ===== SALIDAS (agrupación por punto) =====
async function loadSalidas() {
    const data = await api('GET', 'despachos?select=*&order=created_at.asc&limit=300');
    despachos = Array.isArray(data) ? data : [];
    // Cargar pedidos para mostrar precio/método de pago en el detalle
    try {
        const ordersData = await api('GET', 'orders?select=reference,total,payment_status,payment_method,status,customer_name&order=created_at.desc&limit=100');
        window._ordersAll = Array.isArray(ordersData) ? ordersData : [];
    } catch (e) { window._ordersAll = []; }
    renderSalidas();
    actualizarBadgeSalidas();
}
function actualizarBadgeSalidas() {
    const badge = $('nav-salidas-badge');
    if (!badge) return;
    const nuevos = (despachos || []).filter(d => (d.estado_logistico || '') !== 'entregado' && !d.visto).length;
    if (nuevos > 0) {
        badge.textContent = nuevos;
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}
function renderSalidas() {
    const list = $('salidas-list');
    const activos = despachos.filter(d => (d.estado_logistico || '') !== 'entregado');
    if (!activos.length) {
        list.innerHTML = '<div style="text-align:center;padding:50px;color:#999;"><i class="fas fa-truck" style="font-size:3rem;display:block;margin-bottom:12px;opacity:.3;"></i>No hay salidas pendientes 🎉</div>';
        return;
    }
    // Agrupar por TIPO de salida (c807, merliot, metrocentro, santatecla)
    const grupos = {};
    activos.forEach(d => {
        const key = salidaKey(d.destino);
        if (!grupos[key]) grupos[key] = [];
        grupos[key].push(d);
    });
    const ordenSalida = { 'c807': 1, 'merliot': 2, 'metrocentro': 3, 'santatecla': 4, 'otro': 5 };
    const keys = Object.keys(grupos).sort((a, b) => {
        const nuevosA = grupos[a].filter(d => !d.visto).length;
        const nuevosB = grupos[b].filter(d => !d.visto).length;
        if (nuevosA !== nuevosB) return nuevosB - nuevosA;
        return (ordenSalida[a] || 9) - (ordenSalida[b] || 9);
    });

    list.innerHTML = keys.map(key => {
        const g = grupos[key];
        const info = SALIDA_INFO[key] || SALIDA_INFO.otro;
        const nuevos = g.filter(d => !d.visto).length;
        const porPedido = {};
        g.forEach(d => {
            if (!porPedido[d.order_reference]) porPedido[d.order_reference] = { cliente: d.customer_name, items: [] };
            porPedido[d.order_reference].items.push(d);
        });
        const totalArticulos = g.reduce((s, d) => s + (d.qty || 1), 0);
        const totalPedidos = Object.keys(porPedido).length;
        const clientesHtml = Object.values(porPedido).map(p => p.cliente).filter((v,i,a) => v && a.indexOf(v) === i).slice(0, 3).join(', ') + (Object.values(porPedido).length > 3 ? '…' : '');
        return '<div class="salida-card salida-card--punto" onclick="abrirSalida(\'' + key + '\')" style="cursor:pointer;" title="Tocá para ver detalle">' +
            '<div class="salida-card__header">' +
                '<div style="display:flex;align-items:center;gap:12px;">' +
                    '<span style="font-size:2rem;">' + info.icon + '</span>' +
                    '<div>' +
                        '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">' +
                            '<strong style="font-size:1.15rem;">' + info.titulo + '</strong>' +
                            (nuevos > 0 ? '<span class="punto-nuevo-badge">🔔 ' + nuevos + ' nuevo' + (nuevos > 1 ? 's' : '') + '</span>' : '') +
                        '</div>' +
                        '<div style="font-size:.78rem;color:#888;margin-top:2px;">' + info.detalle + '</div>' +
                        '<div style="font-size:.78rem;color:#555;margin-top:4px;">👤 ' + (clientesHtml || '—') + '</div>' +
                    '</div>' +
                '</div>' +
                '<div style="text-align:right;">' +
                    '<div class="salida-card__count">📦 ' + totalPedidos + ' pedido' + (totalPedidos !== 1 ? 's' : '') + ' · ' + totalArticulos + ' art</div>' +
                    '<button class="admin-btn admin-btn--primary" style="margin-top:10px;padding:8px 18px;font-size:.8rem;width:auto;" onclick="event.stopPropagation();abrirSalida(\'' + key + '\')">👁️ Ver salida</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}
function escJs(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ===== ABRIR DETALLE DE UNA SALIDA (tipo: c807/merliot/metrocentro/santatecla) =====
// Se despliega EN LA MISMA PÁGINA (sin modal, a prueba de fallos)
async function abrirSalida(key) {
    try {
        const list = $('salidas-list');
        if (!list) return;
        list.innerHTML = '<div style="text-align:center;padding:30px;"><i class="fas fa-spinner fa-spin" style="font-size:2rem;color:#ff9686;"></i><p>Cargando detalle...</p></div>';
        // Consultar datos frescos directamente
        let data = despachos;
        try {
            const frescos = await api('GET', 'despachos?select=*&limit=300');
            if (Array.isArray(frescos)) data = frescos;
        } catch (e) {}
        const g = (data || []).filter(d => (d.estado_logistico || '') !== 'entregado' && salidaKey(d.destino) === key);
        if (!g.length) { list.innerHTML = '<div style="text-align:center;padding:30px;color:#999;">No hay artículos en esta salida</div>'; return; }
        // Asegurar orders cargados
        if (!window._ordersAll || !window._ordersAll.length) {
            try {
                const ordersData = await api('GET', 'orders?select=reference,total,payment_status,payment_method,status,customer_name&limit=100');
                window._ordersAll = Array.isArray(ordersData) ? ordersData : [];
            } catch (e) { window._ordersAll = []; }
        }
        const info = SALIDA_INFO[key] || SALIDA_INFO.otro;
        // Agrupar por pedido
        const porPedido = {};
        g.forEach(d => {
            if (!porPedido[d.order_reference]) porPedido[d.order_reference] = { cliente: d.customer_name, telefono: d.customer_phone, items: [] };
            porPedido[d.order_reference].items.push(d);
        });
        const pedidosHtml = Object.entries(porPedido).map(([ref, p]) => {
            const order = (window._ordersAll || []).find(o => o.reference === ref);
            const pagoTxt = order ? fmtPago(order) : 'Pago: ver pedido';
            const totalTxt = order ? '$' + Number(order.total).toFixed(2) : '';
            const itemsHtml = p.items.map(i => {
                const estado = i.estado_logistico || 'pendiente-preparacion';
                const foto = i.imagen_url
                    ? '<img src="' + i.imagen_url + '" style="width:48px;height:48px;object-fit:cover;border-radius:8px;" onerror="this.remove()">'
                    : '<span style="font-size:1.5rem;">🛍️</span>';
                return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px dotted #eee;">' +
                    foto +
                    '<div style="flex:1;">' +
                        '<div><strong>' + (i.nombre_capturado || '') + '</strong> ×' + (i.qty || 1) + (i.talla ? ' (' + i.talla + ')' : '') + '</div>' +
                        '<div style="font-size:.72rem;color:#999;">Código #' + (i.inventory_id || '') + '</div>' +
                    '</div>' +
                    '<span class="log-estado log-estado--' + estado + '">' + (ESTADOS_LABEL[estado] || estado) + '</span>' +
                '</div>';
            }).join('');
            const sede = p.items[0]?.destino || '';
            return '<div style="border:1px solid #e5e5e5;border-radius:12px;padding:14px;margin-bottom:14px;background:#fff;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:4px;">' +
                    '<strong style="font-size:.95rem;">#' + ref + '</strong>' +
                    '<span style="font-size:.8rem;">' + pagoTxt + '</span>' +
                '</div>' +
                (sede ? '<div style="font-size:.85rem;color:#333;margin-bottom:6px;">📍 Recibe en: <strong>' + String(sede).replace(/^Agencia C807 — /, '') + '</strong></div>' : '') +
                '<div style="font-size:.85rem;margin-bottom:8px;">👤 <strong>' + (p.cliente || '—') + '</strong>' + (p.telefono ? ' · ' + p.telefono : '') + '</div>' +
                itemsHtml +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">' +
                    '<span style="font-weight:800;font-size:1.05rem;">💰 ' + (totalTxt || '') + '</span>' +
                    '<a href="https://wa.me/503' + (p.telefono || '').replace(/\D/g, '') + '" target="_blank" style="background:#25D366;color:#fff;padding:7px 14px;border-radius:100px;text-decoration:none;font-size:.75rem;font-weight:600;">💬 WhatsApp</a>' +
                '</div>' +
            '</div>';
        }).join('');
        list.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">' +
                '<button class="admin-btn admin-btn--ghost" onclick="loadSalidas()" style="width:auto;padding:8px 16px;">← Volver a salidas</button>' +
                '<div><strong style="font-size:1.1rem;">' + info.icon + ' ' + info.titulo + '</strong>' +
                '<div style="font-size:.8rem;color:#888;">' + info.detalle + '</div></div>' +
            '</div>' +
            pedidosHtml;
        // Marcar como vistos (sin bloquear)
        g.forEach(d => { if (!d.visto) { d.visto = true; api('PATCH', 'despachos?id=eq.' + d.id, { visto: true }).catch(() => {}); } });
        if (typeof actualizarBadgeSalidas === 'function') actualizarBadgeSalidas();
    } catch (e) {
        console.error('Error abrirSalida:', e);
        const list = $('salidas-list');
        if (list) list.innerHTML = '<div style="text-align:center;padding:30px;color:#d32f2f;">❌ Error: ' + e.message + '</div>';
    }
}
function fmtPago(order) {
    const pm = order.payment_status || order.payment_method || '';
    if (order.payment_method === 'efectivo' || pm === 'efectivo') {
        return order.status === 'pagado' ? '<span style="color:#e67e22;font-weight:700;">💵 EFECTIVO — Pendiente de cobro/entrega</span>' : '<span style="color:#e67e22;font-weight:700;">💵 EFECTIVO — Pendiente</span>';
    }
    if (pm === 'aprobado' || order.status === 'pagado') return '<span style="color:#27ae60;font-weight:700;">💳 PAGADO (Wompi)</span>';
    if (pm === 'rechazado' || order.status === 'rechazado') return '<span style="color:#d32f2f;font-weight:700;">❌ RECHAZADO</span>';
    return '<span style="color:#888;">💳 Tarjeta — pendiente de pago</span>';
}

// ===== PRÓXIMA SALIDA =====
function renderProximaSalida() {
    const box = $('proxima-salida-box');
    if (!box) return;
    const activos = (despachos || []).filter(d => (d.estado_logistico || '') !== 'entregado' && (d.estado_logistico || '') !== 'salio');
    if (!activos.length) { box.style.display = 'none'; return; }
    // Días: C807 y Merliot = jueves; Metrocentro = sábado; Santa Tecla = coordinado
    const hoy = new Date();
    const getDia = (n) => { const d = new Date(hoy); d.setDate(hoy.getDate() + ((n - hoy.getDay() + 7) % 7)); return d; };
    const opciones = [
        { key: 'c807', fecha: getDia(4), label: '📦 C807 — Jueves por la mañana', info: 'Llevás los paquetes a la agencia C807' },
        { key: 'merliot', fecha: getDia(4), label: '🛍️ Plaza Merliot — Jueves 5:00–7:00 PM', info: 'Entrega en Plaza Merliot' },
        { key: 'metrocentro', fecha: getDia(6), label: '🏬 Metrocentro — Sábado 10:00 AM–12:00 PM', info: 'Food Court de Metrocentro' },
        { key: 'santatecla', fecha: new Date(hoy), label: '🏡 Santa Tecla — Entrega coordinada', info: 'Coordinar por WhatsApp 7662-6575' }
    ];
    // Si hoy es jueves, C807/Merliot son hoy (mañana/tarde); si sábado, Metrocentro hoy
    let lista = [];
    opciones.forEach(o => {
        const pend = activos.filter(d => salidaKey(d.destino) === o.key);
        if (!pend.length) return;
        // Si el día ya pasó hoy (jueves tarde), la salida C807 de hoy ya ocurrió
        let fecha = o.fecha;
        if (o.key === 'c807' && hoy.getDay() === 4 && hoy.getHours() >= 12) { fecha = getDia(11); }
        if (o.key === 'merliot' && hoy.getDay() === 4 && hoy.getHours() >= 19) { fecha = getDia(11); }
        if (o.key === 'metrocentro' && hoy.getDay() === 6 && hoy.getHours() >= 12) { fecha = getDia(13); }
        lista.push({ ...o, fecha, pedidos: pend.length, articulos: pend.reduce((s, d) => s + (d.qty || 1), 0) });
    });
    if (!lista.length) { box.style.display = 'none'; return; }
    lista.sort((a, b) => a.fecha - b.fecha);
    const prox = lista[0];
    $('proxima-salida-titulo').textContent = prox.label + (prox.fecha.toDateString() === hoy.toDateString() ? ' — ¡HOY!' : ' (' + prox.fecha.toLocaleDateString('es-SV', { weekday: 'long', day: 'numeric', month: 'long' }) + ')');
    $('proxima-salida-detalle').textContent = prox.info + ' · Clientes: ' + activos.filter(d => salidaKey(d.destino) === prox.key).map(d => d.customer_name).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    $('proxima-salida-conteo').textContent = '📦 ' + prox.pedidos + ' · ' + prox.articulos + ' art';
    box.style.display = '';
}

// ===== PREPARAR PEDIDOS (foto + código + descripción) =====
async function loadPreparar() {
    await cargarEstadosPago();   // PLAN 2: para saber qué pedidos están pagados
    const data = await api('GET', 'despachos?select=*&order=created_at.asc&limit=200');
    despachos = Array.isArray(data) ? data : [];
    renderPreparar();
}
function renderPreparar() {
    const grid = $('prep-grid');
    // PLAN 2 (19-sep-2026): los pedidos SIN PAGAR no se preparan (quedan visibles en Despachos
    // con la etiqueta naranja, y saltan acá solos cuando el cliente paga).
    const ocultosSinPagar = despachos.filter(d => estaSinPagar(d.order_reference)
        && ['pendiente-preparacion', 'en-preparacion'].includes(d.estado_logistico || 'pendiente-preparacion'));
    const avisoSinPagar = ocultosSinPagar.length
        ? '<div style="background:#fff4e5;border:1.5px solid #ffd8a8;border-radius:12px;padding:11px 14px;margin-bottom:14px;font-size:.82rem;color:#8a5a1f;line-height:1.5;">'
          + '⏳ <b>' + ocultosSinPagar.length + ' artículo(s) no están acá</b> porque su pedido todavía no está pagado. '
          + 'Los ves en <b>Despachos</b> con la etiqueta <i>«Sin pagar — no preparar»</i> y aparecen acá solos cuando el pago se completa 💛</div>'
        : '';
    // Vista "Pendiente de preparación" muestra pendientes + en preparación
    const pendientes = despachos.filter(d => {
        if (estaSinPagar(d.order_reference)) return false;
        const e = d.estado_logistico || 'pendiente-preparacion';
        if (prepFilter === 'pendiente-preparacion') return e === 'pendiente-preparacion' || e === 'en-preparacion';
        return e === prepFilter;
    });
    if (!pendientes.length) {
        grid.innerHTML = avisoSinPagar + '<div style="text-align:center;padding:50px;color:#999;">No hay artículos que preparar aquí 🎉</div>';
        return;
    }
    const porPedido = {};
    pendientes.forEach(d => {
        if (!porPedido[d.order_reference]) porPedido[d.order_reference] = [];
        porPedido[d.order_reference].push(d);
    });
    // ⚠️ ARREGLO 2026-09-19: antes decía `prepSelected.clear()` y los checkboxes se dibujaban
    // SIEMPRE sin marcar. Como el panel se refresca solo cada 45 s (loadSalidasSilencioso →
    // loadPreparar), el check que Cindy marcaba DESAPARECÍA y el botón decía "seleccioná un
    // artículo" → parecía que "no se guardaba". Ahora la selección se conserva y se vuelve a
    // pintar marcada.
    const idsVisibles = new Set(pendientes.map(d => String(d.id)));
    for (const id of [...prepSelected]) {
        if (!idsVisibles.has(String(id))) prepSelected.delete(id);   // descartar los que ya no están
    }
    grid.innerHTML = avisoSinPagar + Object.entries(porPedido).map(([ref, items]) => {
        const itemsHtml = items.map(d =>
            '<div class="prep-item' + (prepSelected.has(String(d.id)) ? ' prep-item--sel' : '') + '">' +
                '<label class="prep-check-wrap"><input type="checkbox" class="prep-check-item" data-despacho="' + d.id + '"' +
                (prepSelected.has(String(d.id)) ? ' checked' : '') +
                ' onchange="togglePrepItem(' + d.id + ', this.checked)"></label>' +
                '<div class="prep-item__foto">' + (d.imagen_url ? '<img src="' + d.imagen_url + '" onerror="this.remove()">' : '🛍️') + '</div>' +
                '<div class="prep-item__info">' +
                    '<div><strong>' + (d.nombre_capturado || '') + '</strong> ×' + (d.qty || 1) + (d.talla ? ' (' + d.talla + ')' : '') + '</div>' +
                    '<div class="prep-item__code">Código: #' + (d.inventory_id || '') + '</div>' +
                    '<div class="prep-item__desc" data-producto="' + d.inventory_id + '">Cargando descripción...</div>' +
                '</div>' +
            '</div>').join('');
        return '<div class="prep-card">' +
            '<div class="prep-card__header">' +
                '<strong>#' + ref + '</strong>' +
                '<span style="margin-left:auto;font-size:.8rem;color:#888;">' + (items[0].customer_name || '') + '</span>' +
            '</div>' +
            itemsHtml +
        '</div>';
    }).join('');
    cargarDescripcionesPreparar();
}
async function cargarDescripcionesPreparar() {
    const inv = await api('GET', 'inventory?select=id,name,description,sku&limit=300');
    const mapa = {};
    (Array.isArray(inv) ? inv : []).forEach(p => { mapa[p.id] = p.description || p.name || ''; });
    document.querySelectorAll('.prep-item__desc').forEach(el => {
        const id = el.dataset.producto;
        el.textContent = mapa[id] || 'Sin descripción';
    });
}
function togglePrepItem(id, checked) {
    const k = String(id);
    if (checked) prepSelected.add(k); else prepSelected.delete(k);
    // Feedback visual inmediato en la tarjeta
    const box = document.querySelector('.prep-check-item[data-despacho="' + id + '"]');
    const card = box ? box.closest('.prep-item') : null;
    if (card) card.classList.toggle('prep-item--sel', !!checked);
    actualizarContadorPrep();
}

function actualizarContadorPrep() {
    const b = $('prep-marcar-preparado');
    if (!b) return;
    const n = prepSelected.size;
    b.textContent = n ? ('✅ Marcar ' + n + ' como en preparación') : '✅ Marcar como en preparación';
}
document.querySelectorAll('.prep-filter').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.prep-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        prepFilter = btn.dataset.prepFilter;
        renderPreparar();
    });
});
$('prep-marcar-preparado').addEventListener('click', async () => {
    const ids = [...prepSelected];
    if (!ids.length) { showToast('📝 Seleccioná al menos un artículo'); return; }
    if (!confirm('¿Marcar ' + ids.length + ' artículo(s) como EN PREPARACIÓN?')) return;
    try {
        for (const id of ids) {
            await api('PATCH', 'despachos?id=eq.' + id, { estado_logistico: 'en-preparacion', updated_at: new Date().toISOString() });
        }
        prepSelected.clear();
        actualizarContadorPrep();
        showToast('✅ ' + ids.length + ' artículo(s) en preparación');
    } catch (e) {
        if (e.status === 401) { showToast('🔒 Tu sesión expiró — volvé a entrar al panel'); }
        else showToast('❌ No se pudo marcar: ' + e.message);
        return;
    }
    showToast('✅ Artículos en preparación');
    loadPreparar();
});

// ============================================================
// WHATSAPP — BANDEJA DE ENTRADA (canal oficial Cloud API)
// ============================================================
let waConversaciones = [];
let waTelActivo = null;

function waEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function waHora(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const hoy = new Date();
    const mismoDia = d.toDateString() === hoy.toDateString();
    return mismoDia
        ? d.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString('es-SV', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' });
}

// ======================================================================
// CONTINGENCIAS DE ENTREGA (plan v1.2 · 2026-09-18)
//   · Reportar un imprevisto (avisa al cliente AUTOMÁTICO con Isabel/motorista)
//   · Aprobar el nivel de compensación (escala 10/20/30/45 + sin compensación)
//   · Cancelación por enojo (efectivo): stock + disculpa + cupón 45% automático
//   · Historial completo de cada caso
// ======================================================================
const CONT_URL = SUPABASE_URL + '/functions/v1/contingencia';
const CONT_NIVELES = {
    1: '1️⃣ Leve · 10% (tope $5)',
    2: '2️⃣ Moderado · 20% ($8)',
    3: '3️⃣ Grave · 30% ($12)',
    4: '4️⃣ Muy grave · 45% ($15)',
    5: '5️⃣ Sin compensación'
};
const CONT_ESTADOS = {
    abierta: '🟡 Abierta',
    esperando_cliente: '💬 Esperando al cliente',
    esperando_aprobacion: '🎚️ Esperando tu aprobación',
    resuelta: '✅ Resuelta',
    sin_resolver: '⚪ Sin resolver'
};

async function contApi(payload) {
    const headers = { 'Content-Type': 'application/json', 'apikey': ANON_KEY };
    if (session?.token) headers['Authorization'] = 'Bearer ' + session.token;
    const r = await fetch(CONT_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || (d && d.ok === false)) throw new Error((d && (d.error || d.mensaje)) || ('HTTP ' + r.status));
    return d;
}

async function cargarBadgeContingencias() {
    try {
        const data = await api('GET', 'incidencias_entrega?select=id&estado=neq.resuelta');
        const n = Array.isArray(data) ? data.length : 0;
        const badge = $('nav-cont-badge');
        if (badge) { badge.textContent = n; badge.style.display = n ? '' : 'none'; }
    } catch (_e) { /* silencioso */ }
}

async function loadContingencias() {
    const cont = $('cont-lista');
    if (!cont) return;
    cont.innerHTML = '<div style="padding:24px;color:#999;">Cargando casos…</div>';
    try {
        const data = await api('GET', 'incidencias_entrega?select=*&order=id.desc&limit=100');
        const todas = Array.isArray(data) ? data : [];
        const abiertas = todas.filter(i => i.estado !== 'resuelta');
        const cerradas = todas.filter(i => i.estado === 'resuelta');
        const badge = $('nav-cont-badge');
        if (badge) { badge.textContent = abiertas.length; badge.style.display = abiertas.length ? '' : 'none'; }

        const tarjeta = (i, cerrada) => {
            const ref = i.order_reference || '';
            const fecha = (i.creado_en || '').slice(0, 16).replace('T', ' ');
            const opciones = (Array.isArray(i.opciones_probadas) ? i.opciones_probadas : [])
                .map(o => '· ' + (o.opcion || '') + (o.resultado ? ' → ' + o.resultado : '')).join('<br>') || '—';
            const botones = [];
            if (!cerrada) {
                if (i.estado === 'esperando_aprobacion' || i.opcion_cliente) {
                    for (const n of [1, 2, 3, 4, 5]) {
                        botones.push('<button class="admin-btn ' + (n === 5 ? 'admin-btn--ghost' : 'admin-btn--primary')
                            + '" style="padding:5px 9px;font-size:.72rem;width:auto;margin:3px 3px 0 0;" '
                            + 'onclick="contAprobar(' + i.id + ',' + n + ')">' + CONT_NIVELES[n] + '</button>');
                    }
                } else {
                    botones.push('<button class="admin-btn admin-btn--ghost" style="padding:5px 10px;font-size:.72rem;width:auto;" '
                        + 'onclick="contPedirNivel(' + i.id + ')">🎚️ Pedirme el menú de niveles</button>');
                }
                if (i.opcion_cliente === 'reembolso') {
                    botones.push('<button class="admin-btn admin-btn--ghost" style="padding:5px 10px;font-size:.72rem;width:auto;margin-left:4px;" '
                        + 'onclick="contReembolsoPagado(' + i.id + ')">💸 Ya pagué el reembolso (Wompi)</button>');
                }
            }
            return '<div style="border:1.5px solid ' + (cerrada ? '#eee' : '#ffd9d2') + ';border-radius:14px;padding:14px 16px;margin-bottom:12px;background:' + (cerrada ? '#fafafa' : '#fff7f5') + ';">'
                + '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">'
                + '<div><strong>' + (i.customer_name || 'Sin nombre') + '</strong>'
                + (i.customer_phone ? ' · ' + i.customer_phone : '')
                + (ref ? ' · <span style="font-size:.78rem;color:#999;">' + ref + '</span>' : '') + '</div>'
                + '<div style="font-size:.78rem;">' + (CONT_ESTADOS[i.estado] || i.estado) + ' · ' + fecha + '</div></div>'
                + '<div style="font-size:.82rem;margin-top:8px;">'
                + '🔎 <strong>Motivo:</strong> ' + (i.motivo || '—') + (i.detalle ? ' — ' + i.detalle : '')
                + (i.tipo === 'cancelacion_enojo' ? ' <span style="color:#b9453a;">(cancelación por enojo)</span>' : '')
                + '</div>'
                + '<div style="font-size:.78rem;color:#666;margin-top:6px;">👩 Entregador: ' + (i.entregador_nombre || i.entregador || '—')
                + (i.entregador_telefono ? ' (' + i.entregador_telefono + ')' : '') + '</div>'
                + '<div style="font-size:.75rem;color:#888;margin-top:6px;line-height:1.5;">' + opciones + '</div>'
                + (i.opcion_cliente ? '<div style="font-size:.82rem;margin-top:6px;">💬 El cliente eligió: <strong>' + i.opcion_cliente + '</strong></div>' : '')
                + (i.nivel_aprobado ? '<div style="font-size:.82rem;margin-top:4px;">🎚️ Nivel aprobado: <strong>' + i.nivel_aprobado + '</strong> · ' + (CONT_NIVELES[i.nivel_aprobado] || '') + '</div>' : '')
                + (i.cupon_codigo ? '<div style="font-size:.82rem;margin-top:4px;">🎁 Cupón: <strong>' + i.cupon_codigo + '</strong>' + (i.cupon_descuento ? ' (−$' + Number(i.cupon_descuento).toFixed(2) + ')' : '') + '</div>' : '')
                + (botones.length ? '<div style="margin-top:10px;">' + botones.join('') + '</div>' : '')
                + '</div>';
        };

        let html = '';
        if (abiertas.length) {
            html += '<h3 style="margin:6px 0 10px;font-size:1rem;">🟠 Casos abiertos (' + abiertas.length + ')</h3>'
                + abiertas.map(i => tarjeta(i, false)).join('');
        } else {
            html += '<div style="padding:22px;background:#f8fffa;border:1.5px solid #d8f0e0;border-radius:14px;color:#2c7a4b;">'
                + '✅ No hay contingencias abiertas. ¡Todo en orden!</div>';
        }
        if (cerradas.length) {
            html += '<details style="margin-top:18px;"><summary style="cursor:pointer;font-size:.9rem;color:#666;">📚 Historial (' + cerradas.length + ' casos resueltos)</summary>'
                + '<div style="margin-top:12px;">' + cerradas.map(i => tarjeta(i, true)).join('') + '</div></details>';
        }
        cont.innerHTML = html;
    } catch (e) {
        cont.innerHTML = '<div style="padding:20px;color:#b9453a;">❌ No se pudieron cargar los casos: ' + e.message + '</div>';
    }
}

// Reportar un imprevisto: elegís el pedido activo + motivo
async function contReportar() {
    const box = $('cont-nuevo');
    if (!box) return;
    box.style.display = '';
    box.innerHTML = '<div style="border:1.5px solid #ffd9d2;border-radius:14px;padding:16px;background:#fff;">'
        + '<strong>🚨 Reportar contingencia</strong>'
        + '<div style="font-size:.8rem;color:#777;margin:6px 0 10px;">El cliente recibe el aviso automático con la disculpa y el entregador de respaldo.</div>'
        + '<div id="cont-pedidos" style="font-size:.85rem;color:#999;">Cargando pedidos activos…</div>'
        + '<label style="display:block;font-size:.8rem;margin:10px 0 4px;">Motivo</label>'
        + '<select id="cont-motivo" style="width:100%;padding:9px;border:1.5px solid #ffd9d2;border-radius:10px;">'
        + '<option value="no_puedo_entregar_hoy">No puedo entregar hoy</option>'
        + '<option value="me_voy_a_atrasar">Me voy a atrasar</option>'
        + '<option value="problema_con_el_producto">El producto tuvo un problema</option>'
        + '<option value="otro">Otro (lo describo abajo)</option>'
        + '</select>'
        + '<label style="display:block;font-size:.8rem;margin:10px 0 4px;">Detalle (opcional)</label>'
        + '<textarea id="cont-detalle" rows="2" style="width:100%;padding:9px;border:1.5px solid #ffd9d2;border-radius:10px;"></textarea>'
        + '<div style="margin-top:12px;display:flex;gap:8px;">'
        + '<button class="admin-btn admin-btn--primary" style="width:auto;" onclick="contReportarEnviar()">🚨 Reportar y avisar al cliente</button>'
        + '<button class="admin-btn admin-btn--ghost" style="width:auto;" onclick="contCerrarFormulario()">Cancelar</button>'
        + '</div></div>';
    try {
        const data = await api('GET', 'orders?select=reference,customer_name,customer_phone,total,status,payment_status,delivery_point&status=in.(pendiente,pagado)&order=created_at.desc&limit=40');
        const pedidos = Array.isArray(data) ? data : [];
        const sel = $('cont-pedidos');
        if (!pedidos.length) { sel.innerHTML = 'No hay pedidos activos.'; return; }
        sel.innerHTML = '<label style="display:block;font-size:.8rem;margin-bottom:4px;">Pedido</label>'
            + '<select id="cont-ref" style="width:100%;padding:9px;border:1.5px solid #ffd9d2;border-radius:10px;">'
            + pedidos.map(p => '<option value="' + p.reference + '">' + p.reference + ' · ' + (p.customer_name || 'sin nombre')
                + ' · $' + Number(p.total || 0).toFixed(2) + ' · ' + (p.delivery_point || 'sin punto') + '</option>').join('')
            + '</select>';
    } catch (e) {
        $('cont-pedidos').innerHTML = '❌ No se pudieron cargar los pedidos: ' + e.message;
    }
}

// Engancha el botón de reportar (una sola vez, cuando el panel ya cargó)
function initContingenciasUI() {
    const b = $('cont-reportar');
    if (b) b.addEventListener('click', contReportar);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initContingenciasUI);
else initContingenciasUI();

function contCerrarFormulario() {
    const b = $('cont-nuevo');
    if (b) b.style.display = 'none';
}

async function contReportarEnviar() {
    const ref = ($('cont-ref') || {}).value;
    const motivo = ($('cont-motivo') || {}).value;
    const detalle = ($('cont-detalle') || {}).value || '';
    if (!ref) { showToast('Elegí un pedido'); return; }
    try {
        const d = await contApi({ accion: 'reportar', reference: ref, motivo, detalle });
        showToast(d.avisado_cliente ? '✅ Contingencia reportada · cliente avisado' : '⚠️ Reportada, pero el WhatsApp del cliente estaba cerrado');
        $('cont-nuevo').style.display = 'none';
        loadContingencias();
        loadDespachos();
    } catch (e) { showToast('❌ ' + e.message); }
}

async function contPedirNivel(id) {
    try { await contApi({ accion: 'pedir_nivel', incidencia_id: id }); showToast('📲 Te mandé el menú de niveles a tu WhatsApp'); }
    catch (e) { showToast('❌ ' + e.message); }
}

async function contAprobar(id, nivel) {
    const txt = CONT_NIVELES[nivel] || ('Nivel ' + nivel);
    if (!confirm('¿Aprobar ' + txt + '?\\n\\nSe le envía el cupón al cliente y el caso queda cerrado.')) return;
    try {
        const d = await contApi({ accion: 'aprobar_nivel', incidencia_id: id, nivel });
        showToast(d.cupon ? ('🎁 Listo: cupón ' + d.cupon + ' enviado al cliente') : '✅ Caso cerrado sin compensación');
        loadContingencias();
    } catch (e) { showToast('❌ ' + e.message); }
}

async function contReembolsoPagado(incidenciaId) {
    if (!confirm('¿Confirmás que ya pagaste el reembolso a mano (Wompi)?\\n\\nQueda registrado en la ficha del caso.')) return;
    try {
        const data = await api('GET', 'reembolsos?select=id&incidencia_id=eq.' + incidenciaId + '&estado=neq.pagado&order=id.desc&limit=1');
        const r = Array.isArray(data) ? data[0] : null;
        if (!r) { showToast('No hay reembolso pendiente para este caso'); return; }
        await contApi({ accion: 'reembolso_pagado', reembolso_id: r.id, incidencia_id: incidenciaId });
        showToast('✅ Reembolso marcado como pagado');
        loadContingencias();
    } catch (e) { showToast('❌ ' + e.message); }
}

// 🚫 Cancelación por enojo (efectivo): devuelve stock, disculpa y cupón 45% automático
async function cancelarPorEnojo(ref) {
    if (!ref) return;
    if (!confirm('🚫 CANCELAR LA VENTA por enojo\\n\\nPedido: ' + ref + '\\n\\nEsto hace:\\n'
        + '1) devuelve el stock al catálogo\\n2) cancela el pedido y su despacho\\n'
        + '3) manda la disculpa al cliente\\n4) le genera el cupón del 45% automáticamente\\n\\n¿Confirmás?')) return;
    try {
        const d = await contApi({ accion: 'cancelar_enojo', reference: ref });
        showToast('✅ Venta cancelada · stock devuelto (' + (d.stock_devuelto || 0) + ') · cupón ' + (d.cupon || '—') + ' enviado');
        loadDespachos();
        loadContingencias();
    } catch (e) { showToast('❌ No se pudo cancelar: ' + e.message); }
}

async function loadWhatsApp() {
    const data = await api('GET', 'wa_mensajes?select=*&order=creado_en.desc&limit=400');
    if (!Array.isArray(data)) { $('wa-conv-list').innerHTML = '<div class="wa-empty">No se pudieron cargar los mensajes</div>'; return; }

    const mapa = new Map();
    for (const m of data) {
        const tel = m.telefono;
        if (!mapa.has(tel)) mapa.set(tel, { telefono: tel, nombre: m.nombre_perfil || tel, mensajes: [], noLeidos: 0, ultimo: m });
        const c = mapa.get(tel);
        c.mensajes.unshift(m);                       // vienen desc → quedan asc
        if (!c.nombre && m.nombre_perfil) c.nombre = m.nombre_perfil;
        if (m.direccion === 'entrante' && !m.leido) c.noLeidos++;
    }

    waConversaciones = [...mapa.values()].sort(
        (a, b) => new Date(b.ultimo.creado_en) - new Date(a.ultimo.creado_en)
    );

    renderWaConversaciones();
    actualizarBadgeWa();

    if (waTelActivo) {
        const sigue = waConversaciones.find(c => c.telefono === waTelActivo);
        if (sigue) renderWaHilo();
    }
}

function renderWaConversaciones() {
    const q = ($('wa-search').value || '').toLowerCase().trim();
    const lista = waConversaciones.filter(c =>
        !q || (c.nombre || '').toLowerCase().includes(q) || c.telefono.includes(q));

    if (!lista.length) {
        $('wa-conv-list').innerHTML = '<div class="wa-empty">Sin conversaciones todavía</div>';
        return;
    }

    $('wa-conv-list').innerHTML = lista.map(c => `
        <div class="wa-conv__item ${c.telefono === waTelActivo ? 'wa-conv__item--active' : ''} ${c.noLeidos ? 'wa-conv__item--unread' : ''}"
             onclick="abrirWaConversacion('${c.telefono}')">
            <div class="wa-conv__top">
                <span class="wa-conv__name">${waEsc(c.nombre)}</span>
                <span class="wa-conv__time">${waHora(c.ultimo.creado_en)}</span>
            </div>
            <div class="wa-conv__top">
                <span class="wa-conv__preview">${c.ultimo.direccion === 'saliente' ? '↩ ' : ''}${waEsc(c.ultimo.texto)}</span>
                ${c.noLeidos ? `<span class="wa-conv__badge">${c.noLeidos}</span>` : ''}
            </div>
        </div>`).join('');
}

async function abrirWaConversacion(tel) {
    waTelActivo = tel;
    const conv = waConversaciones.find(c => c.telefono === tel);
    renderWaConversaciones();
    renderWaHilo();
    $('wa-reply-box').style.display = 'flex';

    // marcar como leídos los entrantes de esa conversación
    if (conv && conv.noLeidos > 0) {
        await api('PATCH', `wa_mensajes?telefono=eq.${tel}&direccion=eq.entrante&leido=eq.false`, { leido: true });
        conv.noLeidos = 0;
        renderWaConversaciones();
        actualizarBadgeWa();
    }
}

function renderWaHilo() {
    const conv = waConversaciones.find(c => c.telefono === waTelActivo);
    if (!conv) return;

    $('wa-chat-head').innerHTML =
        `<span>${waEsc(conv.nombre)}</span>
         <span style="font-size:.78rem;color:#999;">+${waEsc(conv.telefono)}</span>
         <a href="https://wa.me/${conv.telefono}" target="_blank" rel="noopener">Abrir en WhatsApp ↗</a>`;

    $('wa-chat-body').innerHTML = conv.mensajes.map(m => `
        <div class="wa-msg ${m.direccion === 'saliente' ? 'wa-msg--out' : 'wa-msg--in'}">
            ${waEsc(m.texto)}
            <span class="wa-msg__time">${waHora(m.creado_en)}${m.direccion === 'saliente' ? ' · ' + waEsc(m.atendido_por || '') : ''}</span>
        </div>`).join('');

    const body = $('wa-chat-body');
    body.scrollTop = body.scrollHeight;
}

function actualizarBadgeWa() {
    const pendientes = waConversaciones.reduce((n, c) => n + (c.noLeidos || 0), 0);
    const badge = $('nav-wa-badge');
    if (!badge) return;
    badge.textContent = pendientes;
    badge.style.display = pendientes ? '' : 'none';
}

async function cargarBadgeWaSilencioso() {
    if (!session?.token) return;
    const data = await api('GET', 'wa_mensajes?select=telefono,direccion,leido&direccion=eq.entrante&leido=eq.false');
    if (!Array.isArray(data)) return;
    actualizarBadgeWaCon(data.length);
}

function actualizarBadgeWaCon(n) {
    const badge = $('nav-wa-badge');
    if (!badge) return;
    badge.textContent = n;
    badge.style.display = n ? '' : 'none';
}

async function enviarWaRespuesta() {
    const texto = ($('wa-reply-text').value || '').trim();
    if (!texto || !waTelActivo) return;

    const btn = $('wa-reply-send');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando';

    try {
        const r = await fetch(SUPABASE_URL + '/functions/v1/wa-enviar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token },
            body: JSON.stringify({ to: waTelActivo, texto })
        });
        const d = await r.json().catch(() => ({}));
        if (!d.ok) throw new Error(d.error || 'No se pudo enviar');

        $('wa-reply-text').value = '';
        await loadWhatsApp();
        showToast('Mensaje enviado ✅');
    } catch (e) {
        showToast('⚠️ ' + (e.message || 'Error al enviar'));
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Enviar';
    }
}

$('wa-refresh')?.addEventListener('click', loadWhatsApp);
$('wa-search')?.addEventListener('input', renderWaConversaciones);
$('wa-reply-send')?.addEventListener('click', enviarWaRespuesta);
$('wa-reply-text')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarWaRespuesta(); }
});
