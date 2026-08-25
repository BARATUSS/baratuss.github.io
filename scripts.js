// ========================================================================
// BARATUSS — Complete e-commerce system
// ========================================================================

// ===== SUPABASE CONFIG =====
const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_m85uJKNu8Izi5ujT8ukWWQ_XvEMOToA';
const WOMPI_API_URL = 'https://lizybztwnlrlvsrmgnug.functions.supabase.co/wompi-checkout';
let supabaseClient = null;

function getSupabase() {
    if (supabaseClient) return supabaseClient;
    if (window.supabase && window.supabase.createClient) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        return supabaseClient;
    }
    return null;
}

// ===== PRICING (IVA 13% + comisión Wompi 3.50% + $0.25) =====
const PRICE_FACTOR = 1.16955;  // 1.13 × 1.035 (IVA 13% + comisión Wompi 3.50%)
const PRICE_FEE = 0.25;
function finalPrice(price) {
    if (!price) return 0;
    const raw = Number(price) * PRICE_FACTOR + PRICE_FEE;
    // Redondear al 0.05 más cercano hacia arriba: 7.52 → 7.55
    return Math.ceil(raw * 20) / 20;
}

// Color nombre → hex (puntitos en la tienda)
function colorHex(name) {
    const map = {
        'negro': '#1a1a1a', 'blanco': '#f5f5f5', 'gris': '#9e9e9e', 'rojo': '#e74c3c',
        'azul': '#2980b9', 'verde': '#27ae60', 'amarillo': '#f1c40f', 'rosado': '#ff9686',
        'morado': '#8e44ad', 'naranja': '#e67e22', 'marrón': '#6d4c41', 'beige': '#d7c4a3'
    };
    return map[name.toLowerCase()] || '#cccccc';
}

// ===== PRODUCT DATA (fallback si Supabase falla) =====
let products = [
    { id: 1, name: 'Vestido Floral Primavera', category: 'ropa', price: 49.99, originalPrice: 69.99, badge: 'Oferta', imgClass: 'p-1', emoji: '👗' },
    { id: 2, name: 'Camisa Premium Blanca', category: 'ropa', price: 39.99, originalPrice: null, badge: null, imgClass: 'p-2', emoji: '👔' },
    { id: 3, name: 'Chaqueta Oversize', category: 'ropa', price: 89.99, originalPrice: null, badge: 'Nuevo', imgClass: 'p-4', emoji: '🧥' },
    { id: 4, name: 'Sudadera con Capucha', category: 'ropa', price: 44.99, originalPrice: null, badge: null, imgClass: 'p-5', emoji: '🏷️' },
    { id: 5, name: 'Jeans Skinny Azul', category: 'ropa', price: 54.99, originalPrice: null, badge: null, imgClass: 'p-7', emoji: '👖' },
    { id: 6, name: 'Camisa Negra', category: 'ropa', price: 5.00, originalPrice: null, badge: 'Nuevo', imgClass: 'p-9', emoji: '🖤' },
    { id: 7, name: 'Bolso Tote de Cuero', category: 'accesorios', price: 59.99, originalPrice: 79.99, badge: 'Oferta', imgClass: 'p-3', emoji: '👜' },
    { id: 8, name: 'Gafas de Sol Aviador', category: 'accesorios', price: 29.99, originalPrice: 39.99, badge: 'Oferta', imgClass: 'p-6', emoji: '🕶️' },
    { id: 9, name: 'Reloj Deportivo', category: 'accesorios', price: 34.99, originalPrice: null, badge: 'Nuevo', imgClass: 'p-8', emoji: '⌚' },
    { id: 10, name: 'Collar Minimalista', category: 'accesorios', price: 19.99, originalPrice: null, badge: null, imgClass: 'p-12', emoji: '📿' },
    { id: 11, name: 'Crema Facial Hidratante', category: 'skincare', price: 24.99, originalPrice: null, badge: null, imgClass: 'p-10', emoji: '🧴' },
    { id: 12, name: 'Sérum Vitamina C', category: 'skincare', price: 34.99, originalPrice: 44.99, badge: 'Oferta', imgClass: 'p-11', emoji: '✨' },
];

// Cargar productos desde Supabase (inventario)
async function loadProductsFromSupabase() {
    const client = getSupabase();
    if (!client) return;
    try {
        const { data, error } = await client
            .from('inventory')
            .select('id, name, category, sale_price, original_price, badge, img_class, emoji, tipo, stock, image_url, images, colors')
            .eq('active', true)
            .order('id', { ascending: true });
        
        if (error) throw error;
        if (data && data.length > 0) {
            products = data.map(p => ({
                id: p.id,
                name: p.name,
                category: p.category || 'ropa',
                price: finalPrice(p.sale_price),
                originalPrice: p.original_price ? finalPrice(p.original_price) : null,
                badge: p.badge || null,
                imgClass: p.img_class || 'p-1',
                emoji: p.emoji || '🛍️',
                tipo: p.tipo || 'nuevo',
                stock: p.stock || 0,
                image: p.image_url || null,
                images: Array.isArray(p.images) ? p.images.filter(Boolean) : (p.image_url ? [p.image_url] : []),
                colors: p.colors || null
            }));
            renderProducts(currentFilter);
            updateCartUI();
        }
    } catch (e) {
        console.log('Usando productos de respaldo:', e.message);
    }
}

