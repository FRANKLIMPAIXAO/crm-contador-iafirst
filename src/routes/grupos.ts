// src/routes/grupos.ts
// CRUD de grupos + sync com Evolution + IA gera resumo
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query, queryOne, transaction } from '../db/connection.js';
import { fetchAllGroups, fetchGroupParticipants, jidToNumero, connectionState } from '../services/evolution.js';
import { getClient as getAnthropic } from '../services/anthropic.js';

export const gruposRouter: Router = Router();
gruposRouter.use(requerAuth);

// GET /api/grupos — lista com contagem
gruposRouter.get('/', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const rows = await query(
      `SELECT g.*,
              (SELECT COUNT(*) FROM alunos_grupos ag WHERE ag.grupo_id = g.id) AS membros_real
         FROM grupos g
        WHERE g.org_id = $1
        ORDER BY g.created_at DESC`,
      [orgId],
    );
    res.json({ grupos: rows });
  } catch (err) { next(err); }
});

// GET /api/grupos/:id — detalhe + membros
gruposRouter.get('/:id', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const grupo = await queryOne(
      `SELECT * FROM grupos WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId],
    );
    if (!grupo) { res.status(404).json({ erro: 'grupo não encontrado' }); return; }
    const membros = await query(
      `SELECT a.id, a.nome, a.whatsapp, a.email, ag.papel, ag.entrou_em
         FROM alunos_grupos ag
         JOIN alunos a ON a.id = ag.aluno_id
        WHERE ag.grupo_id = $1
        ORDER BY a.nome`,
      [req.params.id],
    );
    res.json({ grupo, membros });
  } catch (err) { next(err); }
});

// POST /api/grupos/sincronizar — puxa grupos do WhatsApp via Evolution
gruposRouter.post('/sincronizar', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const stats = { grupos_novos: 0, grupos_atualizados: 0, vinculos_criados: 0, membros_ignorados: 0 };

    // 0) Checa se o WhatsApp está conectado antes de tentar qualquer coisa
    const estado = await connectionState().catch(() => 'desconhecido');
    if (estado !== 'open') {
      res.status(409).json({
        ok: false,
        erro: 'whatsapp_desconectado',
        mensagem: `O WhatsApp da instância não está conectado (estado: "${estado}").\n\n` +
          `Abra o painel do Evolution, gere o QR Code da instância e escaneie com o celular.\n` +
          `Depois volte aqui e sincronize de novo.`,
        estado,
      });
      return;
    }

    // 1) Pega TODOS alunos da org uma vez (pra match esperto)
    const alunos = await query<{ id: string; nome: string; whatsapp: string | null; email: string | null }>(
      `SELECT id, nome, whatsapp, email FROM alunos WHERE org_id = $1`,
      [orgId],
    );

    // Index por telefone e por nome-normalizado
    const porTelefone = new Map<string, string>();  // telefone → aluno_id
    const porNomeNorm = new Map<string, string>();  // nome-normalizado → aluno_id
    for (const a of alunos) {
      if (a.whatsapp) porTelefone.set(a.whatsapp.replace(/\D/g, ''), a.id);
      const n = normalizar(a.nome);
      if (n) porNomeNorm.set(n, a.id);
    }

    // 2) Puxa grupos do Evolution
    const grupos = await fetchAllGroups();
    if (!grupos.length) {
      res.json({ ok: true, mensagem: 'Evolution retornou 0 grupos. Confere se está conectado.', stats });
      return;
    }

    // 3) Pra cada grupo: upsert + puxa participantes
    for (const g of grupos) {
      if (!g.id || !g.subject) continue;

      const existente = await queryOne<{ id: string }>(
        `SELECT id FROM grupos WHERE org_id = $1 AND wa_group_jid = $2`,
        [orgId, g.id],
      );

      let grupoId: string;
      if (existente) {
        await query(
          `UPDATE grupos SET nome = $1, descricao = $2, picture_url = $3, membros_count = $4,
                             ultimo_sync_em = NOW()
           WHERE id = $5`,
          [g.subject, g.desc || null, g.pictureUrl || null, g.size || 0, existente.id],
        );
        grupoId = existente.id;
        stats.grupos_atualizados++;
      } else {
        const novo = await queryOne<{ id: string }>(
          `INSERT INTO grupos (org_id, wa_group_jid, nome, descricao, picture_url, membros_count, ultimo_sync_em)
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
          [orgId, g.id, g.subject, g.desc || null, g.pictureUrl || null, g.size || 0],
        );
        grupoId = novo!.id;
        stats.grupos_novos++;
      }

      // 4) Puxa participantes DESSE grupo
      try {
        const parts = await fetchGroupParticipants(g.id);
        for (const p of parts) {
          const num = jidToNumero(p.id);
          if (!num) continue;

          // Match esperto: primeiro por telefone exato, depois por match não implementado
          // (a IA de match por nome exige que o Evolution nos dê o nome, que hoje não vem;
          //  então só linkamos quem já tem telefone cadastrado igual)
          const alunoId = porTelefone.get(num);
          if (!alunoId) { stats.membros_ignorados++; continue; }

          // Cria vínculo (ignora duplicata)
          try {
            await query(
              `INSERT INTO alunos_grupos (org_id, aluno_id, grupo_id, papel)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (aluno_id, grupo_id) DO UPDATE SET papel = EXCLUDED.papel`,
              [orgId, alunoId, grupoId, p.admin || 'membro'],
            );
            stats.vinculos_criados++;
          } catch {/* dup */}
        }
      } catch (e: any) {
        console.warn(`[grupos-sync] falha ao puxar participantes de ${g.subject}:`, e.message);
      }
    }

    res.json({ ok: true, stats, total_grupos: grupos.length });
  } catch (err: any) {
    // Retorna erro estruturado ao invés de crashar no next()
    console.error('[grupos-sync] falhou:', err.message);
    res.status(500).json({
      ok: false,
      erro: 'sync_falhou',
      mensagem: String(err?.message || err).slice(0, 1000),
    });
  }
});

