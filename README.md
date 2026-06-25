# CRM Contador IA First

CRM de vendas das mentorias (Família TributárIA, Contador IA First) e sistemas (PACSERVICE, ContaChat) do Franklim Paixão.

**Stack:** Node 20 + TypeScript + Express + Postgres 16 + JWT — tudo self-hosted na VPS.

**Princípio:** WhatsApp é a entrada e saída, Postgres é a verdade, painel só reflete.

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────┐
│                  VPS + EasyPanel                    │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  │
│  │ CRM Backend  │  │ CRM Frontend │  │ Postgres │  │
│  │ Node+TS+Exp  │←→│  Vite+React  │  │   16     │  │
│  │  (este repo) │  │              │  └──────────┘  │
│  └──────────────┘  └──────────────┘                 │
│         ↑                                           │
│         ├───────── REST API + WebSocket             │
│         │                                           │
│  ┌──────────────┐         ┌──────────────┐         │
│  │ Evolution API│         │ SEXTA-FEIRA  │         │
│  │  (WhatsApp)  │────────→│  (assistant) │         │
│  └──────────────┘         └──────────────┘         │
└─────────────────────────────────────────────────────┘
```

## 🚀 Setup local

### Pré-requisitos
- Node 20+
- Docker + Docker Compose (pra Postgres local)

### 1. Clone + deps
```bash
git clone https://github.com/FRANKLIMPAIXAO/crm-contador-iafirst.git
cd crm-contador-iafirst
npm install
```

### 2. Configurar env
```bash
cp .env.example .env
# edita .env com chaves reais
```

### 3. Subir Postgres + Adminer
```bash
docker compose up -d postgres adminer
# Postgres: localhost:5432 (user: crm, pass: crmpass, db: crm)
# Adminer (GUI banco): http://localhost:8080
```

### 4. Migration + seed
```bash
npm run db:migrate
ADMIN_EMAIL=franklim@x.com ADMIN_SENHA=trocar123 ADMIN_NOME="Franklim Paixão" ORG_NOME=PAC ORG_SLUG=pac npx tsx src/db/seed.ts
```

### 5. Dev server
```bash
npm run dev
# http://localhost:3000/health → {"ok":true}
```

### 6. Testar login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"franklim@x.com","senha":"trocar123"}'
```

## 📋 Comandos

| Comando | O que faz |
|---------|-----------|
| `npm run dev` | Servidor TSX com watch |
| `npm run build` | Compila TS → dist/ |
| `npm start` | Roda dist/ (produção) |
| `npm run db:migrate` | Aplica src/db/schema.sql |
| `npm run typecheck` | Type-check sem build |

## 🗂️ Estrutura

```
src/
  server.ts            → bootstrap Express
  config.ts            → env validado com Zod
  db/
    connection.ts      → pool Postgres + helpers tipados
    schema.sql         → esquema completo
    migrate.ts         → executa schema.sql
    seed.ts            → cria org + admin inicial
  auth/
    hash.ts            → bcrypt wrapper
    jwt.ts             → sign/verify JWT
  middleware/
    auth.ts            → req.user via Bearer token
    tenant.ts          → helpers getOrgId/getUserId
    error.ts           → handler global
  routes/
    auth.ts            → POST /login, GET /me
    leads.ts           → placeholder Fase 1
    messages.ts        → placeholder Fase 1
    webhook.ts         → placeholder Fase 1 (Evolution)
```

## 🗃️ Modelo de dados

| Tabela | Função |
|--------|--------|
| `orgs` | Inquilinos (multi-tenant) |
| `users` | Login do painel (com `org_id`) |
| `instances` | Configuração WhatsApp Evolution |
| `leads` | Prospects (centrados em `wa_jid`) |
| `messages` | Histórico de conversas |
| `activities` | Notas, mudanças de stage, triagens IA |

**Isolamento por `org_id`** é garantido por middleware (helper `getOrgId(req)` extrai do JWT — nunca do body/query).

## 🚢 Deploy EasyPanel

1. EasyPanel → **+ Service → App**
2. Source: GitHub `FRANKLIMPAIXAO/crm-contador-iafirst`
3. Build: Dockerfile (auto-detectado)
4. Env: cola tudo do `.env.example` com valores reais
5. Port: 3000

Criar separadamente:
- Postgres como service (EasyPanel: + Service → Database → Postgres 16)
- (futuro) Frontend como service separado

## 🛣️ Roadmap

- [x] **Fase 0:** esqueleto + auth + schema ← VOCÊ ESTÁ AQUI
- [ ] **Fase 1:** webhook Evolution + triagem Haiku + storage messages
- [ ] **Fase 2:** painel Vite+React (Kanban + chat)
- [ ] **Fase 3:** endpoint envio + integração SEXTA-FEIRA
- [ ] **Fase 4:** WebSocket realtime
- [ ] **Fase 5:** alertas inteligentes via Telegram

## 🔐 Segurança

- `EVOLUTION_API_KEY` e `JWT_SECRET` só vivem no backend (nunca no front)
- Webhook valida `WEBHOOK_SECRET` no header `apikey`
- bcrypt 12 rounds pra senhas
- Multi-tenant via middleware: queries SEMPRE filtram `org_id` do JWT
- HTTPS obrigatório em produção (EasyPanel oferece grátis)

## 📝 Licença

Uso interno — Franklim Paixão.