// ===== STATE =====
let cart = JSON.parse(localStorage.getItem('baratuss_cart')) || [];
let currentFilter = 'all';
let currentUser = null;
let wishlist = new Set();
let isSupabaseReady = false;

// ===== DOM REFS =====
const $ = id => document.getElementById(id);
const productsGrid = $('products-grid');
const cartSidebar = $('cart-sidebar');
const cartOverlay = $('cart-overlay');
const cartCount = $('cart-count');
const cartItems = $('cart-items');
const cartFooter = $('cart-footer');
const cartTotal = $('cart-total');
const toast = $('toast');
const header = $('header');

// ===== SUPABASE CHECK =====
function checkSupabase() {
    const client = getSupabase();
    if (client) {
        isSupabaseReady = true;
        return true;
    }
    // Retry after a brief delay for CDN to load
    setTimeout(() => {
        const retry = getSupabase();
        if (retry) {
            isSupabaseReady = true;
            initApp();
        }
    }, 1500);
    return false;
}

// ===== AUTH — GET SUPABASE CLIENT =====
function sb() {
    return getSupabase();
}

// ===== AUTH — Register =====
async function registerUser(name, email, phone, password) {
    const client = sb();
    if (!client) return { error: 'Supabase no conectado' };
    
    const { data, error } = await client.auth.signUp({
        email, password,
        options: { data: { name, phone } }
    });
    if (error) return { error: error.message };
    
    // Create profile
    if (data.user) {
        await client.from('profiles').insert({
            id: data.user.id,
            name,
            email,
            phone,
            address: '',
            city: ''
        });
    }
    return { data, needsVerification: true };
}

// ===== AUTH — Login =====
async function loginUser(email, password) {
    const client = sb();
    if (!client) return { error: 'Supabase no conectado' };
    
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { data };
}

// ===== AUTH — Logout =====
async function logoutUser() {
    const client = sb();
    if (client) await client.auth.signOut();
    currentUser = null;
    wishlist.clear();
    updateAuthUI();
    closeAllModals();
    showToast('Sesión cerrada');
}

// ===== AUTH — Password Reset =====
async function resetPassword(email) {
    const client = sb();
    if (!client) return { error: 'Supabase no conectado' };
    const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + '/tienda-ropa/'
    });
    return { error: error?.message };
}

// ===== AUTH — Check Session =====
async function checkSession() {
    if (!isSupabaseReady) checkSupabase();
    const client = sb();
    if (!client) return;
    
    const { data: { session } } = await client.auth.getSession();
    if (session?.user) {
        currentUser = session.user;
        await loadProfile();
        await loadWishlist();
    }
    updateAuthUI();
}

// ===== PROFILE — Load =====
async function loadProfile() {
    if (!currentUser) return;
    const client = sb();
    const { data } = await client.from('profiles').select('*').eq('id', currentUser.id).single();
    if (data) {
        currentUser.profile = data;
        $('profile-name').value = data.name || '';
        $('profile-email').value = data.email || currentUser.email;
        $('profile-phone').value = data.phone || '';
        $('profile-address').value = data.address || '';
        $('profile-city').value = data.city || '';
    }
}

// ===== PROFILE — Save =====
async function saveProfile(data) {
    if (!currentUser) return { error: 'No has iniciado sesión' };
    const client = sb();
    const { error } = await client.from('profiles').upsert({
        id: currentUser.id,
        ...data,
        updated_at: new Date().toISOString()
    });
    if (error) return { error: error.message };
    currentUser.profile = { ...currentUser.profile, ...data };
    showToast('Perfil actualizado ✅');
    return { success: true };
}

// ===== ORDERS — Create =====
async function createOrder(items, total) {
    if (!currentUser) return { error: 'Inicia sesión para comprar' };
    const client = sb();
    const { data, error } = await client.from('orders').insert({
        user_id: currentUser.id,
        items,
        total,
        status: 'pendiente'
    }).select().single();
    return { data, error: error?.message };
}

// ===== ORDERS — Load =====
async function loadOrders() {
    if (!currentUser) return [];
    const client = sb();
    const { data } = await client.from('orders')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false });
    return data || [];
}

// ===== WISHLIST — Add/Remove =====
async function toggleWishlist(productId) {
    if (!currentUser) {
        showToast('Inicia sesión para guardar favoritos');
        openModal('login');
        return;
    }
    
    const client = sb();
    if (wishlist.has(productId)) {
        await client.from('wishlists').delete()
            .eq('user_id', currentUser.id)
            .eq('product_id', productId);
        wishlist.delete(productId);
        showToast('Eliminado de favoritos');
    } else {
        await client.from('wishlists').insert({
            user_id: currentUser.id,
            product_id: productId
        });
        wishlist.add(productId);
        showToast('Guardado en favoritos ♥');
    }
    updateWishlistUI();
    renderProducts(currentFilter);
}

