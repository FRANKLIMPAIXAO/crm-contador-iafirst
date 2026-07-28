// src/services/anthropic.ts
// Wrapper Anthropic Claude SDK — agora lê DIRETO de process.env pra evitar
// problemas de cache/escape do config.ts
import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

function lerKey(): string {
  // Tenta direto do process.env primeiro (sem passar pelo config/zod)
  const raw = process.env.ANTHROPIC_API_KEY || '';
  // Sanitiza: remove espaços, aspas, quebras de linha
  return raw.trim().replace(/^["']|["']$/g, '');
}

export function getClient(): Anthropic {
  if (_client) return _client;
  const key = lerKey();
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY não configurada');
  }
  // Log de diagnóstico mascarado (mostra prefixo e tamanho — sem expor secret)
  console.log(
    `[anthropic] inicializando client com key prefix=${key.slice(0, 12)}... len=${key.length}`,
  );
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export function isConfigured(): boolean {
  return !!lerKey();
}
