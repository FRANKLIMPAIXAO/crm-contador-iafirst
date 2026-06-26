// src/routes/leads.ts
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query, queryOne } from '../db/connection.js';

export const leadsRouter: Router = Router();
leadsRouter.use(requerAuth);

leadsRouter.get('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const rows = await query(
      `SELECT id, wa_jid, nome, produto_interesse, stage, qualif, score, valor,
              tags, last_message_at, created_at
       FROM leads
       WHERE org_id = $1
       ORDER BY last_message_at DESC NULLS LAST, created_at DESC
       LIMIT 200`,
      [orgId],
    );
    res.json({ leads: rows });
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const lead = await queryOne(
      `SELECT * FROM leads WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!lead) {
      res.status(404).json({ erro: 'lead não encontrado' });
      return;
    }
    const messages = await query(
      `SELECT id, direcao, corpo, status, ts FROM messages
       WHERE lead_id = $1 AND org_id = $2 ORDER BY ts ASC LIMIT 500`,
      [id, orgId],
    );
    const activities = await query(
      `SELECT id, tipo, conteudo, created_at FROM activities
       WHERE lead_id = $1 AND org_id = $2 ORDER BY created_at DESC LIMIT 20`,
      [id, orgId],
    );
    res.json({ lead, messages, activities });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  stage: z.enum(['novo', 'qualificado', 'proposta', 'negociacao', 'fechado', 'perdido']).optional(),
  qualif: z.enum(['frio', 'morno', 'quente']).optional(),
  produto_interesse: z.enum(['familia', 'iafirst', 'pacservice', 'contachat', 'indefinido']).optional(),
  valor: z.number().nonnegative().optional(),
  nome: z.string().optional(),
  cnpj: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

leadsRouter.patch('/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const patch = patchSchema.parse(req.body);

    const campos: string[] = [];
    const valores: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      campos.push(`${k} = $${i}`);
      valores.push(v);
      i++;
    }
    if (campos.length === 0) {
      res.status(400).json({ erro: 'nenhum campo enviado' });
      return;
    }
    valores.push(id, orgId);

    const lead = await queryOne(
      `UPDATE leads SET ${campos.join(', ')}
       WHERE id = $${i} AND org_id = $${i + 1}
       RETURNING id, stage, qualif, produto_interesse, valor, nome, tags`,
      valores,
    );
    if (!lead) {
      res.status(404).json({ erro: 'lead não encontrado' });
      return;
    }
    res.json({ lead });
  } catch (err) {
    next(err);
  }
});