// ===== WISHLIST — Load =====
async function loadWishlist() {
    if (!currentUser) return;
    const client = sb();
    const { data } = await client.from('wishlists').select('product_id').eq('user_id', currentUser.id);
    wishlist = new Set(data?.map(d => d.product_id) || []);
    updateWishlistUI();
}

// ===== WISHLIST — Get wishlist product data =====
function getWishlistProducts() {
    return products.filter(p => wishlist.has(p.id));
}

// ===== RENDER PRODUCTS =====
function renderProducts(filter = 'all') {
    const filtered = filter === 'all' ? products : products.filter(p => p.category === filter);
    
    productsGrid.innerHTML = filtered.map(p => {
        const isFav = wishlist.has(p.id);
        return `
        <div class="product-card" data-id="${p.id}" style="cursor:pointer;">
            <button class="wish-btn ${isFav ? 'wish-btn--active' : ''}" data-id="${p.id}" aria-label="Favoritos">
                <i class="${isFav ? 'fas' : 'far'} fa-heart"></i>
            </button>
            <div class="product-card__img ${p.imgClass}">
                ${p.image ? `<img src="${p.image}" alt="${p.name}" class="product-card__photo" loading="lazy" onerror="this.remove()">` : `<span style="font-size:3.5rem;">${p.emoji}</span>`}
                ${p.badge ? `<span class="badge">${p.badge}</span>` : ''}
            </div>
            ${(p.images && p.images.length > 1) ? `<div class="product-card__thumbs" onclick="event.stopPropagation()">${p.images.map((url, ti) => `
                <img src="${url}" class="product-card__thumb ${ti === 0 ? 'product-card__thumb--active' : ''}" data-idx="${ti}" onclick="switchProductPhoto(${p.id}, ${ti}, this)" alt="" loading="lazy">`).join('')}
            </div>` : ''}
            <div class="product-card__body">
                <div class="product-card__category">${capitalize(p.category)}</div>
                <div class="product-card__name">${p.name}</div>
                ${p.colors ? `<div class="product-card__colors" title="${p.colors}">${p.colors.split(',').map(c => `<span class="product-color-dot" style="background:${colorHex(c.trim())}"></span>`).join('')}<small>${p.colors}</small></div>` : ''}
                <div class="product-card__price">
                    <span class="current">$${p.price.toFixed(2)}</span>
                    ${p.originalPrice ? `<span class="original">$${p.originalPrice.toFixed(2)}</span>` : ''}
                </div>
                <div class="product-card__tax">IVA y comisión incluidos</div>
                <button class="add-to-cart" data-id="${p.id}">
                    <i class="fas fa-shopping-bag"></i> Añadir
                </button>
                ${p.id === 6 ? `<button class="add-to-cart buy-now-wompi" data-id="${p.id}" style="display:block;text-align:center;margin-top:8px;padding:10px;background:#ff9686;color:white;border-radius:10px;font-size:0.8rem;font-weight:500;border:none;cursor:pointer;width:100%;">⚡ Comprar ahora</button>` : ''}
            </div>
        </div>`;
    }).join('');

    // Attach events
    document.querySelectorAll('.add-to-cart').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); addToCart(parseInt(btn.dataset.id)); });
    });
    document.querySelectorAll('.wish-btn').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); toggleWishlist(parseInt(btn.dataset.id)); });
    });
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ===== CATEGORY CARD / FILTER LINK CLICKS =====
document.querySelectorAll('.cat-card, .filter-link').forEach(el => {
    el.addEventListener('click', function(e) {
        if (this.classList.contains('filter-link')) e.preventDefault();
        const filter = this.dataset.filter;
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`.filter-btn[data-filter="${filter}"]`)?.classList.add('active');
        currentFilter = filter;
        renderProducts(filter);
        document.getElementById('tienda').scrollIntoView({ behavior: 'smooth' });
    });
});

// ===== GALERÍA DE FOTOS =====
function switchProductPhoto(id, idx, el) {
    const product = products.find(p => p.id === id);
    if (!product || !product.images || !product.images[idx]) return;
    const card = el.closest('.product-card');
    const photo = card?.querySelector('.product-card__photo');
    if (photo) {
        photo.src = product.images[idx];
        photo.removeAttribute('onerror');
    }
    card?.querySelectorAll('.product-card__thumb').forEach(t => t.classList.remove('product-card__thumb--active'));
    el.classList.add('product-card__thumb--active');
}

// ===== MODAL DETALLE PRODUCTO =====
let detailProduct = null;
let detailPhotoIdx = 0;
let detailSize = null;

