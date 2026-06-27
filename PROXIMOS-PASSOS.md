# CRM Contador IA First — Status + Próximos Passos

**Última atualização:** fim do dia, ANTHROPIC_API_KEY corrigida
**Repo:** https://github.com/FRANKLIMPAIXAO/crm-contador-iafirst (privado)
**URL produção:** https://crm-crm-api.ibm21x.easypanel.host
**Local dev:** `C:\dev\crm-contador-iafirst\` (http://localhost:3000)

---

## ✅ TUDO QUE ESTÁ FUNCIONANDO EM PRODUÇÃO

### Infraestrutura
- [x] Postgres 16 (service `crm-db` no EasyPanel) — persistente, auto-backup
- [x] CRM API Node 20 + TS (service `crm-api`) — HTTPS automático
- [x] Auto-migrate + auto-seed no boot
- [x] JWT auth + admin com senha forte
- [x] Multi-tenant via middleware (`org_id` do JWT)

### Frontend (painel)
- [x] Login com JWT
- [x] Dashboard Kanban 6 colunas (Novo/Qualificado/Proposta/Negociação/Fechado/Perdido)
- [x] Drag-and-drop entre colunas → persiste via PATCH
- [x] Busca client-side (nome/jid/cnpj/produto)
- [x] 8 filtros chips (todos/quente/morno/frio + 4 produtos)
- [x] Métricas no topo (total, novos, qualificados, proposta, fechados, quentes)
- [x] Modal "+ Novo lead" — criação manual
- [x] Modal "🧪 Simular" — gera lead fake pra testar IA (admin only)
- [x] Drawer lateral com detalhe do lead
- [x] Edição inline (stage/qualif/valor) com debounce
- [x] Histórico de mensagens estilo chat
- [x] Triagem IA mostrada (intenção + resumo + sugestão)
- [x] Botão "✨ Usar sugestão IA" preenche textarea
- [x] **Botão "📤 Enviar" — envia WhatsApp via Evolution** ✅

### IA e integrações
- [x] Triagem Haiku 4.5 automática (produto + qualif + score + sugestão)
- [x] **WhatsApp REAL conectado via Evolution API** (instance `FP_CRM`)
- [x] Webhook Evolution recebe mensagens entrando
- [x] Status de mensagem: enviado → entregue → lido
- [x] SEXTA-FEIRA recebe alerta de lead quente via webhook
- [x] Telegram da SEXTA bipa com mensagem rica (nome, produto, score, sugestão, link CRM)

### Endpoints prontos
- `GET /health` — liveness
- `GET /ready` — readiness (banco respondendo)
- `POST /api/auth/login` — login admin
- `GET /api/auth/me` — perfil
- `GET /api/leads` — lista
- `POST /api/leads` — criar manual
- `GET /api/leads/:id` — detalhe + mensagens + activities
- `PATCH /api/leads/:id` — atualizar campos
- `GET /api/messages/lead/:leadId` — histórico
- `POST /api/messages/lead/:leadId` — envia mensagem WhatsApp
- `POST /webhook/evolution` — recebe MESSAGES_UPSERT + MESSAGES_UPDATE
- `POST /api/dev/simular-mensagem` — simula mensagem (admin only)

---

## 🔑 Credenciais e infra (atualizado)

### Evolution API (WhatsApp)
```
URL:       https://evo.pacnobolso.com.br
Instance:  FP_CRM
API Key:   5EEC00869B8A-4A5D-BD7A-8CC45FB0B409 (rotacionar quando puder)
Manager:   https://evo.pacnobolso.com.br/manager/instance/059155f9-cc56-452c-b252-5a7e5bf2295a/dashboard
Webhook:   https://crm-crm-api.ibm21x.easypanel.host/webhook/evolution (configurado)
Status:    🟢 conectado (state=open)
Número:    do Franklim (pessoal/comercial)
```

### CRM env vars no EasyPanel (service crm-api)
```
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://crm:***@crm-db:5432/crm
JWT_SECRET=*** (rotacionada)
JWT_EXPIRES_IN=7d
ANTHROPIC_API_KEY=sk-ant-api03-E5IBn... ✅ FUNCIONANDO
ANTHROPIC_MODEL_TRIAGEM=claude-haiku-4-5-20251001
ANTHROPIC_MODEL_RASCUNHO=claude-sonnet-4-5
ADMIN_EMAIL=franklim.contador@pactributaria.com.br
ADMIN_SENHA=*** (rotacionada)
EVOLUTION_API_URL=https://evo.pacnobolso.com.br
EVOLUTION_API_KEY=5EEC00869B8A-4A5D-BD7A-8CC45FB0B409
EVOLUTION_INSTANCE_DEFAULT=FP_CRM
EVOLUTION_WEBHOOK_SECRET=5EEC00869B8A-4A5D-BD7A-8CC45FB0B409
SEXTA_WEBHOOK_URL=https://sexta-feira-sexta-feira.ibm21x.easypanel.host/api/webhook/crm-lead
SEXTA_WEBHOOK_SECRET=*** (mesma da SEXTA)
CORS_ORIGIN=https://crm-crm-api.ibm21x.easypanel.host
```

### SEXTA env vars (service sexta-feira-sexta-feira)
```
CRM_WEBHOOK_SECRET=*** (mesma do CRM)
+ todas as outras existentes (Telegram, Google, etc)
```

---

## 🎯 PENDÊNCIA PRINCIPAL (amanhã)

### "Bot respondendo" — preciso clarificar escopo

3 interpretações possíveis pra discutir amanhã:

#### Opção A: Resposta automática total (zero intervenção)
- Lead manda WhatsApp → IA classifica → IA gera resposta → envia automático
- ⚠️ **Risco:** sem revisão humana, IA pode mandar besteira pro lead
- ⚠️ **Risco:** Meta pode interpretar como bot e banir
- ✅ Bom pra: respostas básicas (preço, prazo, dúvidas frequentes)
- **Tempo:** 1-2h código

#### Opção B: Resposta semi-automática com aprovação no Telegram (RECOMENDADO)
- Lead manda WhatsApp → CRM triagem → SEXTA bipa Telegram com:
  ```
  🔥 Lead quente
  [resposta IA sugerida]
  [✅ Aprovar e enviar] [✏️ Editar] [❌ Ignorar]
  ```
- Você clica ✅ no Telegram → resposta vai pro WhatsApp do lead
- ✅ Você revisa antes de qualquer mensagem ir
- ✅ Reduz risco de ban (parece humano)
- ✅ Você opera tudo pelo celular sem abrir CRM
- **Tempo:** 2-3h código

#### Opção C: Resposta inicial automática + qualificação humana
- 1ª mensagem do lead → resposta automática genérica ("recebi, em breve te respondo")
- Próximas → você assume manualmente pelo CRM
- ⚠️ Resposta inicial só pra não deixar lead sem retorno
- **Tempo:** 30min código

**Minha recomendação:** Opção B. Combina segurança + agilidade.

---

## 🚀 Outras pendências (futuro)

### Curto prazo (1-2h cada)
- [ ] Bot respondendo (ver acima)
- [ ] Renomear instância Evolution (sair de `pac_bot ` antiga travada)
- [ ] **Rotacionar credenciais expostas neste chat:**
  - ANTHROPIC_API_KEY (já trocou)
  - EVOLUTION_API_KEY (`5EEC00869B8A...`)
  - JWT_SECRET (já trocou)
  - ADMIN_SENHA (já trocou)

### Médio prazo
- [ ] WebSocket realtime no CRM (substituir polling 8s)
- [ ] Domínio próprio `crm.franklimpaixao.com.br`
- [ ] Importar contatos antigos (CSV → leads)
- [ ] Métricas avançadas (gráficos, conversão, tempo médio)
- [ ] Notas/comentários no lead
- [ ] Lembretes/follow-up automático ("ligar daqui 3 dias")

### Longo prazo
- [ ] Multi-closer (quando contratar comercial)
- [ ] Migrar pra Z-API oficial (R$ 90-150/mês) se Meta banir
- [ ] Virar SaaS (signup público + billing)

---

## 🔥 Quando voltar amanhã

### Sequência sugerida:

1. **Confere se tudo continua de pé** (1 min):
   ```bash
   curl https://crm-crm-api.ibm21x.easypanel.host/health
   # esperado: {"ok":true,"service":"crm-api",...}
   ```

2. **Manda WhatsApp teste pro teu número** (de outro celular):
   - Tipo: *"Oi, vi seu reels sobre IA pra contador, quero entrar no Contador IA First"*
   - Em ~5s: lead aparece no CRM classificado
   - 🔥 Telegram bipa com alerta

3. **Me chama:** *"voltei, quero o bot respondendo (Opção B / B / C)"*

4. **Eu codo** a opção escolhida, push, redeploy → testa

---

## 🆘 Troubleshooting comum

### "Telegram não bipa quando lead chega"
1. Verifica logs do `crm-api`: deve aparecer `[sexta-notify] ✅`
2. Se aparecer `[triagem] falhou: 401` → key Anthropic inválida
3. Se aparecer `[triagem] sucesso` mas sem `sexta-notify` → SEXTA_WEBHOOK_URL faltando
4. Se aparecer `[sexta-notify]` mas Telegram sem msg → secret diferente entre CRM e SEXTA

### "WhatsApp não chega no CRM"
1. Verifica status Evolution: GET `/instance/connectionState/FP_CRM` deve retornar `open`
2. Se `close` → escaneou QR de novo
3. Se `connecting` → aguarda ou recria instância
4. Verifica webhook configurado: GET `/webhook/find/FP_CRM`

### "Lead aparece mas não classifica"
- Sempre key Anthropic. Tenta key direto no container:
  ```bash
  curl -X POST https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":50,"messages":[{"role":"user","content":"oi"}]}'
  ```
- Se 401 = key inválida, gera nova em console.anthropic.com

### "Botão Simular dá rota não encontrada"
- User precisa ser admin
- Faz logout/login pra atualizar JWT

---

## 📁 Estrutura do projeto

```
C:\dev\crm-contador-iafirst\
├── package.json
├── tsconfig.json
├── Dockerfile (multi-stage + tzdata Brasil)
├── docker-compose.yml (dev local)
├── .env (gitignored)
├── .env.example
├── README.md
├── DEPLOY-EASYPANEL.md
├── PROXIMOS-PASSOS.md (este arquivo)
├── public/
│   └── index.html (painel completo)
└── src/
    ├── server.ts
    ├── config.ts
    ├── db/
    │   ├── connection.ts (pool + autoMigrate + autoSeed)
    │   ├── schema.sql
    │   ├── migrate.ts
    │   └── seed.ts
    ├── auth/
    │   ├── hash.ts (bcrypt)
    │   └── jwt.ts
    ├── middleware/
    │   ├── auth.ts (requerAuth + requerPapel)
    │   ├── tenant.ts (getOrgId/getUserId)
    │   └── error.ts (global handler)
    ├── routes/
    │   ├── auth.ts
    │   ├── leads.ts (GET/POST/PATCH)
    │   ├── messages.ts (GET + POST envio Evolution)
    │   ├── webhook.ts (Evolution incoming)
    │   └── dev.ts (admin-only simular)
    └── services/
        ├── anthropic.ts (client lazy + sanitiza key)
        ├── triagem.ts (Haiku classifica + dispara notify)
        ├── ingestao.ts (upsert lead + msg + triagem async)
        ├── evolution.ts (sendText via API)
        └── sexta-notify.ts (POST webhook SEXTA)
