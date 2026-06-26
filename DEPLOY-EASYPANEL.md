# Deploy CRM no EasyPanel

Tempo: ~10 minutos. Tudo via UI do EasyPanel, sem SSH.

---

## Pré-requisitos
- EasyPanel rodando na VPS ✅
- Conta GitHub ligada ao EasyPanel ✅

---

## Passo 1: Criar projeto
1. EasyPanel → **+ Project** → nome: `crm`
2. Confirma

---

## Passo 2: Service Postgres (banco)
Dentro do projeto **crm**:

1. **+ Service → Database → Postgres**
2. Config:
   - **Service Name:** `crm-db`
   - **Image:** `postgres:16-alpine`
   - **User:** `crm`
   - **Password:** `senha_forte_aqui_troque` (anota — vai usar no Passo 3)
   - **Database:** `crm`
3. **Deploy**

Aguarda ficar verde (~30s).

📍 O banco fica acessível internamente como `crm-db:5432` (hostname do container).

---

## Passo 3: Service da API
Mesmo projeto **crm**:

1. **+ Service → App**
2. Config:
   - **Service Name:** `crm-api`
   - **Source:** GitHub
   - **Owner:** `FRANKLIMPAIXAO`
   - **Repository:** `crm-contador-iafirst`
   - **Branch:** `main`
   - **Build Method:** Dockerfile (auto-detectado)
3. **Environment** — cola:

```env
NODE_ENV=production
PORT=3000

DATABASE_URL=postgresql://crm:senha_forte_aqui_troque@crm-db:5432/crm

JWT_SECRET=GERAR_STRING_ALEATORIA_LONGA_64_CHARS_AQUI_TROQUE
JWT_EXPIRES_IN=7d

ANTHROPIC_API_KEY=sk-ant-COLAR_SUA_KEY_AQUI
ANTHROPIC_MODEL_TRIAGEM=claude-haiku-4-5-20251001
ANTHROPIC_MODEL_RASCUNHO=claude-sonnet-4-5

# Admin inicial — autoseed cria na 1ª subida
ADMIN_EMAIL=franklim@franklimpaixao.com.br
ADMIN_SENHA=TROCAR_SENHA_FORTE
ADMIN_NOME=Franklim Paixão
ORG_NOME=PAC Inteligência Tributária
ORG_SLUG=pac

# Evolution (opcional — preencher quando instalar Evolution na VPS)
EVOLUTION_API_URL=
EVOLUTION_API_KEY=
EVOLUTION_INSTANCE_DEFAULT=pac-vendas
EVOLUTION_WEBHOOK_SECRET=trocar-pra-secret-de-pelo-menos-16-chars

CORS_ORIGIN=https://crm-crm-api.SEU_DOMINIO.easypanel.host
```

