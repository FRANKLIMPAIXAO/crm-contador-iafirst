# Fase 7.4 — Integração Asaas (PIX + Cobrança Recorrente + NFS-e)

> Decisão: **trocamos Banco Inter por Asaas** por simplicidade operacional e por o Asaas emitir NFS-e nativo (dispensa Focus NFE separado).
> Data da decisão: 2026-07-27

---

## Por que Asaas em vez de Inter

| Aspecto | Banco Inter | **Asaas** |
|---|---|---|
| Setup | mTLS + certificado .crt/.key + OAuth2 | Só uma API key |
| PIX dinâmico | ✅ | ✅ |
| Boleto | ✅ | ✅ |
| Cartão recorrente | ❌ | ✅ (mentoria mensal automática) |
| Link de pagamento | ❌ | ✅ (PIX/boleto/cartão em 1 link) |
| Cobrança recorrente nativa | Cron manual | ✅ Asaas gera sozinho todo mês |
| Webhook confirmação | ✅ | ✅ |
| NFS-e integrada | ❌ | ✅ (dispensa Focus NFE) |
| Split de pagamento | ❌ | ✅ |
| Régua de cobrança automática | Custom | ✅ Nativa (D-5, D0, D+3) |
| Sandbox | Meio ruim | ✅ Excelente |
| Custo PIX | Grátis até limite | ~R$ 1,99 por PIX recebido |

**Trade-off aceito:** taxa por transação (~R$ 20/mês em volume 1-10 alunos) vs horas de código e dor de mTLS.

---

## Credenciais necessárias

```env
# .env (dev e produção)
ASAAS_API_KEY=              # painel Asaas → Integrações → API
ASAAS_ENV=sandbox           # começa "sandbox", muda pra "producao" após homologação
ASAAS_WEBHOOK_TOKEN=        # string secreta que você define pra validar webhook
ASAAS_BASE_URL_SANDBOX=https://sandbox.asaas.com/api/v3
ASAAS_BASE_URL_PROD=https://api.asaas.com/v3
```

---

## Escopo da Fase 7.4-7.7 (a executar quando chegar API key)

### 7.4 — Cliente Asaas + criação de cobrança PIX
- `src/services/asaas.ts` — HTTP client autenticado (header `access_token`)
- `criarCobrancaPix(matricula)` — cria charge no Asaas retornando `id`, `invoiceUrl`, QR code, copia-cola
- Persiste no CRM: `cobrancas.pix_qrcode`, `pix_copia_cola`, `pix_txid`, `asaas_charge_id`

### 7.5 — Cobrança recorrente nativa (dispensa cron caseiro)
- Usa endpoint `POST /subscriptions` do Asaas em vez de criar 1 cobrança por mês manualmente
- Asaas gera automaticamente uma cobrança nova a cada ciclo (mensal, no `dia_vencimento`)
- Ainda mantém cron leve pra: enviar WhatsApp com link do PIX, atualizar status local

### 7.6 — Webhook `/webhook/asaas`
- Recebe eventos: `PAYMENT_CREATED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`
- Valida `access_token` header contra `ASAAS_WEBHOOK_TOKEN`
- Ao receber `PAYMENT_RECEIVED`: marca `cobrancas.status='paga'`, cria `pagamento`, dispara emissão NFS-e, notifica Telegram via SEXTA

### 7.7 — NFS-e nativa Asaas
- Ativa módulo NFS-e no painel Asaas (configura CNPJ + IM + código serviço)
- Endpoint Asaas: `POST /invoices` vinculado ao `payment_id`
- Recebe webhook `INVOICE_AUTHORIZED` → salva `nfse_link_pdf`, `nfse_numero`, envia PDF pro WhatsApp do aluno

### 7.8 — UI Financeiro
- Lista cobranças com filtros (status, mês, aluno)
- Botão "ver link PIX" (abre `invoiceUrl` do Asaas)
- Botão "marcar pago manual" (fallback)
- Botão "reenviar link ao aluno" via Evolution WhatsApp

---

## Perguntas em aberto (responder antes de codar)

1. **NFS-e no Asaas ou Focus NFE separado?** — Recomendação: NFS-e Asaas (menos pontos de falha)
2. **PIX puro (QR code) ou link de pagamento** (aluno escolhe PIX/boleto/cartão)? — Recomendação: link (conversão maior)
3. **Régua de cobrança do Asaas ou manter mensagens custom via SEXTA?** — Recomendação: híbrido — Asaas manda email/SMS, SEXTA manda WhatsApp com contexto humano

---

## Fluxo end-to-end desejado

```
[Contador cadastra aluno + matrícula no painel CRM]
        ↓
[CRM cria customer + subscription no Asaas]
        ↓
[Asaas gera cobrança todo dia X do mês automaticamente]
        ↓
[Webhook CRM salva cobrança local + Evolution envia link WhatsApp]
        ↓
[Aluno paga via link (PIX/boleto/cartão)]
        ↓
[Asaas webhook PAYMENT_RECEIVED → CRM marca paga]
        ↓
[Asaas emite NFS-e automaticamente]
        ↓
[Webhook INVOICE_AUTHORIZED → CRM envia PDF pro WhatsApp aluno]
        ↓
[SEXTA notifica Telegram do contador: "R$ 360 recebido de LEANDRO, NFS-e emitida"]
```

---

## Próximos passos

1. Franklim cria conta Asaas (ou usa existente) e gera API key sandbox
2. Franklim ativa módulo NFS-e no painel Asaas (CNPJ, IM, código serviço Aparecida de Goiânia)
3. Franklim traz `ASAAS_API_KEY` sandbox → sessão codar 7.4-7.8 completo
4. Testar em sandbox com 1 cobrança fake
5. Migrar para produção (trocar `ASAAS_ENV=producao` + nova API key prod)

**Sessão pausada em:** 2026-07-27, aguardando `ASAAS_API_KEY`.
