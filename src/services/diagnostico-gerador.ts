// src/services/diagnostico-gerador.ts
// Gera página-diagnóstico HTML personalizada com Claude Sonnet 4.5.
// Prompt herdado da skill `diagnostico-nicho` do plugin, adaptado pra CRM.
import { getClient } from './anthropic.js';
import { config } from '../config.js';

const MODELO = 'claude-sonnet-4-5';

export type DiagnosticoInput = {
  lead: {
    nome: string;
    segmento: string;
    cidade: string;
    nota_google?: number | null;
    avaliacoes_google?: number | null;
    regime_atual?: string | null;
    porte?: string | null;
  };
  contador: {
    nome: string;
    escritorio?: string;
    apresentacao: string;    // "Contador especialista em oficinas"
    crc?: string;
    whatsapp: string;        // 55DDDnnnnnnnnn
  };
  url_publica: string;       // pra usar dentro dos meta tags OG
};

/**
 * Gera HTML completo da página-diagnóstico personalizada.
 * Retorna string HTML pronta pra salvar em prospector_diagnosticos.html_content.
 */
export async function gerarDiagnosticoHtml(input: DiagnosticoInput): Promise<string> {
  const client = getClient();
  const prompt = montarPrompt(input);

  const resp = await client.messages.create({
    model: MODELO,
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const bloco = resp.content.find((c) => c.type === 'text');
  if (!bloco || bloco.type !== 'text') {
    throw new Error('[diagnostico-gerador] resposta sem bloco de texto');
  }

  let html = bloco.text.trim();

  // Remove eventuais ```html ... ``` que o modelo pode incluir
  html = html.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Sanity checks
  if (!html.toLowerCase().includes('<!doctype') && !html.toLowerCase().includes('<html')) {
    throw new Error('[diagnostico-gerador] HTML retornado inválido');
  }
  if (html.includes('{{')) {
    throw new Error('[diagnostico-gerador] placeholder {{...}} não substituído no HTML');
  }

  return html;
}

function montarPrompt(input: DiagnosticoInput): string {
  const { lead, contador, url_publica } = input;
  const nota = lead.nota_google ? `${lead.nota_google.toFixed(1)}★` : 'sem nota';
  const avaliacoes = lead.avaliacoes_google ? `${lead.avaliacoes_google} avaliações` : 'poucas avaliações';
  const waMsg = encodeURIComponent(
    `Vim pela página de contabilidade para ${lead.segmento} e queria entender melhor`,
  );
  const waLink = `https://wa.me/${contador.whatsapp}?text=${waMsg}`;
  const regimeInfo = lead.regime_atual && lead.regime_atual !== 'a confirmar'
    ? `Regime atual confirmado (dado público): ${lead.regime_atual}.`
    : 'Regime não confirmado — cite em condicional ("provavelmente...").';

  return `Você é um contador brasileiro sênior gerando uma página-diagnóstico HTML personalizada de PROSPECÇÃO.

O objetivo: mostrar ao dono da empresa "${lead.nome}" que você entende do NEGÓCIO dele (segmento "${lead.segmento}") através de conteúdo tributário-contábil REAL e específico do nicho. O lead lê a página, se reconhece nas dores e chama no WhatsApp.

## Dados do lead
- Empresa: ${lead.nome}
- Segmento: ${lead.segmento}
- Cidade: ${lead.cidade}
- Nota Google: ${nota} · ${avaliacoes}
- Porte estimado: ${lead.porte || 'indefinido'}
- ${regimeInfo}

## Dados do contador (assinatura)
- Nome: ${contador.nome}
- Apresentação: ${contador.apresentacao}
${contador.escritorio ? `- Escritório: ${contador.escritorio}` : ''}
${contador.crc ? `- CRC: ${contador.crc}` : ''}
- WhatsApp CTA: ${waLink}

## URL final da página (para meta OG)
${url_publica}

## Regras invioláveis
1. NUNCA invente número da empresa (faturamento, funcionários, imposto que ela paga). Fale do SEGMENTO ("oficinas de médio porte costumam...").
2. NUNCA mencione preço/honorário. CTA único: WhatsApp.
3. Dores tributárias TÉCNICAS e REAIS do nicho — nada de "economize 90%".
4. Nome/nota/avaliações do lead são reais e verificáveis — cite pra rapport.
5. TODOS os CTAs vão pro WhatsApp do CONTADOR (não do lead).
6. Página responsiva 360→1440px, sem rolagem horizontal.
7. HTML autocontido: CSS inline no <style>, sem JS, sem imagens externas (pode usar emoji e SVG inline).
8. Fonte: system-ui, -apple-system, sans-serif (sem Google Fonts — bloqueia offline).
9. Cores: paleta profissional escura ou clara (à sua escolha), consistente e legível.

## Biblioteca de dores por segmento (use como base, adapte)
- **Oficinas mecânicas**: separar peça (mercadoria/ICMS) de serviço (mão de obra/ISS); ICMS-ST de autopeças (peça já veio tributada); Simples Anexo I × III via Fator R; crédito ICMS no Presumido/Real; INSS mecânicos.
- **Restaurantes/lanchonetes**: monofásico bebidas frias (PIS/COFINS já pago); Fator R (folha ≥28% joga Anexo V→III); gorjeta e base de cálculo; perdas/quebras.
- **Clínicas médicas/odonto**: Fator R crítico (V→III muda tudo); equiparação hospitalar (redução base Presumido); pró-labore × distribuição de lucros isenta.
- **Pet shops**: banho/tosa é serviço (ISS) mas venda de ração é comércio (ICMS) — Simples Anexo I × III conforme mix; farmácia veterinária tem regras próprias; produtos com ICMS-ST não podem ser tributados de novo.
- **Comércio varejista**: ICMS-ST, DIFAL LC 190/22, aproveitamento crédito, segregação monofásicos.

Para segmentos fora dessa lista: aplique o método — 3 a 5 decisões tributárias que mais impactam o imposto naquele nicho.

## Estrutura obrigatória da página
1. Hero: título forte com "[Segmento] em [Cidade] tem uma conta que quase ninguém confere" (ou similar) + subtítulo com o nome da empresa ("Preparei este raio-x pensando na [Nome]").
2. Rapport: bloco curto citando a nota e nº de avaliações do Google.
3. 3 a 5 CARDS com as dores tributárias do segmento — cada card: título (curto e chamativo) + explicação em 2-3 linhas (linguagem do dono, não do contador).
4. Checklist "o que uma [segmento] costuma deixar passar" — 5-7 itens verificáveis (❌ ou ✓).
5. Comparativo GENÉRICO Simples × Presumido × Real pro nicho (3 colunas com "ganha quando..."). SEM número da empresa.
6. Assinatura: nome + apresentação + CRC (se houver).
7. CTA final: botão grande de WhatsApp + microcopy "Quer o raio-x com os SEUS números? Me chama."
8. Botão flutuante fixo de WhatsApp (canto inferior direito).

## Meta tags obrigatórias no <head>
- <title>Contabilidade para ${lead.segmento} — ${lead.nome}</title>
- <meta name="description" content="Raio-x tributário para ${lead.nome} e outras ${lead.segmento} em ${lead.cidade}.">
- <meta property="og:title" content="...">
- <meta property="og:description" content="...">
- <meta property="og:url" content="${url_publica}">
- <meta name="viewport" content="width=device-width, initial-scale=1">

## Saída
Retorne APENAS o HTML completo (começando com <!DOCTYPE html>). Nada de markdown, nada de \`\`\`, nada de explicação antes ou depois. O primeiro caractere da sua resposta deve ser "<" e o último ">".`;
}
