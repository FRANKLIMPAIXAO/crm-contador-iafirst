// src/db/migrate.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './connection.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log(`📦 Aplicando schema em ${config.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  const sqlPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query(sql);
    console.log('✅ Schema aplicado com sucesso');
  } catch (err) {
    console.error('❌ Erro na migration:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((e) => {
  console.error(e);
  process.exit(1);
});
