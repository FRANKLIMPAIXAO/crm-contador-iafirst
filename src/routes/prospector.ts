// src/routes/prospector.ts
// API do módulo Prospector — buscas, leads capturados, diagnósticos, abordagem.
// Multi-tenant: TUDO filtrado por org_id do JWT.
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId, getUserId } from '../middleware/tenant.js';
import { query, queryOne, transaction } from '../db/connection.js';
import { executarBusca } from '../services/prospector-worker.js';
import { gerarDiagnosticoHtml } from '../services/diagnostico-gerador.js';

export const prospectorRouter: Router = Router();
prospectorRouter.use(requerAuth);

// ============================================================
// BUSCAS — cada rodada de prospecção
// ============================================================

const buscaSchema = z.object({
  segmento: z.string().min(2).max(100),
  cidade: z.string().min(2).max(100),
  meta_leads: z.number().int().min(1).max(60).optional().default(15),
  motor: z.enum(['places', 'playwright']).optional().default('places'),
});

// POST /api/prospector/buscas — cria + enfileira busca
prospectorRouter.post('/buscas', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const input = buscaSchema.parse(req.body);

    const busca = await queryOne<{ id: string }>(
      `INSERT INTO prospector_buscas
         (org_id, segmento, cidade, meta_leads, motor, status, criada_por)
       VALUES ($1, $2, $3, $4, $5, 'pendente', $6)
       RETURNING *`,
      [orgId, input.segmento.trim(), input.cidade.trim(), input.meta_leads, input.motor, userId],
    );

    // Dispara worker em background — não bloqueia a resposta HTTP
    if (busca) {
      executarBusca(busca.id).catch((err) => {
        console.error(`[prospector] worker crashou pra busca ${busca.id}:`, err);
      });
    }

    res.status(202).json({ busca, mensagem: 'Busca iniciada em background. Consulte GET /buscas/:id para acompanhar.' });
  } catch (err) {
    next(err);
  }
});

