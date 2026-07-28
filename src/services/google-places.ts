// src/services/google-places.ts
// Cliente Google Places API (New) — Text Search + Place Details.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
import { config } from '../config.js';

const BASE = 'https://places.googleapis.com/v1';

export type PlacesSearchResult = {
  id: string;                    // Place ID único
  displayName?: string;
  formattedAddress?: string;
  primaryType?: string;
  rating?: number;
  userRatingCount?: number;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
  location?: { latitude: number; longitude: number };
  googleMapsUri?: string;
};

type PlacesApiError = { code: number; message: string; status: string };

/**
 * Text Search — busca "oficinas mecânicas em Aparecida de Goiânia"
 * Retorna até 20 resultados por página (paginação opcional).
 */
export async function textSearch(params: {
  segmento: string;
  cidade: string;
  meta?: number;              // se >20, faz paginação
}): Promise<PlacesSearchResult[]> {
  if (!config.GOOGLE_PLACES_API_KEY) {
    throw new Error('GOOGLE_PLACES_API_KEY não configurada');
  }

  const textQuery = `${params.segmento} em ${params.cidade}`;
  const results: PlacesSearchResult[] = [];
  const meta = params.meta || 15;
  let pageToken: string | undefined;
  let pagesLidas = 0;

  while (results.length < meta && pagesLidas < 3) {
    const body: Record<string, unknown> = {
      textQuery,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: Math.min(20, meta - results.length),
    };
    if (pageToken) body.pageToken = pageToken;

    const resp = await fetch(`${BASE}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': [
          'places.id',
          'places.displayName',
          'places.formattedAddress',
          'places.primaryType',
          'places.rating',
          'places.userRatingCount',
          'places.nationalPhoneNumber',
          'places.internationalPhoneNumber',
          'places.websiteUri',
          'places.businessStatus',
          'places.location',
          'places.googleMapsUri',
          'nextPageToken',
        ].join(','),
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await parseErr(resp);
      throw new Error(`[places] textSearch falhou: ${err}`);
    }

    const data = (await resp.json()) as { places?: PlacesSearchResult[]; nextPageToken?: string };
    if (data.places?.length) {
      results.push(...data.places);
    }
    pagesLidas++;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    // Google exige delay ~2s entre paginações
    if (pagesLidas < 3) await new Promise((r) => setTimeout(r, 2000));
  }

  return results.slice(0, meta);
}

async function parseErr(resp: Response): Promise<string> {
  try {
    const j = (await resp.json()) as { error?: PlacesApiError };
    if (j.error) return `${resp.status} ${j.error.status}: ${j.error.message}`;
  } catch {}
  return `${resp.status} ${resp.statusText}`;
}

/**
 * Extrai o "porte" estimado pelo número de avaliações do Google.
 * Regra prática (calibrada pra PMEs brasileiras):
 *   < 30 avaliações  → pequeno / recém-aberto
 *   30-200          → médio (o ponto doce da prospecção)
 *   > 200           → grande (provável rede/franquia, difícil abocanhar)
 */
export function estimarPorte(userRatingCount?: number): 'pequeno' | 'medio' | 'grande' | 'indefinido' {
  if (typeof userRatingCount !== 'number') return 'indefinido';
  if (userRatingCount < 30) return 'pequeno';
  if (userRatingCount <= 200) return 'medio';
  return 'grande';
}

/**
 * Detecta WhatsApp a partir de telefone brasileiro.
 * Normaliza pra formato 55DDD9NUMERO. Retorna null se não parecer celular.
 */
export function extrairWhatsApp(phone?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  // Se veio com 55 (internacional): 5562991234567 (13 dígitos)
  // Se veio nacional: 62991234567 (11) ou (62) 99123-4567
  let normalizado: string;
  if (digits.length === 13 && digits.startsWith('55')) {
    normalizado = digits;
  } else if (digits.length === 11) {
    normalizado = '55' + digits;
  } else if (digits.length === 10) {
    // Telefone fixo — não é WhatsApp confiável
    return null;
  } else {
    return null;
  }
  // Precisa ter 9º dígito (celular) — 5º caractere após "55DDD"
  // 55 62 9 91234567 → posição 4 é o 9
  if (normalizado[4] !== '9') return null;
  return normalizado;
}
