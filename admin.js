// ============================================================
// BARATUSS — Panel de Administración (versión fetch directo)
// ============================================================

const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const ANON_KEY = 'sb_publishable_m85uJKNu8Izi5ujT8ukWWQ_XvEMOToA';

const $ = id => document.getElementById(id);

let session = JSON.parse(localStorage.getItem('baratuss_admin_session') || 'null');
let inventory = [];
let orders = [];

// ===== API HELPERS (fetch directo, sin librería CDN) =====
async function api(method, path, body) {
    const headers = { 'apikey': ANON_KEY, 'Content-Type': 'application/json' };
    if (session?.token) headers['Authorization'] = 'Bearer ' + session.token;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
    if (r.status === 204) return null;
    return r.json().catch(() => null);
}

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
        if (item.dataset.section === 'resumen') loadStats();
    });
});

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
        $('inventory-body').innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#999;">No hay productos</td></tr>';
        return;
    }

    $('inventory-body').innerHTML = filtered.map(p => `
        <tr>
            <td class="admin-mono">${p.sku || '—'}</td>
            <td><strong>${p.emoji || ''} ${p.name}</strong> ${p.active === false ? '<span class="admin-badge admin-badge--rechazado">oculto</span>' : ''}</td>
            <td><span class="admin-badge admin-badge--cat">${capitalize(p.category)}</span></td>
            <td><span class="admin-badge ${p.tipo === 'usado' ? 'admin-badge--usado' : 'admin-badge--nuevo'}">${p.tipo}</span></td>
            <td>$${Number(p.cost_price || 0).toFixed(2)}</td>
            <td>$${Number(p.sale_price || 0).toFixed(2)}</td>
            <td><span class="admin-stock ${p.stock <= 3 ? 'admin-stock--low' : ''}">${p.stock}</span></td>
            <td class="admin-actions">
                <button class="admin-icon-btn" onclick="editProduct(${p.id})" title="Editar"><i class="fas fa-edit"></i></button>
                <button class="admin-icon-btn admin-icon-btn--danger" onclick="deleteProduct(${p.id})" title="Eliminar"><i class="fas fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}

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
    $('product-modal-overlay').style.display = 'flex';
}

function closeProductModal() {
    $('product-modal-overlay').style.display = 'none';
    $('product-form').reset();
}

$('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('product-id').value;
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
        active: $('product-active').value === 'true',
        updated_at: new Date().toISOString()
    };

    let ok;
    if (id) {
        const r = await api('PATCH', 'inventory?id=eq.' + id, data);
        ok = r === null || !r?.error;
    } else {
        const r = await api('POST', 'inventory', data);
        ok = !r?.error;
    }

    if (!ok) { showToast('❌ Error al guardar'); return; }
    showToast(id ? '✅ Producto actualizado' : '✅ Producto creado');
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
        $('orders-body').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#999;">No hay pedidos</td></tr>';
        return;
    }
    $('orders-body').innerHTML = orders.map(o => {
        const items = (o.items || []).map(i => `${i.name} ×${i.qty}`).join(', ');
        const payStatus = o.payment_status || 'pendiente';
        return `
        <tr>
            <td class="admin-mono">${o.reference || o.id?.slice(0, 8) || '—'}</td>
            <td>${items || '—'}</td>
            <td>$${Number(o.total).toFixed(2)}</td>
            <td><span class="admin-badge admin-badge--${o.status || 'pendiente'}">${capitalize(o.status || 'pendiente')}</span></td>
            <td><span class="admin-badge admin-badge--${payStatus}">${capitalize(payStatus)}</span></td>
            <td>${new Date(o.created_at).toLocaleDateString('es-SV')}</td>
        </tr>`;
    }).join('');
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
}

// ===== HELPERS =====
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function showToast(msg) {
    const toast = $('admin-toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ===== INIT =====
(function init() {
    if (session?.profile?.is_admin) {
        enterDashboard();
    }
})();