// GET /api/prospector/buscas — histórico (paginado simples)
prospectorRouter.get('/buscas', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await query(
      `SELECT b.*, u.nome AS criada_por_nome
         FROM prospector_buscas b
         LEFT JOIN users u ON u.id = b.criada_por
        WHERE b.org_id = $1
        ORDER BY b.created_at DESC
        LIMIT $2`,
      [orgId, limit],
    );
    res.json({ buscas: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/prospector/buscas/:id — detalhe + leads da busca
prospectorRouter.get('/buscas/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const busca = await queryOne(
      `SELECT * FROM prospector_buscas WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId],
    );
    if (!busca) {
      res.status(404).json({ erro: 'busca não encontrada' });
      return;
    }
    const leads = await query(
      `SELECT id, nome, segmento, cidade, wa_jid, email, site, cnpj, regime_atual,
              porte, gancho_contabil, nota_google, avaliacoes_google, stage, created_at
         FROM leads
        WHERE prospector_busca_id = $1 AND org_id = $2
        ORDER BY nota_google DESC NULLS LAST, avaliacoes_google DESC NULLS LAST`,
      [req.params.id, orgId],
    );
    res.json({ busca, leads });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// LEADS DO PROSPECTOR — filtro específico
// ============================================================

// GET /api/prospector/leads — leads capturados via Prospector
prospectorRouter.get('/leads', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const filtros: string[] = [
      'l.org_id = $1',
      "(l.origem = 'prospector' OR l.origem = 'prospector-legado' OR l.prospector_busca_id IS NOT NULL)",
    ];
    const vals: unknown[] = [orgId];

    if (req.query.segmento) {
      filtros.push(`l.segmento = $${vals.length + 1}`);
      vals.push(String(req.query.segmento));
    }
    if (req.query.stage) {
      filtros.push(`l.stage = $${vals.length + 1}`);
      vals.push(String(req.query.stage));
    }
    if (req.query.cidade) {
      filtros.push(`l.cidade = $${vals.length + 1}`);
      vals.push(String(req.query.cidade));
    }

    const rows = await query(
      `SELECT l.*,
              d.slug         AS diag_slug,
              d.views_count  AS diag_views,
              d.ultima_view_em AS diag_ultima_view
         FROM leads l
         LEFT JOIN prospector_diagnosticos d ON d.lead_id = l.id
        WHERE ${filtros.join(' AND ')}
        ORDER BY
          CASE l.stage
            WHEN 'novo'         THEN 1
            WHEN 'qualificado'  THEN 2
            WHEN 'proposta'     THEN 3
            WHEN 'negociacao'   THEN 4
            WHEN 'fechado'      THEN 5
            WHEN 'perdido'      THEN 6
          END,
          l.nota_google DESC NULLS LAST,
          l.avaliacoes_google DESC NULLS LAST
        LIMIT 500`,
      vals,
    );
    res.json({ leads: rows });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DIAGNÓSTICOS — páginas geradas por IA
// ============================================================

// POST /api/prospector/diagnosticos/:leadId — gera página pra 1 lead
prospectorRouter.post('/diagnosticos/:leadId', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { leadId } = req.params;

    const lead = await queryOne<{
      id: string; nome: string; segmento: string; cidade: string;
      nota_google: number | null; avaliacoes_google: number | null;
      regime_atual: string | null; porte: string | null; wa_jid: string;
    }>(
      `SELECT id, nome, segmento, cidade, nota_google, avaliacoes_google,
              regime_atual, porte, wa_jid
         FROM leads WHERE id = $1 AND org_id = $2`,
      [leadId, orgId],
    );
    if (!lead) { res.status(404).json({ erro: 'lead não encontrado' }); return; }
    if (!lead.segmento) { res.status(400).json({ erro: 'lead sem segmento — atualize antes' }); return; }

    const cfg = await queryOne<{
      assinatura_apresentacao: string | null;
      assinatura_crc: string | null;
    }>(`SELECT assinatura_apresentacao, assinatura_crc FROM prospector_config WHERE org_id = $1`, [orgId]);

    const org = await queryOne<{ nome: string }>(
      `SELECT nome FROM orgs WHERE id = $1`, [orgId],
    );
    const user = await queryOne<{ nome: string }>(
      `SELECT nome FROM users WHERE id = $1`, [getUserId(req)],
    );

    // WhatsApp do contador (Evolution instance ativa da org)
    const instance = await queryOne<{ numero: string }>(
      `SELECT numero FROM instances WHERE org_id = $1 AND numero IS NOT NULL LIMIT 1`,
      [orgId],
    );
    const waContador = instance?.numero || '5500000000000';

    const slug = gerarSlug(lead.nome, lead.cidade);
    const urlPub = urlPublica(slug);

    let html: string;
    let modelo = 'claude-sonnet-4-5';
    try {
      html = await gerarDiagnosticoHtml({
        lead: {
          nome: lead.nome,
          segmento: lead.segmento,
          cidade: lead.cidade,
          nota_google: lead.nota_google,
          avaliacoes_google: lead.avaliacoes_google,
          regime_atual: lead.regime_atual,
          porte: lead.porte,
        },
        contador: {
          nome: user?.nome || 'Contador',
          escritorio: org?.nome,
          apresentacao: cfg?.assinatura_apresentacao || `Contador especialista em ${lead.segmento}`,
          crc: cfg?.assinatura_crc || undefined,
          whatsapp: waContador,
        },
        url_publica: urlPub,
      });
    } catch (err: any) {
      console.error('[prospector] gerador IA falhou, salvando fallback:', err.message);
      html = fallbackHtml(lead);
      modelo = 'fallback-erro';
    }

    const diag = await queryOne(
      `INSERT INTO prospector_diagnosticos
         (org_id, lead_id, slug, html_content, segmento, cidade, gerado_por_modelo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE
         SET html_content = EXCLUDED.html_content,
             gerado_por_modelo = EXCLUDED.gerado_por_modelo,
             updated_at = NOW()
       RETURNING *`,
      [orgId, leadId, slug, html, lead.segmento, lead.cidade, modelo],
    );

    res.status(201).json({ diagnostico: diag, url_publica: urlPub, modelo });
  } catch (err) {
    next(err);
  }
});

// GET /api/prospector/diagnosticos — lista com métricas
prospectorRouter.get('/diagnosticos', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const rows = await query(
      `SELECT d.id, d.slug, d.segmento, d.cidade, d.views_count, d.ultima_view_em,
              d.created_at, l.id AS lead_id, l.nome AS lead_nome, l.wa_jid, l.stage
         FROM prospector_diagnosticos d
         JOIN leads l ON l.id = d.lead_id
        WHERE d.org_id = $1
        ORDER BY d.ultima_view_em DESC NULLS LAST, d.created_at DESC
        LIMIT 200`,
      [orgId],
    );
    const comUrl = rows.map((r: any) => ({ ...r, url_publica: urlPublica(r.slug) }));
    res.json({ diagnosticos: comUrl });
  } catch (err) {
    next(err);
  }
});

// GET /api/prospector/diagnosticos/:id — detalhe + views_log (últimas 50)
prospectorRouter.get('/diagnosticos/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const diag = await queryOne(
      `SELECT * FROM prospector_diagnosticos WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId],
    );
    if (!diag) { res.status(404).json({ erro: 'diagnóstico não encontrado' }); return; }
    res.json({ diagnostico: diag, url_publica: urlPublica((diag as any).slug) });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ABORDAGEM — gera link wa.me pronto pra clicar
// ============================================================

const abordarSchema = z.object({
  mensagem_custom: z.string().optional(),
});

// POST /api/prospector/abordar/:leadId
prospectorRouter.post('/abordar/:leadId', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const { leadId } = req.params;
    const input = abordarSchema.parse(req.body || {});

    const lead = await queryOne<{
      id: string; nome: string; wa_jid: string; segmento: string; cidade: string;
      nota_google: number | null; stage: string;
    }>(
      `SELECT id, nome, wa_jid, segmento, cidade, nota_google, stage
         FROM leads WHERE id = $1 AND org_id = $2`,
      [leadId, orgId],
    );
    if (!lead) { res.status(404).json({ erro: 'lead não encontrado' }); return; }
    if (!lead.wa_jid) { res.status(400).json({ erro: 'lead sem WhatsApp' }); return; }

    const diag = await queryOne<{ slug: string }>(
      `SELECT slug FROM prospector_diagnosticos WHERE lead_id = $1`,
      [leadId],
    );
    if (!diag) {
      res.status(400).json({ erro: 'lead sem diagnóstico — gere um antes com POST /diagnosticos/:leadId' });
      return;
    }

    const cfg = await queryOne<{
      assinatura_apresentacao: string | null;
    }>(`SELECT assinatura_apresentacao FROM prospector_config WHERE org_id = $1`, [orgId]);

    const assinatura = cfg?.assinatura_apresentacao || 'Contador especializado no seu segmento';
    const url = urlPublica(diag.slug);

    const mensagem = input.mensagem_custom || montarMensagem({
      nome_empresa: lead.nome,
      segmento: lead.segmento,
      cidade: lead.cidade,
      nota: lead.nota_google,
      assinatura,
      url_diagnostico: url,
    });

    const waLink = `https://wa.me/${lead.wa_jid}?text=${encodeURIComponent(mensagem)}`;

    // Registra activity (não muda stage ainda — só quando envia de verdade)
    await queryOne(
      `INSERT INTO activities (org_id, lead_id, tipo, conteudo, autor)
       VALUES ($1, $2, 'abordagem_preparada', $3, $4)`,
      [orgId, leadId, JSON.stringify({ mensagem, url_diagnostico: url, wa_link: waLink }), userId],
    );

    res.json({ mensagem, wa_link: waLink, url_diagnostico: url });
  } catch (err) {
    next(err);
  }
});

// POST /api/prospector/abordar/:leadId/confirmar-envio
// Usuário clicou "já mandei" — muda stage e registra
prospectorRouter.post('/abordar/:leadId/confirmar-envio', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const userId = getUserId(req);
    const { leadId } = req.params;

    const result = await transaction(async (client) => {
      const upd = await client.query(
        `UPDATE leads
            SET stage = CASE WHEN stage = 'novo' THEN 'qualificado'::lead_stage ELSE stage END,
                last_message_at = NOW()
          WHERE id = $1 AND org_id = $2
          RETURNING id, stage`,
        [leadId, orgId],
      );
      if (!upd.rows.length) throw new Error('lead não encontrado');

      await client.query(
        `INSERT INTO activities (org_id, lead_id, tipo, conteudo, autor)
         VALUES ($1, $2, 'abordagem_enviada', $3, $4)`,
        [orgId, leadId, JSON.stringify({ manual: true, at: new Date().toISOString() }), userId],
      );
      return upd.rows[0];
    });

    res.json({ ok: true, lead: result });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// CONFIG por org
// ============================================================

const configSchema = z.object({
  places_api_key: z.string().optional(),
  motor_default: z.enum(['places', 'playwright']).optional(),
  auto_envio_whatsapp: z.boolean().optional(),
  limite_disparos_dia: z.number().int().min(1).max(200).optional(),
  horario_inicio: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  horario_fim: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  segmentos_ativos: z.array(z.string()).optional(),
  cidade_padrao: z.string().optional(),
  assinatura_apresentacao: z.string().optional(),
  assinatura_crc: z.string().optional(),
});

prospectorRouter.get('/config', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    let cfg = await queryOne(
      `SELECT * FROM prospector_config WHERE org_id = $1`, [orgId],
    );
    if (!cfg) {
      cfg = await queryOne(
        `INSERT INTO prospector_config (org_id) VALUES ($1) RETURNING *`,
        [orgId],
      );
    }
    // Não devolve places_api_key (só flag de "está configurada")
    const c: any = cfg;
    const publica = { ...c, places_api_key_configurada: !!c.places_api_key };
    delete publica.places_api_key;
    res.json({ config: publica });
  } catch (err) { next(err); }
});