function openDetailModal(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    // Cerrar cualquier otro overlay abierto (carrito, login, checkout)
    try { closeCart?.(); } catch (e) {}
    try { closeAllModals?.(); } catch (e) {}
    try { closeCheckoutModal?.(); } catch (e) {}
    detailProduct = p;
    detailPhotoIdx = 0;
    detailSize = null;
    $('detail-category').textContent = capitalize(p.category);
    $('detail-name').textContent = p.name;
    $('detail-price').textContent = '$' + p.price.toFixed(2);
    $('detail-original').textContent = p.originalPrice ? '$' + p.originalPrice.toFixed(2) : '';
    $('detail-desc').textContent = p.description || 'Sin descripción por ahora.';
    // Tallas
    const sizesBox = $('detail-sizes');
    if (p.sizes && p.sizes.length) {
        sizesBox.innerHTML = '<div class="detail__sizes-label">Tallas:</div>' + p.sizes.map(s =>
            `<button class="detail__size-btn" data-size="${s}" onclick="selectDetailSize(this, '${s}')">${s}</button>`).join('');
        sizesBox.style.display = '';
    } else {
        sizesBox.innerHTML = '';
        sizesBox.style.display = 'none';
    }
    // Colores
    const colorsBox = $('detail-colors');
    if (p.colors) {
        colorsBox.innerHTML = '<div class="detail__colors-label">Colores:</div>' + p.colors.split(',').map(c => c.trim()).map(c =>
            `<span class="product-color-dot" style="background:${colorHex(c)}" title="${c}"></span>`).join('') +
            `<small style="margin-left:6px;">${p.colors}</small>`;
        colorsBox.style.display = '';
    } else {
        colorsBox.style.display = 'none';
    }
    // Stock
    $('detail-stock').textContent = p.stock <= 0 ? '❌ Agotado' : (p.stock <= 3 ? `⚠️ Solo quedan ${p.stock}` : `✅ Disponible (${p.stock})`);
    // Galería
    const imgs = p.images && p.images.length ? p.images : (p.image ? [p.image] : []);
    if (imgs.length) {
        $('detail-photo').src = imgs[0];
        $('detail-photo').style.display = '';
        $('detail-thumbs').innerHTML = imgs.length > 1 ? imgs.map((url, i) =>
            `<img src="${url}" class="detail__thumb ${i === 0 ? 'detail__thumb--active' : ''}" onclick="switchDetailPhoto(${i}, this)" alt="">`).join('') : '';
    } else {
        $('detail-photo').style.display = 'none';
        $('detail-thumbs').innerHTML = `<span style="font-size:4rem;padding:40px;">${p.emoji || '🛍️'}</span>`;
    }
    $('detail-overlay').style.display = 'block';
    $('detail-modal').style.display = 'grid';
    // Forzar visibilidad directa (sin depender de clases CSS)
    $('detail-modal').style.opacity = '1';
    $('detail-modal').style.pointerEvents = 'auto';
    $('detail-modal').style.transform = 'translate(-50%, -50%) scale(1)';
    $('detail-modal').classList.add('modal--open');
    $('detail-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeDetailModal() {
    $('detail-overlay').style.display = 'none';
    $('detail-modal').style.display = 'none';
    $('detail-modal').style.opacity = '0';
    $('detail-modal').classList.remove('modal--open');
    $('detail-overlay').classList.remove('open');
    document.body.style.overflow = '';
    detailProduct = null;
}

function switchDetailPhoto(idx, el) {
    detailPhotoIdx = idx;
    if (!detailProduct) return;
    const imgs = detailProduct.images && detailProduct.images.length ? detailProduct.images : [detailProduct.image];
    $('detail-photo').src = imgs[idx];
    document.querySelectorAll('.detail__thumb').forEach(t => t.classList.remove('detail__thumb--active'));
    el.classList.add('detail__thumb--active');
}

function selectDetailSize(btn, size) {
    detailSize = size;
    document.querySelectorAll('.detail__size-btn').forEach(b => b.classList.remove('detail__size-btn--active'));
    btn.classList.add('detail__size-btn--active');
}

$('detail-close').addEventListener('click', closeDetailModal);
$('detail-overlay').addEventListener('click', closeDetailModal);
// Delegación: clic en cualquier tarjeta de producto abre el modal
document.addEventListener('click', (e) => {
    const card = e.target.closest('.product-card');
    if (!card) return;
    // No abrir si el clic fue en botones internos (añadir, favorito, miniaturas)
    if (e.target.closest('.add-to-cart') || e.target.closest('.wish-btn') || e.target.closest('.product-card__thumb')) return;
    const id = parseInt(card.dataset.id);
    if (id && typeof openDetailModal === 'function') openDetailModal(id);
});
$('detail-add-cart').addEventListener('click', () => {
    if (!detailProduct) return;
    if (detailProduct.sizes && detailProduct.sizes.length && !detailSize) {
        showToast('⚠️ Elegí una talla primero');
        return;
    }
    addToCart(detailProduct.id, detailSize);
    closeDetailModal();
});
$('detail-buy-now').addEventListener('click', () => {
    if (!detailProduct) return;
    if (detailProduct.sizes && detailProduct.sizes.length && !detailSize) {
        showToast('⚠️ Elegí una talla primero');
        return;
    }
    addToCart(detailProduct.id, detailSize);
    closeDetailModal();
    openCheckoutModal();
});

// ===== CART OPERATIONS =====
function addToCart(id, size) {
    const product = products.find(p => p.id === id);
    if (!product) return;
    const key = size ? id + '-' + size : String(id);
    const existing = cart.find(item => item.key === key);
    if (existing) { existing.qty += 1; }
    else {
        cart.push({ key, id, size: size || null, name: product.name, price: product.price, image: product.image || null, qty: 1 });
    }
    saveCart();
    updateCartUI();
    showToast('🛒 Añadido al carrito' + (size ? ' (talla ' + size + ')' : ''));
}
function removeFromCart(key) { cart = cart.filter(item => item.key !== key); saveCart(); updateCartUI(); }
function updateQty(key, delta) {
    const item = cart.find(i => i.key === key);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) { removeFromCart(key); return; }
    saveCart(); updateCartUI();
}
function getCartTotal() { return cart.reduce((sum, item) => sum + item.price * item.qty, 0); }
function saveCart() { localStorage.setItem('baratuss_cart', JSON.stringify(cart)); }

