// ============================================================
// BARATUSS — Panel de Administración
// ============================================================

const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_m85uJKNu8Izi5ujT8ukWWQ_XvEMOToA';

const supabase = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let inventory = [];
let orders = [];

// ===== DOM REFS =====
const $ = id => document.getElementById(id);

// ===== AUTH — Login =====
async function loginAdmin(email, password) {
    if (!supabase) return { error: 'Supabase no conectado' };
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { data };
}

// ===== CHECK ADMIN =====
async function checkAdmin() {
    if (!supabase) return false;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return false;
    
    const { data: profile } = await supabase
        .from('profiles')
        .select('is_admin, name, email')
        .eq('id', session.user.id)
        .single();
    
    if (profile?.is_admin) {
        currentUser = { ...session.user, profile };
        return true;
    }
    return false;
}

// ===== LOGIN FORM =====
$('admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Ingresando...';
    $('admin-login-error').textContent = '';
    
    try {
        // Login directo SIN limpiar sesión (evita cuelgues)
        const result = await loginAdmin(
            $('admin-email').value,
            $('admin-password').value
        );
        
        if (result.error) {
            $('admin-login-error').textContent = '❌ ' + result.error;
            btn.disabled = false; btn.textContent = 'Ingresar';
            return;
        }
        
        const isAdmin = await checkAdmin();
        if (!isAdmin) {
            try { await supabase.auth.signOut(); } catch (err) {}
            $('admin-login-error').textContent = '❌ Esta cuenta no tiene permisos de administradora';
            btn.disabled = false; btn.textContent = 'Ingresar';
            return;
        }
        
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
    $('admin-user-name').textContent = currentUser.profile?.name || 'Admin';
    loadInventory();
    loadOrders();
    loadStats();
}

// ===== LOGOUT =====
$('admin-logout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.reload();
});

// ===== NAV =====
document.querySelectorAll('.admin-nav__item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.admin-nav__item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        
        const section = item.dataset.section;
        document.querySelectorAll('.admin-section').forEach(s => s.style.display = 'none');
        $('section-' + section).style.display = '';
        
        if (section === 'pedidos') loadOrders();
        if (section === 'resumen') loadStats();
    });
});

// ===== INVENTORY CRUD =====
async function loadInventory() {
    if (!supabase) return;
    const { data } = await supabase.from('inventory').select('*').order('id', { ascending: false });
    inventory = data || [];
    renderInventory();
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
            <td>
                <span class="admin-stock ${p.stock <= 3 ? 'admin-stock--low' : ''}">${p.stock}</span>
            </td>
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

// ===== ADD / EDIT PRODUCT =====
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
    
    let result;
    if (id) {
        result = await supabase.from('inventory').update(data).eq('id', id);
    } else {
        result = await supabase.from('inventory').insert(data);
    }
    
    if (result.error) {
        showToast('❌ ' + result.error.message);
        return;
    }
    
    showToast(id ? '✅ Producto actualizado' : '✅ Producto creado');
    closeProductModal();
    loadInventory();
    loadStats();
});

// ===== EDIT =====
async function editProduct(id) {
    const product = inventory.find(p => p.id === id);
    if (product) openProductModal(product);
}

// ===== DELETE =====
async function deleteProduct(id) {
    if (!confirm('¿Eliminar este producto?')) return;
    const { error } = await supabase.from('inventory').delete().eq('id', id);
    if (error) { showToast('❌ ' + error.message); return; }
    showToast('🗑️ Producto eliminado');
    loadInventory();
    loadStats();
}

// ===== ORDERS =====
async function loadOrders() {
    if (!supabase) return;
    const { data } = await supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(50);
    orders = data || [];
    renderOrders();
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
    
    if (orders.length === 0) {
        const { data } = await supabase.from('orders').select('*').limit(1000);
        orders = data || [];
    }
    
    $('stat-orders').textContent = orders.length;
    $('stat-paid').textContent = orders.filter(o => o.payment_status === 'aprobado' || o.status === 'pagado').length;
    
    // Stock alert
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
async function init() {
    try {
        const isAdmin = await checkAdmin();
        if (isAdmin) {
            enterDashboard();
        }
    } catch (e) {
        console.log('Init check:', e.message);
    }
}

init();
