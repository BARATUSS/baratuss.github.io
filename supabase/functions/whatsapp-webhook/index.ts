import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

// Token de verificación que se pega en la pantalla de Meta (Configuración → Webhook)
const VERIFY_TOKEN = 'baratuss_wa_2026';

// Clave secreta de la app (para validar que los mensajes vengan realmente de Meta).
// Se configura como secreto de la función: WHATSAPP_APP_SECRET.
const APP_SECRET = Deno.env.get('WHATSAPP_APP_SECRET') || '';

/** Comparación en tiempo constante (evita filtrar información por timing) */
function igualSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Valida el header X-Hub-Signature-256 que Meta firma con el App Secret */
async function firmaValida(raw: string, header: string | null): Promise<boolean> {
  if (!APP_SECRET) return true;                 // sin secreto configurado no se valida (compatibilidad)
  if (!header || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return igualSeguro(hex, header.slice(7));
}

/** Extrae el texto legible de cualquier tipo de mensaje de WhatsApp */
function extraerTexto(msg: any): string {
  return msg.text?.body
    || msg.button?.text
    || msg.interactive?.button_reply?.title
    || msg.interactive?.list_reply?.title
    || msg.image?.caption
    || msg.document?.caption
    || msg.video?.caption
    || '[' + (msg.type || 'mensaje') + ']';
}

serve(async (req) => {
  const url = new URL(req.url);

  // ===== VERIFICACION DE META (GET) =====
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // ===== MENSAJES ENTRANTES (POST) =====
  if (req.method === 'POST') {
    try {
      // 0) Validar que el mensaje venga firmado por Meta (App Secret)
      const raw = await req.text();
      const firma = req.headers.get('x-hub-signature-256');
      if (!(await firmaValida(raw, firma))) {
        return new Response(JSON.stringify({ ok: false, error: 'firma invalida' }), {
          status: 401, headers: { 'Content-Type': 'application/json' }
        });
      }

      const body = JSON.parse(raw);
      const entries = body.entry || [];
      let guardados = 0;
      let cruzados = 0;
      let errores = 0;

      for (const entry of entries) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id || null;
          const displayPhone = value.metadata?.display_phone_number || null;

          // Nombre de perfil de cada contacto del payload
          const contactos: Record<string, string | null> = {};
          for (const c of value.contacts || []) {
            contactos[String(c.wa_id || '')] = c.profile?.name || null;
          }

          for (const msg of value.messages || []) {
            const tel = String(msg.from || '');
            const texto = extraerTexto(msg);
            const ts = msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null;

            // 1) Buscar el despacho activo de ese cliente (por telefono)
            const ult8 = tel.slice(-8);
            const { data: desp } = await supabase
              .from('despachos')
              .select('id, notas, estado_logistico, customer_phone, order_reference')
              .ilike('customer_phone', '%' + ult8 + '%')
              .neq('estado_logistico', 'entregado')
              .order('id', { ascending: false })
              .limit(1)
              .maybeSingle();

            // 2) Guardar SIEMPRE el mensaje (idempotente por id de Meta)
            const { error: errIns } = await supabase
              .from('wa_mensajes')
              .upsert({
                wa_message_id: msg.id || null,
                telefono: tel,
                nombre_perfil: contactos[tel] ?? null,
                texto,
                tipo: msg.type || 'text',
                direccion: 'entrante',
                phone_number_id: phoneNumberId,
                display_phone_number: displayPhone,
                order_reference: (desp as any)?.order_reference || null,
                despacho_id: (desp as any)?.id || null,
                wa_timestamp: ts
              }, { onConflict: 'wa_message_id', ignoreDuplicates: true });

            if (errIns) errores++;
            else guardados++;

            // 3) Si hay despacho, reflejarlo en su bitácora (confirma / reprograma)
            if (desp) {
              const norm = (texto || '').toString().trim().toLowerCase();
              const esConfirma = ['✅', 'confirmo', 'confirm', 'sí', 'si', '1'].some(c => norm.includes(c));
              const esReprog = ['🔄', 'reprogram', 'no puedo', 'cambiar', '2'].some(c => norm.includes(c));
              const marca = esConfirma ? '✅ CONF' : (esReprog ? '🔄 REPROG' : '💬 MSG');
              const sello = new Date().toISOString().slice(0, 16).replace('T', ' ');
              const nuevas = (((desp as any).notas as string) || '') + '\n' + marca + ' ' + sello + ': ' + texto;

              await supabase
                .from('despachos')
                .update({ notas: nuevas.trim().slice(-4000), visto: false })
                .eq('id', (desp as any).id);
              cruzados++;
            }
          }
        }
      }

      return new Response(JSON.stringify({ ok: true, guardados, cruzados, errores }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      // Siempre 200 para que Meta no reintente en bucle
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Method not allowed', { status: 405 });
});
