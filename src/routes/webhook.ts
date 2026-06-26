// src/routes/webhook.ts
// POST /webhook/evolution — recebe MESSAGES_UPSERT e MESSAGES_UPDATE
// Valida segredo via header 'apikey' contra EVOLUTION_WEBHOOK_SECRET
import { Router } from 'express';
import { config } from '../config.js';
import { queryOne } from '../db/connection.js';
import { ingerirMensagemRecebida } from '../services/ingestao.js';

export const webhookRouter: Router = Router();

// Mapeia uma instância Evolution → org_id no banco.
// Por enquanto: pega a primeira org (single tenant prático).
// Quando virar SaaS, mapeia instance.nome → instance.org_id via banco.
async function resolverOrgIdParaInstancia(_instancia: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM orgs ORDER BY created_at ASC LIMIT 1`);
  return row?.id || null;
}

webhookRouter.post('/evolution', async (req, res) => {
  const recebido = req.headers['apikey'] || req.headers['x-webhook-secret'];
  if (!config.EVOLUTION_WEBHOOK_SECRET || recebido !== config.EVOLUTION_WEBHOOK_SECRET) {
    res.status(401).json({ erro: 'webhook secret inválido' });
    return;
  }

  const body = req.body as {
    event?: string;
    instance?: string;
    data?: {
      key?: { remoteJid?: string; fromMe?: boolean; id?: string };
      pushName?: string;
      message?: { conversation?: string; extendedTextMessage?: { text?: string } };
      messageTimestamp?: number;
    };
  };

  const event = body.event;
  const data = body.data;

  // ===== MESSAGES_UPDATE — atualização de status (entregue/lido) =====
  if (event === 'messages.update') {
    const waId = (data as any)?.key?.id || (data as any)?.keyId;
    const statusEvolution = (data as any)?.status || (data as any)?.update?.status;
    if (!waId || !statusEvolution) {
      res.status(202).json({ ok: true, ignorado: 'update sem id/status' });
      return;
    }
    // Map Evolution status (DELIVERY_ACK / READ / PLAYED) → nosso enum
    const mapStatus: Record<string, string> = {
      DELIVERY_ACK: 'delivered',
      SERVER_ACK: 'sent',
      READ: 'read',
      PLAYED: 'read',
      ERROR: 'failed',
    };
    const novoStatus = mapStatus[statusEvolution] || statusEvolution.toLowerCase();
    try {
      const { queryOne } = await import('../db/connection.js');
      await queryOne(
        `UPDATE messages SET status = $1 WHERE wa_message_id = $2`,
        [novoStatus, waId],
      );
    } catch(_) {}
    res.status(202).json({ ok: true, atualizado: waId, status: novoStatus });
    return;
  }

  if (event !== 'messages.upsert') {
    res.status(202).json({ ok: true, ignorado: event });
    return;
  }
  if (data?.key?.fromMe) {
    res.status(202).json({ ok: true, ignorado: 'fromMe' });
    return;
  }

  const waJid = data?.key?.remoteJid;
  const texto = data?.message?.conversation || data?.message?.extendedTextMessage?.text;
  if (!waJid || !texto) {
    res.status(202).json({ ok: true, ignorado: 'sem texto/jid' });
    return;
  }

  const orgId = await resolverOrgIdParaInstancia(body.instance || '');
  if (!orgId) {
    res.status(500).json({ erro: 'org não encontrada — rode o seed primeiro' });
    return;
  }

  try {
    const r = await ingerirMensagemRecebida({
      orgId,
      waJid,
      pushName: data.pushName || null,
      corpo: texto,
      waMessageId: data.key?.id || null,
      timestamp: data.messageTimestamp ? new Date(data.messageTimestamp * 1000) : new Date(),
    });
    res.status(202).json({ ok: true, lead_id: r.lead.id, criado: r.lead.criado_agora });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[webhook] ingestão falhou:', msg);
    res.status(500).json({ erro: 'falha na ingestão', mensagem: msg });
  }
});
