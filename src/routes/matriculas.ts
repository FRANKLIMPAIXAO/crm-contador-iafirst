// src/routes/matriculas.ts
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query, queryOne } from '../db/connection.js';

export const matriculasRouter: Router = Router();
matriculasRouter.use(requerAuth);

const schema = z.object({
  aluno_id: z.string().uuid(),
  mentoria_id: z.string().uuid(),
  valor: z.number().nonnegative(),
  dia_vencimento: z.number().int().min(1).max(28),
  data_inicio: z.string().optional(),
  data_fim: z.string().nullable().optional(),
  status: z.enum(['ativa', 'pausada', 'cancelada', 'concluida']).default('ativa'),
  notas: z.string().optional(),
});

matriculasRouter.get('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const rows = await query(
      `SELECT mt.*, a.nome AS aluno_nome, a.whatsapp AS aluno_whatsapp,
              m.nome AS mentoria_nome, m.cor AS mentoria_cor
       FROM matriculas mt
       JOIN alunos a ON a.id = mt.aluno_id
       JOIN mentorias m ON m.id = mt.mentoria_id
       WHERE mt.org_id = $1
       ORDER BY mt.created_at DESC`,
      [orgId],
    );
    res.json({ matriculas: rows });
  } catch (err) { next(err); }
});

matriculasRouter.post('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const input = schema.parse(req.body);
    const m = await queryOne(
      `INSERT INTO matriculas (org_id, aluno_id, mentoria_id, valor, dia_vencimento, data_inicio, data_fim, status, notas)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [orgId, input.aluno_id, input.mentoria_id, input.valor, input.dia_vencimento,
       input.data_inicio || new Date().toISOString().slice(0, 10),
       input.data_fim || null, input.status, input.notas || null],
    );
    res.status(201).json({ matricula: m });
  } catch (err) { next(err); }
});

matriculasRouter.patch('/:id', async (req, res, next) => {
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
    if (!campos.length) { res.status(400).json({ erro: 'nada' }); return; }
    vals.push(id, orgId);
    const m = await queryOne(
      `UPDATE matriculas SET ${campos.join(', ')} WHERE id = $${i} AND org_id = $${i + 1} RETURNING *`,
      vals,
    );
    if (!m) { res.status(404).json({ erro: 'matrícula não encontrada' }); return; }
    res.json({ matricula: m });
  } catch (err) { next(err); }
});
