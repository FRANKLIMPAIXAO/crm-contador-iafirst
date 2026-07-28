#!/usr/bin/env node
// scripts/migrar-prospector-legado.mjs
// Migração ONE-SHOT: prospector.db (SQLite do plugin antigo) → Postgres (CRM).
//
// Uso:
//   node scripts/migrar-prospector-legado.mjs \
//     --sqlite "C:\\sistemas\\PROSPECTOR\\prospector.db" \
//     --sites  "C:\\sistemas\\PROSPECTOR\\sites" \
//     --org    pac \
//     --pg     postgres://user:pass@host:5432/crm
//
// Requer: better-sqlite3 e pg instalados no projeto.
// Idempotente — pode rodar N vezes (upsert por wa_jid ou nome+cidade).

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Argumentos simples
function argOf(flag, def) {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : def;
}
const SQLITE = argOf('--sqlite', 'C:\\sistemas\\PROSPECTOR\\prospector.db');
const SITES  = argOf('--sites',  'C:\\sistemas\\PROSPECTOR\\sites');
const ORG_SLUG = argOf('--org',  process.env.ORG_SLUG || 'pac');
const PG     = argOf('--pg',     process.env.DATABASE_URL);
const DRY    = argv.includes('--dry-run');

if (!PG) { console.error('❌ Faltou --pg <url> ou DATABASE_URL no env'); exit(1); }
if (!fs.existsSync(SQLITE)) { console.error('❌ SQLite não encontrado:', SQLITE); exit(1); }

// Imports dinâmicos (pra não quebrar se rodar em ambiente sem better-sqlite3)
const [{ default: Database }, { default: pg }] = await Promise.all([
  import('better-sqlite3'),
  import('pg'),
]);

const sqlite = new Database(SQLITE, { readonly: true });
const pgPool = new pg.Pool({ connectionString: PG, max: 4 });

