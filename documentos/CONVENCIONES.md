# 📁 Convenciones de carpetas BARATUSS

**Válido para ambas PCs (Leo y Cindy).** Todo lo relativo a BARATUSS se consolida en `C:\BARATUSS\` en su subcarpeta correspondiente. Nada suelto en la raíz, ni en Escritorio, Descargas o scratch.

## Subcarpetas fijas

| Carpeta | Contenido |
|---|---|
| `buzon\` | Mensajes/token del bus bot-a-bot (no tocar) |
| `datos\` | CSV/JSON/datasets/productos |
| `imagenes\` | Imágenes, renders, creativos |
| `codigo\` | Scripts y código (incluye gestor_facturas, app_android) |
| `documentos\` | Textos, config, informes (.md), finanzas/ |
| `descargas\` | Descargas temporales |

## Reglas

1. **Siempre** guardar archivos nuevos de BARATUSS en su subcarpeta correspondiente.
2. La raíz es SOLO el código web de la tienda (index.html, admin.*, scripts.js, styles.css, api/, supabase/, worker/, assets/).
3. Secretos (service keys, tokens, credenciales) **nunca** se suben a git (`.gitignore` los protege; `codigo/`, `buzon/` y `backups/` están excluidos).
4. Confirmado por DUDU el 2026-08-31 — estructura alineada con la de Luke.
