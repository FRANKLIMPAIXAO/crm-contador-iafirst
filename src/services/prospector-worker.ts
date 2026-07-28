// src/services/prospector-worker.ts
// Executa uma busca do Prospector: chama Places API, enriquece com BrasilAPI,
// insere leads novos (dedup por google_place_id ou wa_jid) e atualiza a busca.
// Rodado em background pelo endpoint POST /api/prospector/buscas.
import { query, queryOne, transaction } from '../db/connection.js';
import { textSearch, estimarPorte, extrairWhatsApp, extrairTexto, type PlacesSearchResult } from './google-places.js';
import { consultarCnpj, extrairCnpjDeTexto, inferirRegime } from './brasil-api.js';

type Busca = {
  id: string;
  org_id: string;
  segmento: string;
  cidade: string;
  meta_leads: number;
  motor: string;
};

export async function executarBusca(buscaId: string): Promise<void> {
  const busca = await queryOne<Busca>(
    `SELECT id, org_id, segmento, cidade, meta_leads, motor
       FROM prospector_buscas WHERE id = $1`,
    [buscaId],
  );
  if (!busca) {
    console.warn(`[prospector-worker] busca ${buscaId} não encontrada`);
    return;
  }

  await query(
    `UPDATE prospector_buscas SET status = 'rodando', iniciada_em = NOW() WHERE id = $1`,
    [buscaId],
  );

  try {
    console.log(`[prospector-worker] busca ${buscaId}: "${busca.segmento} em ${busca.cidade}" (meta ${busca.meta_leads})`);

    // 1) Places API — text search
    const places = await textSearch({
      segmento: busca.segmento,
      cidade: busca.cidade,
      meta: busca.meta_leads,
    });

    console.log(`[prospector-worker] busca ${buscaId}: Places retornou ${places.length} resultados`);

    // 2) Insere/atualiza cada lead com enriquecimento
    let novos = 0;
    let atualizados = 0;
    for (const p of places) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;

      // Places API New devolve displayName como { text, languageCode } — precisa extrair
      const nomeLimpo = extrairTexto(p.displayName) || 'Sem nome';
      const wa = extrairWhatsApp(p.internationalPhoneNumber || p.nationalPhoneNumber);
      const porte = estimarPorte(p.userRatingCount);

      // Enriquecimento CNPJ — best-effort (não bloqueia lead se falhar)
      let cnpj: string | null = null;
      let regime: string | null = null;
      let cnae: string | null = null;
      let dataAbertura: string | null = null;

      const cnpjTexto = extrairCnpjDeTexto(p.websiteUri) || extrairCnpjDeTexto(p.formattedAddress);
      if (cnpjTexto) {
        const info = await consultarCnpj(cnpjTexto);
        if (info) {
          cnpj = cnpjTexto;
          regime = inferirRegime(info);
          cnae = info.cnae_fiscal_descricao || null;
          dataAbertura = info.data_inicio_atividade || null;
        }
      }
      if (!regime) regime = 'a confirmar';

      const gancho = montarGancho({
        segmento: busca.segmento,
        porte,
        regime,
        avaliacoes: p.userRatingCount,
      });

      // Dedup: primeiro por google_place_id, senão por wa_jid+org_id
      const existente = await queryOne<{ id: string }>(
        `SELECT id FROM leads WHERE google_place_id = $1 AND org_id = $2
         UNION
         SELECT id FROM leads WHERE org_id = $2 AND wa_jid = $3 AND $3 <> ''
         LIMIT 1`,
        [p.id, busca.org_id, wa || ''],
      );

      if (existente) {
        // Atualiza dados soft (não sobrescreve stage/qualif)
        await query(
          `UPDATE leads SET
             nome = COALESCE(nome, $1),
             segmento = COALESCE(segmento, $2),
             cidade = COALESCE(cidade, $3),
             site = COALESCE(site, $4),
             endereco = COALESCE(endereco, $5),
             nota_google = COALESCE($6, nota_google),
             avaliacoes_google = COALESCE($7, avaliacoes_google),
             porte = COALESCE($8::prospector_porte, porte),
             cnpj = COALESCE(cnpj, $9),
             regime_atual = COALESCE(regime_atual, $10),
             cnae_fiscal = COALESCE(cnae_fiscal, $11),
             data_abertura = COALESCE(data_abertura, $12::date),
             google_place_id = COALESCE(google_place_id, $13),
             prospector_busca_id = COALESCE(prospector_busca_id, $14)
           WHERE id = $15`,
          [
            nomeLimpo, busca.segmento, busca.cidade, p.websiteUri, p.formattedAddress,
            p.rating, p.userRatingCount, porte, cnpj, regime, cnae, dataAbertura,
            p.id, buscaId, existente.id,
          ],
        );
        atualizados++;
      } else {
        // Insert novo lead
        await query(
          `INSERT INTO leads (
             org_id, wa_jid, nome, origem, segmento, cidade, site, endereco,
             nota_google, avaliacoes_google, porte, cnpj, regime_atual,
             cnae_fiscal, data_abertura, google_place_id, prospector_busca_id,
             gancho_contabil, stage
           ) VALUES ($1, $2, $3, 'prospector', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date, $15, $16, $17, 'novo')`,
          [
            busca.org_id, wa || `place:${p.id}`, nomeLimpo, busca.segmento, busca.cidade,
            p.websiteUri, p.formattedAddress, p.rating, p.userRatingCount,
            porte, cnpj, regime, cnae, dataAbertura, p.id, buscaId, gancho,
          ],
        );
        novos++;
      }
    }

    // 3) Marca busca concluída
    const custo = calcularCustoEstimado(places.length);
    await query(
      `UPDATE prospector_buscas SET
         status = 'concluida',
         leads_encontrados = $1,
         leads_novos = $2,
         custo_estimado = $3,
         concluida_em = NOW()
       WHERE id = $4`,
      [places.length, novos, custo, buscaId],
    );

    console.log(`[prospector-worker] busca ${buscaId}: OK — ${novos} novos, ${atualizados} atualizados`);
  } catch (err: any) {
    console.error(`[prospector-worker] busca ${buscaId} FALHOU:`, err.message);
    await query(
      `UPDATE prospector_buscas SET
         status = 'erro',
         erro = $1,
         concluida_em = NOW()
       WHERE id = $2`,
      [String(err.message).slice(0, 500), buscaId],
    );
  }
}

