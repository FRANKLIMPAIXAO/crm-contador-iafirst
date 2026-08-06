// src/services/triagem.ts
// Triagem IA de mensagens recebidas via Claude Haiku
// Recebe: texto da mensagem nova + histórico recente
// Devolve: produto_interesse, qualif, score, sugestão de resposta
import { getClient, isConfigured } from './anthropic.js';
import { config } from '../config.js';
import { query, queryOne } from '../db/connection.js';
import { notificar, urlCrmLead } from './sexta-notify.js';
import * as evolution from './evolution.js';

export interface TriagemResultado {
  produto_interesse: 'familia' | 'iafirst' | 'pacservice' | 'contachat' | 'indefinido';
  qualif: 'frio' | 'morno' | 'quente';
  score: number;
  intencao: string;
  resumo: string;
  sugestao_resposta: string;
  dados_extraidos: {
    cnpj?: string | null;
    num_clientes?: number | null;
    regime?: string | null;
  };
}

const SYSTEM_PROMPT = `Você é o SDR de triagem do CRM do Franklim Paixão, contador que vende mentorias (Família TributárIA, Contador IA First) e sistemas (PACSERVICE de NFS-e, ContaChat de atendimento). A audiência é contador. Leia a mensagem do lead e o histórico, e classifique.

Responda APENAS com um objeto JSON válido, sem texto antes ou depois, sem markdown, sem cercas de código.

Produtos possíveis (campo produto_interesse): familia, iafirst, pacservice, contachat, indefinido.
Qualificação (campo qualif): frio, morno, quente.

Formato exato:
{
  "produto_interesse": "iafirst",
  "qualif": "quente",
  "score": 85,
  "intencao": "frase curta do que o lead quer",
  "resumo": "uma linha de contexto pro vendedor",
  "sugestao_resposta": "resposta pronta pra enviar, no tom direto do Franklim",
  "dados_extraidos": { "cnpj": null, "num_clientes": null, "regime": null }
}

Score 0-100. Quente >= 70, morno 30-69, frio < 30.`;