// GET /api/grupos/_leads-de-grupo — lista leads criados por engano de grupos
gruposRouter.get('/_leads-de-grupo', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const rows = await query(
      `SELECT id, nome, wa_jid, stage, created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.lead_id = leads.id) AS msgs
         FROM leads
        WHERE org_id = $1
          AND (wa_jid LIKE '%@g.us' OR wa_jid LIKE '%@broadcast'
               OR wa_jid LIKE '%@newsletter' OR wa_jid LIKE '%@lid%')
        ORDER BY created_at DESC`,
      [orgId],
    );
    res.json({ leads: rows, total: rows.length });
  } catch (err) { next(err); }
});

// DELETE /api/grupos/_leads-de-grupo — apaga os leads criados de grupos
gruposRouter.delete('/_leads-de-grupo', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const del = await query(
      `DELETE FROM leads
        WHERE org_id = $1
          AND (wa_jid LIKE '%@g.us' OR wa_jid LIKE '%@broadcast'
               OR wa_jid LIKE '%@newsletter' OR wa_jid LIKE '%@lid%')
        RETURNING id, nome, wa_jid`,
      [orgId],
    );
    res.json({ ok: true, deletados: del.length, leads: del });
  } catch (err) { next(err); }
});

// POST /api/grupos/:id/gerar-resumo — Claude analisa membros e resume
gruposRouter.post('/:id/gerar-resumo', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const grupo = await queryOne<{ id: string; nome: string; descricao: string | null; membros_count: number }>(
      `SELECT id, nome, descricao, membros_count FROM grupos WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId],
    );
    if (!grupo) { res.status(404).json({ erro: 'grupo não encontrado' }); return; }

    const membros = await query<{ nome: string; email: string | null; notas: string | null }>(
      `SELECT a.nome, a.email, a.notas
         FROM alunos_grupos ag JOIN alunos a ON a.id = ag.aluno_id
        WHERE ag.grupo_id = $1 LIMIT 100`,
      [grupo.id],
    );

    const listaMembros = membros.map((m, i) => `${i + 1}. ${m.nome}${m.email ? ` <${m.email}>` : ''}${m.notas ? ` — ${m.notas}` : ''}`).join('\n');

    const prompt = `Você é analista de comunidade. Analise este grupo WhatsApp de contadores/empreendedores e gere um resumo estruturado.

## Grupo
Nome: ${grupo.nome}
Descrição: ${grupo.descricao || '(sem descrição)'}
Total de membros: ${grupo.membros_count}
Membros identificados no CRM (${membros.length}):

${listaMembros || '(sem membros cadastrados)'}

## Tarefa
Gere um resumo em MARKDOWN com essas seções (use exatamente esses títulos):

### 🎯 Propósito provável
1 parágrafo curto inferindo do nome + membros.

### 👥 Perfil dominante
2-3 bullets identificando padrões (região dos emails, tipo de escritório se der pra inferir).

### 💡 Sugestões de conteúdo pra postar
3 sugestões de posts/aulas/lives que vão engajar esse grupo específico.

### ⚠️ Observações
Alertas úteis (contato faltando, membro potencialmente inativo, oportunidades comerciais).

Seja direto e prático. Nada de "provavelmente pode ser interessante considerar...". Português BR de contador com contador.`;

    const client = getAnthropic();
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const bloco = resp.content.find((c) => c.type === 'text');
    const resumo = (bloco && bloco.type === 'text') ? bloco.text.trim() : '';

    await query(
      `UPDATE grupos SET ai_resumo = $1, ai_atualizado_em = NOW() WHERE id = $2`,
      [resumo, grupo.id],
    );

    res.json({ ok: true, resumo });
  } catch (err: any) {
    next(err);
  }
});

function normalizar(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
