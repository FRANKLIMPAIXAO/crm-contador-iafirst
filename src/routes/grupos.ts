// src/routes/grupos.ts
// CRUD de grupos + sync com Evolution + IA gera resumo
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { query, queryOne, transaction } from '../db/connection.js';
import {
  fetchAllGroups, fetchGroupParticipants, jidToNumero, connectionState,
  fetchMessages, extrairTextoMensagem, sendText,
} from '../services/evolution.js';
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

// POST /api/grupos/descobrir-contatos
// Lê mensagens dos grupos pra montar telefone ↔ pushName, e sugere match
// com alunos que ainda não têm WhatsApp. NÃO grava nada — só sugere.
gruposRouter.post('/descobrir-contatos', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const limitPorGrupo = Math.min(Number(req.body?.limit) || 300, 500);

    const estado = await connectionState().catch(() => 'desconhecido');
    if (estado !== 'open') {
      res.status(409).json({
        ok: false, erro: 'whatsapp_desconectado',
        mensagem: `WhatsApp não conectado (estado: "${estado}").`,
      });
      return;
    }

    const grupos = await query<{ id: string; nome: string; wa_group_jid: string }>(
      `SELECT id, nome, wa_group_jid FROM grupos WHERE org_id = $1`,
      [orgId],
    );
    if (!grupos.length) {
      res.json({ ok: true, sugestoes: [], sem_match: [], mensagem: 'Nenhum grupo sincronizado.' });
      return;
    }

    // 1) Varre mensagens e monta telefone → { nome, grupos[] }
    const contatos = new Map<string, { nome: string; grupos: Set<string> }>();
    for (const g of grupos) {
      try {
        const msgs = await fetchMessages(g.wa_group_jid, limitPorGrupo);
        for (const m of msgs) {
          if (m.key?.fromMe) continue;
          const jid = m.key?.participant;
          const nome = (m.pushName || '').trim();
          if (!jid || !nome) continue;
          const tel = jidToNumero(jid);
          if (!tel || tel.length < 12) continue;
          const atual = contatos.get(tel);
          if (atual) { atual.grupos.add(g.nome); if (!atual.nome && nome) atual.nome = nome; }
          else contatos.set(tel, { nome, grupos: new Set([g.nome]) });
        }
      } catch (e: any) {
        console.warn(`[descobrir-contatos] ${g.nome}: ${e.message}`);
      }
    }

    // 2) Alunos SEM whatsapp
    const alunos = await query<{ id: string; nome: string; email: string | null }>(
      `SELECT id, nome, email FROM alunos
        WHERE org_id = $1 AND (whatsapp IS NULL OR whatsapp = '')`,
      [orgId],
    );

    // 3) Match por similaridade de nome
    const sugestoes: any[] = [];
    const usados = new Set<string>();
    for (const a of alunos) {
      let melhor: { tel: string; nome: string; score: number; grupos: string[] } | null = null;
      for (const [tel, c] of contatos.entries()) {
        if (usados.has(tel)) continue;
        const score = similaridade(a.nome, c.nome);
        if (score >= 0.62 && (!melhor || score > melhor.score)) {
          melhor = { tel, nome: c.nome, score, grupos: Array.from(c.grupos) };
        }
      }
      if (melhor) {
        usados.add(melhor.tel);
        sugestoes.push({
          aluno_id: a.id,
          aluno_nome: a.nome,
          aluno_email: a.email,
          whatsapp: melhor.tel,
          nome_whatsapp: melhor.nome,
          confianca: Math.round(melhor.score * 100),
          grupos: melhor.grupos,
        });
      }
    }
    sugestoes.sort((x, y) => y.confianca - x.confianca);

    // 4) Contatos do WhatsApp que não casaram com ninguém
    const semMatch = Array.from(contatos.entries())
      .filter(([tel]) => !usados.has(tel))
      .map(([tel, c]) => ({ whatsapp: tel, nome_whatsapp: c.nome, grupos: Array.from(c.grupos) }))
      .sort((a, b) => a.nome_whatsapp.localeCompare(b.nome_whatsapp));

    res.json({
      ok: true,
      contatos_encontrados: contatos.size,
      alunos_sem_whatsapp: alunos.length,
      sugestoes,
      sem_match: semMatch,
    });
  } catch (err: any) {
    console.error('[descobrir-contatos] falhou:', err.message);
    res.status(500).json({ ok: false, erro: 'descoberta_falhou', mensagem: String(err?.message || err).slice(0, 800) });
  }
});

// POST /api/grupos/aplicar-contatos — grava os telefones aprovados
const aplicarSchema = z.object({
  vinculos: z.array(z.object({
    aluno_id: z.string().uuid(),
    whatsapp: z.string().min(10).max(15),
  })).min(1).max(500),
});

