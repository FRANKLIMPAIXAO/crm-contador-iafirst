// src/db/connection.ts
// Pool Postgres compartilhado
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[pg] erro no pool:', err.message);
});

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<T[]> {
  const res = await pool.query(text, params as never[]);
  return res.rows as T[];
}

export async function queryOne<T = unknown>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Roda schema.sql no boot — idempotente (IF NOT EXISTS).
 * Garante que o banco está pronto sem precisar `npm run db:migrate` manual em prod.
 */
export async function autoMigrate(): Promise<void> {
  try {
    // Em dev: src/db/schema.sql. Em prod (dist/): ../../src/db/schema.sql via COPY no Dockerfile
    const candidatos = [
      path.join(__dirname, 'schema.sql'),
      path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
    ];
    const sqlPath = candidatos.find((p) => fs.existsSync(p));
    if (!sqlPath) {
      console.warn('[db] schema.sql não encontrado — pulando auto-migrate');
      return;
    }
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const client = await pool.connect();
    try {
      await client.query(sql);
      console.log('[db] ✅ schema aplicado (auto-migrate)');
    } finally {
      client.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[db] ❌ auto-migrate falhou:', msg);
    throw err;
  }
}

/**
 * Se DB vazio (0 usuários), cria primeira org + admin via env vars.
 * Em prod o EasyPanel define ADMIN_EMAIL/ADMIN_SENHA na primeira subida.
 */
export async function autoSeed(hashFn: (s: string) => Promise<string>): Promise<void> {
  try {
    const { rows } = await pool.query<{ c: string }>(`SELECT count(*)::text as c FROM users`);
    if (Number(rows[0]?.c ?? 0) > 0) return; // já tem usuário, pula

    const orgNome = process.env.ORG_NOME || 'PAC Inteligencia Tributaria';
    const orgSlug = process.env.ORG_SLUG || 'pac';
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const adminSenha = process.env.ADMIN_SENHA || 'trocar123';
    const adminNome = process.env.ADMIN_NOME || 'Admin';

    console.log(`[db] DB vazio — criando org "${orgNome}" + admin ${adminEmail}...`);
    const { rows: orgs } = await pool.query<{ id: string }>(
      `INSERT INTO orgs (nome, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
      [orgNome, orgSlug],
    );
    const orgId = orgs[0]!.id;
    const hash = await hashFn(adminSenha);
    await pool.query(
      `INSERT INTO users (org_id, email, senha_hash, nome, papel)
       VALUES ($1, $2, $3, $4, 'admin') ON CONFLICT (email) DO NOTHING`,
      [orgId, adminEmail, hash, adminNome],
    );
    console.log(`[db] ✅ admin criado. Login: ${adminEmail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[db] auto-seed falhou (não-crítico):', msg);
  }
}
