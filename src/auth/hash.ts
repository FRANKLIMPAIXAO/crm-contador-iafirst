// src/auth/hash.ts
import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export function hashSenha(senha: string): Promise<string> {
  return bcrypt.hash(senha, ROUNDS);
}

export function compararSenha(senha: string, hash: string): Promise<boolean> {
  return bcrypt.compare(senha, hash);
}