gruposRouter.post('/aplicar-contatos', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { vinculos } = aplicarSchema.parse(req.body);
    let aplicados = 0;
    const erros: any[] = [];
    for (const v of vinculos) {
      try {
        const upd = await queryOne(
          `UPDATE alunos SET whatsapp = $1
            WHERE id = $2 AND org_id = $3 AND (whatsapp IS NULL OR whatsapp = '')
            RETURNING id`,
          [v.whatsapp.replace(/\D/g, ''), v.aluno_id, orgId],
        );
        if (upd) aplicados++;
      } catch (e: any) {
        erros.push({ aluno_id: v.aluno_id, erro: e.message });
      }
    }
    res.json({ ok: true, aplicados, ignorados: vinculos.length - aplicados, erros });
  } catch (err) { next(err); }
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

// GET /api/grupos/:id/mensagens — últimas mensagens do grupo
gruposRouter.get('/:id/mensagens', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const grupo = await queryOne<{ wa_group_jid: string; nome: string }>(
      `SELECT wa_group_jid, nome FROM grupos WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId],
    );
    if (!grupo) { res.status(404).json({ erro: 'grupo não encontrado' }); return; }

    const estado = await connectionState().catch(() => 'desconhecido');
    if (estado !== 'open') {
      res.status(409).json({
        ok: false, erro: 'whatsapp_desconectado',
        mensagem: `WhatsApp não conectado (estado: "${estado}"). Reconecte no painel do Evolution.`,
      });
      return;
    }

    const raw = await fetchMessages(grupo.wa_group_jid, limit);
    const mensagens = raw.map((m) => {
      const ts = Number(m.messageTimestamp) || 0;
      return {
        id: m.key?.id || null,
        de_mim: !!m.key?.fromMe,
        autor: m.pushName || (m.key?.participant ? jidToNumero(m.key.participant) : null),
        autor_numero: m.key?.participant ? jidToNumero(m.key.participant) : null,
        texto: extrairTextoMensagem(m),
        em: ts ? new Date(ts * 1000).toISOString() : null,
      };
    })
    .filter((m) => m.texto)
    .sort((a, b) => (a.em || '').localeCompare(b.em || ''));

    res.json({ grupo: grupo.nome, total: mensagens.length, mensagens });
  } catch (err: any) {
    console.error('[grupos-mensagens] falhou:', err.message);
    res.status(500).json({ ok: false, erro: 'mensagens_falhou', mensagem: String(err?.message || err).slice(0, 800) });
  }
});

// POST /api/grupos/:id/enviar — envia mensagem NO GRUPO
// AÇÃO DE ALTO IMPACTO: atinge todos os membros. Exige confirmar_membros
// igual ao total conhecido, pra evitar disparo acidental.
const enviarSchema = z.object({
  texto: z.string().min(1).max(4000),
  confirmar_membros: z.number().int().nonnegative(),
});

gruposRouter.post('/:id/enviar', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const input = enviarSchema.parse(req.body);
    const grupo = await queryOne<{ wa_group_jid: string; nome: string; membros_count: number }>(
      `SELECT wa_group_jid, nome, membros_count FROM grupos WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId],
    );
    if (!grupo) { res.status(404).json({ erro: 'grupo não encontrado' }); return; }

    // Trava anti-disparo-acidental: o cliente precisa ecoar o nº de membros
    if (input.confirmar_membros !== grupo.membros_count) {
      res.status(409).json({
        ok: false, erro: 'confirmacao_invalida',
        mensagem: `Confirmação não bate. O grupo "${grupo.nome}" tem ${grupo.membros_count} membros, ` +
                  `mas a requisição enviou ${input.confirmar_membros}. Recarregue a página e tente de novo.`,
      });
      return;
    }

    const estado = await connectionState().catch(() => 'desconhecido');
    if (estado !== 'open') {
      res.status(409).json({
        ok: false, erro: 'whatsapp_desconectado',
        mensagem: `WhatsApp não conectado (estado: "${estado}").`,
      });
      return;
    }

    const r = await sendText({ numero: grupo.wa_group_jid, texto: input.texto });
    if (!r.ok) {
      res.status(502).json({ ok: false, erro: 'envio_falhou', mensagem: r.erro || 'Evolution recusou o envio' });
      return;
    }

    res.json({ ok: true, wa_message_id: r.wa_message_id, grupo: grupo.nome, membros: grupo.membros_count });
  } catch (err: any) {
    res.status(500).json({ ok: false, erro: 'envio_falhou', mensagem: String(err?.message || err).slice(0, 800) });
  }
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

/**
 * Similaridade 0..1 entre dois nomes.
 * Compara tokens: quantos pedaços do nome menor aparecem no maior.
 * "Wendell Naves" vs "Wendell Naves Contabilidade" → alto
 * "Kelly da Silva" vs "Kelly Rezende" → baixo (só 1 token comum)
 */
function similaridade(a: string, b: string): number {
  const ta = normalizar(a).split(' ').filter((t) => t.length > 2);
  const tb = normalizar(b).split(' ').filter((t) => t.length > 2);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let comuns = 0;
  for (const t of ta) if (setB.has(t)) comuns++;
  const menor = Math.min(ta.length, tb.length);
  const base = comuns / menor;
  // Bônus se o primeiro nome bate exatamente (forte sinal de pessoa)
  const bonus = ta[0] && tb[0] && ta[0] === tb[0] ? 0.15 : 0;
  return Math.min(1, base + bonus);
}

function normalizar(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