function updateCartUI() {
    const totalItems = cart.reduce((sum, item) => sum + item.qty, 0);
    cartCount.textContent = totalItems;
    if (cart.length === 0) {
        cartItems.innerHTML = '<div class="cart-empty"><i class="fas fa-shopping-bag"></i><p>Tu carrito está vacío</p></div>';
        cartFooter.style.display = 'none';
        return;
    }
    cartFooter.style.display = 'block';
    cartItems.innerHTML = cart.map(item => `
        <div class="cart-item">
            <div class="cart-item__img ${item.imgClass}">${item.emoji}</div>
            <div class="cart-item__info">
                <div class="cart-item__name">${item.name}${item.size ? ` <small style="color:#888;">(${item.size})</small>` : ''}</div>
                <div class="cart-item__price">$${(item.price * item.qty).toFixed(2)}</div>
                <div class="cart-item__qty">
                    <button onclick="updateQty('${item.key}', -1)">−</button>
                    <span>${item.qty}</span>
                    <button onclick="updateQty('${item.key}', 1)">+</button>
                </div>
            </div>
            <button class="cart-item__remove" onclick="removeFromCart('${item.key}')"><i class="fas fa-trash-alt"></i></button>
        </div>
    `).join('');
    cartTotal.textContent = `$${getCartTotal().toFixed(2)}`;
}

// ===== CART SIDEBAR =====
function openCart() { cartSidebar.classList.add('open'); cartOverlay.classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeCart() { cartSidebar.classList.remove('open'); cartOverlay.classList.remove('open'); document.body.style.overflow = ''; }
document.getElementById('cart-btn').addEventListener('click', openCart);
document.getElementById('cart-close').addEventListener('click', closeCart);
cartOverlay.addEventListener('click', closeCart);

// ===== FILTERS =====
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        currentFilter = this.dataset.filter;
        renderProducts(currentFilter);
    });
});

// ===== TOAST =====
function showToast(msg) { toast.textContent = msg; toast.classList.add('show'); clearTimeout(toast._timer); toast._timer = setTimeout(() => toast.classList.remove('show'), 2500); }

// ===== MODALS =====
function openModal(name) {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('modal--open'));
    document.getElementById('modal-overlay').classList.add('open');
    if (name === 'auth') document.getElementById('auth-modal').classList.add('modal--open');
    if (name === 'profile') document.getElementById('profile-modal').classList.add('modal--open');
    if (name === 'orders') { document.getElementById('orders-modal').classList.add('modal--open'); renderOrders(); }
    document.body.style.overflow = 'hidden';
}
function closeAllModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('modal--open'));
    document.getElementById('modal-overlay').classList.remove('open');
    document.body.style.overflow = '';
}
document.getElementById('modal-overlay').addEventListener('click', closeAllModals);
document.getElementById('auth-close').addEventListener('click', closeAllModals);
document.getElementById('profile-close').addEventListener('click', closeAllModals);
document.getElementById('orders-close').addEventListener('click', closeAllModals);

// ===== AUTH UI =====
function updateAuthUI() {
    const logged = document.getElementById('user-logged');
    const notLogged = document.getElementById('user-not-logged');
    const greeting = document.getElementById('user-greeting');
    const userBtn = document.getElementById('user-btn');
    
    if (currentUser) {
        logged.style.display = '';
        notLogged.style.display = 'none';
        const name = currentUser.profile?.name || currentUser.email?.split('@')[0] || 'Usuario';
        greeting.textContent = `¡Hola, ${name}!`;
        userBtn.innerHTML = '<i class="fas fa-user-check"></i>';
        userBtn.style.color = 'var(--accent)';
    } else {
        logged.style.display = 'none';
        notLogged.style.display = '';
        userBtn.innerHTML = '<i class="fas fa-user"></i>';
        userBtn.style.color = '';
    }
}

// ===== USER MENU (handled by onclick in HTML) =====
const userMenu = document.getElementById('user-menu');
// Close when clicking outside
document.addEventListener('click', function(e) {
    if (!userMenu.contains(e.target) && e.target.id !== 'user-btn') {
        userMenu.classList.remove('user-menu--open');
    }
}, false);

// ===== AUTH — Form Toggles =====
document.getElementById('switch-to-register').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = '';
    document.getElementById('reset-form').style.display = 'none';
    document.getElementById('auth-title').textContent = 'Crear cuenta';
});
document.getElementById('switch-to-login').addEventListener('click', (e) => {
    e.preventDefault();
    showLoginForm();
});
document.getElementById('switch-to-login-reset').addEventListener('click', (e) => {
    e.preventDefault();
    showLoginForm();
});
document.getElementById('switch-to-reset').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('reset-form').style.display = '';
    document.getElementById('auth-title').textContent = 'Recuperar contraseña';
});

