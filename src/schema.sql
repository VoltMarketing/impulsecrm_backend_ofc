-- Impulse CRM — schema
-- Multi-tenant: cada cliente (clínica) é um tenant. Tudo é filtrado por tenant_id.

CREATE TABLE IF NOT EXISTS tenants (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  -- Conexão WAHA dedicada deste cliente (no WAHA Core, uma instância por cliente)
  waha_url      TEXT,
  waha_api_key  TEXT,
  waha_session  TEXT NOT NULL DEFAULT 'default',
  -- Token que o WAHA precisa mandar no webhook (validação)
  webhook_token TEXT NOT NULL,
  -- Se preenchido, o CRM repassa as mensagens recebidas para o n8n
  n8n_webhook_url TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS settings (
  tenant_id         BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  auto_create_leads BOOLEAN NOT NULL DEFAULT TRUE,
  entry_stage       TEXT NOT NULL DEFAULT 'novo',
  default_owner     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS leads (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT,
  phone        TEXT,
  chat_id      TEXT,                       -- ex.: 5561981237745@c.us
  stage        TEXT NOT NULL DEFAULT 'novo',
  value        NUMERIC(12,2) NOT NULL DEFAULT 0,
  owner        TEXT NOT NULL DEFAULT '',
  tags         TEXT[] NOT NULL DEFAULT '{}',
  notes        TEXT NOT NULL DEFAULT '',
  origin       TEXT NOT NULL DEFAULT 'WhatsApp',
  ai_enabled   BOOLEAN NOT NULL DEFAULT TRUE,   -- botão "pausar IA" por conversa
  unread_count INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_chat_key ON leads (tenant_id, chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_tenant_idx ON leads (tenant_id, stage);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id    BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  client_id  TEXT,                 -- id otimista gerado no navegador
  wa_id      TEXT,                 -- id da mensagem no WhatsApp (para ACK)
  direction  TEXT NOT NULL,        -- 'in' | 'out'
  sender     TEXT NOT NULL DEFAULT 'human', -- 'contact' | 'human' | 'bot'
  text       TEXT NOT NULL DEFAULT '',
  media_url  TEXT,
  status     TEXT NOT NULL DEFAULT 'sent',  -- pending|sent|delivered|read|failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_lead_idx ON messages (lead_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_key ON messages (tenant_id, wa_id) WHERE wa_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS logs (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  who        TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logs_tenant_idx ON logs (tenant_id, created_at DESC);
