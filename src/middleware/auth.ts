// src/middleware/auth.ts
// Extrai Bearer token, valida, injeta req.user
import type { Request, Response, NextFunction } from 'express';
import { verificarToken, type JwtPayload } from '../auth/jwt.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requerAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization || '';
  const [tipo, token] = auth.split(' ');

  if (tipo !== 'Bearer' || !token) {
    res.status(401).json({ erro: 'Token ausente. Envie Authorization: Bearer <token>' });
    return;
  }

  const payload = verificarToken(token);
  if (!payload) {
    res.status(401).json({ erro: 'Token inválido ou expirado' });
    return;
  }

  req.user = payload;
  next();
}

export function requerPapel(...papeis: Array<'admin' | 'closer' | 'viewer'>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ erro: 'Não autenticado' });
      return;
    }
    if (!papeis.includes(req.user.papel)) {
      res.status(403).json({ erro: 'Sem permissão' });
      return;
    }
    next();
  };
}
