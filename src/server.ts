// src/server.ts
// Bootstrap Express
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { leadsRouter } from './routes/leads.js';
import { messagesRouter } from './routes/messages.js';
import { webhookRouter } from './routes/webhook.js';
import { devRouter } from './routes/dev.js';
import { pool } from './db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(
  cors({
    origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'crm-api',
    version: '0.2.0',
    env: config.NODE_ENV,
    time: new Date().toISOString(),
  });
});

app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'ok' });
  } catch {
    res.status(503).json({ ok: false, db: 'erro' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/dev', devRouter);
app.use('/webhook', webhookRouter);

const publicDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get(/^(?!\/api\/|\/health|\/ready|\/webhook).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) res.status(404).json({ erro: 'rota não encontrada' });
  });
});

app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  console.log(`\n  🚀 CRM API rodando em http://localhost:${config.PORT}`);
  console.log(`  📦 Ambiente: ${config.NODE_ENV}`);
  console.log(`  🗄️  Banco: ${config.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`  Pressione Ctrl+C para encerrar.\n`);
});

function shutdown(sig: string) {
  console.log(`\n[${sig}] encerrando...`);
  server.close(() => {
    pool.end().then(() => {
      console.log('[shutdown] ok');
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
