// src/server.ts
// Bootstrap Express
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { leadsRouter } from './routes/leads.js';
import { messagesRouter } from './routes/messages.js';
import { webhookRouter } from './routes/webhook.js';
import { devRouter } from './routes/dev.js';
import { mentoriasRouter } from './routes/mentorias.js';
import { alunosRouter } from './routes/alunos.js';
import { matriculasRouter } from './routes/matriculas.js';
import { cobrancasRouter } from './routes/cobrancas.js';
import { prospectorRouter } from './routes/prospector.js';
import { diagnosticoPublicoRouter } from './routes/diagnostico-publico.js';
import { pool, autoMigrate, autoSeed } from './db/connection.js';
import { hashSenha } from './auth/hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Resolve publicDir tentando múltiplos paths (robusto pra dev e prod)
function resolverPublicDir(): string {
  const candidatos = [
    path.resolve(__dirname, '..', 'public'),       // dist/server.js → /app/public
    path.resolve(process.cwd(), 'public'),         // cwd-based
    path.resolve(__dirname, 'public'),             // ao lado do server.js
    '/app/public',                                 // hardcoded prod
  ];
  for (const dir of candidatos) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      console.log(`[static] publicDir resolvido: ${dir}`);
      return dir;
    }
  }
  console.warn(`[static] ⚠️ index.html NÃO encontrado em nenhum candidato:`);
  candidatos.forEach((c) => console.warn(`  - ${c} (existe? ${fs.existsSync(c)})`));
  // Retorna o primeiro como fallback (pra não crashar — vai cair no 404)
  return candidatos[0]!;
}
const publicDir = resolverPublicDir();

// EasyPanel/Traefik é reverse proxy — Express precisa confiar nos X-Forwarded-*
// (senão req.hostname devolve o host interno do container, não o público)
app.set('trust proxy', true);

app.use(
  cors({
    origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rewrite: d.relacionapac.com.br/<slug> → /d/<slug>
// Lê hostname de x-forwarded-host primeiro (proxy), depois req.hostname (fallback)
app.use((req, _res, next) => {
  const fwd = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = (fwd || req.hostname || '').toLowerCase();
  if (
    host.startsWith('d.') &&
    !req.path.startsWith('/d/') &&
    !req.path.startsWith('/api/') &&
    !req.path.startsWith('/webhook/') &&
    req.path !== '/health' &&
    req.path !== '/ready'
  ) {
    req.url = '/d' + req.url;
  }
  next();
});

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
app.use('/api/mentorias', mentoriasRouter);
app.use('/api/alunos', alunosRouter);
app.use('/api/matriculas', matriculasRouter);
app.use('/api/cobrancas', cobrancasRouter);
app.use('/api/prospector', prospectorRouter);
app.use('/d', diagnosticoPublicoRouter);
app.use('/webhook', webhookRouter);

app.use(express.static(publicDir));

app.get(/^(?!\/api\/|\/health|\/ready|\/webhook).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) res.status(404).json({ erro: 'rota não encontrada' });
  });
});

app.use(errorHandler);

// ===== Boot: auto-migrate + auto-seed + listen =====
async function bootstrap() {
  // Auto-migrate só em produção (em dev, dev roda npm run db:migrate manual)
  // Em produção, container nasce limpo e precisa do schema na 1ª subida
  if (process.env.AUTO_MIGRATE !== 'false') {
    try {
      await autoMigrate();
    } catch (err) {
      console.error('[boot] migrate falhou — abortando.', err);
      process.exit(1);
    }
  }
  if (process.env.AUTO_SEED !== 'false') {
    await autoSeed(hashSenha);
  }

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
}

bootstrap().catch((err) => {
  console.error('[boot] falha crítica:', err);
  process.exit(1);
});