prospectorRouter.patch('/config', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const input = configSchema.parse(req.body);
    const campos: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(input)) {
      campos.push(`${k} = $${i}`); vals.push(v); i++;
    }
    if (!campos.length) { res.status(400).json({ erro: 'nada pra atualizar' }); return; }
    vals.push(orgId);
    const upd = await queryOne(
      `INSERT INTO prospector_config (org_id) VALUES ($${i})
         ON CONFLICT (org_id) DO UPDATE SET ${campos.join(', ')}
       RETURNING org_id`,
      vals,
    );
    res.json({ ok: true, config: upd });
  } catch (err) { next(err); }
});

// ============================================================
// MÉTRICAS
// ============================================================

prospectorRouter.get('/metricas', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const r = await queryOne(
      `WITH t AS (
         SELECT
           (SELECT COUNT(*) FROM leads WHERE org_id = $1 AND (origem LIKE 'prospector%' OR prospector_busca_id IS NOT NULL)) AS total_leads,
           (SELECT COUNT(*) FROM leads WHERE org_id = $1 AND (origem LIKE 'prospector%' OR prospector_busca_id IS NOT NULL) AND stage = 'novo') AS novos,
           (SELECT COUNT(*) FROM leads WHERE org_id = $1 AND (origem LIKE 'prospector%' OR prospector_busca_id IS NOT NULL) AND stage IN ('qualificado','proposta','negociacao')) AS em_andamento,
           (SELECT COUNT(*) FROM leads WHERE org_id = $1 AND (origem LIKE 'prospector%' OR prospector_busca_id IS NOT NULL) AND stage = 'fechado') AS fechados,
           (SELECT COUNT(*) FROM prospector_diagnosticos WHERE org_id = $1) AS diagnosticos_gerados,
           (SELECT COALESCE(SUM(views_count),0) FROM prospector_diagnosticos WHERE org_id = $1) AS diagnosticos_views_total,
           (SELECT COUNT(*) FROM prospector_buscas WHERE org_id = $1) AS buscas_total,
           (SELECT COUNT(*) FROM prospector_buscas WHERE org_id = $1 AND status = 'concluida') AS buscas_concluidas
       ) SELECT * FROM t`,
      [orgId],
    );

    const porSegmento = await query(
      `SELECT segmento,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE stage = 'fechado') AS fechados
         FROM leads
        WHERE org_id = $1 AND segmento IS NOT NULL
        GROUP BY segmento
        ORDER BY total DESC`,
      [orgId],
    );

    res.json({ resumo: r, por_segmento: porSegmento });
  } catch (err) { next(err); }
});

