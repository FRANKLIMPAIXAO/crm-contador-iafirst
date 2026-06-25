// src/middleware/error.ts
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { isDev } from '../config.js';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      erro: 'Validação falhou',
      detalhes: err.flatten().fieldErrors,
    });
    return;
  }

  if (err instanceof Error) {
    console.error('[error]', err.stack);
    res.status(500).json({
      erro: 'Erro interno',
      mensagem: isDev ? err.message : undefined,
    });
    return;
  }

  console.error('[error desconhecido]', err);
  res.status(500).json({ erro: 'Erro desconhecido' });
}