function limparJsonResposta(texto: string): string {
  return texto
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export async function triar({
  textoNovo,
  historico = [],
}: {
  textoNovo: string;
  historico?: Array<{ direcao: 'in' | 'out'; corpo: string }>;
}): Promise<TriagemResultado | null> {
  if (!isConfigured()) {
    console.warn('[triagem] ANTHROPIC_API_KEY não configurada — pulando');
    return null;
  }

  const historicoFmt = historico
    .slice(-8)
    .map((m) => `${m.direcao === 'in' ? 'Lead' : 'SDR'}: ${m.corpo}`)
    .join('\n');

  const userMsg = `Histórico recente:
${historicoFmt || '(primeira mensagem)'}

Mensagem nova do lead:
${textoNovo}`;

  try {
    const r = await getClient().messages.create({
      model: config.ANTHROPIC_MODEL_TRIAGEM,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    });

    const textoBruto = r.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('')
      .trim();

    const jsonLimpo = limparJsonResposta(textoBruto);
    const parsed = JSON.parse(jsonLimpo) as TriagemResultado;

    if (!parsed.qualif || !parsed.produto_interesse) {
      throw new Error('JSON sem campos obrigatórios');
    }

    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[triagem] falhou:', msg);
    return null;
  }
}

export async function triarLead(leadId: string, orgId: string, textoNovo: string): Promise<TriagemResultado | null> {
  // Corte de contexto: histórico velho não deve entrar no prompt, senão o bot
  // responde uma conversa de semanas atrás como se fosse agora ("tudo pronto
  // pra nossa call?" 40 dias depois). Duas travas:
  //   1. conversa_reiniciada_em — marco manual, setado pelo botão "Encerrar conversa"
  //   2. CONVERSA_CONTEXTO_DIAS — janela automática (default 7 dias)
  const janelaDias = Number(process.env.CONVERSA_CONTEXTO_DIAS || 7);
  const lead = await queryOne<{ conversa_reiniciada_em: Date | null }>(
    `SELECT conversa_reiniciada_em FROM leads WHERE id = $1 AND org_id = $2`,
    [leadId, orgId],
  );

  const corteJanela = new Date(Date.now() - janelaDias * 24 * 60 * 60 * 1000);
  const corteManual = lead?.conversa_reiniciada_em ? new Date(lead.conversa_reiniciada_em) : null;
  const corte = corteManual && corteManual > corteJanela ? corteManual : corteJanela;

  const historico = await query<{ direcao: 'in' | 'out'; corpo: string }>(
    `SELECT direcao, corpo FROM messages
      WHERE lead_id = $1 AND org_id = $2 AND ts >= $3
      ORDER BY ts DESC LIMIT 10`,
    [leadId, orgId, corte],
  );

  const resultado = await triar({
    textoNovo,
    historico: historico.reverse().map((h) => ({ direcao: h.direcao, corpo: h.corpo || '' })),
  });

  if (!resultado) return null;

  await queryOne(
    `UPDATE leads SET
       produto_interesse = $1,
       qualif = $2,
       score = $3,
       cnpj = COALESCE($4, cnpj)
     WHERE id = $5 AND org_id = $6`,
    [
      resultado.produto_interesse,
      resultado.qualif,
      resultado.score,
      resultado.dados_extraidos?.cnpj || null,
      leadId,
      orgId,
    ],
  );

  await queryOne(
    `INSERT INTO activities (org_id, lead_id, tipo, conteudo)
     VALUES ($1, $2, 'triagem_ia', $3)`,
    [orgId, leadId, JSON.stringify(resultado)],
  );

  // ===== BOT AUTO-RESPONDER =====
  // Envia sugestão IA direto pro WhatsApp do lead se:
  //   1. BOT_AUTO_RESPONDER=true (default true)
  //   2. ehNovo (primeira mensagem do lead — evita loop)
  //   3. qualif >= BOT_AUTO_RESPONDER_MIN_QUALIF (default morno, frio nunca)
  //   4. Sugestão de resposta existe
  //   5. Evolution configurado
  const ordemQualif: Record<string, number> = { frio: 1, morno: 2, quente: 3 };
  const botHabilitado = (process.env.BOT_AUTO_RESPONDER || 'true').toLowerCase() === 'true';
  const botMinQualif = (process.env.BOT_AUTO_RESPONDER_MIN_QUALIF || 'morno').toLowerCase();
  let respondidoAuto = false;

  if (botHabilitado && evolution.isConfigured() && resultado.sugestao_resposta) {
    try {
      const passouQualif = (ordemQualif[resultado.qualif] || 0) >= (ordemQualif[botMinQualif] || 2);

      // Humano-tomou-conta: se houve resposta MANUAL recente (via painel CRM),
      // bot fica quieto pra não atrapalhar. Configurável via BOT_PAUSA_APOS_HUMANO_MIN (default 60min).
      const pausaMin = Number(process.env.BOT_PAUSA_APOS_HUMANO_MIN || 60);
      const humanoAssumiu = await queryOne<{ c: string }>(
        `SELECT count(*)::text as c FROM activities
         WHERE lead_id = $1 AND tipo = 'mensagem_enviada'
         AND created_at > NOW() - INTERVAL '${pausaMin} minutes'`,
        [leadId],
      );
      const humanoRecente = Number(humanoAssumiu?.c ?? 0) > 0;

      if (passouQualif && !humanoRecente) {
        const leadData = await queryOne<{ wa_jid: string }>(
          `SELECT wa_jid FROM leads WHERE id = $1`,
          [leadId],
        );
        // Trava dura: NUNCA responder em grupo/broadcast/canal, mesmo que um
        // lead com jid não-individual tenha entrado no banco por outro caminho.
        const jid = leadData?.wa_jid || '';
        const jidIndividual = !!jid
          && !jid.endsWith('@g.us')
          && !jid.endsWith('@broadcast')
          && !jid.endsWith('@newsletter')
          && !jid.includes('@lid');

        if (!jidIndividual && jid) {
          console.warn(`[triagem] bot NAO respondeu — jid nao-individual: ${jid}`);
        }

        if (leadData?.wa_jid && jidIndividual) {
          // Delay 2-4s aleatório pra parecer humano
          const delay = 2000 + Math.floor(Math.random() * 2000);
          await new Promise((r) => setTimeout(r, delay));

          const r = await evolution.sendText({
            numero: leadData.wa_jid,
            texto: resultado.sugestao_resposta,
          });

          if (r.ok) {
            respondidoAuto = true;
            // Salva como mensagem 'out' no banco
            await queryOne(
              `INSERT INTO messages (org_id, lead_id, direcao, corpo, wa_message_id, status)
               VALUES ($1, $2, 'out', $3, $4, 'sent')`,
              [orgId, leadId, resultado.sugestao_resposta, r.wa_message_id || null],
            );
            // Activity
            await queryOne(
              `INSERT INTO activities (org_id, lead_id, tipo, conteudo)
               VALUES ($1, $2, 'resposta_automatica', $3)`,
              [orgId, leadId, JSON.stringify({ resposta: resultado.sugestao_resposta, qualif: resultado.qualif })],
            );
            console.log(`[bot] ✅ auto-respondeu lead ${leadId} (${resultado.qualif})`);
          } else {
            console.warn('[bot] auto-resposta falhou:', r.erro);
          }
        }
      }
    } catch (err) {
      console.warn('[bot] erro auto-responder:', err instanceof Error ? err.message : err);
    }
  }

  // ===== Notifica SEXTA pra todos exceto FRIO (frio = silencioso, não vira spam) =====
  // Override via env: SEXTA_NOTIFY_MIN_QUALIF=frio|morno|quente (default 'morno')
  const minQualif = (process.env.SEXTA_NOTIFY_MIN_QUALIF || 'morno').toLowerCase();
  const passou = (ordemQualif[resultado.qualif] || 0) >= (ordemQualif[minQualif] || 2);
  if (passou) {
    try {
      const lead = await queryOne<{
        nome: string | null; wa_jid: string; stage: string;
      }>(`SELECT nome, wa_jid, stage FROM leads WHERE id = $1`, [leadId]);
      if (lead) {
        // Se já existia conversa (>1 msg), é "lead quente respondeu". Senão "lead novo quente".
        const count = await queryOne<{ c: string }>(
          `SELECT count(*)::text as c FROM messages WHERE lead_id = $1`,
          [leadId],
        );
        const ehNovo = Number(count?.c ?? 0) <= 1;
        // Tipo dinâmico: lead_novo_<qualif> ou lead_<qualif>_respondeu
        const tipoEvento = ehNovo
          ? (`lead_novo_${resultado.qualif}` as const)
          : (`lead_${resultado.qualif}_respondeu` as const);
        await notificar({
          tipo: tipoEvento as never,
          lead: {
            id: leadId,
            nome: lead.nome,
            wa_jid: lead.wa_jid,
            produto_interesse: resultado.produto_interesse,
            qualif: resultado.qualif,
            score: resultado.score,
            stage: lead.stage,
          },
          mensagem_lead: textoNovo,
          triagem: {
            intencao: resultado.intencao,
            resumo: resultado.resumo,
            sugestao_resposta: resultado.sugestao_resposta,
          },
          url_crm: urlCrmLead(leadId),
          respondido_auto: respondidoAuto,
        } as never);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[triagem] notificar SEXTA falhou (não-crítico):', msg);
    }
  }

  return resultado;
}
