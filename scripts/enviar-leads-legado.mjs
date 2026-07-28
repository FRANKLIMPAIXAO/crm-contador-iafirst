#!/usr/bin/env node
// scripts/enviar-leads-legado.mjs
// Lê o prospector.db LOCAL e envia batch via HTTPS pra API do CRM.
// Não precisa acesso ao Postgres — usa endpoint /api/prospector/importar-legado.
//
// Uso (PowerShell):
//   node scripts/enviar-leads-legado.mjs \
//     --sqlite "C:\sistemas\PROSPECTOR\prospector.db" \
//     --sites  "C:\sistemas\PROSPECTOR\sites" \
//     --url    "https://relacionapac.com.br" \
//     --email  "seu@email.com" \
//     --senha  "sua-senha"

import path from 'node:path';
import fs from 'node:fs';
import { argv, exit } from 'node:process';

function argOf(flag, def) {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : def;
}

const SQLITE = argOf('--sqlite', 'C:\\sistemas\\PROSPECTOR\\prospector.db');
const SITES  = argOf('--sites',  'C:\\sistemas\\PROSPECTOR\\sites');
const URL    = argOf('--url',    'https://relacionapac.com.br').replace(/\/$/, '');
const EMAIL  = argOf('--email',  process.env.CRM_EMAIL);
const SENHA  = argOf('--senha',  process.env.CRM_SENHA);
const BATCH  = Number(argOf('--batch', '25'));

if (!EMAIL || !SENHA) {
  console.error('❌ Faltou --email e --senha (ou CRM_EMAIL/CRM_SENHA no env)');
  console.error('   Uso: node scripts/enviar-leads-legado.mjs --email seu@email --senha xxx');
  exit(1);
}
if (!fs.existsSync(SQLITE)) { console.error('❌ SQLite não encontrado:', SQLITE); exit(1); }

const { default: Database } = await import('better-sqlite3');
const sqlite = new Database(SQLITE, { readonly: true });

async function main() {
  console.log(`\n🔐 Fazendo login em ${URL}...`);
  const loginResp = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: SENHA }),
  });
  if (!loginResp.ok) {
    console.error(`❌ Login falhou: ${loginResp.status} ${await loginResp.text()}`);
    exit(1);
  }
  const { token, user } = await loginResp.json();
  console.log(`✅ Autenticado como ${user?.nome || user?.email || 'usuário'}\n`);

  const rows = sqlite.prepare(`SELECT * FROM leads ORDER BY atualizado`).all();
  console.log(`📊 ${rows.length} leads no SQLite local\n`);

  // Prepara payload
  const payload = rows.map((r) => {
    let diagHtml = null;
    if (r.urlNova && r.slug) {
      const htmlPath = path.join(SITES, r.slug, 'index.html');
      if (fs.existsSync(htmlPath)) {
        diagHtml = fs.readFileSync(htmlPath, 'utf8');
      }
    }
    return {
      slug: r.slug || null,
      nome: r.nome || 'Sem nome',
      segmento: r.segmento || null,
      cidade: r.cidade || 'Goiânia',
      whatsapp: r.whatsapp || null,
      email: r.email || null,
      cnpj: r.cnpj || null,
      regime_atual: r.regimeAtual || null,
      porte: r.porte || null,
      nota_google: r.nota || null,
      avaliacoes_google: r.avaliacoes || null,
      gancho_contabil: r.motivo || null,
      site: r.siteAntigo || null,
      status_legado: r.status || 'novo',
      diagnostico_html: diagHtml,
    };
  });

  // Envia em batches (senão payload grande demais com HTMLs)
  const totalStats = { inseridos: 0, atualizados: 0, diagnosticos: 0, erros: 0 };
  const errosTodos = [];

  for (let i = 0; i < payload.length; i += BATCH) {
    const chunk = payload.slice(i, i + BATCH);
    const kb = Math.round(JSON.stringify(chunk).length / 1024);
    process.stdout.write(`📤 Batch ${Math.floor(i / BATCH) + 1}: ${chunk.length} leads (${kb} KB)... `);
    const resp = await fetch(`${URL}/api/prospector/importar-legado`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leads: chunk }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.log(`❌ ${resp.status}`);
      console.error(`   ${txt.slice(0, 300)}`);
      continue;
    }
    const j = await resp.json();
    totalStats.inseridos    += j.stats?.inseridos    || 0;
    totalStats.atualizados  += j.stats?.atualizados  || 0;
    totalStats.diagnosticos += j.stats?.diagnosticos || 0;
    totalStats.erros        += j.stats?.erros        || 0;
    if (j.erros?.length) errosTodos.push(...j.erros);
    console.log(`✅ ins:${j.stats?.inseridos} upd:${j.stats?.atualizados} diag:${j.stats?.diagnosticos}${j.stats?.erros ? ` err:${j.stats.erros}` : ''}`);
  }

  console.log(`\n=== RESULTADO ===`);
  console.log(`  Inseridos:    ${totalStats.inseridos}`);
  console.log(`  Atualizados:  ${totalStats.atualizados}`);
  console.log(`  Diagnósticos: ${totalStats.diagnosticos}`);
  console.log(`  Erros:        ${totalStats.erros}`);
  if (errosTodos.length) {
    console.log(`\n⚠️  Erros:`);
    for (const e of errosTodos.slice(0, 10)) console.log(`    - ${e.nome}: ${e.msg}`);
  }

  sqlite.close();
}

main().catch((err) => {
  console.error('\n❌ Falhou:', err);
  exit(1);
});