/**
 * Gancho contábil sugerido — usado como 1ª linha de mensagem/diagnóstico.
 * IA (Fase 8.3) refina, mas até lá isso já dá contexto.
 */
function montarGancho(p: {
  segmento: string;
  porte: string;
  regime: string;
  avaliacoes?: number;
}): string {
  const pistas: string[] = [];
  if (p.porte === 'medio') pistas.push('porte médio (ponto doce)');
  if (p.porte === 'grande') pistas.push('porte grande — provável rede');
  if (p.regime === 'MEI' && p.avaliacoes && p.avaliacoes > 100) {
    pistas.push('MEI faturando alto — risco de estourar teto R$ 81k');
  }
  if (p.regime === 'Simples') pistas.push('Simples Nacional — verificar Anexo e segregação de receitas');
  if (p.regime === 'a confirmar') pistas.push('regime não identificado — confirmar na abordagem');
  return `${p.segmento}${pistas.length ? ' · ' + pistas.join(' · ') : ''}`;
}

/**
 * Custo estimado em BRL (Text Search + potenciais detalhes futuros).
 * Text Search: US$ 0.032 por query. Câmbio conservador R$ 5,50/US$.
 * Como pedimos até 3 páginas, o custo é ~US$ 0.032 × páginas.
 */
function calcularCustoEstimado(qtdResultados: number): number {
  const paginasUsadas = Math.min(3, Math.ceil(qtdResultados / 20));
  const usdPerRequest = 0.032;
  const brlPerUsd = 5.5;
  return Number((paginasUsadas * usdPerRequest * brlPerUsd).toFixed(4));
}
