// src/routes/alunos.ts — CRUD mentorados + promote lead → aluno
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query, queryOne, transaction } from '../db/connection.js';

export const alunosRouter: Router = Router();
alunosRouter.use(requerAuth);

const enderecoSchema = z.object({
  rua: z.string().optional(),
  numero: z.string().optional(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
  cidade: z.string().optional(),
  uf: z.string().length(2).optional(),
  cep: z.string().optional(),
}).optional();

const schema = z.object({
  nome: z.string().min(1),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  cpf_cnpj: z.string().optional(),
  endereco: enderecoSchema,
  status: z.enum(['ativo', 'inadimplente', 'pausado', 'cancelado']).default('ativo'),
  notas: z.string().optional(),
});

// GET — lista alunos com resumo de matrículas e status pagamento
alunosRouter.get('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const status = req.query.status as string | undefined;
    const filtros: string[] = ['a.org_id = $1'];
    const vals: unknown[] = [orgId];
    if (status) { filtros.push(`a.status = $${vals.length + 1}`); vals.push(status); }
    const rows = await query(
      `SELECT
         a.*,
         COALESCE(json_agg(DISTINCT jsonb_build_object(
           'matricula_id', mt.id,
           'mentoria_id', m.id,
           'mentoria_nome', m.nome,
           'valor', mt.valor,
           'dia_vencimento', mt.dia_vencimento,
           'status', mt.status
         )) FILTER (WHERE mt.id IS NOT NULL), '[]'::json) AS matriculas,
         (SELECT COUNT(*)::int FROM cobrancas c
          JOIN matriculas mt2 ON mt2.id = c.matricula_id
          WHERE mt2.aluno_id = a.id AND c.status IN ('aberta','atrasada')
            AND c.data_vencimento < CURRENT_DATE) AS cobrancas_atrasadas,
         (SELECT COALESCE(SUM(c.valor), 0) FROM cobrancas c
          JOIN matriculas mt3 ON mt3.id = c.matricula_id
          WHERE mt3.aluno_id = a.id AND c.status = 'paga') AS total_pago
       FROM alunos a
       LEFT JOIN matriculas mt ON mt.aluno_id = a.id AND mt.status = 'ativa'
       LEFT JOIN mentorias m ON m.id = mt.mentoria_id
       WHERE ${filtros.join(' AND ')}
       GROUP BY a.id
       ORDER BY a.nome`,
      vals,
    );
    res.json({ alunos: rows });
  } catch (err) { next(err); }
});

// GET /:id — detalhe completo
alunosRouter.get('/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const aluno = await queryOne(
      `SELECT * FROM alunos WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!aluno) { res.status(404).json({ erro: 'aluno não encontrado' }); return; }
    const matriculas = await query(
      `SELECT mt.*, m.nome AS mentoria_nome, m.cor AS mentoria_cor
       FROM matriculas mt
       JOIN mentorias m ON m.id = mt.mentoria_id
       WHERE mt.aluno_id = $1 AND mt.org_id = $2
       ORDER BY mt.created_at DESC`,
      [id, orgId],
    );
    const cobrancas = await query(
      `SELECT c.*, mt.aluno_id, m.nome AS mentoria_nome
       FROM cobrancas c
       JOIN matriculas mt ON mt.id = c.matricula_id
       JOIN mentorias m ON m.id = mt.mentoria_id
       WHERE mt.aluno_id = $1 AND c.org_id = $2
       ORDER BY c.data_vencimento DESC
       LIMIT 24`,
      [id, orgId],
    );
    const pagamentos = await query(
      `SELECT * FROM pagamentos WHERE aluno_id = $1 AND org_id = $2
       ORDER BY pago_em DESC LIMIT 50`,
      [id, orgId],
    );
    res.json({ aluno, matriculas, cobrancas, pagamentos });
  } catch (err) { next(err); }
});

// POST — criar aluno
alunosRouter.post('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const input = schema.parse(req.body);
    const a = await queryOne(
      `INSERT INTO alunos (org_id, nome, whatsapp, email, cpf_cnpj, endereco_jsonb, status, notas)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [orgId, input.nome, input.whatsapp || null, input.email || null, input.cpf_cnpj || null,
       input.endereco ? JSON.stringify(input.endereco) : null, input.status, input.notas || null],
    );
    res.status(201).json({ aluno: a });
  } catch (err) { next(err); }
});

// PATCH — atualizar
alunosRouter.patch('/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const input = schema.partial().parse(req.body);
    const campos: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(input)) {
      const key = k === 'endereco' ? 'endereco_jsonb' : k;
      const val = k === 'endereco' && v ? JSON.stringify(v) : v;
      campos.push(`${key} = $${i}`); vals.push(val); i++;
    }
    if (!campos.length) { res.status(400).json({ erro: 'nada pra atualizar' }); return; }
    vals.push(id, orgId);
    const a = await queryOne(
      `UPDATE alunos SET ${campos.join(', ')} WHERE id = $${i} AND org_id = $${i + 1} RETURNING *`,
      vals,
    );
    if (!a) { res.status(404).json({ erro: 'aluno não encontrado' }); return; }
    res.json({ aluno: a });
  } catch (err) { next(err); }
});

// POST /promover-lead/:leadId — converte lead em aluno (cria aluno, mantém vínculo)
const promoverSchema = z.object({
  mentoria_id: z.string().uuid(),
  valor: z.number().nonnegative(),
  dia_vencimento: z.number().int().min(1).max(28),
  data_inicio: z.string().optional(),  // YYYY-MM-DD, default hoje
  email: z.string().email().optional(),
  cpf_cnpj: z.string().optional(),
});

alunosRouter.post('/promover-lead/:leadId', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { leadId } = req.params;
    const input = promoverSchema.parse(req.body);

    const result = await transaction(async (client) => {
      const lead = await client.query<{ id: string; nome: string | null; wa_jid: string; cnpj: string | null }>(
        `SELECT id, nome, wa_jid, cnpj FROM leads WHERE id = $1 AND org_id = $2`,
        [leadId, orgId],
      );
      if (!lead.rows.length) throw new Error('lead não encontrado');
      const l = lead.rows[0]!;

      // Verifica mentoria existe
      const mentoria = await client.query(
        `SELECT id FROM mentorias WHERE id = $1 AND org_id = $2 AND ativa = true`,
        [input.mentoria_id, orgId],
      );
      if (!mentoria.rows.length) throw new Error('mentoria não encontrada ou inativa');

      // Cria aluno (com lead_id de vínculo)
      const aluno = await client.query<{ id: string }>(
        `INSERT INTO alunos (org_id, lead_id, nome, whatsapp, email, cpf_cnpj)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [orgId, l.id, l.nome || 'Sem nome', l.wa_jid, input.email || null, input.cpf_cnpj || l.cnpj || null],
      );
      const alunoId = aluno.rows[0]!.id;

      // Cria matrícula
      const matricula = await client.query<{ id: string }>(
        `INSERT INTO matriculas (org_id, aluno_id, mentoria_id, valor, dia_vencimento, data_inicio)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [orgId, alunoId, input.mentoria_id, input.valor, input.dia_vencimento,
         input.data_inicio || new Date().toISOString().slice(0, 10)],
      );

      // Marca lead como 'fechado'
      await client.query(`UPDATE leads SET stage = 'fechado' WHERE id = $1 AND org_id = $2`, [leadId, orgId]);

      return { aluno_id: alunoId, matricula_id: matricula.rows[0]!.id };
    });

    res.status(201).json(result);
  } catch (err) { next(err); }
});
