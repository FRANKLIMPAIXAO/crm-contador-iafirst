// src/routes/messages.ts
// Placeholder — Fase 1 implementa envio via Evolution
import { Router } from 'express';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query } from '../db/connection.js';

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
