// src/routes/webhook.ts
// Placeholder — Fase 1 implementa ingestão completa
// POST /webhook/evolution — recebe MESSAGES_UPSERT e MESSAGES_UPDATE
import { Router } from 'express';
import { config } from '../config.js';

export const webhookRouter: Router = Router();

webhookRouter.post('/evolution', async (req, res) => {
  // 1. Valida segredo
  const recebido = req.headers['apikey'] || req.headers['x-webhook-secret'];
  if (!config.EVOLUTION_WEBHOOK_SECRET || recebido !== config.EVOLUTION_WEBHOOK_SECRET) {
    res.status(401).json({ erro: 'webhook secret inválido' });
    return;
  }

  // TODO Fase 1:
  //    - Parse event/data
  //    - Filtra fromMe: false
  //    - Upsert lead (definir mapeamento instance → org)
  //    - Insere mensagem
  //    - Triagem Haiku async
  //    - Emite WebSocket

  console.log('[webhook] recebido:', JSON.stringify(req.body).slice(0, 200));
  res.status(202).json({ ok: true, recebido: req.body?.event });
});
