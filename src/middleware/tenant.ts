// src/middleware/tenant.ts
// Helpers pra extrair org_id/userId do JWT — SEMPRE use isto.
// O org_id NUNCA vem do request — só do token autenticado.
import type { Request } from 'express';

export function getOrgId(req: Request): string {
  if (!req.user) {
    throw new Error('getOrgId chamado sem usuário autenticado — falta middleware requerAuth?');
  }
  return req.user.orgId;
}

export function getUserId(req: Request): string {
  if (!req.user) {
    throw new Error('getUserId chamado sem usuário autenticado');
  }
  return req.user.userId;
}
