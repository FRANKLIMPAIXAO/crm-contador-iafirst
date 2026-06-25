// src/routes/leads.ts
// Placeholder — Fase 1 amplia (filtros, paginação, detalhe, update stage etc)
import { Router } from 'express';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query } from '../db/connection.js';

export const leadsRouter: Router = Router();
leadsRouter.use(requerAuth);

leadsRouter.get('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const rows = await query(
      `SELECT id, wa_jid, nome, produto_interesse, stage, qualif, score, valor,
              last_message_at, created_at
       FROM leads
       WHERE org_id = $1
       ORDER BY last_message_at DESC NULLS LAST, created_at DESC
       LIMIT 100`,
      [orgId],
    );
    res.json({ leads: rows });
  } catch (err) {
    next(err);
  }
});