async function main() {
  const { rows: orgs } = await pgPool.query(`SELECT id, nome FROM orgs WHERE slug = $1`, [ORG_SLUG]);
  if (!orgs.length) { console.error(`❌ Org "${ORG_SLUG}" não existe no Postgres`); exit(1); }
  const orgId = orgs[0].id;
  console.log(`✅ Org destino: ${orgs[0].nome} (${orgId})`);

  const rows = sqlite.prepare(`SELECT * FROM leads ORDER BY atualizado`).all();
  console.log(`📊 ${rows.length} leads a migrar\n`);

  // Cria 1 busca sintética por segmento — permite dashboard fazer sentido
  const buscas = new Map(); // key = "segmento::cidade" → busca_id
  const stats = { inseridos: 0, atualizados: 0, diagnosticos: 0, pulados: 0, erros: 0 };

  for (const r of rows) {
    try {
      const nome     = (r.nome || 'Sem nome').trim();
      const segmento = (r.segmento || 'indefinido').trim();
      const cidade   = (r.cidade || 'Goiânia').trim();
      const waRaw   = String(r.whatsapp || '').replace(/\D/g,'');
      const waJid   = waRaw.length >= 11 ? (waRaw.length === 11 ? '55'+waRaw : waRaw) : `legado:${r.slug}`;
      const stage   = mapStage(r.status);
      const porte   = mapPorte(r.porte);

      // Cria/pega busca sintética por segmento+cidade
      const bKey = `${segmento}::${cidade}`;
      let buscaId = buscas.get(bKey);
      if (!buscaId) {
        const { rows: b } = await pgPool.query(
          `INSERT INTO prospector_buscas (org_id, segmento, cidade, status, motor, concluida_em, iniciada_em)
             VALUES ($1, $2, $3, 'concluida', 'legado', NOW(), NOW())
           RETURNING id`,
          [orgId, segmento, cidade],
        );
        buscaId = b[0].id;
        buscas.set(bKey, buscaId);
      }

      if (DRY) { console.log(`[dry] ${stage.padEnd(12)} ${nome}`); continue; }

      // Upsert lead (dedup por wa_jid + org_id)
      const { rows: existRows } = await pgPool.query(
        `SELECT id FROM leads WHERE org_id = $1 AND wa_jid = $2 LIMIT 1`,
        [orgId, waJid],
      );

      let leadId;
      if (existRows.length) {
        leadId = existRows[0].id;
        await pgPool.query(
          `UPDATE leads SET
             nome = COALESCE(nome, $1),
             segmento = COALESCE(segmento, $2),
             cidade = COALESCE(cidade, $3),
             stage = CASE WHEN stage = 'novo' THEN $4::lead_stage ELSE stage END,
             email = COALESCE(email, $5),
             site = COALESCE(site, $6),
             cnpj = COALESCE(cnpj, $7),
             regime_atual = COALESCE(regime_atual, $8),
             porte = COALESCE(porte, $9::prospector_porte),
             nota_google = COALESCE(nota_google, $10),
             avaliacoes_google = COALESCE(avaliacoes_google, $11),
             gancho_contabil = COALESCE(gancho_contabil, $12),
             prospector_busca_id = COALESCE(prospector_busca_id, $13),
             origem = COALESCE(origem, 'prospector-legado')
           WHERE id = $14`,
          [nome, segmento, cidade, stage, r.email, r.siteAntigo, r.cnpj, r.regimeAtual,
           porte, r.nota, r.avaliacoes, r.motivo, buscaId, leadId],
        );
        stats.atualizados++;
      } else {
        const { rows: ins } = await pgPool.query(
          `INSERT INTO leads (
             org_id, wa_jid, nome, origem, segmento, cidade, stage,
             email, site, cnpj, regime_atual, porte,
             nota_google, avaliacoes_google, gancho_contabil, prospector_busca_id
           ) VALUES ($1, $2, $3, 'prospector-legado', $4, $5, $6::lead_stage,
                     $7, $8, $9, $10, $11::prospector_porte, $12, $13, $14, $15)
           RETURNING id`,
          [orgId, waJid, nome, segmento, cidade, stage,
           r.email, r.siteAntigo, r.cnpj, r.regimeAtual, porte,
           r.nota, r.avaliacoes, r.motivo, buscaId],
        );
        leadId = ins[0].id;
        stats.inseridos++;
      }

      // Se tem diagnóstico publicado, importa o HTML do arquivo
      if (r.urlNova && r.slug) {
        const htmlPath = path.join(SITES, r.slug, 'index.html');
        if (fs.existsSync(htmlPath)) {
          const html = fs.readFileSync(htmlPath, 'utf8');
          await pgPool.query(
            `INSERT INTO prospector_diagnosticos
               (org_id, lead_id, slug, html_content, segmento, cidade, gerado_por_modelo)
             VALUES ($1, $2, $3, $4, $5, $6, 'legado-html')
             ON CONFLICT (slug) DO UPDATE SET html_content = EXCLUDED.html_content, updated_at = NOW()`,
            [orgId, leadId, r.slug, html, segmento, cidade],
          );
          stats.diagnosticos++;
        }
      }

      process.stdout.write('.');
    } catch (e) {
      stats.erros++;
      console.error(`\n❌ ${r.slug || r.nome}: ${e.message}`);
    }
  }

  // Atualiza contadores nas buscas sintéticas
  for (const [key, buscaId] of buscas.entries()) {
    const [segmento, cidade] = key.split('::');
    await pgPool.query(
      `UPDATE prospector_buscas SET
         leads_encontrados = (SELECT COUNT(*) FROM leads WHERE prospector_busca_id = $1),
         leads_novos = (SELECT COUNT(*) FROM leads WHERE prospector_busca_id = $1)
       WHERE id = $1`,
      [buscaId],
    );
  }

  console.log(`\n\n=== RESULTADO ===`);
  console.log(`  Inseridos:      ${stats.inseridos}`);
  console.log(`  Atualizados:    ${stats.atualizados}`);
  console.log(`  Diagnósticos:   ${stats.diagnosticos}`);
  console.log(`  Erros:          ${stats.erros}`);
  console.log(`  Buscas criadas: ${buscas.size}`);

  await pgPool.end();
  sqlite.close();
}

function mapStage(status) {
  const m = {
    'novo': 'novo',
    'diagnosticado': 'qualificado',
    'abordado': 'proposta',
    'respondeu': 'negociacao',
    'fechado': 'fechado',
    'descartado': 'perdido',
  };
  return m[status] || 'novo';
}

function mapPorte(p) {
  if (!p) return 'indefinido';
  const s = String(p).toLowerCase();
  if (s.includes('peq')) return 'pequeno';
  if (s.includes('méd') || s.includes('med')) return 'medio';
  if (s.includes('gr'))  return 'grande';
  return 'indefinido';
}

main().catch((err) => {
  console.error('❌ Migração falhou:', err);
  exit(1);
});
