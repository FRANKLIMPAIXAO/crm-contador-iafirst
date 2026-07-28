// src/services/brasil-api.ts
// Consulta CNPJ pública via BrasilAPI — dados oficiais RFB.
// Docs: https://brasilapi.com.br/docs#tag/CNPJ

export type CnpjInfo = {
  cnpj: string;
  razao_social?: string;
  nome_fantasia?: string;
  situacao_cadastral?: number;    // 2 = ativa
  descricao_situacao_cadastral?: string;
  data_inicio_atividade?: string; // 'YYYY-MM-DD'
  cnae_fiscal?: number;
  cnae_fiscal_descricao?: string;
  porte?: string;                  // '01' MEI, '03' ME, '05' EPP, etc
  descricao_porte?: string;
  opcao_pelo_mei?: boolean;
  opcao_pelo_simples?: boolean;
  municipio?: string;
  uf?: string;
  regime_tributario?: Array<{ ano: number; forma_de_tributacao: string }>;
};

export async function consultarCnpj(cnpj: string): Promise<CnpjInfo | null> {
  const digits = cnpj.replace(/\D/g, '');
  if (digits.length !== 14) return null;
  try {
    const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as CnpjInfo;
  } catch {
    return null;
  }
}

/**
 * Interpreta o regime tributário atual a partir dos dados da BrasilAPI.
 * Retorna string curta apropriada pra `leads.regime_atual`.
 */
export function inferirRegime(info: CnpjInfo): string {
  if (info.opcao_pelo_mei) return 'MEI';
  if (info.opcao_pelo_simples) return 'Simples';
  // Se tem histórico regime_tributario, pega o mais recente
  if (info.regime_tributario?.length) {
    const recente = [...info.regime_tributario].sort((a, b) => b.ano - a.ano)[0];
    if (recente?.forma_de_tributacao) {
      const t = recente.forma_de_tributacao.toUpperCase();
      if (t.includes('REAL')) return 'Real';
      if (t.includes('PRESUMIDO')) return 'Presumido';
      if (t.includes('ARBITRADO')) return 'Arbitrado';
    }
  }
  return 'a confirmar';
}

/**
 * Extrai CNPJ (só dígitos) de um texto qualquer — rodapé de site, bio etc.
 * Retorna null se não achar padrão válido.
 */
export function extrairCnpjDeTexto(texto?: string): string | null {
  if (!texto) return null;
  const match = texto.match(/(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})/);
  const raw = match?.[1];
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length === 14 ? digits : null;
}