// ============================================================
// HELPERS
// ============================================================

function gerarSlug(nome: string, cidade: string | null): string {
  const base = `${nome}-${cidade || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const suf = Math.random().toString(36).slice(2, 6);
  return `${base}-${suf}`;
}

function urlPublica(slug: string): string {
  const base = process.env.DIAGNOSTICOS_BASE_URL || 'https://d.relacionapac.com.br';
  return `${base}/${slug}`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

function fallbackHtml(lead: { nome: string; segmento: string; cidade: string }): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico contábil — ${escapeHtml(lead.nome)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:1rem;color:#1e293b}h1{color:#0f172a}</style></head>
<body><h1>Diagnóstico em preparação</h1>
<p>Página para <strong>${escapeHtml(lead.nome)}</strong> (${escapeHtml(lead.segmento)} em ${escapeHtml(lead.cidade)}).</p>
<p>Regenere via painel — houve erro na IA no primeiro envio.</p></body></html>`;
}

function montarMensagem(p: {
  nome_empresa: string;
  segmento: string;
  cidade: string;
  nota: number | null;
  assinatura: string;
  url_diagnostico: string;
}): string {
  const linhaNota = p.nota ? ` — ${p.nota.toFixed(1)}★, parabéns pelas avaliações` : '';
  return `Oi, aqui é o ${p.assinatura}. Vi a ${p.nome_empresa} no Google${linhaNota} 👏

Como trabalho com ${p.segmento} em ${p.cidade}, preparei um raio-x rápido dos pontos onde uma empresa como a sua costuma pagar imposto a mais.

Dá uma olhada, fiz pensando em vocês: ${p.url_diagnostico}

Se fizer sentido, te mostro com os seus números. Sem compromisso.`;
}
