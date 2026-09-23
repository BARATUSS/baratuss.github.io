// ========================================================================
// BARATUSS — Complete e-commerce system
// ========================================================================

// ===== SUPABASE CONFIG =====
const SUPABASE_URL = 'https://lizybztwnlrlvsrmgnug.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_m85uJKNu8Izi5ujT8ukWWQ_XvEMOToA';
const WOMPI_API_URL = 'https://lizybztwnlrlvsrmgnug.functions.supabase.co/wompi-checkout';
// NIVEL B (21-sep-2026): el pedido lo arma el servidor (nadie puede tocar los precios)
const CREAR_PEDIDO_URL = 'https://lizybztwnlrlvsrmgnug.functions.supabase.co/crear-pedido';
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
            .select('id, name, category, sale_price, original_price, badge, img_class, emoji, tipo, stock, image_url, images, colors, description, sizes, condition, reservado_hasta, reservado_token')
            .eq('active', true)
            // Incluir agotados: se muestran con etiqueta "AGOTADO" y compra bloqueada
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
                description: p.description || null,
                sizes: Array.isArray(p.sizes) ? p.sizes.filter(Boolean) : null,
                condition: p.condition || null,
                colors: p.colors || null,
                reservadoHasta: p.reservado_hasta || null,
                reservadoToken: p.reservado_token || null
            }));
            renderProducts(currentFilter);
            updateCartUI();
        }
    } catch (e) {
        console.log('Usando productos de respaldo:', e.message);
    }
    // 👁️ Tiempo real: si un producto se agota (otro cliente lo compró), ocultarlo al instante
    try {
        const ch = client.channel('stock-live');
        ch.on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'inventory' },
            (payload) => {
                const nuevo = payload.new;
                const prod = products.find(p => p.id === nuevo.id);
                if (!prod) return;
                const stockAntes = prod.stock || 0;
                const stockNuevo = Number(nuevo.stock) || 0;
                if (stockNuevo !== stockAntes) {
                    prod.stock = stockNuevo;
                    renderProducts(currentFilter);
                    // Si el producto se ve en el modal abierto, actualizar el aviso de stock
                    const detailStock = $('detail-stock');
                    if (detailProduct && detailProduct.id === nuevo.id && detailStock) {
                        detailStock.textContent = stockNuevo <= 0 ? '❌ Agotado' : (stockNuevo <= 3 ? `⚠️ Solo quedan ${stockNuevo}` : `✅ Disponible (${stockNuevo})`);
                    }
                    // Quitar del carrito si se agotó
                    const enCarrito = cart.filter(i => i.id === nuevo.id);
                    if (enCarrito.length && stockNuevo <= 0) {
                        cart = cart.filter(i => i.id !== nuevo.id);
                        saveCart();
                        updateCartUI();
                        showToast('😔 Un artículo de tu carrito se agotó y fue removido');
                    }
                }
            }
        ).subscribe();
    } catch (e) {
        console.log('Sin tiempo real:', e.message);
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
// ===== STOCK: descontar inventario automáticamente al vender =====
async function decreaseStock(items) {
    try {
        for (const item of items) {
            const qty = item.qty || 1;
            // Leer stock actual
            const r = await fetch(SUPABASE_URL + '/rest/v1/inventory?select=stock&id=eq.' + item.id, {
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
                }
            });
            const rows = await r.json().catch(() => []);
            const current = Array.isArray(rows) && rows.length ? (Number(rows[0].stock) || 0) : 0;
            const nuevo = Math.max(0, current - qty);
            await fetch(SUPABASE_URL + '/rest/v1/inventory?id=eq.' + item.id, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ stock: nuevo, updated_at: new Date().toISOString() })
            });
            // Actualizar en memoria (para que desaparezca al instante)
            const prod = products.find(p => p.id === item.id);
            if (prod) prod.stock = nuevo;
        }
        // Re-render para ocultar agotados inmediatamente
        if (typeof renderProducts === 'function') renderProducts(currentFilter);
    } catch (e) {
        console.log('Error descontando stock:', e.message);
    }
}

