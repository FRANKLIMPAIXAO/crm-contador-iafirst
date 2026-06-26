// src/routes/messages.ts
// GET  /api/messages/lead/:leadId — histórico
// POST /api/messages/lead/:leadId — envia mensagem via Evolution + grava como 'out'
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId, getUserId } from '../middleware/tenant.js';
import { query, queryOne } from '../db/connection.js';
import * as evolution from '../services/evolution.js';

export const messagesRouter: Router = Router();
messagesRouter.use(requerAuth);

messagesRouter.get('/lead/:leadId', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { leadId } = req.params;
    const rows = await query(
      `SELECT id, direcao, corpo, status, ts
       FROM messages
       WHERE org_id = $1 AND lead_id = $2
       ORDER BY ts ASC
       LIMIT 500`,
      [orgId, leadId],
    );
    res.json({ messages: rows });
  } catch (err) {
    next(err);
  }
});

const sendSchema = z.object({
  corpo: z.string().min(1).max(4000),
});

messagesRouter.post('/lead/:leadId', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const { leadId } = req.params;
    const { corpo } = sendSchema.parse(req.body);

    const lead = await queryOne<{ id: string; wa_jid: string }>(
      `SELECT id, wa_jid FROM leads WHERE id = $1 AND org_id = $2`,
      [leadId, orgId],
    );
    if (!lead) {
      res.status(404).json({ erro: 'lead não encontrado' });
      return;
    }

    let status: 'sent' | 'failed' = 'failed';
    let waMessageId: string | null = null;
    let erroEnvio: string | null = null;

    if (evolution.isConfigured()) {
      const r = await evolution.sendText({ numero: lead.wa_jid, texto: corpo });
      if (r.ok) {
        status = 'sent';
        waMessageId = r.wa_message_id || null;
      } else {
        erroEnvio = r.erro || 'falha desconhecida';
      }
    } else {
      // Modo DEV: Evolution não configurada — registra como "sent" pra UX funcionar
      status = 'sent';
      erroEnvio = 'modo dev — Evolution não configurada, mensagem salva mas não enviada';
    }

    const msg = await queryOne<{ id: string; ts: Date }>(
      `INSERT INTO messages (org_id, lead_id, direcao, corpo, wa_message_id, status)
       VALUES ($1, $2, 'out', $3, $4, $5)
       RETURNING id, ts`,
      [orgId, leadId, corpo, waMessageId, status],
    );

    await queryOne(`UPDATE leads SET last_message_at = NOW() WHERE id = $1`, [leadId]);

    await queryOne(
      `INSERT INTO activities (org_id, lead_id, tipo, conteudo, autor)
       VALUES ($1, $2, 'mensagem_enviada', $3, $4)`,
      [orgId, leadId, JSON.stringify({ status, erro: erroEnvio, preview: corpo.slice(0, 100) }), userId],
    );

    res.status(201).json({
      message: { ...msg, direcao: 'out', corpo, status },
      aviso: erroEnvio,
    });
  } catch (err) {
    next(err);
  }
});
