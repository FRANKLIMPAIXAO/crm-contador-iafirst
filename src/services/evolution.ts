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

  // Individual: Evolution aceita só o número (sem @s.whatsapp.net).
  // GRUPO: precisa manter o JID completo com @g.us, senão não entrega.
  const ehGrupo = numero.endsWith('@g.us');
  const numeroLimpo = ehGrupo ? numero : numero.replace(/@s\.whatsapp\.net$/, '');

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
 * Estado da conexão da instância: 'open' | 'close' | 'connecting'.
 * GET /instance/connectionState/{instance}
 */
export async function connectionState(instancia?: string): Promise<string> {
  if (!isConfigured()) throw new Error('Evolution não configurada');
  const inst = instancia || config.EVOLUTION_INSTANCE_DEFAULT;
  const base = config.EVOLUTION_API_URL!.replace(/\/+$/, '');
  const r = await fetch(`${base}/instance/connectionState/${encodeURIComponent(inst)}`, {
    headers: { apikey: config.EVOLUTION_API_KEY! },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) return 'desconhecido';
  const j = await r.json().catch(() => ({} as any));
  return j?.instance?.state || j?.state || 'desconhecido';
}

/**
 * Lista TODOS os grupos que o número tá dentro.
 * Tenta várias variações de endpoint (versões diferentes do Evolution).
 */
export async function fetchAllGroups(instancia?: string): Promise<EvolutionGroup[]> {
  if (!isConfigured()) throw new Error('Evolution não configurada');
  const inst = instancia || config.EVOLUTION_INSTANCE_DEFAULT;
  const base = config.EVOLUTION_API_URL!.replace(/\/+$/, '');
  const encInst = encodeURIComponent(inst);

  const tentativas = [
    { method: 'GET' as const,  url: `${base}/group/fetchAllGroups/${encInst}?getParticipants=false` },
    { method: 'GET' as const,  url: `${base}/group/fetchAllGroups/${encInst}?getParticipants=true` },
    { method: 'POST' as const, url: `${base}/group/fetchAllGroups/${encInst}`, body: { getParticipants: false } },
    { method: 'GET' as const,  url: `${base}/group/findGroupInfos/${encInst}` },
  ];

  const erros: string[] = [];
  for (const t of tentativas) {
    try {
      const r = await fetch(t.url, {
        method: t.method,
        headers: {
          'Content-Type': 'application/json',
          apikey: config.EVOLUTION_API_KEY!,
        },
        body: t.body ? JSON.stringify(t.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        erros.push(`${t.method} ${t.url.split('/').slice(-2).join('/')} → ${r.status} ${txt.slice(0, 100)}`);
        continue;
      }
      const data = await r.json();
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.groups)) return data.groups;
      if (Array.isArray(data?.data)) return data.data;
      // Se veio objeto mas sem array conhecido, tenta pegar values
      if (data && typeof data === 'object') {
        const vals = Object.values(data).filter((v): v is any[] => Array.isArray(v));
        if (vals.length && vals[0]!.length > 0 && vals[0]![0]?.id) return vals[0] as EvolutionGroup[];
      }
      erros.push(`${t.method} ${t.url.split('/').slice(-2).join('/')} → resposta sem grupos: ${JSON.stringify(data).slice(0, 150)}`);
    } catch (e: any) {
      erros.push(`${t.method} → ${e.message}`);
    }
  }
  throw new Error(`Evolution fetchAllGroups falhou em todas variações:\n${erros.join('\n')}`);
}

/**
 * Lista participantes de UM grupo. Tenta variações.
 */
export async function fetchGroupParticipants(
  groupJid: string,
  instancia?: string,
): Promise<EvolutionGroupParticipant[]> {
  if (!isConfigured()) throw new Error('Evolution não configurada');
  const inst = instancia || config.EVOLUTION_INSTANCE_DEFAULT;
  const base = config.EVOLUTION_API_URL!.replace(/\/+$/, '');
  const encInst = encodeURIComponent(inst);
  const encJid = encodeURIComponent(groupJid);

  const tentativas = [
    { method: 'GET' as const, url: `${base}/group/participants/${encInst}?groupJid=${encJid}` },
    { method: 'GET' as const, url: `${base}/group/findParticipants/${encInst}?groupJid=${encJid}` },
    { method: 'POST' as const, url: `${base}/group/participants/${encInst}`, body: { groupJid } },
  ];

  for (const t of tentativas) {
    try {
      const r = await fetch(t.url, {
        method: t.method,
        headers: {
          'Content-Type': 'application/json',
          apikey: config.EVOLUTION_API_KEY!,
        },
        body: t.body ? JSON.stringify(t.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.participants)) return data.participants;
      if (Array.isArray(data?.data)) return data.data;
    } catch {/* tenta próxima */}
  }
  return [];  // silencioso — o sync tolera grupos sem membros
}

export type EvolutionMessage = {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  pushName?: string;
  message?: any;
  messageTimestamp?: number | string;
  messageType?: string;
};

/**
 * Busca mensagens de um chat/grupo. Tenta variações de endpoint.
 */
export async function fetchMessages(
  remoteJid: string,
  limit = 50,
  instancia?: string,
): Promise<EvolutionMessage[]> {
  if (!isConfigured()) throw new Error('Evolution não configurada');
  const inst = instancia || config.EVOLUTION_INSTANCE_DEFAULT;
  const base = config.EVOLUTION_API_URL!.replace(/\/+$/, '');
  const encInst = encodeURIComponent(inst);

  const tentativas: Array<{ method: 'POST' | 'GET'; url: string; body?: any }> = [
    { method: 'POST', url: `${base}/chat/findMessages/${encInst}`, body: { where: { key: { remoteJid } }, limit } },
    { method: 'POST', url: `${base}/chat/findMessages/${encInst}`, body: { where: { remoteJid }, limit } },
    { method: 'GET',  url: `${base}/chat/findMessages/${encInst}?remoteJid=${encodeURIComponent(remoteJid)}&limit=${limit}` },
  ];

  const erros: string[] = [];
  for (const t of tentativas) {
    try {
      const r = await fetch(t.url, {
        method: t.method,
        headers: { 'Content-Type': 'application/json', apikey: config.EVOLUTION_API_KEY! },
        body: t.body ? JSON.stringify(t.body) : undefined,
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        erros.push(`${t.method} → ${r.status} ${txt.slice(0, 120)}`);
        continue;
      }
      const data = await r.json();
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.messages)) return data.messages;
      if (Array.isArray(data?.messages?.records)) return data.messages.records;
      if (Array.isArray(data?.records)) return data.records;
      if (Array.isArray(data?.data)) return data.data;
      erros.push(`${t.method} → formato inesperado: ${JSON.stringify(data).slice(0, 150)}`);
    } catch (e: any) {
      erros.push(`${t.method} → ${e.message}`);
    }
  }
  throw new Error(`Evolution findMessages falhou:\n${erros.join('\n')}`);
}

/**
 * Extrai o texto de uma mensagem Evolution (formatos variados).
 */
export function extrairTextoMensagem(m: EvolutionMessage): string {
  const msg = m?.message;
  if (!msg) return '';
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    (msg.audioMessage ? '[áudio]' : '') ||
    (msg.stickerMessage ? '[figurinha]' : '') ||
    (msg.imageMessage ? '[imagem]' : '') ||
    (msg.videoMessage ? '[vídeo]' : '') ||
    (msg.documentMessage ? '[documento]' : '') ||
    ''
  );
}

/**
 * Extrai o número puro (55DDDNNNNNNNNN) do jid Evolution.
 */
export function jidToNumero(jid: string): string {
  return String(jid || '').replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '').replace(/\D/g, '');
}
