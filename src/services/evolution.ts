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
  // encodeURIComponent pra suportar nomes com espaço/caracteres especiais
  const url = `${config.EVOLUTION_API_URL!.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(inst)}`;

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

// ============================================================
// GROUPS — fetch all + participants
// ============================================================

export type EvolutionGroup = {
  id: string;              // jid do grupo (ex: 120363xxxxx@g.us)
  subject: string;         // nome do grupo
  subjectOwner?: string;
  subjectTime?: number;
  creation?: number;
  owner?: string;
  desc?: string;
  descId?: string;
  restrict?: boolean;
  announce?: boolean;
  size?: number;
  pictureUrl?: string | null;
};

export type EvolutionGroupParticipant = {
  id: string;              // jid do membro (ex: 5562...@s.whatsapp.net)
  admin?: 'admin' | 'superadmin' | null;
};

/**
 * Lista TODOS os grupos que o número tá dentro.
 * GET /group/fetchAllGroups/{instance}?getParticipants=false
 */
export async function fetchAllGroups(instancia?: string): Promise<EvolutionGroup[]> {
  if (!isConfigured()) throw new Error('Evolution não configurada');
  const inst = instancia || config.EVOLUTION_INSTANCE_DEFAULT;
  const url = `${config.EVOLUTION_API_URL!.replace(/\/+$/, '')}/group/fetchAllGroups/${encodeURIComponent(inst)}?getParticipants=false`;
  const r = await fetch(url, {
    headers: { apikey: config.EVOLUTION_API_KEY! },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Evolution fetchAllGroups ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  // Formato varia entre versões: pode vir { groups: [...] } ou array direto
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.groups)) return data.groups;
  return [];
}

/**
 * Lista participantes de UM grupo.
 * GET /group/participants/{instance}?groupJid=xxx
 */
export async function fetchGroupParticipants(
  groupJid: string,
  instancia?: string,
): Promise<EvolutionGroupParticipant[]> {
  if (!isConfigured()) throw new Error('Evolution não configurada');
  const inst = instancia || config.EVOLUTION_INSTANCE_DEFAULT;
  const url = `${config.EVOLUTION_API_URL!.replace(/\/+$/, '')}/group/participants/${encodeURIComponent(inst)}?groupJid=${encodeURIComponent(groupJid)}`;
  const r = await fetch(url, {
    headers: { apikey: config.EVOLUTION_API_KEY! },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Evolution participants ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.participants)) return data.participants;
  return [];
}

/**
 * Extrai o número puro (55DDDNNNNNNNNN) do jid Evolution.
 */
export function jidToNumero(jid: string): string {
  return String(jid || '').replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '').replace(/\D/g, '');
}