⚠️ **Substituir:**
- `senha_forte_aqui_troque` — mesma senha do Passo 2 (Postgres)
- `JWT_SECRET` — string aleatória 64+ chars (gera em https://1password.com/password-generator/)
- `ANTHROPIC_API_KEY` — sua chave (mesma que está na SEXTA-FEIRA)
- `ADMIN_EMAIL` / `ADMIN_SENHA` — seu login admin
- `CORS_ORIGIN` — depois do deploy, ajusta com a URL real

4. **Ports:** `3000` (auto-detectado)
5. **Deploy** → aguarda build (~3-4 min na 1ª vez)

---

## Passo 4: Confirmar funcionamento

Quando status virar verde:

1. EasyPanel mostra a URL pública (algo tipo `https://crm-crm-api.SEU_IP.easypanel.host`)
2. Abre no navegador
3. Tela de login aparece
4. Login com `ADMIN_EMAIL` / `ADMIN_SENHA` que você definiu
5. Dashboard com Kanban vazio

📊 Acompanhar logs: aba **Logs** do service `crm-api`

Procure por:
```
[db] ✅ schema aplicado (auto-migrate)
[db] DB vazio — criando org "..." + admin ...
[db] ✅ admin criado. Login: ...
🚀 CRM API rodando em http://localhost:3000
```

---

## Passo 5: Domínio próprio (opcional)

Quer `crm.franklimpaixao.com.br`?

1. No DNS do seu domínio: cria registro `A`:
   - **Host:** `crm`
   - **Value:** IP da VPS
2. No EasyPanel → service `crm-api` → **Domains** → **+ Add**
   - **Host:** `crm.franklimpaixao.com.br`
   - HTTPS é automático (Let's Encrypt)
3. Aguarda ~1 min e acessa

Não esquece de atualizar `CORS_ORIGIN` no env vars pro novo domínio.

---

## Passo 6 (opcional): Instalar Evolution API

Mesmo projeto **crm**, separadamente:

1. **+ Service → App**
2. **Service Name:** `evolution`
3. **Source:** Docker Image
4. **Image:** `atendai/evolution-api:latest` (ou versão estável)
5. **Environment Evolution** (consulta docs Evolution pra valores):
   ```env
   AUTHENTICATION_API_KEY=string_aleatoria_longa
   DATABASE_ENABLED=true
   DATABASE_CONNECTION_URI=postgresql://crm:senha@crm-db:5432/evolution
   # ... outros conforme docs Evolution
   ```
6. **Volume:** `/evolution/instances` (persiste sessões WhatsApp)
7. **Deploy**

Depois:
- Criar database `evolution` no Postgres (executa `CREATE DATABASE evolution OWNER crm` via Adminer)
- Conectar número WhatsApp (QR code via UI Evolution)
- Atualizar `EVOLUTION_API_URL` no service `crm-api` apontando pro Evolution interno: `http://evolution:8080`
- Configurar webhook na Evolution: `https://crm.franklimpaixao.com.br/webhook/evolution`
- Redeploy `crm-api`

---

## ⚠️ Pontos críticos

1. **Senha do Postgres**: usa a mesma em `crm-db` e no `DATABASE_URL` do `crm-api`. Erro = `ECONNREFUSED` ou `password authentication failed`.

2. **JWT_SECRET**: precisa ter 32+ chars. App não sobe se falhar.

3. **ANTHROPIC_API_KEY**: sem ela, triagem não funciona (lead criado mas qualif fica `frio` permanente).

4. **AUTO_MIGRATE**: roda automático no boot. Pra desligar (manutenção), `AUTO_MIGRATE=false`.

5. **AUTO_SEED**: cria admin só se DB vazio. Pra forçar reset, `DROP DATABASE crm; CREATE DATABASE crm OWNER crm;` via Adminer, redeploy.

---

## 🔄 Atualizações futuras

A cada `git push main`:
- Se ativou **Auto Deploy** no EasyPanel → rebuilds sozinho
- Senão → service `crm-api` → **Redeploy** manual (~2 min)

---

## 🆘 Troubleshooting

| Sintoma | Fix |
|---------|-----|
| "ECONNREFUSED 5432" no log | DATABASE_URL aponta pro nome errado. Usa `crm-db` (nome do service Postgres) |
| "password authentication failed" | Senha diferente entre `crm-db` e `DATABASE_URL` |
| App não sobe + "JWT_SECRET precisa ter pelo menos 32 caracteres" | Aumenta o JWT_SECRET |
| Login não funciona | Confere logs por `[db] ✅ admin criado`. Senão, define ADMIN_EMAIL/SENHA + redeploy |
| Triagem nunca classifica | `ANTHROPIC_API_KEY` faltando ou inválida |
| Webhook Evolution não dispara | URL pública correta? Header `apikey` = `EVOLUTION_WEBHOOK_SECRET`? |

---

## 💰 Custo

Tudo dentro da VPS que você já paga. **R$ 0 adicional.**

APIs externas:
- Anthropic Haiku triagem: ~R$ 15-30/mês (uso real)
- Anthropic Sonnet rascunhos: ~R$ 0 (ainda não usado)

---

**Quando deployar e conseguir login, me avisa pra fazermos teste end-to-end + integração SEXTA (Fase 5).**
