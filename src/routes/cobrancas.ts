// src/routes/cobrancas.ts — read-only nesta fase (PIX e NFS-e vêm depois)
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query, queryOne } from '../db/connection.js';

export const cobrancasRouter: Router = Router();
cobrancasRouter.use(requerAuth);

// GET — lista com filtros (status, mês, aluno)
cobrancasRouter.get('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const filtros: string[] = ['c.org_id = $1'];
    const vals: unknown[] = [orgId];
    if (req.query.status) {
      filtros.push(`c.status = $${vals.length + 1}`); vals.push(req.query.status);
    }
    if (req.query.aluno_id) {
      filtros.push(`mt.aluno_id = $${vals.length + 1}`); vals.push(req.query.aluno_id);
    }
    if (req.query.mes) {
      filtros.push(`c.mes_referencia = $${vals.length + 1}`); vals.push(req.query.mes);
    }
    const rows = await query(
      `SELECT c.*, a.nome AS aluno_nome, a.whatsapp AS aluno_whatsapp,
              m.nome AS mentoria_nome, m.cor AS mentoria_cor
       FROM cobrancas c
       JOIN matriculas mt ON mt.id = c.matricula_id
       JOIN alunos a ON a.id = mt.aluno_id
       JOIN mentorias m ON m.id = mt.mentoria_id
       WHERE ${filtros.join(' AND ')}
       ORDER BY c.data_vencimento DESC
       LIMIT 200`,
      vals,
    );
    res.json({ cobrancas: rows });
  } catch (err) { next(err); }
});

// POST /:id/marcar-paga — marcação manual (até Inter API estar pronta)
const marcarPagaSchema = z.object({
  pago_em: z.string().optional(),
  metodo: z.enum(['pix', 'boleto', 'dinheiro', 'cartao', 'outro']).default('pix'),
  comprovante_url: z.string().optional(),
});

cobrancasRouter.post('/:id/marcar-paga', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const input = marcarPagaSchema.parse(req.body);
    const pagoEm = input.pago_em ? new Date(input.pago_em) : new Date();

    const cobranca = await queryOne<{
      id: string; matricula_id: string; valor: number; status: string;
    }>(
      `UPDATE cobrancas SET status = 'paga', pago_em = $1, comprovante_url = COALESCE($2, comprovante_url)
       WHERE id = $3 AND org_id = $4 RETURNING id, matricula_id, valor, status`,
      [pagoEm, input.comprovante_url || null, id, orgId],
    );
    if (!cobranca) { res.status(404).json({ erro: 'cobrança não encontrada' }); return; }

    // Pega aluno_id da matrícula
    const m = await queryOne<{ aluno_id: string }>(
      `SELECT aluno_id FROM matriculas WHERE id = $1`,
      [cobranca.matricula_id],
    );

    // Registra pagamento
    await queryOne(
      `INSERT INTO pagamentos (org_id, cobranca_id, aluno_id, valor, metodo, pago_em, fonte)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
      [orgId, id, m?.aluno_id || null, cobranca.valor, input.metodo, pagoEm],
    );

    res.json({ ok: true, cobranca });
  } catch (err) { next(err); }
});

// GET /resumo — métricas pro dashboard
cobrancasRouter.get('/_resumo', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const mesAtual = new Date().toISOString().slice(0, 7);
    const r = await queryOne(
      `WITH t AS (
         SELECT
           COUNT(*) FILTER (WHERE mes_referencia = $2) AS no_mes,
           COUNT(*) FILTER (WHERE status = 'paga' AND mes_referencia = $2) AS pagas_mes,
           COUNT(*) FILTER (WHERE status IN ('aberta','atrasada') AND data_vencimento < CURRENT_DATE) AS atrasadas,
           COALESCE(SUM(valor) FILTER (WHERE status = 'paga' AND mes_referencia = $2), 0) AS faturado_mes,
           COALESCE(SUM(valor) FILTER (WHERE status IN ('aberta','atrasada') AND data_vencimento < CURRENT_DATE), 0) AS inadimplencia_valor,
           COALESCE(SUM(valor) FILTER (WHERE status IN ('aberta','atrasada') AND data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'), 0) AS proximos_7d
         FROM cobrancas WHERE org_id = $1
       )
       SELECT * FROM t`,
      [orgId, mesAtual],
    );
    res.json({ resumo: r, mes_atual: mesAtual });
  } catch (err) { next(err); }
});