```

---

## 💰 Custo mensal estimado (atualizado)

| Item | R$/mês |
|------|--------|
| VPS Hostinger (já pago) | — |
| Postgres na VPS | R$ 0 |
| Evolution API self-hosted | R$ 0 |
| Anthropic Haiku triagem (volume real estimado) | ~R$ 20-50 |
| Anthropic Sonnet rascunhos (se ativar) | ~R$ 30-80 |
| OpenAI TTS (SEXTA) | ~R$ 10-30 |
| **Total APIs** | **~R$ 60-160/mês** |

---

## 🎉 Conquistas dessa sessão

1. ✅ Construído CRM do zero (TS + Express + Postgres + JWT)
2. ✅ Frontend painel completo sem build (HTML + Tailwind CDN)
3. ✅ Triagem IA classificando leads automaticamente
4. ✅ Deploy EasyPanel funcionando 24/7
5. ✅ Integração CRM ↔ SEXTA (webhook reverso)
6. ✅ **Evolution API conectada com WhatsApp REAL**
7. ✅ Webhook Evolution funcionando (recebe mensagens reais)
8. ✅ Tudo versionado no GitHub
9. ✅ ~25 commits em sequência

**Faltam ~3-5h pra ter operação comercial 100% automatizada.**

---

**Quando voltar amanhã, me chama com "voltei pro CRM, opção X" (referente ao "bot respondendo").** 🚀
