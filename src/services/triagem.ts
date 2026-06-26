// src/services/triagem.ts
// Triagem IA de mensagens recebidas via Claude Haiku
// Recebe: texto da mensagem nova + histórico recente
// Devolve: produto_interesse, qualif, score, sugestão de resposta
import { getClient, isConfigured } from './anthropic.js';
import { config } from '../config.js';
import { query, queryOne } from '../db/connection.js';

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
  const historico = await query<{ direcao: 'in' | 'out'; corpo: string }>(
    `SELECT direcao, corpo FROM messages WHERE lead_id = $1 AND org_id = $2 ORDER BY ts DESC LIMIT 10`,
    [leadId, orgId],
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

  return resultado;
}
