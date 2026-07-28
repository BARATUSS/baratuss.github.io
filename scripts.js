// ========== RECURRENTE PAYMENT LINK ==========
const RECURRENTE_LINK = 'https://app.recurrente.com/s/cindy-rubio/o/o_ashc4npo';

// ========== PRODUCT DATA ==========
const products = [
    // ROPA
    { id: 1, name: 'Vestido Floral Primavera', category: 'ropa', price: 49.99, originalPrice: 69.99, badge: 'Oferta', imgClass: 'p-1', emoji: '👗' },
    { id: 2, name: 'Camisa Premium Blanca', category: 'ropa', price: 39.99, originalPrice: null, badge: null, imgClass: 'p-2', emoji: '👔' },
    { id: 3, name: 'Chaqueta Oversize', category: 'ropa', price: 89.99, originalPrice: null, badge: 'Nuevo', imgClass: 'p-4', emoji: '🧥' },
    { id: 4, name: 'Sudadera con Capucha', category: 'ropa', price: 44.99, originalPrice: null, badge: null, imgClass: 'p-5', emoji: '🏷️' },
    { id: 5, name: 'Jeans Skinny Azul', category: 'ropa', price: 54.99, originalPrice: null, badge: null, imgClass: 'p-7', emoji: '👖' },
    { id: 6, name: 'Camisa Negra', category: 'ropa', price: 2.00, originalPrice: null, badge: 'Nuevo', imgClass: 'p-9', emoji: '🖤' },
    // ACCESORIOS
    { id: 7, name: 'Bolso Tote de Cuero', category: 'accesorios', price: 59.99, originalPrice: 79.99, badge: 'Oferta', imgClass: 'p-3', emoji: '👜' },
    { id: 8, name: 'Gafas de Sol Aviador', category: 'accesorios', price: 29.99, originalPrice: 39.99, badge: 'Oferta', imgClass: 'p-6', emoji: '🕶️' },
    { id: 9, name: 'Reloj Deportivo', category: 'accesorios', price: 34.99, originalPrice: null, badge: 'Nuevo', imgClass: 'p-8', emoji: '⌚' },
    { id: 10, name: 'Collar Minimalista', category: 'accesorios', price: 19.99, originalPrice: null, badge: null, imgClass: 'p-12', emoji: '📿' },
    // SKINCARE
    { id: 11, name: 'Crema Facial Hidratante', category: 'skincare', price: 24.99, originalPrice: null, badge: null, imgClass: 'p-10', emoji: '🧴' },
    { id: 12, name: 'Sérum Vitamina C', category: 'skincare', price: 34.99, originalPrice: 44.99, badge: 'Oferta', imgClass: 'p-11', emoji: '✨' },
];

// ========== STATE ==========
let cart = JSON.parse(localStorage.getItem('baratuss_cart')) || [];
let currentFilter = 'all';

// ========== DOM REFS ==========
const productsGrid = document.getElementById('products-grid');
const cartSidebar = document.getElementById('cart-sidebar');
const cartOverlay = document.getElementById('cart-overlay');
const cartCount = document.getElementById('cart-count');
const cartItems = document.getElementById('cart-items');
const cartFooter = document.getElementById('cart-footer');
const cartTotal = document.getElementById('cart-total');
const toast = document.getElementById('toast');
const header = document.getElementById('header');

// ========== RENDER PRODUCTS ==========
function renderProducts(filter = 'all') {
    const filtered = filter === 'all'
        ? products
        : products.filter(p => p.category === filter);

    productsGrid.innerHTML = filtered.map(p => `
        <div class="product-card" data-id="${p.id}">
            <div class="product-card__img ${p.imgClass}">
                <span style="font-size:3.5rem;">${p.emoji}</span>
                ${p.badge ? `<span class="badge">${p.badge}</span>` : ''}
            </div>
            <div class="product-card__body">
                <div class="product-card__category">${capitalize(p.category)}</div>
                <div class="product-card__name">${p.name}</div>
                <div class="product-card__price">
                    <span class="current">$${p.price.toFixed(2)}</span>
                    ${p.originalPrice ? `<span class="original">$${p.originalPrice.toFixed(2)}</span>` : ''}
                </div>
                <button class="add-to-cart" data-id="${p.id}">
                    <i class="fas fa-shopping-bag"></i> Añadir
                </button>
                ${p.id === 6 ? `
                <a href="${RECURRENTE_LINK}" target="_blank" style="display:block;text-align:center;margin-top:8px;padding:10px;background:#ff9686;color:white;border-radius:10px;font-size:0.8rem;font-weight:500;text-decoration:none;">
                    ⚡ Comprar ahora
                </a>` : ''}
            </div>
        </div>
    `).join('');

    document.querySelectorAll('.add-to-cart').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            addToCart(parseInt(btn.dataset.id));
        });
    });
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ========== CATEGORY CARD CLICKS ==========
document.querySelectorAll('.cat-card').forEach(card => {
    card.addEventListener('click', (e) => {
        e.preventDefault();
        const filter = card.dataset.filter;
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`.filter-btn[data-filter="${filter}"]`)?.classList.add('active');
        currentFilter = filter;
        renderProducts(filter);
        document.getElementById('tienda').scrollIntoView({ behavior: 'smooth' });
    });
});

