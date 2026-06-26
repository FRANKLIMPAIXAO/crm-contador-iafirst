// src/services/evolution.ts
// Wrapper Evolution API (WhatsApp não-oficial)
// Docs: https://doc.evolution-api.com
import { config } from '../config.js';

export function isConfigured(): boolean {
  return !!(config.EVOLUTION_API_URL && config.EVOLUTION_API_KEY);
}

interface SendTextResult {
  ok: boolean;
  wa_message_id?: string;
  status?: string;
  erro?: string;
}

/**
 * Envia mensagem de texto via Evolution API
 * Endpoint: POST {base}/message/sendText/{instance}
 * Body: { number, text, options? }
 */
export async function sendText({
  instancia,
  numero,
  texto,
}: {
  instancia?: string;
  numero: string;
  texto: string;
}): Promise<SendTextResult> {
  if (!isConfigured()) {
    return { ok: false, erro: 'EVOLUTION_API_URL/KEY não configurados' };
  }
  const inst = instancia || config.EVOLUTION_INSTANCE_DEFAULT;
  const url = `${config.EVOLUTION_API_URL!.replace(/\/+$/, '')}/message/sendText/${inst}`;

  // Evolution aceita JID ou só número (sem @s.whatsapp.net)
  // Padroniza: tira sufixo se vier
  const numeroLimpo = numero.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.EVOLUTION_API_KEY!,
      },
      body: JSON.stringify({ number: numeroLimpo, text: texto }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, erro: `Evolution ${r.status}: ${json?.message || JSON.stringify(json).slice(0, 200)}` };
    }
    // Evolution retorna { key: { id, ... }, status, ... }
    return {
      ok: true,
      wa_message_id: json?.key?.id || json?.messageId || null,
      status: json?.status || 'sent',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, erro: 'Evolution erro: ' + msg };
  }
}
