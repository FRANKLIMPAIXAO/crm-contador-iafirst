-- ============================================================
-- CRM Contador IA First — Schema
-- Postgres 16+
-- ============================================================
-- Estratégia:
--   * Multi-tenant por org_id em TODAS as tabelas de domínio
--   * Isolamento garantido por middleware (não RLS — sem Supabase)
--   * Toda PK é uuid (gen_random_uuid)
--   * updated_at auto via trigger
--   * Lead nasce no wa_jid (prospect), CNPJ vem só na qualificação
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================
DO $$ BEGIN
  CREATE TYPE produto_interesse AS ENUM ('familia','iafirst','pacservice','contachat','indefinido');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE lead_stage AS ENUM ('novo','qualificado','proposta','negociacao','fechado','perdido');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE msg_direcao AS ENUM ('in','out');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE msg_status AS ENUM ('received','sent','delivered','read','failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE qualificacao AS ENUM ('frio','morno','quente');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE user_papel AS ENUM ('admin','closer','viewer');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ============================================================
-- TRIGGER GENÉRICO updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ORGS — inquilinos
-- ============================================================
CREATE TABLE IF NOT EXISTS orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_orgs_updated ON orgs;
CREATE TRIGGER trg_orgs_updated BEFORE UPDATE ON orgs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- USERS — login do painel
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email           text UNIQUE NOT NULL,
  senha_hash      text NOT NULL,
  nome            text NOT NULL,
  papel           user_papel NOT NULL DEFAULT 'closer',
  ativo           boolean NOT NULL DEFAULT true,
  ultimo_acesso   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- INSTANCES — Evolution WhatsApp
-- ============================================================
CREATE TABLE IF NOT EXISTS instances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  numero      text,
  status      text NOT NULL DEFAULT 'desconhecido',
  qrcode      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, nome)
);
CREATE INDEX IF NOT EXISTS idx_instances_org ON instances(org_id);
DROP TRIGGER IF EXISTS trg_instances_updated ON instances;
CREATE TRIGGER trg_instances_updated BEFORE UPDATE ON instances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- LEADS — prospects (centrados em wa_jid)
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  wa_jid              text NOT NULL,
  nome                text,
  produto_interesse   produto_interesse DEFAULT 'indefinido',
  stage               lead_stage NOT NULL DEFAULT 'novo',
  valor               numeric(12,2) DEFAULT 0,
  origem              text,
  score               int DEFAULT 0,
  qualif              qualificacao DEFAULT 'frio',
  tags                text[] DEFAULT '{}',
  cnpj                text,
  consent             boolean NOT NULL DEFAULT false,
  consent_at          timestamptz,
  assigned_to         uuid REFERENCES users(id) ON DELETE SET NULL,
  last_message_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, wa_jid)
);
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(org_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(org_id, stage);
CREATE INDEX IF NOT EXISTS idx_leads_qualif ON leads(org_id, qualif);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(org_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_last_msg ON leads(org_id, last_message_at DESC NULLS LAST);
DROP TRIGGER IF EXISTS trg_leads_updated ON leads;
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- MESSAGES — histórico de conversas
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direcao         msg_direcao NOT NULL,
  corpo           text,
  wa_message_id   text,
  status          msg_status NOT NULL DEFAULT 'received',
  ts              timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL;

-- ============================================================
-- ACTIVITIES — notas, mudanças, triagens IA
-- ============================================================
CREATE TABLE IF NOT EXISTS activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id     uuid REFERENCES leads(id) ON DELETE CASCADE,
  tipo        text NOT NULL,
  conteudo    jsonb,
  autor       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_org ON activities(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_tipo ON activities(org_id, tipo);

-- ============================================================
-- MÓDULO MENTORADOS (Fase 7) — alunos pagantes recorrentes
-- ============================================================
DO $$ BEGIN
  CREATE TYPE frequencia_cobranca AS ENUM ('mensal','trimestral','semestral','anual');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE aluno_status AS ENUM ('ativo','inadimplente','pausado','cancelado');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE matricula_status AS ENUM ('ativa','pausada','cancelada','concluida');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE cobranca_status AS ENUM ('aberta','paga','atrasada','cancelada');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE pagamento_metodo AS ENUM ('pix','boleto','dinheiro','cartao','outro');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- MENTORIAS — catálogo de produtos
CREATE TABLE IF NOT EXISTS mentorias (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  nome            text NOT NULL,
  descricao       text,
  valor_padrao    numeric(12,2) NOT NULL DEFAULT 0,
  frequencia      frequencia_cobranca NOT NULL DEFAULT 'mensal',
  ativa           boolean NOT NULL DEFAULT true,
  cor             text,                 -- hex pra UI ex: '#84cc16'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mentorias_org ON mentorias(org_id);
DROP TRIGGER IF EXISTS trg_mentorias_updated ON mentorias;
CREATE TRIGGER trg_mentorias_updated BEFORE UPDATE ON mentorias FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ALUNOS — mentorados ativos (separado de leads)
CREATE TABLE IF NOT EXISTS alunos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,  -- se veio de lead
  nome            text NOT NULL,
  whatsapp        text,
  email           text,
  cpf_cnpj        text,
  endereco_jsonb  jsonb,                -- {rua, numero, bairro, cidade, uf, cep}
  status          aluno_status NOT NULL DEFAULT 'ativo',
  notas           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alunos_org ON alunos(org_id);
CREATE INDEX IF NOT EXISTS idx_alunos_status ON alunos(org_id, status);
CREATE INDEX IF NOT EXISTS idx_alunos_whatsapp ON alunos(whatsapp) WHERE whatsapp IS NOT NULL;
DROP TRIGGER IF EXISTS trg_alunos_updated ON alunos;
CREATE TRIGGER trg_alunos_updated BEFORE UPDATE ON alunos FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- MATRÍCULAS — aluno × mentoria com valor e ciclo de cobrança próprios
CREATE TABLE IF NOT EXISTS matriculas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  aluno_id        uuid NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  mentoria_id     uuid NOT NULL REFERENCES mentorias(id) ON DELETE RESTRICT,
  valor           numeric(12,2) NOT NULL,
  dia_vencimento  int NOT NULL CHECK (dia_vencimento BETWEEN 1 AND 28),
  data_inicio     date NOT NULL DEFAULT CURRENT_DATE,
  data_fim        date,                 -- NULL = recorrente sem fim
  status          matricula_status NOT NULL DEFAULT 'ativa',
  notas           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_matriculas_org ON matriculas(org_id);
CREATE INDEX IF NOT EXISTS idx_matriculas_aluno ON matriculas(aluno_id);
CREATE INDEX IF NOT EXISTS idx_matriculas_ativas ON matriculas(org_id, status) WHERE status = 'ativa';
DROP TRIGGER IF EXISTS trg_matriculas_updated ON matriculas;
CREATE TRIGGER trg_matriculas_updated BEFORE UPDATE ON matriculas FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- COBRANÇAS — geradas mensalmente pra cada matrícula
CREATE TABLE IF NOT EXISTS cobrancas (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  matricula_id        uuid NOT NULL REFERENCES matriculas(id) ON DELETE CASCADE,
  mes_referencia      text NOT NULL,    -- 'YYYY-MM'
  valor               numeric(12,2) NOT NULL,
  data_vencimento     date NOT NULL,
  status              cobranca_status NOT NULL DEFAULT 'aberta',
  -- PIX (Inter API ou manual)
  pix_qrcode          text,             -- base64 da imagem
  pix_copia_cola      text,             -- string PIX
  pix_txid            text,             -- TXID do Inter
  pix_e2eid           text,             -- end-to-end ID do pagamento
  -- Notificações
  notif_5d_enviada    boolean DEFAULT false,
  notif_vencimento    boolean DEFAULT false,
  notif_atraso        boolean DEFAULT false,
  -- Pagamento
  pago_em             timestamptz,
  comprovante_url     text,
  -- NFS-e (Focus NFE)
  nfse_emitida        boolean DEFAULT false,
  nfse_ref            text,             -- referência única na Focus NFE
  nfse_numero         text,
  nfse_link_pdf       text,
  nfse_xml            text,
  nfse_erro           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matricula_id, mes_referencia)
);
CREATE INDEX IF NOT EXISTS idx_cobrancas_org ON cobrancas(org_id);
CREATE INDEX IF NOT EXISTS idx_cobrancas_matricula ON cobrancas(matricula_id);
CREATE INDEX IF NOT EXISTS idx_cobrancas_status ON cobrancas(org_id, status);
CREATE INDEX IF NOT EXISTS idx_cobrancas_venc ON cobrancas(org_id, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_cobrancas_pix_txid ON cobrancas(pix_txid) WHERE pix_txid IS NOT NULL;
DROP TRIGGER IF EXISTS trg_cobrancas_updated ON cobrancas;
CREATE TRIGGER trg_cobrancas_updated BEFORE UPDATE ON cobrancas FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- PAGAMENTOS — registro de cada movimento financeiro confirmado
CREATE TABLE IF NOT EXISTS pagamentos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  cobranca_id     uuid REFERENCES cobrancas(id) ON DELETE SET NULL,
  aluno_id        uuid REFERENCES alunos(id) ON DELETE SET NULL,
  valor           numeric(12,2) NOT NULL,
  metodo          pagamento_metodo NOT NULL DEFAULT 'pix',
  pago_em         timestamptz NOT NULL DEFAULT now(),
  fonte           text,                 -- 'manual', 'webhook_inter', 'comprovante_wpp'
  meta            jsonb,                -- payload bruto da fonte
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_org ON pagamentos(org_id, pago_em DESC);
CREATE INDEX IF NOT EXISTS idx_pagamentos_cobranca ON pagamentos(cobranca_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_aluno ON pagamentos(aluno_id);
