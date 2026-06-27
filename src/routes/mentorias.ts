// src/routes/mentorias.ts — CRUD catálogo de mentorias
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query, queryOne } from '../db/connection.js';

export const mentoriasRouter: Router = Router();
mentoriasRouter.use(requerAuth);

const schema = z.object({
  nome: z.string().min(1),
  descricao: z.string().optional(),
  valor_padrao: z.number().nonnegative().default(0),
  frequencia: z.enum(['mensal', 'trimestral', 'semestral', 'anual']).default('mensal'),
  ativa: z.boolean().default(true),
  cor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

mentoriasRouter.get('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const rows = await query(
      `SELECT m.*, COUNT(mt.id)::int AS matriculas_ativas
       FROM mentorias m
       LEFT JOIN matriculas mt ON mt.mentoria_id = m.id AND mt.status = 'ativa'
       WHERE m.org_id = $1
       GROUP BY m.id
       ORDER BY m.nome`,
      [orgId],
    );
    res.json({ mentorias: rows });
  } catch (err) { next(err); }
});

mentoriasRouter.post('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const input = schema.parse(req.body);
    const m = await queryOne(
      `INSERT INTO mentorias (org_id, nome, descricao, valor_padrao, frequencia, ativa, cor)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [orgId, input.nome, input.descricao || null, input.valor_padrao, input.frequencia, input.ativa, input.cor || null],
    );
    res.status(201).json({ mentoria: m });
  } catch (err) { next(err); }
});

mentoriasRouter.patch('/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const input = schema.partial().parse(req.body);
    const campos: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(input)) {
      campos.push(`${k} = $${i}`); vals.push(v); i++;
    }
    if (!campos.length) { res.status(400).json({ erro: 'nada pra atualizar' }); return; }
    vals.push(id, orgId);
    const m = await queryOne(
      `UPDATE mentorias SET ${campos.join(', ')} WHERE id = $${i} AND org_id = $${i + 1} RETURNING *`,
      vals,
    );
    if (!m) { res.status(404).json({ erro: 'mentoria não encontrada' }); return; }
    res.json({ mentoria: m });
  } catch (err) { next(err); }
});

mentoriasRouter.delete('/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    // soft delete: marca ativa=false (não exclui pra não quebrar histórico)
    const m = await queryOne(
      `UPDATE mentorias SET ativa = false WHERE id = $1 AND org_id = $2 RETURNING id`,
      [id, orgId],
    );
    if (!m) { res.status(404).json({ erro: 'mentoria não encontrada' }); return; }
    res.json({ ok: true, info: 'mentoria desativada (soft delete)' });
  } catch (err) { next(err); }
});
