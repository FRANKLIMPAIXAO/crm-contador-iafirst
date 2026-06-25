// src/routes/auth.ts
// POST /api/auth/login — email+senha → JWT
// GET  /api/auth/me — retorna perfil do usuário logado
import { Router } from 'express';
import { z } from 'zod';
import { queryOne } from '../db/connection.js';
import { compararSenha } from '../auth/hash.js';
import { gerarToken, type JwtPayload } from '../auth/jwt.js';
import { requerAuth } from '../middleware/auth.js';

export const authRouter: Router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});

interface UserRow {
  id: string;
  org_id: string;
  email: string;
  senha_hash: string;
  nome: string;
  papel: 'admin' | 'closer' | 'viewer';
  ativo: boolean;
}

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, senha } = loginSchema.parse(req.body);

    const user = await queryOne<UserRow>(
      `SELECT id, org_id, email, senha_hash, nome, papel, ativo
       FROM users WHERE email = $1 LIMIT 1`,
      [email],
    );

    if (!user || !user.ativo) {
      res.status(401).json({ erro: 'Credenciais inválidas' });
      return;
    }

    const ok = await compararSenha(senha, user.senha_hash);
    if (!ok) {
      res.status(401).json({ erro: 'Credenciais inválidas' });
      return;
    }

    const payload: JwtPayload = {
      userId: user.id,
      orgId: user.org_id,
      email: user.email,
      papel: user.papel,
    };

    const token = gerarToken(payload);

    // Atualiza último acesso (não bloqueia resposta)
    queryOne(`UPDATE users SET ultimo_acesso = NOW() WHERE id = $1`, [user.id]).catch(() => {});

    res.json({
      token,
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        papel: user.papel,
        org_id: user.org_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requerAuth, async (req, res, next) => {
  try {
    const user = await queryOne<{ id: string; nome: string; email: string; papel: string }>(
      `SELECT id, nome, email, papel FROM users WHERE id = $1`,
      [req.user!.userId],
    );
    if (!user) {
      res.status(404).json({ erro: 'Usuário não encontrado' });
      return;
    }
    res.json({ user: { ...user, org_id: req.user!.orgId } });
  } catch (err) {
    next(err);
  }
});