function showLoginForm() {
    document.getElementById('login-form').style.display = '';
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('reset-form').style.display = 'none';
    document.getElementById('auth-title').textContent = 'Iniciar sesión';
}

// ===== AUTH — Login Submit =====
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-submit');
    btn.disabled = true; btn.textContent = 'Iniciando...';
    
    const result = await loginUser(
        document.getElementById('login-email').value,
        document.getElementById('login-password').value
    );
    
    btn.disabled = false; btn.textContent = 'Iniciar sesión';
    
    if (result.error) {
        showToast('❌ ' + result.error);
        return;
    }
    
    currentUser = result.data.user;
    await loadProfile();
    await loadWishlist();
    updateAuthUI();
    closeAllModals();
    showToast('¡Bienvenida/o a BARATUSS! 🎉');
    e.target.reset();
});

// ===== AUTH — Register Submit =====
document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('register-submit');
    btn.disabled = true; btn.textContent = 'Creando cuenta...';
    
    const result = await registerUser(
        document.getElementById('register-name').value,
        document.getElementById('register-email').value,
        document.getElementById('register-phone').value,
        document.getElementById('register-password').value
    );
    
    btn.disabled = false; btn.textContent = 'Crear cuenta';
    
    if (result.error) {
        showToast('❌ ' + result.error);
        return;
    }
    
    showToast('✅ Cuenta creada. Revisá tu correo para verificar.');
    showLoginForm();
    e.target.reset();
});

// ===== AUTH — Reset Submit =====
document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('reset-submit');
    btn.disabled = true; btn.textContent = 'Enviando...';
    
    const result = await resetPassword(document.getElementById('reset-email').value);
    btn.disabled = false; btn.textContent = 'Enviar link';
    
    if (result.error) {
        showToast('❌ ' + result.error);
        return;
    }
    showToast('📬 Revisá tu correo para restablecer');
    showLoginForm();
    e.target.reset();
});

// ===== PROFILE — Open =====
document.getElementById('open-profile').addEventListener('click', (e) => {
    e.preventDefault();
    userMenu.classList.remove('user-menu--open');
    if (currentUser) {
        loadProfile();
        openModal('profile');
    }
});

// ===== PROFILE — Save =====
document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = await saveProfile({
        name: document.getElementById('profile-name').value,
        phone: document.getElementById('profile-phone').value,
        address: document.getElementById('profile-address').value,
        city: document.getElementById('profile-city').value
    });
    if (result.error) showToast('❌ ' + result.error);
    else { updateAuthUI(); closeAllModals(); }
});

// ===== ORDERS — Open & Render =====
document.getElementById('open-orders').addEventListener('click', (e) => {
    e.preventDefault();
    userMenu.classList.remove('user-menu--open');
    if (currentUser) openModal('orders');
    else { showToast('Inicia sesión para ver tus pedidos'); openModal('auth'); }
});

async function renderOrders() {
    const container = document.getElementById('orders-body');
    const orders = await loadOrders();
    
    if (orders.length === 0) {
        container.innerHTML = '<div class="orders-empty"><i class="fas fa-box-open"></i><p>Todavía no tenés pedidos</p></div>';
        return;
    }
    
    container.innerHTML = orders.map(o => `
        <div class="order-card">
            <div class="order-card__header">
                <span class="order-card__id">#${o.id.slice(0, 8)}</span>
                <span class="order-card__status status--${o.status}">${capitalize(o.status)}</span>
            </div>
            <div class="order-card__items">
                ${(o.items || []).map(i => `<span>${i.emoji || ''} ${i.name} × ${i.qty}</span>`).join(', ')}
            </div>
            <div class="order-card__footer">
                <span>${new Date(o.created_at).toLocaleDateString('es-SV', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                <strong>$${parseFloat(o.total).toFixed(2)}</strong>
            </div>
        </div>
    `).join('');
}

// ===== WISHLIST — Open & UI =====
document.getElementById('open-wishlist-menu').addEventListener('click', (e) => {
    e.preventDefault();
    userMenu.classList.remove('user-menu--open');
    openWishlist();
});
document.getElementById('wishlist-btn').addEventListener('click', openWishlist);

function openWishlist() {
    const sidebar = document.getElementById('wishlist-sidebar');
    const items = document.getElementById('wishlist-items');
    const wishes = getWishlistProducts();
    
    if (wishes.length === 0) {
        items.innerHTML = '<div class="cart-empty"><i class="fas fa-heart"></i><p>No tenés favoritos aún</p></div>';
    } else {
        items.innerHTML = wishes.map(p => `
            <div class="cart-item">
                <div class="cart-item__img ${p.imgClass}">${p.emoji}</div>
                <div class="cart-item__info">
                    <div class="cart-item__name">${p.name}</div>
                    <div class="cart-item__price">$${p.price.toFixed(2)}</div>
                    <button class="add-to-cart" data-id="${p.id}" style="margin-top:8px;padding:8px 16px;background:var(--gray-100);border:none;border-radius:8px;cursor:pointer;font-size:0.8rem;">🛒 Añadir al carrito</button>
                </div>
                <button class="cart-item__remove" onclick="toggleWishlist(${p.id})"><i class="fas fa-trash-alt"></i></button>
            </div>
        `).join('');
        
        document.querySelectorAll('#wishlist-items .add-to-cart').forEach(btn => {
            btn.addEventListener('click', () => { addToCart(parseInt(btn.dataset.id)); });
        });
    }
    
    sidebar.classList.add('open');
    cartOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
}

