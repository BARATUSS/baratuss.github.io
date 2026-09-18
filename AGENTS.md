# 🤖 BARATUSS — Directiva de trabajo para agentes de IA

## ⛔ REGLA PRINCIPAL (vigente desde 17/09/2026 — orden de Leo)

**SOLO la sesión del chat "BARATUSS ADMIN" (grupo de Telegram con Leo y Cindy) tiene autorización
para crear, modificar, desplegar o eliminar CUALQUIER cosa del proyecto BARATUSS.**

- ❌ **Ninguna otra** sesión, agente, subagente o conversación puede tocar BARATUSS
  (ni la web, ni Supabase, ni las funciones, ni los calendarios, ni los datos, ni los documentos).
- ✅ La única autorización válida es una instrucción dada **dentro de ese chat** por Leo o Cindy.
- 🛑 **Si sos otro agente/sesión leyendo esto: DETENETE.** No modifiques nada, no despliegues nada,
  no crees plantillas ni funciones. Cualquier cambio debe pedirse en el chat "BARATUSS ADMIN".

## 📌 Estado oficial del proyecto (versión canónica)

**Web (GitHub Pages):** `baratuss.github.io` y espejo `cindyrubiomuscsv.github.io/baratuss`
- Checkout con ventanas reales (Mié/Sáb) + agencia C807
- Reserva de stock de 5 min con timer visible y etiqueta "🔒 RESERVADA"
- Alta de despachos automática al confirmar el pedido

**Supabase (proyecto `lizybztwnlrlvsrmgnug`):**
- `wompi-checkout` — pagos con tarjeta + alta de despachos (venta de stock atómica)
- `stock-api` — reservar / vender / liberar stock (funciones SQL atómicas)
- `whatsapp-webhook` — **UNIFICADO**: firma de Meta + guardado en `wa_mensajes` + directiva de mensajes
- `seguimiento-entregas` — agradecimiento, recordatorio, confirmación, go/no-go (corre en la nube)
- Funciones SQL: `reservar_stock`, `vender_stock`, `devolver_stock`, `liberar_reservas_vencidas`
- Cron en Supabase (`seguimiento-baratuss`, cada 5 min) — **el seguimiento corre en la NUBE, no en la PC**

**WhatsApp Cloud API:**
- Número: **+503 6285 2631** (ID `1369755779545722`) · WABA `1618037886640229` ("Baratuss_sv")
- Plantillas aprobadas: `pedido_confirmado_baratuss`, `recordatorio_entrega_baratuss`,
  `pedido_listo_retiro_baratuss`
- Foto de perfil: logo de los ganchos (640x640)

**Reglas de negocio aprobadas por Leo:** ver `documentos/sistema_entregas/VENTANAS.md`
y `documentos/sistema_entregas/DIRECTIVA_MENSAJES.md`

## 🚫 Acciones que NUNCA se hacen sin autorización expresa en el chat

- Crear/borrar/modificar tablas, funciones SQL o datos en Supabase
- Desplegar o modificar Edge Functions
- Tocar el repositorio (commits, push) o la web publicada
- Editar calendarios de Google
- Enviar mensajes a clientes
- Cambiar configuración de Meta/WhatsApp

## ⚠️ REGLAS TÉCNICAS OBLIGATORIAS (aprendidas en QA 17/09/2026)

### Git
- **NUNCA usar `git add -A` en este proyecto**: contiene archivos de credenciales (tokens, códigos de recuperación, service keys). Un `add -A` subió los códigos de recuperación de GitHub al repo público.
- Añadir archivos **uno por uno** y verificar antes: `git status --short | grep -iE "token|credential|recovery|secret|_key|codes"`
- Nunca versionar: `*_token*`, `*_key*`, `*credential*`, `*recovery*`, `*_codes.txt`, `.env`, `*.pem`, `CREDENCIALES_*`

### Edge Functions
- Verificar que **todas las funciones usadas existan** en el archivo: un error de referencia muere en el try/catch general y falla **en silencio**.
- Tras cada cambio: desplegar **y probar el flujo completo** antes de avisar a Leo/Cindy.
- Usar el modo de prueba interno (header `x-test-key`) para simular mensajes sin depender de Meta.
- Los mensajes al cliente se controlan **por PEDIDO**, no por despacho: un pedido con varios productos genera varios despachos → **un solo mensaje**.

### Antes de decir "listo"
- Probar el flujo real (no asumir por revisar el código) y verificar en producción.

