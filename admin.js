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
async function api(method, path, body) {
    const headers = { 'apikey': ANON_KEY, 'Content-Type': 'application/json' };
    if (session?.token) headers['Authorization'] = 'Bearer ' + session.token;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
    if (r.status === 204) return null;
    return r.json().catch(() => null);
}

// ===== PRICING (misma fórmula que la tienda) =====
const PRICE_FACTOR = 1.189325;
const PRICE_FEE = 0.25;
function finalPrice(price) {
    if (!price) return 0;
    return Math.round((Number(price) * PRICE_FACTOR + PRICE_FEE) * 100) / 100;
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
            <td><span class="admin-badge admin-badge--cat">${capitalize(p.category)}</span></td>
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
    // Foto existente
    selectedImageFile = null;
    existingImageUrl = product?.image_url || null;
    $('product-image').value = '';
    if (existingImageUrl) {
        $('product-image-preview-img').src = existingImageUrl;
        $('product-image-preview-img').style.display = '';
        $('product-image-preview-empty').style.display = 'none';
    } else {
        $('product-image-preview-img').style.display = 'none';
        $('product-image-preview-empty').style.display = '';
    }
    updateSalePreview();
    $('product-modal-overlay').style.display = 'flex';
}

// Vista previa en vivo: cuánto paga el cliente
function updateSalePreview() {
    const sale = parseFloat($('product-sale').value) || 0;
    const total = finalPrice(sale);
    $('sale-preview').textContent = `El cliente pagará: $${total.toFixed(2)} (IVA 13% + comisión Wompi incluidos)`;
}
$('product-sale').addEventListener('input', updateSalePreview);

// Vista previa de la foto seleccionada
let selectedImageFile = null;
let existingImageUrl = null;

function previewProductImage(input) {
    const file = input.files?.[0];
    if (!file) return;
    selectedImageFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
        $('product-image-preview-img').src = e.target.result;
        $('product-image-preview-img').style.display = '';
        $('product-image-preview-empty').style.display = 'none';
    };
    reader.readAsDataURL(file);
}

// Subir foto a Supabase Storage
async function uploadProductImage() {
    if (!selectedImageFile) return existingImageUrl || null;
    if (!session?.token) return null;
    try {
        const ext = selectedImageFile.name.split('.').pop() || 'jpg';
        const filename = 'prod-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
        const resp = await fetch(SUPABASE_URL + '/storage/v1/object/productos/' + filename, {
            method: 'POST',
            headers: {
                'apikey': ANON_KEY,
                'Authorization': 'Bearer ' + session.token,
                'Content-Type': selectedImageFile.type || 'image/jpeg',
                'x-upsert': 'true'
            },
            body: selectedImageFile
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.message || 'Error subiendo foto');
        }
        return SUPABASE_URL + '/storage/v1/object/public/productos/' + filename;
    } catch (e) {
        console.error('Upload error:', e);
        showToast('❌ No se pudo subir la foto: ' + e.message);
        return existingImageUrl || null;
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
    
    // Subir foto primero (si hay)
    const imageUrl = await uploadProductImage();
    if (selectedImageFile && !imageUrl) {
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
        active: $('product-active').value === 'true',
        updated_at: new Date().toISOString()
    };
    if (imageUrl) data.image_url = imageUrl;

    let ok;
    if (id) {
        const old = inventory.find(p => p.id === parseInt(id));
        if (old?.image_url && selectedImageFile) removeOldImageIfReplaced(old.image_url, imageUrl);
        const r = await api('PATCH', 'inventory?id=eq.' + id, data);
        ok = r === null || !r?.error;
    } else {
        const r = await api('POST', 'inventory', data);
        ok = !r?.error;
    }

    btn.disabled = false; btn.textContent = 'Guardar';
    if (!ok) { showToast('❌ Error al guardar'); return; }
    showToast(id ? '✅ Producto actualizado' : '✅ Producto creado');
    selectedImageFile = null;
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
        const canMarkPaid = isCash && payStatus !== 'pagado';
        return `
        <tr>
            <td class="admin-mono">${o.reference || o.id?.slice(0, 8) || '—'}</td>
            <td>${items || '—'}</td>
            <td>$${Number(o.total).toFixed(2)}</td>
            <td><span class="admin-badge admin-badge--${o.status || 'pendiente'}">${capitalize(o.status || 'pendiente')}</span></td>
            <td>
                <span class="admin-badge ${isCash ? 'admin-badge--efectivo' : 'admin-badge--aprobado'}">${isCash ? '💵 Efectivo' : capitalize(payStatus)}</span>
                ${delivery ? `<br><small style="color:#888;">${delivery}</small>` : ''}
            </td>
            <td>${customer || new Date(o.created_at).toLocaleDateString('es-SV')}</td>
            <td>
                <small style="color:#aaa;">${new Date(o.created_at).toLocaleDateString('es-SV')}</small>
                ${canMarkPaid ? `<br><button class="admin-btn admin-btn--primary" style="width:auto;padding:6px 10px;font-size:0.75rem;margin-top:6px;" onclick="markCashPaid('${o.id}')">✅ Marcar pagado</button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

// Marcar pedido en efectivo como pagado/entregado
async function markCashPaid(id) {
    if (!confirm('¿Marcar este pedido como PAGADO y ENTREGADO?')) return;
    await api('PATCH', 'orders?id=eq.' + id, {
        payment_status: 'pagado',
        status: 'entregado',
        payment_date: new Date().toISOString(),
        updated_at: new Date().toISOString()
    });
    showToast('✅ Pedido marcado como pagado');
    loadOrders();
    loadStats();
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