document.getElementById('wishlist-close').addEventListener('click', () => {
    document.getElementById('wishlist-sidebar').classList.remove('open');
    cartOverlay.classList.remove('open');
    document.body.style.overflow = '';
});

function updateWishlistUI() {
    document.getElementById('wish-count').textContent = wishlist.size;
}

// ===== CHECKOUT — Método de pago =====
const DELIVERY_FEE = 2.50; // Envío a domicilio (editable)

function openCheckoutModal() {
    if (cart.length === 0) return;
    closeCart();
    // Autocompletar datos del usuario logueado
    if (currentUser) {
        const p = currentUser.profile || {};
        $('checkout-name').value = p.name || '';
        $('checkout-phone').value = p.phone || '';
        $('checkout-address').value = p.address || '';
        $('checkout-city').value = p.city || '';
    }
    updateCheckoutUI();
    $('checkout-overlay').style.display = '';
    $('checkout-modal').style.display = '';
}

function closeCheckoutModal() {
    $('checkout-overlay').style.display = 'none';
    $('checkout-modal').style.display = 'none';
}

function updateCheckoutUI() {
    const method = document.querySelector('input[name="pay-method"]:checked').value;
    const isCash = method === 'efectivo';
    $('checkout-delivery').style.display = isCash ? '' : 'none';
    const isDelivery = document.querySelector('input[name="delivery-method"]:checked')?.value === 'domicilio';
    $('checkout-address-group').style.display = isCash && isDelivery ? '' : 'none';
    
    const baseTotal = getCartTotal();
    const fee = isCash && isDelivery ? DELIVERY_FEE : 0;
    const totalConFee = baseTotal + fee;
    // Desglose: IVA 13% + comisión Wompi 3.50% ya incluidos en el precio final
    $('checkout-total').textContent = '$' + totalConFee.toFixed(2);
    const breakdown = $('checkout-breakdown');
    if (breakdown) {
        breakdown.innerHTML =
            `<small style="opacity:.7;display:block;margin-top:4px;">` +
            `Incluye: IVA 13% · Comisión Wompi 3.50% · Tarifa $${PRICE_FEE.toFixed(2)}` +
            `</small>`;
    }
}

document.querySelectorAll('input[name="pay-method"], input[name="delivery-method"]').forEach(r => {
    r.addEventListener('change', updateCheckoutUI);
});
$('checkout-close').addEventListener('click', closeCheckoutModal);
$('checkout-overlay').addEventListener('click', closeCheckoutModal);

// ===== CHECKOUT — Wompi SV (tarjeta) =====
async function wompiCheckout() {
    if (cart.length === 0) return;
    
    showToast('🔄 Procesando pago...');
    
    try {
        const response = await fetch(WOMPI_API_URL + '/create-payment', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
                items: cart,
                total: getCartTotal(),
                userId: currentUser?.id || null
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            showToast('❌ Error: ' + (data.error || 'Error al procesar pago'));
            return;
        }
        
        // Save order reference
        if (data.reference) {
            localStorage.setItem('baratuss_last_ref', data.reference);
        }
        
        // Save order info for logged in users
        if (currentUser) {
            const result = await createOrder(cart, getCartTotal());
            if (result.error) { showToast('❌ ' + result.error); return; }
        }
        
        // Clear cart and redirect to Wompi
        cart = [];
        saveCart();
        updateCartUI();
        setTimeout(closeCart, 500);
        
        // Redirect to Wompi payment page
        window.location.href = data.paymentUrl;
        
    } catch (e) {
        showToast('❌ Error de conexión: ' + e.message);
    }
}

