# 📋 INFORME COMPLETO — BARATUSS
### De principio a fin · Generado: 31 de julio de 2026

---

## 1. 🚀 El inicio

Cindy pidió crear una tienda de ropa en línea desde cero, hospedada en GitHub Pages (gratis). El proyecto nació como "MODA VIVA" y luego fue rebautizado como **BARATUSS** con la identidad visual oficial.

**Identidad actual:**
- Nombre: **BARATUSS**
- Color principal: `#ff9686` (rosado coral)
- Logo: `assets/logo.jpg` (proporcionado por Cindy)
- Instagram: **@baratuss_sv**
- Slogan: "Moda, accesorios & skincare"

---

## 2. 🏗️ Lo que se construyó (fase por fase)

### Fase 1 — Sitio web base
- Página principal con diseño limpio y elegante
- Secciones: Hero, categorías, tienda, nosotros, newsletter, footer
- 3 categorías obligatorias: **Ropa, Accesorios, Skincare**
- Catálogo inicial de 12 productos

### Fase 2 — Carrito y funcionalidad
- Carrito de compras persistente (se guarda en el navegador)
- Filtros por categoría
- Favoritos / "Me gusta"
- Notificaciones visuales (toasts)

### Fase 3 — Cuentas de usuario (Supabase)
- Registro, login, recuperar contraseña, cerrar sesión
- Perfil con nombre, dirección, ciudad, teléfono, email
- Historial de pedidos por usuario
- Base de datos en la nube (gratis): tablas `profiles`, `orders`, `wishlists`

### Fase 4 — Pagos en línea
- **Primera pasarela: Recurrente** (links de pago) — luego descartada
- **Migración a Wompi El Salvador** (pasarela oficial del Banco Agrícola):
  - Backend en Supabase Edge Functions (`wompi-checkout`)
  - Genera enlace de pago seguro automáticamente
  - Webhook que actualiza el estado del pedido cuando Wompi confirma
  - Estados: pendiente → aprobado/rechazado
  - Eliminación TOTAL del código de Recurrente ✅
  - Tarjetas de crédito/débito y puntos Agrícola

### Fase 5 — URL profesional
- Creación de la organización **BARATUSS** en GitHub
- URL final: **https://baratuss.github.io/** (sin "cindyrubiomusicsv")

### Fase 6 — Panel de administración
- **https://baratuss.github.io/admin.html** (protegido, solo cuenta admin)
- Gestión completa del inventario: crear, editar, eliminar productos
- Campos: SKU, nombre, categoría, tipo (nuevo/usado), costo, venta, stock
- Vista de pedidos con estado de pago, referencia, total y fecha
- Resumen: total de productos, valor del inventario, pedidos, pagados
- Alerta de **stock bajo** (menos de 3 unidades)
- **Selección por lotes**: checkbox en el encabezado + acciones masivas (ocultar/mostrar/eliminar varios a la vez)

### Fase 7 — Tienda conectada a la base de datos
- Los productos de la tienda ahora se leen **directamente de Supabase**
- Lo que agregás en el panel aparece **al instante** en la tienda
- Control visual por producto: emoji, etiqueta (Oferta/Nuevo), color de fondo, visible/oculto

### Fase 8 — Precios con impuestos incluidos
- **Precio final = venta × 1.189325 + $0.25** (IVA 13% + comisión Wompi 5.25% + $0.25)
- La tienda muestra el precio final con la nota "IVA y comisión incluidos"
- El panel muestra 3 columnas: Costo | Venta | **Cliente paga**
- Vista previa en vivo al escribir el precio: "El cliente pagará: $X.XX"

---

## 3. 🏗️ Arquitectura técnica actual

| Componente | Tecnología | Función |
|---|---|---|
| **Sitio web** | HTML/CSS/JS en GitHub Pages | La tienda visible |
| **Base de datos** | Supabase (PostgreSQL, gratis) | Productos, usuarios, pedidos, favoritos |
| **Autenticación** | Supabase Auth | Cuentas de clientes + admin |
| **Pagos** | Wompi El Salvador | Pasarela con tarjeta |
| **Backend pagos** | Supabase Edge Function | Crear enlaces de pago + webhooks |
| **Almacenamiento** | Repositorio GitHub | Código del sitio |

**Repositorios:**
- `baratuss/baratuss.github.io` (sitio activo)
- `cindyrubiomusicsv/baratuss` (copia del código)

**Archivos clave en C:\BARATUSS:**
- `index.html` — la tienda
- `admin.html` + `admin.js` + `admin.css` — panel de administración
- `scripts.js` — lógica de la tienda (carrito, cuentas, pagos)
- `supabase/functions/wompi-checkout/` — backend de pagos
- `assets/` — logo e isotipo

---

## 4. ✅ Estado actual — TODO funcionando

- ✅ Sitio online: **https://baratuss.github.io/**
- ✅ Carrito, favoritos, cuentas de usuario
- ✅ Pagos con Wompi (probados y funcionando)
- ✅ Panel admin con inventario completo
- ✅ Productos sincronizados Supabase ↔ tienda
- ✅ Selección por lotes
- ✅ Precios con IVA + comisión incluidos

**Credenciales de admin:**
- Email: `cindyrubiomusic@gmail.com`
- Panel: https://baratuss.github.io/admin.html

---

## 5. 🔜 Pendiente / Próximos pasos

1. **Estrategia de precios automática** (acordada, falta implementar):
   - Precio de venta = costo × 2 (utilidad neta 100%)
   - Marcación especial: Normal / Oferta (% descuento) / Liquidación (% mayor)
   - Badges automáticos: 🏷️ "Oferta" / 🔥 "Liquidación"
   - Vista previa de utilidad y precio final en el panel
2. (Opcional) Enviar informes por correo desde Gmail
3. (Opcional) Dominio propio tipo `baratuss.com.sv`
4. (Opcional) Publicidad / seguimiento de visitas

---

## 6. 💰 Resumen financiero de la estrategia

**Fórmula acordada:**
```
Precio de venta = costo de compra × 2 (utilidad 100%)
Precio final = venta × 1.189325 + $0.25
```

**Ejemplo:** Vestido costo $10 → venta $20 → cliente paga **$24.04**
→ Tu utilidad neta queda ≈ **$10** (100% del costo) ✅

---

*Informe generado automáticamente por Hermes (asistente de BARATUSS)*
