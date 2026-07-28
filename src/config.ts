// src/config.ts
// Centraliza acesso a env vars com validação Zod
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter pelo menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL_TRIAGEM: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_MODEL_RASCUNHO: z.string().default('claude-sonnet-4-5'),

  EVOLUTION_API_URL: z.string().url().optional(),
  EVOLUTION_API_KEY: z.string().optional(),
  EVOLUTION_INSTANCE_DEFAULT: z.string().default('pac-vendas'),
  EVOLUTION_WEBHOOK_SECRET: z.string().min(16).optional(),

  SEXTA_API_TOKEN: z.string().optional(),

  // Webhook da SEXTA — quando lead quente entra, CRM avisa
  SEXTA_WEBHOOK_URL: z.string().url().optional(),
  SEXTA_WEBHOOK_SECRET: z.string().min(16).optional(),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Prospector — Google Places API + página pública
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  DIAGNOSTICOS_BASE_URL: z.string().url().default('https://d.anapaixao.com'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Configuração inválida:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
export const isDev = config.NODE_ENV === 'development';