// ===== CHECKOUT — Efectivo (contra entrega / retiro) =====
async function cashCheckout() {
    const name = $('checkout-name').value.trim();
    const phone = $('checkout-phone').value.trim();
    if (!name || !phone) {
        showToast('📝 Completá tu nombre y teléfono');
        return;
    }
    
    const isDelivery = document.querySelector('input[name="delivery-method"]:checked').value === 'domicilio';
    if (isDelivery) {
        const address = $('checkout-address').value.trim();
        const city = $('checkout-city').value.trim();
        if (!address || !city) {
            showToast('📝 Completá tu dirección de entrega');
            return;
        }
    }
    
    const items = [...cart];
    const baseTotal = getCartTotal();
    const fee = isDelivery ? DELIVERY_FEE : 0;
    const total = baseTotal + fee;
    const ref = 'BAR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    
    showToast('🔄 Procesando pedido...');
    
    try {
        // Insertar pedido con fetch directo (evita problemas de la librería CDN)
        const orderPayload = {
            items: items,
            total: total,
            status: 'pendiente',
            payment_status: 'efectivo',
            payment_method: 'efectivo',
            reference: ref,
            delivery_type: isDelivery ? 'domicilio' : 'retiro',
            delivery_fee: fee,
            customer_name: name,
            customer_phone: phone,
            customer_address: isDelivery ? $('checkout-address').value.trim() : null,
            customer_city: isDelivery ? $('checkout-city').value.trim() : null
        };
        if (currentUser) orderPayload.user_id = currentUser.id;
        
        try {
            await fetch(SUPABASE_URL + '/rest/v1/orders', {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(orderPayload)
            });
        } catch (insertErr) {
            console.log('No se pudo guardar el pedido online:', insertErr.message);
        }
        
        // Si no está logueado y no hay supabase, igual confirmamos
        cart = [];
        saveCart();
        updateCartUI();
        closeCheckoutModal();
        
        // Confirmación
        const deliveryText = isDelivery ? 'a domicilio' : 'para retiro';
        showToast('✅ Pedido confirmado');
        alert(
            '🎉 ¡Pedido confirmado, ' + name + '!\n\n' +
            '📍 Referencia: ' + ref + '\n' +
            '💰 Total a pagar en efectivo: $' + total.toFixed(2) + ' (' + deliveryText + ')\n\n' +
            '📲 Te vamos a contactar al ' + phone + ' para coordinar la ' + (isDelivery ? 'entrega' : 'entrega/retiro') + '.\n' +
            '¡Gracias por comprar en BARATUSS! 💕'
        );
        
    } catch (e) {
        showToast('❌ Error: ' + e.message);
    }
}

// ===== BOTÓN PRINCIPAL DE CHECKOUT =====
$('checkout-btn').addEventListener('click', openCheckoutModal);
$('checkout-confirm').addEventListener('click', () => {
    const method = document.querySelector('input[name="pay-method"]:checked').value;
    if (method === 'tarjeta') {
        closeCheckoutModal();
        wompiCheckout();
    } else {
        cashCheckout();
    }
});

// ===== NEWSLETTER =====
document.getElementById('newsletter-form').addEventListener('submit', (e) => {
    e.preventDefault();
    showToast('📬 ¡Bienvenida/o a BARATUSS!');
    e.target.reset();
});

// ===== CONTACT =====
document.getElementById('contact-form').addEventListener('submit', (e) => {
    e.preventDefault();
    showToast('📩 Mensaje enviado. Te responderemos pronto.');
    e.target.reset();
});

// ===== HEADER SCROLL =====
window.addEventListener('scroll', () => { header.classList.toggle('scrolled', window.scrollY > 50); });

// ===== MOBILE MENU =====
const hamburger = document.getElementById('hamburger');
const navMenu = document.getElementById('nav-menu');
hamburger.addEventListener('click', () => navMenu.classList.toggle('open'));
document.querySelectorAll('.nav__link').forEach(link => {
    link.addEventListener('click', () => navMenu.classList.remove('open'));
});

// ===== NAV ACTIVE LINK =====
document.querySelectorAll('.nav__link').forEach(link => {
    link.addEventListener('click', function() {
        document.querySelectorAll('.nav__link').forEach(l => l.classList.remove('active'));
        this.classList.add('active');
    });
});

// ===== OPEN AUTH FROM HEADER/BUTTONS =====
document.getElementById('open-login').addEventListener('click', (e) => {
    e.preventDefault(); userMenu.classList.remove('user-menu--open');
    showLoginForm(); openModal('auth');
});
document.getElementById('open-register').addEventListener('click', (e) => {
    e.preventDefault(); userMenu.classList.remove('user-menu--open');
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = '';
    document.getElementById('reset-form').style.display = 'none';
    document.getElementById('auth-title').textContent = 'Crear cuenta';
    openModal('auth');
});
document.getElementById('logout-btn').addEventListener('click', (e) => { e.preventDefault(); logoutUser(); });

// Footer links
document.getElementById('footer-login')?.addEventListener('click', (e) => { e.preventDefault(); showLoginForm(); openModal('auth'); });
document.getElementById('footer-register')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = '';
    document.getElementById('auth-title').textContent = 'Crear cuenta';
    openModal('auth');
});
document.getElementById('footer-orders')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (currentUser) openModal('orders');
    else { showToast('Inicia sesión para ver tus pedidos'); openModal('auth'); }
});

// ===== INIT =====
function initApp() {
    // Precios finales con IVA + comisión para el fallback local
    products = products.map(p => ({
        ...p,
        price: finalPrice(p.price),
        originalPrice: p.originalPrice ? finalPrice(p.originalPrice) : null
    }));
    // Actualizar carritos viejos guardados con precios base
    cart = cart.map(item => {
        if (!item.key) item.key = String(item.id);  // migrar carritos viejos
        const p = products.find(x => x.id === item.id);
        return p ? { ...item, price: p.price } : item;
    });
    saveCart();
    renderProducts();
    updateCartUI();
    loadProductsFromSupabase();
    checkSession();
}

initApp();
