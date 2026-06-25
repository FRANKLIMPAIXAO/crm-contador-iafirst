// src/auth/jwt.ts
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface JwtPayload {
  userId: string;
  orgId: string;
  email: string;
  papel: 'admin' | 'closer' | 'viewer';
}

export function gerarToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as never,
  });
}

export function verificarToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}