// ========== FOOTER FILTER LINKS ==========
document.querySelectorAll('.filter-link').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const filter = link.dataset.filter;
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(`.filter-btn[data-filter="${filter}"]`)?.classList.add('active');
        currentFilter = filter;
        renderProducts(filter);
        document.getElementById('tienda').scrollIntoView({ behavior: 'smooth' });
    });
});

// ========== CART OPERATIONS ==========
function addToCart(id) {
    const product = products.find(p => p.id === id);
    if (!product) return;
    const existing = cart.find(item => item.id === id);
    if (existing) {
        existing.qty += 1;
    } else {
        cart.push({ ...product, qty: 1 });
    }
    saveCart();
    updateCartUI();
    showToast(`${product.name} añadido ✨`);
}

function removeFromCart(id) {
    cart = cart.filter(item => item.id !== id);
    saveCart();
    updateCartUI();
}

function updateQty(id, delta) {
    const item = cart.find(i => i.id === id);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) {
        removeFromCart(id);
        return;
    }
    saveCart();
    updateCartUI();
}

function getCartTotal() {
    return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function saveCart() {
    localStorage.setItem('baratuss_cart', JSON.stringify(cart));
}

function updateCartUI() {
    const totalItems = cart.reduce((sum, item) => sum + item.qty, 0);
    cartCount.textContent = totalItems;

    if (cart.length === 0) {
        cartItems.innerHTML = `
            <div class="cart-empty">
                <i class="fas fa-shopping-bag"></i>
                <p>Tu carrito está vacío</p>
            </div>
        `;
        cartFooter.style.display = 'none';
        return;
    }

    cartFooter.style.display = 'block';
    cartItems.innerHTML = cart.map(item => `
        <div class="cart-item">
            <div class="cart-item__img ${item.imgClass}">${item.emoji}</div>
            <div class="cart-item__info">
                <div class="cart-item__name">${item.name}</div>
                <div class="cart-item__price">$${(item.price * item.qty).toFixed(2)}</div>
                <div class="cart-item__qty">
                    <button onclick="updateQty(${item.id}, -1)">−</button>
                    <span>${item.qty}</span>
                    <button onclick="updateQty(${item.id}, 1)">+</button>
                </div>
            </div>
            <button class="cart-item__remove" onclick="removeFromCart(${item.id})">
                <i class="fas fa-trash-alt"></i>
            </button>
        </div>
    `).join('');
    cartTotal.textContent = `$${getCartTotal().toFixed(2)}`;
}

// ========== CART SIDEBAR ==========
function openCart() {
    cartSidebar.classList.add('open');
    cartOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
}
function closeCart() {
    cartSidebar.classList.remove('open');
    cartOverlay.classList.remove('open');
    document.body.style.overflow = '';
}

document.getElementById('cart-btn').addEventListener('click', openCart);
document.getElementById('cart-close').addEventListener('click', closeCart);
cartOverlay.addEventListener('click', closeCart);

// ========== FILTERS ==========
document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderProducts(currentFilter);
    });
});

// ========== TOAST ==========
function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ========== CHECKOUT ==========
document.getElementById('checkout-btn').addEventListener('click', () => {
    if (cart.length === 0) return;
    window.open(RECURRENTE_LINK, '_blank');
    cart = [];
    saveCart();
    updateCartUI();
    setTimeout(closeCart, 500);
    showToast('🛒 Redirigiendo a pago seguro...');
});

// ========== NEWSLETTER ==========
document.getElementById('newsletter-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = e.target.querySelector('input').value;
    showToast(`📬 ${email} — ¡Bienvenida a BARATUSS!`);
    e.target.reset();
});

// ========== CONTACT FORM ==========
document.getElementById('contact-form').addEventListener('submit', (e) => {
    e.preventDefault();
    showToast('📩 Mensaje enviado. Te responderemos pronto.');
    e.target.reset();
});

// ========== HEADER SCROLL ==========
window.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', window.scrollY > 50);
});

// ========== MOBILE MENU ==========
const hamburger = document.getElementById('hamburger');
const navMenu = document.getElementById('nav-menu');
hamburger.addEventListener('click', () => {
    navMenu.classList.toggle('open');
});
document.querySelectorAll('.nav__link').forEach(link => {
    link.addEventListener('click', () => navMenu.classList.remove('open'));
});

// ========== NAV ACTIVE LINK ==========
document.querySelectorAll('.nav__link').forEach(link => {
    link.addEventListener('click', function() {
        document.querySelectorAll('.nav__link').forEach(l => l.classList.remove('active'));
        this.classList.add('active');
    });
});

// ========== INIT ==========
renderProducts();
updateCartUI();
