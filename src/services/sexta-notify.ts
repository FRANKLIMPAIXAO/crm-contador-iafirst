// src/services/sexta-notify.ts
// Notifica SEXTA-FEIRA via webhook quando rola algo importante (lead quente, lead novo respondeu).
// SEXTA decide o que fazer com isso (manda no Telegram do Franklim).
import { config } from '../config.js';

export interface AlertaPayload {
  tipo:
    | 'lead_novo'
    | 'lead_novo_frio' | 'lead_novo_morno' | 'lead_novo_quente'
    | 'lead_frio_respondeu' | 'lead_morno_respondeu' | 'lead_quente_respondeu';
  lead: {
    id: string;
    nome: string | null;
    wa_jid: string;
    produto_interesse: string;
    qualif: string;
    score: number;
    stage: string;
  };
  mensagem_lead?: string;
  triagem?: {
    intencao?: string;
    resumo?: string;
    sugestao_resposta?: string;
  };
  url_crm: string;
  respondido_auto?: boolean;
}

export function isConfigured(): boolean {
  return !!(process.env.SEXTA_WEBHOOK_URL && process.env.SEXTA_WEBHOOK_SECRET);
}

export async function notificar(payload: AlertaPayload): Promise<void> {
  if (!isConfigured()) {
    console.log('[sexta-notify] não configurado (SEXTA_WEBHOOK_URL ausente) — pulando');
    return;
  }
  const url = process.env.SEXTA_WEBHOOK_URL!;
  const secret = process.env.SEXTA_WEBHOOK_SECRET!;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sexta-secret': secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      console.warn(`[sexta-notify] webhook respondeu ${r.status}`);
    } else {
      console.log(`[sexta-notify] ✅ ${payload.tipo} — ${payload.lead.nome || payload.lead.wa_jid}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[sexta-notify] falhou:', msg);
  }
}

// Helper: monta URL pública do CRM pro lead específico
export function urlCrmLead(leadId: string): string {
  const base = (config.CORS_ORIGIN.split(',')[0] || 'http://localhost:3000').trim();
  return `${base}#lead=${leadId}`;
}
