# CRM Contador IA First — Estado atual e próximos passos

**Última atualização:** quando você parou pra ir em outro projeto
**Repo GitHub:** https://github.com/FRANKLIMPAIXAO/crm-contador-iafirst (privado)
**Local:** `C:\dev\crm-contador-iafirst\`
**Rodando em:** http://localhost:3000

---

## ✅ O que JÁ funciona

### Backend (Fase 0 + Fase 1 completas)
- [x] **Stack:** Node 20 + TypeScript + Express + Postgres 16 + JWT
- [x] **Auth:** login com bcrypt + JWT (Bearer token)
- [x] **Multi-tenant:** middleware injeta `org_id` do JWT em todas as queries
- [x] **Schema completo:** orgs, users, instances, leads, messages, activities + 6 enums + triggers
- [x] **Webhook Evolution** funcional (valida secret, parsing, fromMe filter)
- [x] **Triagem IA Haiku** automática (classifica produto/qualif/score/sugestão)
- [x] **Endpoint dev** `/api/dev/simular-mensagem` (testar sem WhatsApp real)
- [x] **CRUD básico leads** (GET, GET/:id, PATCH)
- [x] **Postgres** rodando como serviço Windows

### Frontend (HTML/Tailwind via CDN — sem build)
- [x] Tela login com auto-preenchimento
- [x] Dashboard com 6 métricas
- [x] **Kanban pipeline** 5 colunas
- [x] **Cards clicáveis** mostrando nome + produto + score + qualif
- [x] **Drawer lateral** com detalhe completo (triagem IA + histórico)
- [x] **Modal "Simular lead"** pra testar fluxo sem Evolution
- [x] Auto-refresh a cada 8s
- [x] Visual dark moderno (zinc-950 + lime-400)

### Testes feitos
- "Roberto Carvalho" → triagem: familia / quente / score 88 ✅
- "Juliana Ferraz" → triagem: iafirst / quente / score 88 ✅

---

## ⏳ Próximas fases

### 🎯 Fase 2 — Painel React real (Vite)
- React + Vite + Tailwind
- Drag-and-drop entre colunas
- Busca/filtros
- Edição inline
- **Tempo:** 3-4h

### 🎯 Fase 3 — Envio WhatsApp (mais importante)
- Botão "Responder" no drawer
- Aceita sugestão IA ou edita
- Envia via Evolution
- Status: enviado → entregue → lido
- **Pré-requisito:** Evolution rodando
- **Tempo:** 2-3h

### 🎯 Fase 4 — WebSocket realtime
- Painel atualiza sem refresh
- **Tempo:** 2h

### 🎯 Fase 5 — Integração SEXTA-FEIRA
- Tools pra SEXTA consultar/operar CRM
- Alertas Telegram quando lead esquentar
- **Tempo:** 2-3h

### 🎯 Fase 6 — Deploy EasyPanel
- Postgres + crm-api + evolution-api containers
- HTTPS automático
- **Tempo:** 1-2h

---

## 🔑 Credenciais

### Postgres local
```
Host: localhost:5432
User: crm / crmpass / db: crm
Superuser: postgres / crmpass
```

### Admin CRM
```
Email: franklim@x.com
Senha: trocar123
```

### Falta configurar
- ❌ `EVOLUTION_API_URL` e `EVOLUTION_API_KEY`
- ❌ `SEXTA_API_TOKEN` (Fase 5)

---

## 🛠️ Comandos úteis

### Reiniciar servidor
```powershell
Get-Process node | Stop-Process -Force
cd C:\dev\crm-contador-iafirst
npm run dev
```

### Ver logs
```powershell
Get-Content C:\dev\crm-contador-iafirst\crm.log -Wait -Tail 20
```

### Backup banco
```powershell
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -U crm -h localhost crm > backup-$(Get-Date -Format yyyyMMdd).sql
```

### Resetar banco
```powershell
$env:PGPASSWORD = "crmpass"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost -c "DROP DATABASE crm; CREATE DATABASE crm OWNER crm;"
cd C:\dev\crm-contador-iafirst
npm run db:migrate
$env:ADMIN_EMAIL="franklim@x.com"; $env:ADMIN_SENHA="trocar123"; $env:ADMIN_NOME="Franklim Paixao"; $env:ORG_NOME="PAC"; $env:ORG_SLUG="pac"; npx tsx src/db/seed.ts
```

---

## 🧪 Testar fluxo IA agora

1. http://localhost:3000 → login → ENTRAR
2. **🧪 Simular lead** no header
3. Cola mensagem:
   - **Família:** "100 clientes SN, quero entender Família TributárIA"
   - **IA First:** "Vi seu reels, quero entrar no Contador IA First"
   - **PACSERVICE:** "Preciso de sistema de NFS-e"
   - **ContaChat:** "Como funciona ContaChat?"
4. ENVIAR → ~5s lead triado no Kanban
5. Clica no card → drawer com triagem

---

## 📁 Estrutura

```
C:\dev\crm-contador-iafirst\
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── .env (gitignored)
├── public/index.html
└── src/
    ├── server.ts
    ├── config.ts
    ├── db/ (connection, schema.sql, migrate, seed)
    ├── auth/ (hash, jwt)
    ├── middleware/ (auth, tenant, error)
    ├── routes/ (auth, leads, messages, webhook, dev)
    └── services/ (anthropic, triagem, ingestao)
```

---

## 💰 Custo mensal estimado

| Item | Custo |
|------|-------|
| Postgres local | R$ 0 |
| Anthropic Haiku | ~R$ 15-25 |
| Anthropic Sonnet (futuro) | ~R$ 30-50 |
| Evolution self-hosted | R$ 0 |
| **Total** | **~R$ 45-75/mês** |

---

## 🔥 Quando voltar

1. Confere Postgres: `Get-Service postgresql*` → "Running"
2. Confere API: `curl http://localhost:3000/health` → `{ok:true}`
3. Me chama: "voltei pro CRM, vamos pra Fase X"

---

## 🆘 Troubleshooting

| Erro | Fix |
|------|-----|
| `ECONNREFUSED 5432` | `Start-Service postgresql-x64-16` |
| `401 invalid x-api-key` | Atualiza `ANTHROPIC_API_KEY` no `.env` + restart |
| Token JWT inválido | Logout + login |
| Porta 3000 ocupada | `Get-NetTCPConnection -LocalPort 3000`, kill PID |
| Triagem demora | Espera 5-10s, recarrega |

---

**Quando voltar, me chama. Continuamos.**
