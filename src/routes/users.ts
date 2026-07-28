// src/routes/users.ts
// CRUD de usuários — só admin pode gerenciar
// Todos criados na mesma org do admin (multi-tenant preservado)
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth, requerPapel } from '../middleware/auth.js';
import { getOrgId, getUserId } from '../middleware/tenant.js';
import { query, queryOne } from '../db/connection.js';
import { hashSenha } from '../auth/hash.js';

export const usersRouter: Router = Router();
usersRouter.use(requerAuth);

// GET /api/users — lista todos da minha org (admin only)
usersRouter.get('/', requerPapel('admin'), async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const rows = await query(
      `SELECT id, email, nome, papel, ativo, ultimo_acesso, created_at
         FROM users WHERE org_id = $1
         ORDER BY created_at DESC`,
      [orgId],
    );
    res.json({ users: rows });
  } catch (err) { next(err); }
});

// POST /api/users — cria novo usuário na minha org
const criarSchema = z.object({
  nome: z.string().min(2).max(120),
  email: z.string().email(),
  senha: z.string().min(6).max(80),
  papel: z.enum(['admin', 'closer', 'viewer']).default('closer'),
});

usersRouter.post('/', requerPapel('admin'), async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const input = criarSchema.parse(req.body);

    const existente = await queryOne(
      `SELECT id FROM users WHERE email = $1`, [input.email.toLowerCase()],
    );
    if (existente) {
      res.status(409).json({ erro: 'Email já em uso' });
      return;
    }

    const hash = await hashSenha(input.senha);
    const novo = await queryOne<{ id: string; email: string; nome: string; papel: string }>(
      `INSERT INTO users (org_id, email, senha_hash, nome, papel, ativo)
         VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, email, nome, papel, ativo, created_at`,
      [orgId, input.email.toLowerCase(), hash, input.nome, input.papel],
    );
    res.status(201).json({ user: novo });
  } catch (err) { next(err); }
});

// PATCH /api/users/:id — edita (nome, papel, ativo) OU reseta senha
const editarSchema = z.object({
  nome: z.string().min(2).max(120).optional(),
  papel: z.enum(['admin', 'closer', 'viewer']).optional(),
  ativo: z.boolean().optional(),
  nova_senha: z.string().min(6).max(80).optional(),
});

usersRouter.patch('/:id', requerPapel('admin'), async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const meId = getUserId(req);
    const { id } = req.params;
    const input = editarSchema.parse(req.body);

    // Segurança: admin não pode desativar/rebaixar A SI MESMO (evita se trancar fora)
    if (id === meId) {
      if (input.ativo === false) {
        res.status(400).json({ erro: 'Você não pode se desativar' });
        return;
      }
      if (input.papel && input.papel !== 'admin') {
        res.status(400).json({ erro: 'Você não pode rebaixar seu próprio papel' });
        return;
      }
    }

    const alvo = await queryOne<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM users WHERE id = $1`, [id],
    );
    if (!alvo || alvo.org_id !== orgId) {
      res.status(404).json({ erro: 'Usuário não encontrado' });
      return;
    }

    const campos: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.nome !== undefined) { campos.push(`nome = $${i++}`); vals.push(input.nome); }
    if (input.papel !== undefined) { campos.push(`papel = $${i++}`); vals.push(input.papel); }
    if (input.ativo !== undefined) { campos.push(`ativo = $${i++}`); vals.push(input.ativo); }
    if (input.nova_senha !== undefined) {
      const hash = await hashSenha(input.nova_senha);
      campos.push(`senha_hash = $${i++}`); vals.push(hash);
    }
    if (!campos.length) { res.status(400).json({ erro: 'nada pra atualizar' }); return; }

    vals.push(id);
    const upd = await queryOne(
      `UPDATE users SET ${campos.join(', ')} WHERE id = $${i}
       RETURNING id, email, nome, papel, ativo`,
      vals,
    );
    res.json({ user: upd });
  } catch (err) { next(err); }
});
