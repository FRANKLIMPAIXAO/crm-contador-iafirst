// src/services/ingestao.ts
// Lógica compartilhada entre webhook Evolution e endpoint de simulação dev.
// Recebe: mensagem nova de um wa_jid → upsert lead, salva message, dispara triagem.
import { queryOne, transaction } from '../db/connection.js';
import { triarLead } from './triagem.js';

export interface MensagemEntrada {
  orgId: string;
  waJid: string;
  pushName?: string | null;
  corpo: string;
  waMessageId?: string | null;
  timestamp?: Date;
}

export interface ResultadoIngestao {
  lead: {
    id: string;
    nome: string | null;
    wa_jid: string;
    criado_agora: boolean;
  };
  message: { id: string };
}

export async function ingerirMensagemRecebida(input: MensagemEntrada): Promise<ResultadoIngestao> {
  const ts = input.timestamp || new Date();

  const lead = await transaction(async (client) => {
    const existing = await client.query<{ id: string; nome: string | null }>(
      `SELECT id, nome FROM leads WHERE org_id = $1 AND wa_jid = $2 LIMIT 1`,
      [input.orgId, input.waJid],
    );

    if (existing.rows.length > 0) {
      const found = existing.rows[0]!;
      if (input.pushName && !found.nome) {
        await client.query(`UPDATE leads SET nome = $1, last_message_at = $2 WHERE id = $3`, [
          input.pushName,
          ts,
          found.id,
        ]);
      } else {
        await client.query(`UPDATE leads SET last_message_at = $1 WHERE id = $2`, [ts, found.id]);
      }
      return { id: found.id, nome: input.pushName || found.nome, criado_agora: false };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO leads (org_id, wa_jid, nome, stage, qualif, last_message_at)
       VALUES ($1, $2, $3, 'novo', 'frio', $4)
       RETURNING id`,
      [input.orgId, input.waJid, input.pushName || null, ts],
    );
    return { id: inserted.rows[0]!.id, nome: input.pushName || null, criado_agora: true };
  });

  const msg = await queryOne<{ id: string }>(
    `INSERT INTO messages (org_id, lead_id, direcao, corpo, wa_message_id, status, ts)
     VALUES ($1, $2, 'in', $3, $4, 'received', $5)
     RETURNING id`,
    [input.orgId, lead.id, input.corpo, input.waMessageId || null, ts],
  );

  triarLead(lead.id, input.orgId, input.corpo).catch((err) => {
    console.error('[ingestao] triagem async falhou:', err.message);
  });

  return {
    lead: { id: lead.id, nome: lead.nome, wa_jid: input.waJid, criado_agora: lead.criado_agora },
    message: { id: msg!.id },
  };
}
