// src/routes/diagnostico-publico.ts
// Rota PÚBLICA (sem auth) — serve páginas-diagnóstico dos leads
// Acessível em: https://d.relacionapac.com.br/<slug>  (via rewrite no server.ts)
// Ou direto:   https://relacionapac.com.br/d/<slug>
import { Router } from 'express';
import { query, queryOne } from '../db/connection.js';

export const diagnosticoPublicoRouter: Router = Router();

type DiagRow = {
  id: string;
  html_content: string;
  views_count: number;
};

diagnosticoPublicoRouter.get('/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      res.status(404).type('html').send(paginaNaoEncontrada());
      return;
    }

    const diag = await queryOne<DiagRow>(
      `SELECT id, html_content, views_count
         FROM prospector_diagnosticos
        WHERE slug = $1`,
      [slug],
    );

    if (!diag) {
      res.status(404).type('html').send(paginaNaoEncontrada());
      return;
    }

    // Registra view (fire-and-forget — não segura resposta do lead)
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.ip || '').slice(0, 45);
    const ua = String(req.headers['user-agent'] || '').slice(0, 500);
    const ref = String(req.headers.referer || '').slice(0, 500);
    const viewEntry = JSON.stringify({ at: new Date().toISOString(), ip, ua, ref });

    query(
      `UPDATE prospector_diagnosticos
          SET views_count = views_count + 1,
              ultima_view_em = NOW(),
              views_log = COALESCE(views_log, '[]'::jsonb) || $1::jsonb
        WHERE id = $2`,
      [viewEntry, diag.id],
    ).catch((err) => console.error('[diagnostico-publico] falha ao registrar view:', err.message));

    // Headers anti-cache — cada abertura conta
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(diag.html_content);
  } catch (err) {
    next(err);
  }
});

function paginaNaoEncontrada(): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Página não encontrada</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem;text-align:center}
  .box{max-width:420px}
  h1{font-size:5rem;margin:0;background:linear-gradient(135deg,#84cc16,#22d3ee);
     -webkit-background-clip:text;-webkit-text-fill-color:transparent}
  p{color:#94a3b8;line-height:1.6}
</style></head>
<body><div class="box">
  <h1>404</h1>
  <p>Essa página não existe ou foi removida.</p>
  <p style="font-size:.85rem;opacity:.6">relacionapac.com.br</p>
</div></body></html>`;
}
