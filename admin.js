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
const PRICE_FACTOR = 1.16955;  // 1.13 × 1.035 (IVA 13% + comisión Wompi 3.50%)
const PRICE_FEE = 0.25;
function finalPrice(price) {
    if (!price) return 0;
    const raw = Number(price) * PRICE_FACTOR + PRICE_FEE;
    // Redondear al 0.05 más cercano hacia arriba: 7.52 → 7.55
    return Math.ceil(raw * 20) / 20;
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
