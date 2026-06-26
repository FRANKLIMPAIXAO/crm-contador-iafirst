// src/routes/dev.ts
// Rotas de teste/dev — em produção, só admin autenticado pode acessar.
// Útil pra testar fluxo IA antes do Evolution estar conectado.
import { Router } from 'express';
import { z } from 'zod';
import { requerAuth, requerPapel } from '../middleware/auth.js';
import { getOrgId } from '../middleware/tenant.js';
import { ingerirMensagemRecebida } from '../services/ingestao.js';

export const devRouter: Router = Router();

// Em qualquer ambiente, exige autenticação.
// Em produção, exige adicionalmente que seja admin (closer/viewer não pode simular).
devRouter.use(requerAuth);
devRouter.use(requerPapel('admin'));

const simularSchema = z.object({
  wa_jid: z.string().min(5).default('5562999999999@s.whatsapp.net'),
  push_name: z.string().optional(),
  corpo: z.string().min(1),
});

devRouter.post('/simular-mensagem', async (req, res, next) => {
  try {
    const { wa_jid, push_name, corpo } = simularSchema.parse(req.body);
    const orgId = getOrgId(req);
    const r = await ingerirMensagemRecebida({
      orgId,
      waJid: wa_jid,
      pushName: push_name || null,
      corpo,
    });
    res.json({
      ok: true,
      lead: r.lead,
      message_id: r.message.id,
      info: 'Triagem rodando em background — recarregue o painel em ~3s pra ver classificação',
    });
  } catch (err) {
    next(err);
  }
});

devRouter.get('/leads-recentes', async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { query } = await import('../db/connection.js');
    const leads = await query(
      `SELECT id, wa_jid, nome, stage, qualif, score, produto_interesse, last_message_at
       FROM leads WHERE org_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [orgId],
    );
    res.json({ leads });
  } catch (err) {
    next(err);
  }
});