async function createOrder(items, total, delivery = {}) {
    if (!currentUser) return { error: 'Inicia sesión para comprar' };
    const client = sb();
    const { data, error } = await client.from('orders').insert({
        user_id: currentUser.id,
        items,
        total,
        status: 'pendiente',
        // Fase 1 entregas: persistir datos de entrega (caso suelto #1 del reporte caos)
        delivery_type: delivery.deliveryType || 'retiro-punto',
        delivery_fee: delivery.fee || 0,
        delivery_point: delivery.point || null,
        customer_name: delivery.name || null,
        customer_phone: delivery.phone || null,
        reference: delivery.reference || null
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
    const filtered = (filter === 'all' ? products : products.filter(p => p.category === filter));
    // Mostrar TODOS: los agotados aparecen con etiqueta roja y compra bloqueada
    
    productsGrid.innerHTML = filtered.map((p, posicion) => {
        const isFav = wishlist.has(p.id);
        const agotado = (p.stock || 0) <= 0;
        // Reservada por otro cliente (reserva activa de 5 min que no es la mía)
        const reservadaPorOtro = !agotado && p.reservadoHasta && new Date(p.reservadoHasta) > new Date() && p.reservadoToken !== sessionToken();
        const bloqueado = agotado || reservadaPorOtro;
        return `
        <div class="product-card ${bloqueado ? 'product-card--agotado' : ''}" data-id="${p.id}" style="cursor:pointer;">
            <button class="wish-btn ${isFav ? 'wish-btn--active' : ''}" data-id="${p.id}" aria-label="Favoritos">
                <i class="${isFav ? 'fas' : 'far'} fa-heart"></i>
            </button>
            <div class="product-card__img ${p.imgClass}">
                <span class="product-card__placeholder" aria-hidden="true" onclick="event.stopPropagation(); if(this.parentElement.classList.contains('foto-error')) reintentarFoto(this.parentElement);">${p.emoji}</span>
                ${p.image ? `<img src="${p.image}" alt="${p.name}" class="product-card__photo" loading="${posicion < 6 ? 'eager' : 'lazy'}"${posicion < 2 ? ' fetchpriority="high"' : ''} decoding="async" onload="fotoCargada(this)" onerror="fotoFallo(this)">` : ''}
                <button class="product-card__zoom" type="button" title="Ampliar foto" aria-label="Ampliar foto" onclick="event.stopPropagation(); abrirZoomProducto(${p.id}, 0)"><i class="fas fa-search-plus"></i></button>
                ${p.badge ? `<span class="badge">${p.badge}</span>` : ''}
                ${p.condition === 'segunda-mano' ? `<span class="badge badge--condition">♻️ Segunda mano</span>` : ''}
                ${p.condition === 'como-nuevo' ? `<span class="badge badge--condition">✨ Como nuevo</span>` : ''}
                ${agotado ? `<span class="badge badge--agotado">❌ AGOTADO</span>` : ''}
                ${reservadaPorOtro ? `<span class="badge badge--agotado">🔒 RESERVADA</span>` : ''}
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
                ${agotado
                    ? `<div class="agotado-msg">❌ Agotado — pronto reponemos</div>`
                    : `<button class="add-to-cart" data-id="${p.id}">
                    <i class="fas fa-shopping-bag"></i> Añadir
                </button>`}
                ${p.id === 6 && !agotado ? `<button class="add-to-cart buy-now-wompi" data-id="${p.id}" style="display:block;text-align:center;margin-top:8px;padding:10px;background:#ff9686;color:white;border-radius:10px;font-size:0.8rem;font-weight:500;border:none;cursor:pointer;width:100%;">⚡ Comprar ahora</button>` : ''}
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

// ===== FOTOS EN EL CELULAR (22-sep-2026) =====
// Antes: mientras la foto cargaba quedaba un hueco blanco, y si fallaba se borraba sin avisar.
// Ahora: se ve el icono del producto, avisa si falla y se puede reintentar tocando.
function fotoCargada(img) {
    img.classList.add('cargada');
    const caja = img.parentElement;
    if (caja) { caja.classList.add('con-foto'); caja.classList.remove('foto-error'); }
}
function fotoFallo(img) {
    const caja = img.parentElement;
    if (!caja) return;
    img.classList.remove('cargada');
    img.style.display = 'none';
    caja.classList.add('foto-error');
    // Un reintento automático (por si fue un parpadeo de la red)
    if (!caja.dataset.reintento) {
        caja.dataset.reintento = '1';
        setTimeout(() => { reintentarFoto(caja); }, 1800);
    }
}
function reintentarFoto(caja) {
    const img = caja && caja.querySelector('.product-card__photo');
    if (!img) return;
    caja.classList.remove('foto-error');
    delete caja.dataset.reintento;
    img.style.display = '';
    img.src = img.src.split('?')[0] + '?r=' + Date.now();
}

// ════════════════════════════════════════════════════════════════════
// 🎠 CARRUSEL DE IMÁGENES DE LA PORTADA (23-sep-2026)
// Fotos que van pasando solas, detrás del logo grande y del texto.
// 👉 PARA CAMBIARLAS: reemplazá esta lista por las fotos que mande Cindy
//    (pueden ser las direcciones de la tienda o archivos en assets/)
// ════════════════════════════════════════════════════════════════════
const HERO_IMAGENES = [
    'https://lizybztwnlrlvsrmgnug.supabase.co/storage/v1/object/public/productos/prod-1788403286968-wntxq6.jpg',
    'https://lizybztwnlrlvsrmgnug.supabase.co/storage/v1/object/public/productos/prod-1788403186440-x9tlgm.jpg',
    'https://lizybztwnlrlvsrmgnug.supabase.co/storage/v1/object/public/productos/prod-1788403099842-xm9lvn.jpg',
];
const HERO_SEGUNDOS = 7;   // cada cuántos segundos cambia la foto

function iniciarCarruselHero() {
    const caja = document.getElementById('hero-carrusel');
    if (!caja || !HERO_IMAGENES.length) return;
    HERO_IMAGENES.forEach((url, i) => {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        if (i === 0) img.classList.add('activa');
        caja.appendChild(img);
    });
    const imgs = caja.querySelectorAll('img');
    if (imgs.length < 2) return;
    let i = 0, t = null;
    const pasar = () => {
        imgs[i].classList.remove('activa');
        i = (i + 1) % imgs.length;
        imgs[i].classList.add('activa');
    };
    const arrancar = () => { if (!t) t = setInterval(pasar, HERO_SEGUNDOS * 1000); };
    const parar = () => { if (t) { clearInterval(t); t = null; } };
    // Si la clienta pidió menos movimiento en su celular, no se mueve
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) arrancar();
    // Y si sale de la pestaña, se pausa (no gasta datos ni batería)
    document.addEventListener('visibilitychange', () => document.hidden ? parar() : arrancar());
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciarCarruselHero);
else iniciarCarruselHero();

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
    // Condición del producto (si aplica)
    const condLabel = p.condition === 'nuevo' ? '🆕 Nuevo' :
        p.condition === 'segunda-mano' ? '♻️ De segunda mano' :
        p.condition === 'como-nuevo' ? '✨ De segunda mano como nuevo' : '';
    $('detail-condition').textContent = condLabel;
    $('detail-condition').style.display = condLabel ? 'inline-block' : 'none';
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
    const reservadaOtro = p.reservadoHasta && new Date(p.reservadoHasta) > new Date() && p.reservadoToken !== sessionToken();
    const agotadoModal = (p.stock || 0) <= 0 || reservadaOtro;
    $('detail-stock').textContent = reservadaOtro ? '🔒 Reservada por otra persona' : (agotadoModal ? '❌ Agotado' : (p.stock <= 3 ? `⚠️ Solo quedan ${p.stock}` : `✅ Disponible (${p.stock})`));
    $('detail-stock').style.color = agotadoModal ? '#d32f2f' : (p.stock <= 3 ? '#e67e22' : '#27ae60');
    // Botones: si está agotado, mostrar mensaje rojo y ocultar compra
    $('detail-add-cart').style.display = agotadoModal ? 'none' : '';
    $('detail-buy-now').style.display = agotadoModal ? 'none' : '';
    $('detail-agotado-msg').style.display = agotadoModal ? 'block' : 'none';
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
    // Transform según pantalla: desktop centrado, móvil con media query (translateX)
    if (window.innerWidth > 700) {
        $('detail-modal').style.transform = 'translate(-50%, -50%) scale(1)';
    } else {
        $('detail-modal').style.transform = '';
    }
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

// ===== ZOOM / LIGHTBOX =====
let zoomIndex = 0, zoomScale = 1, zoomTx = 0, zoomTy = 0;
let zoomDragging = false, zoomStartX = 0, zoomStartY = 0, touchDist = 0;

let zoomListaManual = null;   // cuando el zoom se abre desde una tarjeta de la tienda
function abrirZoomProducto(id, idx) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const imgs = (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []);
    if (!imgs.length) { showToast('📷 Este producto todavía no tiene foto'); return; }
    zoomListaManual = imgs;
    openZoom(idx);
}

function zoomImagesList() {
    if (zoomListaManual && zoomListaManual.length) return zoomListaManual;
    if (!detailProduct) return [];
    return detailProduct.images && detailProduct.images.length
        ? detailProduct.images
        : (detailProduct.image ? [detailProduct.image] : []);
}

function applyZoomTransform() {
    $('zoom-photo').style.transform = 'translate(' + zoomTx + 'px,' + zoomTy + 'px) scale(' + zoomScale + ')';
}

function resetZoom() { zoomScale = 1; zoomTx = 0; zoomTy = 0; applyZoomTransform(); }

function openZoom(idx) {
    const imgs = zoomImagesList();
    if (!imgs.length) return;
    zoomIndex = Math.min(idx, imgs.length - 1);
    resetZoom();
    $('zoom-photo').src = imgs[zoomIndex];
    const multi = imgs.length > 1;
    $('zoom-counter').textContent = multi ? (zoomIndex + 1) + ' / ' + imgs.length : '';
    $('zoom-counter').style.display = multi ? '' : 'none';
    $('zoom-prev').style.display = multi ? '' : 'none';
    $('zoom-next').style.display = multi ? '' : 'none';
    $('zoom-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeZoom() {
    zoomListaManual = null;
    $('zoom-overlay').classList.remove('open');
    if (!$('detail-modal').classList.contains('modal--open')) document.body.style.overflow = '';
}

function zoomStep(dir) {
    const imgs = zoomImagesList();
    if (imgs.length < 2) return;
    zoomIndex = (zoomIndex + dir + imgs.length) % imgs.length;
    $('zoom-photo').src = imgs[zoomIndex];
    resetZoom();
    $('zoom-counter').textContent = (zoomIndex + 1) + ' / ' + imgs.length;
}

function toggleZoom() {
    if (zoomScale > 1) { resetZoom(); }
    else { zoomScale = 2.5; zoomTx = 0; zoomTy = 0; applyZoomTransform(); }
}

// Abrir al hacer clic en la foto principal del modal de detalle
$('detail-photo').addEventListener('click', () => openZoom(detailPhotoIdx));

// Cerrar: botón X, clic fuera de la imagen, tecla Escape
$('zoom-close').addEventListener('click', closeZoom);
$('zoom-overlay').addEventListener('click', (e) => {
    if (e.target === $('zoom-overlay') || e.target === $('zoom-stage')) closeZoom();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('zoom-overlay').classList.contains('open')) closeZoom();
});

// Botones de zoom
$('zoom-in').addEventListener('click', () => {
    zoomScale = Math.min(6, zoomScale * 1.4); applyZoomTransform();
});
$('zoom-out').addEventListener('click', () => {
    zoomScale = Math.max(1, zoomScale / 1.4);
    if (zoomScale === 1) { zoomTx = 0; zoomTy = 0; }
    applyZoomTransform();
});
$('zoom-reset').addEventListener('click', resetZoom);
$('zoom-prev').addEventListener('click', () => zoomStep(-1));
$('zoom-next').addEventListener('click', () => zoomStep(1));

// Rueda del mouse para zoom (sobre la imagen)
$('zoom-stage').addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomScale = Math.min(6, Math.max(1, zoomScale * factor));
    if (zoomScale === 1) { zoomTx = 0; zoomTy = 0; }
    applyZoomTransform();
}, { passive: false });

// Doble clic: acercar / alejar
$('zoom-photo').addEventListener('dblclick', (e) => { e.preventDefault(); toggleZoom(); });

// Arrastrar para mover la imagen cuando hay zoom (mouse)
$('zoom-stage').addEventListener('mousedown', (e) => {
    if (zoomScale <= 1) return;
    zoomDragging = true;
    zoomStartX = e.clientX - zoomTx;
    zoomStartY = e.clientY - zoomTy;
    e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
    if (!zoomDragging) return;
    zoomTx = e.clientX - zoomStartX;
    zoomTy = e.clientY - zoomStartY;
    applyZoomTransform();
});
window.addEventListener('mouseup', () => { zoomDragging = false; });

// Soporte táctil: pellizco para zoom + dedo para mover
$('zoom-stage').addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && zoomScale > 1) {
        zoomDragging = true;
        const t = e.touches[0];
        zoomStartX = t.clientX - zoomTx;
        zoomStartY = t.clientY - zoomTy;
    } else if (e.touches.length === 2) {
        zoomDragging = false;
        touchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
}, { passive: true });
$('zoom-stage').addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && touchDist > 0) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        zoomScale = Math.min(6, Math.max(1, zoomScale * (d / touchDist)));
        touchDist = d;
        if (zoomScale === 1) { zoomTx = 0; zoomTy = 0; }
        applyZoomTransform();
    } else if (e.touches.length === 1 && zoomDragging) {
        const t = e.touches[0];
        zoomTx = t.clientX - zoomStartX;
        zoomTy = t.clientY - zoomStartY;
        applyZoomTransform();
    }
}, { passive: true });
$('zoom-stage').addEventListener('touchend', () => { zoomDragging = false; touchDist = 0; });

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
// ═══ RESERVA REAL DE 5 MINUTOS (21-sep-2026) ═══
// Antes la tienda MOSTRABA "reservada" pero nadie creaba la reserva. Ahora sí:
// al agregar al carrito se aparta el producto por 5 minutos para esa clienta.
async function reservarMiCarrito(items) {
    if (!items || !items.length) return;
    try {
        await fetch(STOCK_API_URL + '/reservar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: items.map(i => ({ id: i.id, qty: i.qty || 1 })),
                token: sessionToken(),
                minutos: 5
            })
        });
    } catch (_e) { /* si falla la red, no se bloquea la compra */ }
}
async function liberarMiReserva(items) {
    if (!items || !items.length) return;
    try {
        await fetch(STOCK_API_URL + '/liberar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: items.map(i => ({ id: i.id, qty: i.qty || 1 })),
                token: sessionToken()
            })
        });
    } catch (_e) { /* silencioso */ }
}

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
    reservarMiCarrito([{ id: id, qty: (existing ? existing.qty : 1) }]);   // aparta 5 min
    showToast('🛒 Añadido al carrito' + (size ? ' (talla ' + size + ')' : ''));
}
function removeFromCart(key) {
    const quitado = cart.find(item => item.key === key);
    cart = cart.filter(item => item.key !== key);
    saveCart();
    updateCartUI();
    if (quitado) liberarMiReserva([{ id: quitado.id, qty: quitado.qty || 1 }]);   // suelto la reserva
}
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
            <div class="cart-item__img">${item.image ? `<img src="${item.image}" alt="${item.name}" class="cart-item__photo" onerror="this.replaceWith(document.createTextNode('🛍️'))">` : (item.emoji || '🛍️')}</div>
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

// ===== TARJETAS DE DÍA Y PUNTO DE ENTREGA (reemplazan visualmente al desplegable) =====
// El <select id="checkout-point"> sigue siendo la fuente de datos: las tarjetas solo lo manejan.
function proximaFechaDia(diaSemana) {          // 3 = miércoles, 6 = sábado
    const hoy = new Date();
    const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    let dif = (diaSemana - base.getDay() + 7) % 7;
    if (dif === 0) dif = 7;                    // siempre la PRÓXIMA ocurrencia
    base.setDate(base.getDate() + dif);
    return base;
}

function renderPuntosCards() {
    const sel = $('checkout-point');
    const cont = $('puntos-cards');
    if (!sel || !cont) return;
    const hoy = new Date();
    const hoy0 = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    let html = '';

    sel.querySelectorAll('optgroup').forEach(g => {
        const etiqueta = g.label || '';
        const bajo = etiqueta.toLowerCase();
        const diaSemana = (bajo.includes('mié') || bajo.includes('mie')) ? 3
                        : ((bajo.includes('sáb') || bajo.includes('sab')) ? 6 : null);
        let fechaTxt = '';
        if (diaSemana) {
            const f = proximaFechaDia(diaSemana);
            const dias = Math.round((f - hoy0) / 86400000);
            fechaTxt = f.toLocaleDateString('es-SV', { weekday: 'long', day: 'numeric', month: 'long' });
            if (dias === 1) fechaTxt += ' · ¡es mañana!';
            else if (dias <= 3) fechaTxt += ' · en ' + dias + ' días';
        }
        html += `<div class="puntos-dia">
            <div class="puntos-dia__cabecera">
                <span class="puntos-dia__titulo">${etiqueta}</span>
                ${fechaTxt ? `<span class="puntos-dia__fecha">${fechaTxt}</span>` : ''}
            </div>
            <div class="puntos-dia__opciones">`;

        g.querySelectorAll('option').forEach(o => {
            const partes = (o.textContent || '').split('·');
            const lugar = (partes[0] || '').trim();
            const hora = (partes[1] || '').trim();
            const activo = o.value === sel.value;
            html += `<button type="button" class="punto-card${activo ? ' punto-card--activo' : ''}"
                        data-valor="${o.value.replace(/"/g, '&quot;')}" onclick="elegirPunto(this)">
                <span class="punto-card__check">${activo ? '✅' : '📍'}</span>
                <span class="punto-card__txt">
                    <strong>${lugar}</strong>
                    <small>🕒 ${hora || 'horario a coordinar'} · 🚗 Entrega gratis con Cindy</small>
                </span>
            </button>`;
        });
        html += `</div></div>`;
    });
    cont.innerHTML = html;
}

function elegirPunto(btn) {
    const sel = $('checkout-point');
    if (!sel || !btn) return;
    sel.value = btn.dataset.valor;
    if (typeof showPointWhatsApp === 'function') showPointWhatsApp();
    document.querySelectorAll('.punto-card').forEach(b => {
        const activo = b === btn;
        b.classList.toggle('punto-card--activo', activo);
        const chk = b.querySelector('.punto-card__check');
        if (chk) chk.textContent = activo ? '✅' : '📍';
    });
}

// ===== RESUMEN DE LA COMPRA (dentro del cuadro de pago) =====
// Muestra foto, talla, cantidad, precio y total de lo que se está comprando.
function mostrarResumenCompra() {
    const cont = $('checkout-resumen');
    if (!cont) return;
    if (!cart.length) { cont.style.display = 'none'; return; }
    cont.innerHTML = cart.map(item => `
        <div class="checkout-resumen__item">
            <div class="checkout-resumen__img">${item.image ? `<img src="${item.image}" alt="${item.name}" onerror="this.replaceWith(document.createTextNode('🛍️'))">` : '🛍️'}</div>
            <div class="checkout-resumen__txt">
                <strong>${item.name}${item.size ? ' · Talla ' + item.size : ''}</strong>
                <small>${item.qty} × $${Number(item.price).toFixed(2)}</small>
            </div>
            <div class="checkout-resumen__precio">$${(item.price * item.qty).toFixed(2)}</div>
        </div>`).join('') +
        `<div class="checkout-resumen__item" style="border-top:1.5px solid #e5e5e5;">
            <div class="checkout-resumen__txt"><strong>Total</strong></div>
            <div class="checkout-resumen__precio">$${getCartTotal().toFixed(2)}</div>
        </div>`;
    cont.style.display = '';
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
const C807_FEE = 1.00; // Retiro en agencia C807 (solo tarjeta)
const DELIVERY_FEE = C807_FEE; // compatibilidad

// Muestra aviso de WhatsApp cuando el método de entrega es punto fijo con Cindy
function showPointWhatsApp() {
    const sel = $('checkout-point');
    const box = $('checkout-whatsapp-box');
    if (!sel || !box) return;
    const method = document.querySelector('input[name="delivery-method"]:checked')?.value || 'punto';
    // Punto fijo = entrega coordinada con Cindy (se confirma por WhatsApp)
    box.style.display = method === 'punto' ? '' : 'none';
}

// Muestra la dirección de la agencia C807 elegida + link a Google Maps
function showC807Address() {
    const sel = $('checkout-c807-point');
    if (!sel) return;
    const opt = sel.options[sel.selectedIndex];
    const addrBox = $('checkout-c807-address');
    if (!addrBox || !opt) return;
    const address = opt.getAttribute('data-address');
    const mapsUrl = opt.getAttribute('data-maps');
    if (address) {
        $('c807-address-name').textContent = opt.textContent.trim();
        $('c807-address-text').textContent = address;
        addrBox.style.display = '';
        const mapsLink = $('c807-address-maps');
        if (mapsLink) {
            if (mapsUrl) {
                mapsLink.href = mapsUrl;
                mapsLink.style.display = 'inline-block';
            } else {
                mapsLink.style.display = 'none';
            }
        }
    } else {
        addrBox.style.display = 'none';
    }
}

// ===== RESERVA DE STOCK (5 minutos) — Fase 1+2 entregas =====
const STOCK_API_URL = 'https://lizybztwnlrlvsrmgnug.functions.supabase.co/stock-api';
const RESERVA_MINUTOS = 5;
let reservaTimerId = null;

function sessionToken() {
    let t = localStorage.getItem('baratuss_sesion');
    if (!t) {
        t = 'web-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('baratuss_sesion', t);
    }
    return t;
}

// Reserva los productos del carrito al entrar al checkout (el primero que llega gana)
async function reservarCarrito() {
    if (!cart.length) return true;
    try {
        const r = await fetch(STOCK_API_URL + '/reservar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: cart.map(i => ({ id: i.id, qty: i.qty || 1 })),
                token: sessionToken(),
                minutos: RESERVA_MINUTOS
            })
        });
        const d = await r.json();
        if (!d.ok) {
            let msg = 'No pudimos reservar tu pedido 😕';
            if (d.motivo === 'reservada_por_otro') msg = '😮 Otra persona está comprando este producto ahora mismo. Probá en unos minutos.';
            else if (d.motivo === 'sin_stock') msg = '❌ Este producto acaba de venderse.';
            showToast(msg);
            if (d.producto) {
                cart = cart.filter(i => String(i.id) !== String(d.producto));
                saveCart(); updateCartUI();
            }
            return false;
        }
        iniciarTimerReserva(RESERVA_MINUTOS * 60);
        return true;
    } catch (e) {
        console.log('Error reservando stock:', e.message);
        return true; // si falla la red, no bloqueamos la compra
    }
}

// Venta definitiva (descuento atomico en el servidor)
async function venderCarrito(items) {
    try {
        const r = await fetch(STOCK_API_URL + '/vender', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: items.map(i => ({ id: i.id, qty: i.qty || 1 })),
                token: sessionToken()
            })
        });
        return await r.json();
    } catch (e) {
        console.log('Error en venta de stock:', e.message);
        return { ok: true }; // no bloquear si falla la red
    }
}

// Devuelve el stock de los productos (se usa cuando el pedido NO se pudo guardar)
async function devolverCarrito(items) {
    for (const it of items) {
        try {
            await fetch(SUPABASE_URL + '/rest/v1/rpc/devolver_stock', {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ p_id: Number(it.id), p_qty: Number(it.qty || 1) })
            });
        } catch (e) {
            console.log('No se pudo devolver el stock de', it.id, e.message);
        }
    }
}

// Avisa al negocio por Telegram cuando algo no salió bien con un pedido
async function avisarFalloPedido(datos) {
    try {
        await fetch(SUPABASE_URL + '/functions/v1/avisar-fallo', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify(datos)
        });
    } catch (_e) { /* silencioso: no romper la experiencia del cliente */ }
}

// Pantalla de fallo: NUNCA mostrar ticket falso. Mensaje claro + WhatsApp directo.
function mostrarFalloPedido(waUrl, items, total, detalle) {
    const viejo = document.getElementById('fallo-pedido');
    if (viejo) viejo.remove();
    const lista = (items || []).map(i => (i.qty || 1) + '× ' + i.name).join(' · ');
    const div = document.createElement('div');
    div.id = 'fallo-pedido';
    div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;'
        + 'align-items:center;justify-content:center;z-index:99999;padding:16px;';
    div.innerHTML =
        '<div style="background:#fff;border-radius:18px;max-width:420px;width:100%;padding:24px;'
        + 'text-align:center;font-family:inherit;">'
        + '<div style="font-size:2.2rem;margin-bottom:8px;">😕</div>'
        + '<h3 style="margin:0 0 8px;font-size:1.05rem;color:#333;">No pudimos registrar tu pedido</h3>'
        + '<p style="font-size:.85rem;color:#666;line-height:1.5;margin:0 0 14px;">'
        + 'No se te cobró nada y <strong>tu stock quedó liberado</strong>.<br>'
        + 'Escribinos por WhatsApp y lo cerramos al instante 🙌</p>'
        + '<div style="background:#fff6f4;border-radius:12px;padding:10px 12px;font-size:.78rem;'
        + 'color:#8a5b52;margin-bottom:14px;text-align:left;">' + lista
        + '<br><strong>Total: $' + Number(total || 0).toFixed(2) + '</strong></div>'
        + '<a href="' + waUrl + '" target="_blank" rel="noopener" style="display:block;background:#25D366;'
        + 'color:#fff;padding:12px;border-radius:100px;text-decoration:none;font-weight:700;'
        + 'font-size:.9rem;margin-bottom:8px;">💬 Escribir por WhatsApp</a>'
        + '<button onclick="document.getElementById(\'fallo-pedido\').remove()" style="background:none;'
        + 'border:none;color:#999;font-size:.8rem;cursor:pointer;">Cerrar</button></div>';
    document.body.appendChild(div);
    if (detalle) console.log('Detalle del fallo del pedido:', detalle);
}

// Contador visible de la reserva
function iniciarTimerReserva(segundos) {
    const aviso = $('reserva-aviso');
    const t = $('reserva-timer');
    if (!aviso || !t) return;
    aviso.style.display = '';
    let s = segundos;
    clearInterval(reservaTimerId);
    const pintar = () => {
        const m = Math.floor(s / 60);
        const ss = String(s % 60).padStart(2, '0');
        t.textContent = m + ':' + ss;
    };
    pintar();
    reservaTimerId = setInterval(() => {
        s--;
        if (s <= 0) {
            clearInterval(reservaTimerId);
            aviso.innerHTML = '⏰ <b>Tu reserva expiró.</b> Volvé a seleccionar el producto.';
            return;
        }
        pintar();
    }, 1000);
}

// ===== CUPÓN (plan contingencias v1.2 · Etapa 3) =====
let cuponAplicado = null;   // { codigo, valor, tope } — lo llena la validación del servidor

// Descuento SOLO sobre productos (el envío nunca lleva descuento), con tope
function descuentoCupon(baseTotal) {
    if (!cuponAplicado || !baseTotal) return 0;
    const bruto = Number(baseTotal) * Number(cuponAplicado.valor || 0) / 100;
    const tope = (cuponAplicado.tope === null || cuponAplicado.tope === undefined) ? 1e9 : Number(cuponAplicado.tope);
    return Math.round(Math.min(bruto, tope) * 100) / 100;
}

async function aplicarCupon() {
    const inp = $('cupon-codigo');
    const msg = $('cupon-msg');
    if (!inp || !msg) return;
    const codigo = (inp.value || '').trim().toUpperCase();
    msg.style.display = '';
    if (!codigo) {
        msg.style.color = '#b9453a';
        msg.textContent = 'Escribí el código de tu cupón 🙂';
        return;
    }
    msg.style.color = '#8a5b52';
    msg.textContent = 'Verificando…';
    try {
        const r = await fetch(SUPABASE_URL + '/functions/v1/cupones', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({
                accion: 'validar', codigo,
                telefono: ($('checkout-phone')?.value || '').trim(),
                subtotal: getCartTotal()
            })
        });
        const d = await r.json().catch(() => ({}));
        if (!d || !d.ok) {
            cuponAplicado = null;
            msg.style.color = '#b9453a';
            msg.textContent = '❌ ' + (d && (d.mensaje || d.error) ? (d.mensaje || d.error) : 'Ese cupón no es válido');
            updateCheckoutUI();
            return;
        }
        cuponAplicado = {
            codigo: d.codigo || codigo,
            valor: Number(d.valor || 0),
            tope: (d.tope === null || d.tope === undefined) ? null : Number(d.tope)
        };
        const desc = descuentoCupon(getCartTotal());
        msg.style.color = '#1a7f4b';
        msg.textContent = '✅ Cupón aplicado: ' + cuponAplicado.valor + '% de descuento (−$' + desc.toFixed(2) + ')';
        updateCheckoutUI();
    } catch (e) {
        cuponAplicado = null;
        msg.style.color = '#b9453a';
        msg.textContent = '❌ No pudimos verificar el cupón. Probá de nuevo.';
        updateCheckoutUI();
    }
}

function quitarCupon() {
    cuponAplicado = null;
    const msg = $('cupon-msg');
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
    const inp = $('cupon-codigo');
    if (inp) inp.value = '';
    updateCheckoutUI();
}

function initCuponUI() {
    const btn = $('cupon-aplicar');
    const inp = $('cupon-codigo');
    if (btn) btn.addEventListener('click', aplicarCupon);
    if (inp) {
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aplicarCupon(); } });
        inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase(); });
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCuponUI);
else initCuponUI();

// ===== PLAN 2 (19-sep-2026): teléfono obligatorio, WhatsApp y pago adelantado =====
const EF_PAGOS = SUPABASE_URL + '/functions/v1/pagos-noshow';
const HEADERS_PAGOS = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
};

// Normaliza el teléfono: 8 dígitos (7000-0000) → 503XXXXXXXX. Devuelve '' si no es válido.
function normalizarTelefono(v) {
    let t = String(v || '').replace(/\D/g, '');
    if (t.startsWith('0')) t = '503' + t.slice(1);
    if (t.length === 8) t = '503' + t;
    return (t.length === 11 && t.startsWith('503')) ? t : '';
}

function usaWhatsApp() {
    const r = document.querySelector('input[name="usa-wa"]:checked');
    return !r || r.value !== 'no';
}

function correoCliente() {
    const wa = $('checkout-email-wa');
    const fac = $('checkout-email');
    return ((wa && wa.value.trim()) || (fac && fac.value.trim()) || '');
}

// Valida nombre + teléfono (+ correo si no usa WhatsApp) ANTES de crear el pedido
function validarDatosCompra() {
    const nombre = $('checkout-name').value.trim();
    const tel = normalizarTelefono($('checkout-phone').value);
    if (!nombre) { showToast('📝 Escribí tu nombre'); return null; }
    if (!tel) {
        showToast('📱 Escribí tu teléfono de 8 dígitos (ej. 7000-0000)');
        mostrarAvisoTel('❌ Ese número no parece correcto — escribilo así: 7000-0000', false);
        return null;
    }
    if (!usaWhatsApp() && !correoCliente()) {
        const g = $('wa-correo-grupo');
        if (g) g.style.display = '';
        showToast('📧 Como no usás WhatsApp, dejanos tu correo para avisarte');
        return null;
    }
    mostrarAvisoTel('✅ Te escribiremos al ' + tel.slice(3, 7) + '-' + tel.slice(7), true);
    return { nombre, tel, correo: correoCliente() || null, preferido: usaWhatsApp() ? 'whatsapp' : 'correo' };
}

function mostrarAvisoTel(msg, ok) {
    const el = $('telefono-aviso');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = ok ? '#1a7f4b' : '#b9453a';
    el.style.display = msg ? '' : 'none';
}

// Bloquea el pago en efectivo cuando el cliente ya no retiró antes (2ª vez → pago adelantado)
function bloquearEfectivo(on) {
    const radio = document.querySelector('input[name="pay-method"][value="efectivo"]');
    const aviso = $('pago-adelantado-aviso');
    if (!radio) return;
    if (on) {
        if (radio.checked) document.querySelector('input[name="pay-method"][value="tarjeta"]').checked = true;
        radio.disabled = true;
        const label = radio.closest('label');
        if (label) { label.style.opacity = '.45'; label.style.pointerEvents = 'none'; }
        if (aviso) aviso.style.display = '';
    } else {
        radio.disabled = false;
        const label = radio.closest('label');
        if (label) { label.style.opacity = ''; label.style.pointerEvents = ''; }
        if (aviso) aviso.style.display = 'none';
    }
}

// Al escribir el teléfono: guarda el intento (recuperación de carrito) y consulta
// si el cliente tiene entregas sin retirar → pide pago adelantado.
async function revisarClienteEnCheckout() {
    const tel = normalizarTelefono($('checkout-phone').value);
    if (!tel) { bloquearEfectivo(false); return; }
    const nombre = $('checkout-name').value.trim();
    try {
        if (cart.length) {
            fetch(EF_PAGOS, {
                method: 'POST', headers: HEADERS_PAGOS,
                body: JSON.stringify({ accion: 'guardar-intento', telefono: tel, nombre, items: cart, total: getCartTotal() })
            }).catch(() => {});
        }
        const r = await fetch(EF_PAGOS, {
            method: 'POST', headers: HEADERS_PAGOS,
            body: JSON.stringify({ accion: 'consultar-cliente', telefono: tel })
        });
        const d = await r.json().catch(() => ({}));
        bloquearEfectivo(!!(d && d.pago_adelantado));
    } catch (_e) { bloquearEfectivo(false); }
}

function openCheckoutModal() {
    // La reserva de 5 minutos se renueva cada vez que abre el checkout
    reservarMiCarrito(cart);
    if (cart.length === 0) return;
    closeCart();
    // Autocompletar datos del usuario logueado
    if (currentUser) {
        const p = currentUser.profile || {};
        $('checkout-name').value = p.name || '';
        $('checkout-phone').value = p.phone || '';
    }
    updateCheckoutUI();
    mostrarResumenCompra();
    renderPuntosCards();   // tarjetas de día/punto con la fecha real de la próxima entrega
    toggleFacturaUI();     // estado inicial del bloque de comprobante
    if (typeof showPointWhatsApp === 'function') showPointWhatsApp();
    reservarCarrito(); // NUEVO: reserva los productos por 5 min (el primero que llega gana)
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
    // El bloque de entrega siempre visible (retiro en punto o C807)
    $('checkout-delivery').style.display = '';
    
    const deliveryMethod = document.querySelector('input[name="delivery-method"]:checked')?.value || 'punto';
    const wantsC807 = deliveryMethod === 'c807';
    
    // C807 SOLO con tarjeta: si paga efectivo, la opción desaparece por completo
    const c807Radio = $('delivery-c807');
    const c807Label = c807Radio ? c807Radio.closest('label') : null;
    if (c807Label) c807Label.style.display = isCash ? 'none' : '';
    
    const c807Note = $('checkout-c807-note'); // puede no existir (opción oculta)
    const pointGroup = $('checkout-point-group');
    const c807Group = $('checkout-c807-group');
    
    if (isCash) {
        // Efectivo: solo puntos BARATUSS. Forzar selección a "punto"
        if (c807Radio) c807Radio.checked = false;
        const puntoRadio = document.querySelector('input[name="delivery-method"][value="punto"]');
        if (puntoRadio) puntoRadio.checked = true;
        if (c807Note) c807Note.style.display = 'none';
        if (pointGroup) pointGroup.style.display = '';
        if (c807Group) c807Group.style.display = 'none';
    } else if (wantsC807) {
        // Tarjeta + C807: ocultar puntos BARATUSS, mostrar agencias C807
        if (c807Note) c807Note.style.display = 'none';
        if (pointGroup) pointGroup.style.display = 'none';
        if (c807Group) c807Group.style.display = '';
        if (typeof showC807Address === 'function') showC807Address();
    } else {
        // Tarjeta + punto BARATUSS: mostrar selector de puntos
        if (c807Note) c807Note.style.display = 'none';
        if (pointGroup) pointGroup.style.display = '';
        if (c807Group) c807Group.style.display = 'none';
    }
    
    // Fee: C807 = $1.00 (solo tarjeta), puntos BARATUSS = $0
    const fee = (!isCash && wantsC807) ? C807_FEE : 0;
    
    const baseTotal = getCartTotal();
    const descCupon = descuentoCupon(baseTotal);
    const totalConFee = Math.max(0, baseTotal + fee - descCupon);
    $('checkout-total').textContent = '$' + totalConFee.toFixed(2);
    const breakdown = $('checkout-breakdown');
    if (breakdown) {
        breakdown.innerHTML =
            (fee > 0 ? `<small style="opacity:.7;display:block;margin-top:4px;">Retiro C807: +$${fee.toFixed(2)}</small>` : '')
            + (descCupon > 0
                ? `<small style="display:block;margin-top:4px;color:#1a7f4b;">🎟️ Cupón ${cuponAplicado.codigo}: −$${descCupon.toFixed(2)}`
                  + ` <a href="#" onclick="quitarCupon();return false;" style="color:#b9453a;">(quitar)</a></small>`
                : '');
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
    
    // Datos de retiro (tarjeta puede elegir punto BARATUSS o C807)
    // PLAN 2: nombre + teléfono (+ correo si no usa WhatsApp) validados ANTES de cobrar
    const datos = validarDatosCompra();
    if (!datos) return;
    const name = datos.nombre;
    const phone = datos.tel;
    const deliveryMethod = document.querySelector('input[name="delivery-method"]:checked').value;
    const isC807 = deliveryMethod === 'c807';
    const punto = isC807 ? ($('checkout-c807-point').value || 'Agencia C807') : ($('checkout-point').value || 'Punto BARATUSS');
    const fee = isC807 ? C807_FEE : 0;
    const baseTotal = getCartTotal();
    const descCuponTarjeta = descuentoCupon(baseTotal);
    const total = Math.max(0, baseTotal + fee - descCuponTarjeta);

    // Documento tributario (opcional, decidido por el cliente): se valida ANTES de cobrar
    const fac = datosFactura();
    if (!fac.ok) { showToast(fac.error); return; }

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
                total: total,
                userId: currentUser?.id || null,
                deliveryType: isC807 ? 'retiro-c807' : 'retiro-punto',
                deliveryFee: fee,
                deliveryPoint: punto,
                customerName: name || null,
                customerPhone: phone || null,
                // PLAN 2: si no usa WhatsApp, el correo es el canal de aviso
                contactoPreferido: datos.preferido,
                token: sessionToken(),
                // Documento tributario (si el cliente lo pidió)
                facturaTipo: fac.datos.factura_tipo,
                facturaNombre: fac.datos.factura_nombre,
                facturaNit: fac.datos.factura_nit,
                facturaNrc: fac.datos.factura_nrc,
                facturaGiro: fac.datos.factura_giro,
                facturaDireccion: fac.datos.factura_direccion,
                customerEmail: fac.datos.customer_email || datos.correo || null,
                facturaPorCorreo: fac.datos.factura_por_correo,
                // 🎟️ Cupón (el servidor lo valida y recalcula el descuento; nunca se confía en el navegador)
                cuponCodigo: cuponAplicado ? cuponAplicado.codigo : null
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
        
        // Guardar ticket pendiente (se muestra al volver de Wompi con ?ref=)
        const mapsSel = isC807 ? $('checkout-c807-point') : null;
        const mapsUrl = mapsSel && mapsSel.selectedOptions.length ? mapsSel.selectedOptions[0].getAttribute('data-maps') : null;
        localStorage.setItem('baratuss_pending_ticket', JSON.stringify({
            name: name,
            phone: phone,
            ref: data.reference || ref,
            items: [...cart],
            punto: punto,
            mapsUrl: mapsUrl,
            ...fac.datos,
            total: total,
            metodo: 'tarjeta'
        }));
        
        // La orden ya fue creada por la Edge Function /create-payment con TODOS los datos
        // (delivery_type, delivery_point, customer_name/phone, user_id) y su reference.
        // ❌ Eliminada la llamada duplicada a createOrder(): insertaba una 2ª orden sin
        // reference que quedaba 'pendiente' para siempre (bug del reporte caos #1).
        // "Mis pedidos" carga por user_id y la orden de la EF ya lo tiene.
        
        // ✅ Actualizar stock local (la Edge Function ya lo reservó en la base)
        // Así el artículo desaparece al instante y nadie más puede pedirlo
        for (const item of cart) {
            const qty = item.qty || 1;
            const prod = products.find(p => p.id === item.id);
            if (prod) prod.stock = Math.max(0, (prod.stock || 0) - qty);
        }
        if (typeof renderProducts === 'function') renderProducts(currentFilter);
        
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
    const datos = validarDatosCompra();
    if (!datos) return;
    const name = datos.nombre;
    const phone = datos.tel;

    // Documento tributario (opcional, decidido por el cliente): se valida ANTES de vender el stock
    const fac = datosFactura();
    if (!fac.ok) { showToast(fac.error); return; }

    // Efectivo: siempre retiro en punto BARATUSS (C807 no existe con efectivo)
    const punto = $('checkout-point').value || 'Punto BARATUSS';
    const fee = 0; // puntos BARATUSS son gratis
    
    const items = [...cart];
    const baseTotal = getCartTotal();
    const descCupon = descuentoCupon(baseTotal);
    // NIVEL B: el total y la referencia definitivos los devuelve el servidor
    let total = Math.max(0, baseTotal + fee - descCupon);
    let ref = '';
    
    showToast('🔄 Procesando pedido...');
    
    // ═══════════════════════════════════════════════════════════════════════
    // NIVEL B (21-sep-2026) · el pedido lo arma el SERVIDOR
    // El navegador solo manda QUÉ quiere (ids + cantidades + talla). El servidor
    // busca los precios reales, valida el cupón, calcula el envío y el total,
    // aparta el stock y crea el pedido. Nadie puede tocar los números.
    // ═══════════════════════════════════════════════════════════════════════
    try {

        // El pedido lo crea el SERVIDOR: la tienda solo dice QUÉ se lleva el cliente.
        // (?simular_fallo=1 en la URL fuerza el fallo para poder probar este camino)
        const simularFallo = new URLSearchParams(location.search).get('simular_fallo') === '1';
        let orderErr = '';
        if (simularFallo) {
            orderErr = 'SIMULACIÓN de fallo (prueba pedida desde la URL)';
        } else {
            try {
                const facTipo = (fac.datos && fac.datos.factura_tipo) ? fac.datos.factura_tipo : 'ninguna';
                const resp = await fetch(CREAR_PEDIDO_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': SUPABASE_ANON_KEY,
                        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
                    },
                    body: JSON.stringify({
                        items: items.map(i => ({ id: i.id, qty: i.qty || 1, talla: i.size || null })),
                        cliente: {
                            nombre: name,
                            telefono: phone,
                            correo: fac.datos.customer_email || datos.correo || null,
                            usa_whatsapp: datos.preferido === 'whatsapp'
                        },
                        entrega: { tipo: 'retiro-punto', punto: punto },
                        cupon: (cuponAplicado && cuponAplicado.codigo) || null,
                        factura: {
                            tipo: facTipo,
                            nombre: fac.datos.factura_nombre,
                            nit: fac.datos.factura_nit,
                            nrc: fac.datos.factura_nrc,
                            giro: fac.datos.factura_giro,
                            direccion: fac.datos.factura_direccion,
                            por_correo: !!fac.datos.factura_por_correo
                        },
                        metodo: 'efectivo',
                        token: sessionToken(),
                        user_id: currentUser ? currentUser.id : null
                    })
                });
                const creado = await resp.json().catch(() => ({}));
                if (resp.ok && creado && creado.ok) {
                    ref = creado.reference;                 // ← la referencia la da el servidor
                    total = Number(creado.total || 0);      // ← y el total también
                } else {
                    const motivo = (creado && creado.motivo) || '';
                    const msg = motivo === 'sin_stock'
                            ? '😮 ' + (creado.error || 'Se agotó un producto') + ' — quitalo del carrito para seguir'
                        : motivo === 'reservada_por_otro'
                            ? '😮 Otra persona está comprando este producto ahora mismo. Intentá en unos minutos.'
                        : motivo === 'ya_usado' ? '🎟️ ' + (creado.error || 'Ese cupón ya fue usado')
                        : '❌ ' + ((creado && creado.error) || 'No se pudo registrar el pedido');
                    showToast(msg);
                    // Si el problema es un producto, lo saco del carrito para que pueda seguir
                    if ((motivo === 'sin_stock' || motivo === 'reservada_por_otro') && creado.producto) {
                        cart = cart.filter(i => String(i.id) !== String(creado.producto));
                        saveCart(); updateCartUI(); updateCheckoutUI();
                    }
                    // Si el cupón ya no sirve, lo saco del checkout
                    if (cuponAplicado && ['ya_usado', 'no_existe', 'vencido', 'inactivo', 'no_corresponde'].includes(motivo)) {
                        cuponAplicado = null; updateCheckoutUI();
                    }
                    return;
                }
            } catch (insertErr) {
                orderErr = (insertErr && insertErr.message) ? insertErr.message : String(insertErr);
            }
        }

        // ✅ VERIFICACIÓN (2026-09-18 · actualizado con Nivel B): el pedido YA quedó creado
        // por el servidor (con el stock apartado en la misma operación). Acá solo revisamos
        // que no haya habido error para no mostrar un ticket falso.
        const orderOk = !orderErr && !!ref;

        if (!orderOk) {
            console.log('⚠️ El pedido NO se guardó:', orderErr);
            // 1) NO se devuelve stock desde acá: con Nivel B el servidor crea el pedido y
            //    aparta el stock en la misma operación, así que si falló no se tocó nada.
            // 2) respaldo local: si el cliente recarga, no se pierden sus datos
            try {
                localStorage.setItem('baratuss_pedido_fallido', JSON.stringify({
                    pedido: orderPayload, fecha: new Date().toISOString(), error: orderErr
                }));
            } catch (_e) { /* sin espacio en el navegador */ }
            // 3) alerta al negocio (para que Cindy se entere al instante)
            await avisarFalloPedido({
                reference: ref, nombre: name, telefono: phone, total: total,
                items: (items || []).map(i => ({ id: i.id, qty: i.qty || 1, name: i.name })),
                motivo: orderErr
            });
            // 4) mensaje claro al cliente (sin ticket falso) + WhatsApp
            const detalleWa = (items || []).map(i => (i.qty || 1) + 'x ' + i.name).join(', ');
            const waUrl = 'https://wa.me/50362852631?text=' + encodeURIComponent(
                'Hola BARATUSS 🙋 Intenté hacer un pedido y no se registró.\nPedido: ' + detalleWa
                + '\nTotal: $' + Number(total || 0).toFixed(2) + '\n¿Me ayudan a cerrarlo?');
            mostrarFalloPedido(waUrl, items, total, orderErr);
            showToast('😕 No se pudo registrar el pedido — escribinos por WhatsApp');
            return;
        }
        
        // 🎟️ CUPÓN: ya lo validó y lo marcó como usado el SERVIDOR (dentro de crear-pedido),
        // en la misma operación que el pedido. Acá no hay nada que hacer.

        // Alta de despachos (las tarjetas de preparación) + ✅ VERIFICACIÓN (2026-09-18).
        // Antes no se revisaba nada: si fallaban, el pedido existía pero NO aparecía en el
        // panel, sin recordatorios ni aviso de entrega, y el cliente llegaba sin estar en la lista.
        try {
            const rd = await fetch(WOMPI_API_URL + '/create-despachos', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
                },
                body: JSON.stringify({
                    reference: ref,
                    items: items,
                    deliveryType: 'retiro-punto',
                    deliveryPoint: punto,
                    customerName: name || null,
                    customerPhone: phone || null
                })
            });
            const dd = await rd.json().catch(() => ({}));
            const listas = Number(dd && dd.creados ? dd.creados : 0)
                + Number(dd && dd.ya_existian ? dd.ya_existian : (dd && dd.count ? dd.count : 0));
            if (!rd.ok || listas < items.length) {
                console.log('⚠️ Faltan tarjetas de despacho:', JSON.stringify(dd));
                await avisarFalloPedido({
                    reference: ref, nombre: name, telefono: phone, total: total,
                    items: (items || []).map(i => ({ id: i.id, qty: i.qty || 1, name: i.name })),
                    motivo: 'El pedido se guardó, pero faltan tarjetas de despacho ('
                        + listas + ' de ' + items.length + ')'
                });
            }
        } catch (despErr) {
            console.log('No se pudo crear el despacho:', despErr.message);
            await avisarFalloPedido({
                reference: ref, nombre: name, telefono: phone, total: total,
                items: (items || []).map(i => ({ id: i.id, qty: i.qty || 1, name: i.name })),
                motivo: 'No se pudo contactar el alta de despachos: ' + (despErr.message || despErr)
            });
        }
        
        // El stock ya quedó apartado por el servidor en la MISMA operación del pedido (Nivel B)
        
        // Si no está logueado y no hay supabase, igual confirmamos
        cuponAplicado = null;   // el cupón ya quedó usado: se limpia del checkout
        cart = [];
        saveCart();
        updateCartUI();
        closeCheckoutModal();
        
        // Confirmación con ticket
        showToast('✅ Pedido confirmado');
        showTicket({
            name: name,
            phone: phone,
            ref: ref,
            items: items,
            punto: punto,
            mapsUrl: null,
            total: total,
            metodo: 'efectivo',
            // Documento tributario elegido por el cliente (para el botón "Ver mi factura")
            ...fac.datos
        });
        
    } catch (e) {
        showToast('❌ Error: ' + e.message);
    }
}

// ===== TICKET DE COMPRA =====
function showTicket(data) {
    $('ticket-ref').textContent = '#' + data.ref;
    $('ticket-name').textContent = data.name + (data.phone ? ' · ' + data.phone : '');
    $('ticket-point').textContent = data.punto || 'Por coordinar';
    $('ticket-total').textContent = '$' + data.total.toFixed(2);
    
    // Items con código (id)
    const itemsHtml = (data.items || []).map(it => `
        <div class="ticket__item">
            <span class="ticket__item-name">${it.qty || 1}× ${it.name}${it.size ? ` (${it.size})` : ''}
                <span class="ticket__item-code">· #${it.id}</span>
            </span>
            <span>$${((it.price || 0) * (it.qty || 1)).toFixed(2)}</span>
        </div>`).join('');
    $('ticket-items').innerHTML = itemsHtml || '<div class="ticket__item">—</div>';
    
    // Link Google Maps si aplica (C807 o Casa Matriz)
    const mapsRow = $('ticket-maps-row');
    const mapsLink = $('ticket-maps-link');
    if (data.mapsUrl) {
        mapsLink.href = data.mapsUrl;
        mapsRow.style.display = '';
    } else {
        mapsRow.style.display = 'none';
    }
    
    // Documento tributario: si el cliente lo pidió, se guarda y se ofrece el botón en el ticket
    const contFac = $('ticket-factura');
    if (contFac) {
        if (data.factura_tipo && data.factura_tipo !== 'ninguna') {
            _facturaPedido = {
                factura_tipo: data.factura_tipo,
                factura_nombre: data.factura_nombre, factura_nit: data.factura_nit,
                factura_nrc: data.factura_nrc, factura_giro: data.factura_giro,
                factura_direccion: data.factura_direccion, customer_email: data.customer_email,
                ref: data.ref, items: data.items, total: data.total,
                name: data.name, phone: data.phone, punto: data.punto,
            };
            const etiqueta = data.factura_tipo === 'ccf' ? 'comprobante de crédito fiscal' : 'factura de consumidor final';
            contFac.innerHTML = `<button class="btn btn--outline btn--full" onclick="verFactura()">🧾 Ver mi ${etiqueta}</button>`
                + (data.customer_email ? `<small style="display:block;margin-top:6px;text-align:center;color:#888;">📧 También a ${data.customer_email}</small>` : '');
        } else {
            contFac.innerHTML = '';
        }
    }

    // Cerrar checkout y mostrar ticket
    closeCheckoutModal();
    $('ticket-overlay').style.display = 'block';
    $('ticket-modal').style.display = 'block';
    $('ticket-modal').style.opacity = '1';
    $('ticket-modal').style.pointerEvents = 'auto';
    $('ticket-modal').classList.add('modal--open');
}

function closeTicket() {
    $('ticket-overlay').style.display = 'none';
    $('ticket-modal').style.display = 'none';
    $('ticket-modal').classList.remove('modal--open');
}
$('ticket-close').addEventListener('click', closeTicket);
$('ticket-overlay').addEventListener('click', closeTicket);
$('ticket-done').addEventListener('click', closeTicket);

// ============================================================
// DOCUMENTO TRIBUTARIO — EJERCICIO DE FACTURACIÓN (2026-09-17)
// El CLIENTE decide si quiere comprobante (factura de consumidor final o
// comprobante de crédito fiscal) y si lo quiere por correo. Los precios de la
// tienda YA incluyen IVA (13%), así que el documento lo desglosa hacia atrás.
// ⚠️ Mientras el emisor no tenga NRC y autorización de DTE de Hacienda, el
// documento se emite marcado como SIMULACIÓN (sin valor fiscal).
// ============================================================
const EMISOR = {
    nombre: 'BARATUSS',
    razonSocial: 'Cindy Rubio — persona natural',
    nit: 'PENDIENTE',
    nrc: 'PENDIENTE',
    giro: 'Comercio al por menor de prendas de vestir, accesorios y cosméticos',
    direccion: 'San Salvador, El Salvador',
    telefono: '+503 6285 2631',
    correo: 'baratusses@gmail.com',
    establecimiento: '0001',
    simulacion: true,     // ← poner false cuando existan NRC + DTE autorizado
};
const IVA_TASA = 0.13;
let _facturaPedido = null;

function tipoFacturaElegido() {
    const r = document.querySelector('input[name="factura-tipo"]:checked');
    return r ? r.value : 'ninguna';
}

function toggleFacturaUI() {
    const tipo = tipoFacturaElegido();
    const datos = $('factura-datos');
    const ccf = $('factura-ccf-campos');
    const correoGrupo = $('factura-correo-grupo');
    const quiereCorreo = !!($('factura-por-correo') && $('factura-por-correo').checked);
    if (datos) datos.style.display = tipo === 'ninguna' ? 'none' : '';
    if (ccf) ccf.style.display = tipo === 'ccf' ? '' : 'none';
    if (correoGrupo) correoGrupo.style.display = quiereCorreo ? '' : 'none';
}

// Valida SOLO si el cliente pidió documento. Devuelve { ok, error, datos }
function datosFactura() {
    const tipo = tipoFacturaElegido();
    const d = {
        factura_tipo: tipo, factura_por_correo: false, customer_email: null,
        factura_nombre: null, factura_nit: null, factura_nrc: null,
        factura_giro: null, factura_direccion: null,
    };
    if (tipo === 'ninguna') return { ok: true, datos: d };

    const porCorreo = !!($('factura-por-correo') && $('factura-por-correo').checked);
    d.factura_por_correo = porCorreo;
    if (porCorreo) {
        const correo = ($('checkout-email') ? $('checkout-email').value : '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(correo)) {
            return { ok: false, error: '📧 Escribí un correo válido para enviarte el documento' };
        }
        d.customer_email = correo;
    }
    if (tipo === 'ccf') {
        const nombre = ($('factura-nombre') ? $('factura-nombre').value : '').trim();
        const nit = ($('factura-nit') ? $('factura-nit').value : '').trim();
        const nrc = ($('factura-nrc') ? $('factura-nrc').value : '').trim();
        const giro = ($('factura-giro') ? $('factura-giro').value : '').trim();
        const dir = ($('factura-direccion') ? $('factura-direccion').value : '').trim();
        if (!nombre) return { ok: false, error: '🏢 Falta la razón social para el comprobante de crédito fiscal' };
        // Se aceptan NIT/NRC con o sin guiones (se valida la cantidad de dígitos, no el formato exacto):
        // trabar a un cliente legítimo por los guiones sería perder la venta.
        const nitDig = nit.replace(/\D/g, '');
        const nrcDig = nrc.replace(/\D/g, '');
        if (nitDig.length < 9 || nitDig.length > 14) {
            return { ok: false, error: '🏢 Revisá el NIT: se escribe 0000-000000-000-0 (ejemplo: 0614-150590-101-5)' };
        }
        if (nrcDig.length < 5 || nrcDig.length > 7) {
            return { ok: false, error: '🏢 Revisá el NRC: se escribe 00000-0 (ejemplo: 123456-7)' };
        }
        if (!giro) return { ok: false, error: '🏢 Falta el giro o actividad económica' };
        if (!dir) return { ok: false, error: '🏢 Falta la dirección del receptor' };
        d.factura_nombre = nombre; d.factura_nit = nit; d.factura_nrc = nrc;
        d.factura_giro = giro; d.factura_direccion = dir;
    } else {
        d.factura_nombre = ($('checkout-name') ? $('checkout-name').value : '').trim() || 'Consumidor final';
    }
    return { ok: true, datos: d };
}

function documentoHTML(p) {
    const total = Number(p.total || 0);
    const gravada = total / (1 + IVA_TASA);
    const iva = total - gravada;
    const esCCF = p.factura_tipo === 'ccf';
    const f = new Date();
    const fechaTxt = f.toLocaleDateString('es-SV') + ' ' + f.toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' });
    const correlativo = 'SIM-' + (esCCF ? 'CCF' : 'CF') + '-' + String(p.ref || '').slice(-6);
    const filas = (p.items || []).map(it => {
        const sub = (it.price || 0) * (it.qty || 1);
        return `<tr>
            <td class="num">${it.qty || 1}</td>
            <td>${it.name}${it.size ? ' · Talla ' + it.size : ''}<span class="mini"> · cód. #${it.id}</span></td>
            <td class="num">$${((sub / (1 + IVA_TASA)) / (it.qty || 1)).toFixed(2)}</td>
            <td class="num">$${(sub / (1 + IVA_TASA)).toFixed(2)}</td>
        </tr>`;
    }).join('');

    // ===== CÓDIGO QR =====
    // ⚠️ En un DTE autorizado el QR debe llevar el enlace oficial de consulta de Hacienda
    // (ambiente + código de generación + fecha de emisión). Mientras no exista autorización de DTE,
    // el QR lleva los datos del documento para poder verificarlo escaneando.
    let qrHtml = '';
    try {
        if (typeof qrcode === 'function') {
            const q = qrcode(0, 'M');
            q.addData([
                (esCCF ? 'COMPROBANTE DE CRÉDITO FISCAL' : 'FACTURA DE CONSUMIDOR FINAL') + ' — ' + EMISOR.nombre,
                'N°: ' + correlativo,
                'Fecha: ' + fechaTxt,
                'Emisor — NIT: ' + EMISOR.nit + ' / NRC: ' + EMISOR.nrc,
                'Receptor: ' + (p.factura_nombre || p.name || 'Consumidor final'),
                'Total: $' + total.toFixed(2),
                'Referencia: ' + (p.ref || '—'),
                EMISOR.simulacion ? 'DOCUMENTO DE SIMULACIÓN — SIN VALOR FISCAL' : '',
            ].filter(Boolean).join('\n'));
            q.make();
            qrHtml = `<div class="factura__qr">${q.createSvgTag({ cellSize: 3, margin: 1 })}<small>Escaneá para verificar este documento</small></div>`;
        }
    } catch (e) { qrHtml = ''; }

    return `
    ${EMISOR.simulacion ? '<div class="factura__simulacion">SIMULACIÓN — DOCUMENTO SIN VALOR FISCAL</div>' : ''}
    <div class="factura__cabecera">
        <div class="factura__emisor">
            <div class="factura__emisor-nombre">${EMISOR.nombre}</div>
            <div class="factura__dato">${EMISOR.razonSocial}</div>
            <div class="factura__dato">NIT: ${EMISOR.nit} · NRC: ${EMISOR.nrc}</div>
            <div class="factura__dato">Giro: ${EMISOR.giro}</div>
            <div class="factura__dato">Dirección: ${EMISOR.direccion}</div>
            <div class="factura__dato">Tel. ${EMISOR.telefono} · ${EMISOR.correo}</div>
            <div class="factura__dato">Establecimiento: ${EMISOR.establecimiento}</div>
        </div>
        <div class="factura__tipo-caja">
            <div class="factura__tipo">${esCCF ? 'COMPROBANTE DE CRÉDITO FISCAL' : 'FACTURA DE CONSUMIDOR FINAL'}</div>
            <div class="factura__numero">N° ${correlativo}</div>
            <div class="factura__dato">Fecha de emisión: ${fechaTxt}</div>
            <div class="factura__dato">Condición de pago: contado</div>
            <div class="factura__dato">Referencia interna: ${p.ref || '—'}</div>
        </div>
    </div>

    <div class="factura__bloque">
        <div class="factura__titulo">Datos del comprador</div>
        <div class="factura__grid">
            <div><span>Nombre</span>${p.factura_nombre || 'Consumidor final'}</div>
            <div><span>NIT</span>${esCCF ? (p.factura_nit || '—') : '—'}</div>
            <div><span>NRC</span>${esCCF ? (p.factura_nrc || '—') : '—'}</div>
            <div><span>Giro</span>${esCCF ? (p.factura_giro || '—') : '—'}</div>
            <div class="ancho"><span>Dirección</span>${esCCF ? (p.factura_direccion || '—') : '—'}</div>
            <div class="ancho"><span>Correo</span>${p.customer_email || '—'}</div>
            <div><span>Teléfono</span>${p.phone || '—'}</div>
            <div><span>Entrega</span>${p.punto || '—'}</div>
        </div>
    </div>

    <table class="factura__tabla">
        <thead>
            <tr><th>Cant.</th><th>Descripción</th><th class="num">P. unitario</th><th class="num">Ventas gravadas</th></tr>
        </thead>
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
        ${EMISOR.simulacion
            ? '⚠️ Documento de PRUEBA del sistema de facturación: no tiene valor fiscal mientras el emisor no cuente con NRC y la autorización de Documentos Tributarios Electrónicos (DTE) del Ministerio de Hacienda.'
            : 'Entrega: por correo electrónico o en el punto de retiro.'}
    </div>`;
}

function verFactura(pedido) {
    if (pedido) _facturaPedido = pedido;
    if (!_facturaPedido) return;
    const doc = $('factura-doc');
    if (doc) doc.innerHTML = documentoHTML(_facturaPedido);
    const aviso = $('factura-aviso');
    if (aviso) {
        aviso.textContent = _facturaPedido.customer_email
            ? 'Se enviará a ' + _facturaPedido.customer_email
            : 'Podés imprimirlo o guardarlo en PDF.';
    }
    const enviar = $('factura-enviar');
    if (enviar) enviar.style.display = _facturaPedido.customer_email ? '' : 'none';
    const ov = $('factura-overlay'), mo = $('factura-modal');
    if (ov) ov.style.display = 'block';
    if (mo) { mo.style.display = 'block'; mo.classList.add('modal--open'); }
}

function cerrarFactura() {
    const ov = $('factura-overlay'), mo = $('factura-modal');
    if (ov) ov.style.display = 'none';
    if (mo) { mo.style.display = 'none'; mo.classList.remove('modal--open'); }
}

(function initFacturaUI() {
    document.querySelectorAll('input[name="factura-tipo"]').forEach(r => r.addEventListener('change', toggleFacturaUI));
    const chk = $('factura-por-correo');
    if (chk) chk.addEventListener('change', toggleFacturaUI);
    const c = $('factura-close'), o = $('factura-overlay'), im = $('factura-imprimir');
    if (c) c.addEventListener('click', cerrarFactura);
    if (o) o.addEventListener('click', cerrarFactura);
    if (im) im.addEventListener('click', () => window.print());
    const en = $('factura-enviar');
    if (en) en.addEventListener('click', () => {
        alert('El envío automático por correo se activa en el próximo paso (falta conectar el servicio de correo).\n\nTu documento ya quedó registrado con el correo ' + ((_facturaPedido && _facturaPedido.customer_email) || '') + '.');
    });
})();

// ===== PLAN 2: WhatsApp / teléfono / pago adelantado =====
document.querySelectorAll('input[name="usa-wa"]').forEach(r => {
    r.addEventListener('change', () => {
        const g = $('wa-correo-grupo');
        if (g) g.style.display = usaWhatsApp() ? 'none' : '';
        if (!usaWhatsApp()) showToast('📧 Dejanos tu correo para avisarte del pedido');
    });
});
const _telInput = $('checkout-phone');
if (_telInput) {
    _telInput.addEventListener('blur', revisarClienteEnCheckout);
    _telInput.addEventListener('change', revisarClienteEnCheckout);
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
    
    // Ticket pendiente: mostrar al volver de Wompi (?ref=) o si hay uno guardado sin confirmar
    const params = new URLSearchParams(window.location.search);
    if (params.get('ref')) {
        const pending = localStorage.getItem('baratuss_pending_ticket');
        if (pending) {
            try {
                const ticket = JSON.parse(pending);
                localStorage.removeItem('baratuss_pending_ticket');
                setTimeout(() => showTicket(ticket), 800);
            } catch (e) {}
        }
    }
}

initApp();
