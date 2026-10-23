# Impulse CRM — Backend

Backend do CRM da Volt: login, funil de leads, conversas em tempo real e integração real com o WhatsApp via WAHA.
Feito para rodar no seu VPS pelo EasyPanel, sem serviços pagos.

---

## Como funciona

```
WhatsApp do cliente
        │
      WAHA  ──webhook──►  Backend (este projeto)  ──►  Postgres
        ▲                        │
        └──── sendText ──────────┤
                                 ├──► SSE  ──►  HTML do CRM (atualiza sozinho)
                                 └──► n8n  ──►  Gemini (automação, opcional)
```

- Cada mensagem recebida cai no webhook, vira (ou atualiza) um **lead** e aparece na tela na hora.
- O CRM **não depende do n8n**: dá para vender só o CRM.
- Se o cliente tiver automação, o CRM repassa a mensagem pro n8n e mostra também o que o bot respondeu
  (via evento `message.any` do WAHA), marcado como `sender: bot`.
- Cada conversa tem a flag `aiEnabled`. O n8n consulta antes de responder — é o "assumir conversa".

---

## 1. Subir o Postgres no EasyPanel

Crie um serviço **Postgres**. Anote usuário, senha e nome do banco.
A connection string fica tipo `postgres://usuario:senha@nome_do_servico:5432/impulse`.

As tabelas são criadas sozinhas na primeira inicialização.

## 2. Subir este backend

1. Suba esta pasta para um repositório Git (ou use a opção de upload do EasyPanel).
2. Crie um serviço **App** apontando para o repositório (o `Dockerfile` já está pronto).
3. Em **Environment**, cole as variáveis do `.env.example` preenchidas.
4. Em **Domains**, aponte um domínio (ex.: `crm.seudominio.com`) para a porta `3000`.

Variáveis obrigatórias:

| Variável | Para que serve |
|---|---|
| `DATABASE_URL` | Conexão com o Postgres |
| `JWT_SECRET` | Assina o token de login (string longa e aleatória) |
| `PUBLIC_URL` | Domínio público do backend — o WAHA usa para o webhook |
| `WAHA_URL` | URL interna do WAHA do cliente (ex.: `http://waha_cliente1:3000`) |
| `WAHA_API_KEY` | A `WAHA_API_KEY` que o EasyPanel gerou no serviço do WAHA |
| `ALLOW_SIGNUP` | `true` só no primeiro acesso, para criar sua conta |

## 3. Primeiro acesso

1. Abra `https://crm.seudominio.com` — o backend já serve o HTML com a configuração injetada.
2. Com `ALLOW_SIGNUP=true`, crie sua conta.
3. **Volte `ALLOW_SIGNUP` para `false`** e reinicie o serviço.

## 4. Conectar o WhatsApp

Na aba **Integrações**, clique em **Conectar**. O backend cria a sessão no WAHA já com o webhook
apontando para cá e mostra o QR Code. Leia pelo celular do cliente e pronto: as mensagens começam
a cair no funil.

Se preferir configurar o webhook na mão no WAHA, a URL é:

```
POST {PUBLIC_URL}/api/webhooks/waha/{tenantId}?token={webhook_token}
Eventos: message, message.any, message.ack, session.status
```

O `webhook_token` é gerado na criação do tenant e aparece no log do primeiro start.
Para consultar depois: `SELECT id, slug, webhook_token FROM tenants;`

---

## Vários clientes (WAHA Core)

O WAHA Core normalmente roda **uma sessão por instância**. Para 3 a 15 clientes:

1. Crie **um serviço WAHA por cliente** no EasyPanel (ex.: `waha_clinicaA`, `waha_clinicaB`).
   Use o engine **NOWEB** (`WHATSAPP_DEFAULT_ENGINE=NOWEB`) — é bem mais leve que o WEBJS,
   que sobe um Chromium por sessão.
2. Crie um tenant por cliente no banco:

```sql
INSERT INTO tenants (name, slug, waha_url, waha_api_key, waha_session, webhook_token)
VALUES ('Clínica A', 'clinica-a', 'http://waha_clinicaa:3000', 'sua-api-key', 'default',
        encode(gen_random_bytes(16), 'hex'))
RETURNING id, webhook_token;

INSERT INTO settings (tenant_id) VALUES (<id_retornado>);
```

3. Crie o usuário do cliente (gere o hash pelo endpoint de registro ou rode o script abaixo):

```bash
node -e "import('./src/auth.js').then(a=>console.log(a.hashPassword('senhaDoCliente')))"
```

```sql
INSERT INTO users (tenant_id, name, email, password_hash)
VALUES (<id>, 'Recepção Clínica A', 'clinicaa@email.com', '<hash>');
```

Cada cliente só enxerga os próprios dados — todas as consultas são filtradas por `tenant_id`.

**Limitação do Core:** o envio de mídia (imagem, áudio, arquivo) exige o WAHA Plus.
No Core o CRM envia texto normalmente; mídia recebida aparece como `[mídia recebida]`.

---

## Ligando o n8n (automação)

1. Em `N8N_WEBHOOK_URL` (ou na coluna `n8n_webhook_url` do tenant), coloque a URL do webhook do fluxo.
   O CRM repassa cada mensagem recebida com `{ tenantId, leadId, chatId, text, raw }`.
2. No início do fluxo, consulte se a IA está ativa:

```
GET {PUBLIC_URL}/api/n8n/lead-state?tenantId={{$json.tenantId}}&chatId={{$json.chatId}}
Header: x-api-key: {INTERNAL_API_KEY}
```

Se `aiEnabled` for `false`, encerre o fluxo — o atendente assumiu.

3. O n8n continua respondendo pelo WAHA como já faz. O CRM registra a resposta do bot pelo
   evento `message.any`, sem precisar de nada a mais.

Para desligar a IA de uma conversa, o front só precisa chamar
`PATCH /api/leads/:id` com `{ "aiEnabled": false }`.

---

## Endpoints

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | Autenticação |
| GET | `/api/auth/me` | Usuário logado |
| GET | `/api/events?token=` | SSE — tempo real |
| GET/POST | `/api/leads` | Listar / criar lead |
| PATCH/DELETE | `/api/leads/:id` | Editar / excluir |
| POST | `/api/leads/:id/read` | Zerar não lidas |
| POST | `/api/leads/:id/messages` | Enviar mensagem pelo WhatsApp |
| GET/PATCH | `/api/settings` | Criação automática, etapa de entrada, responsável |
| GET | `/api/users` · `/api/logs` | Equipe e eventos |
| GET/POST | `/api/whatsapp/status` · `/connect` · `/disconnect` | Sessão e QR Code |
| POST | `/api/webhooks/waha/:tenantId` | Entrada das mensagens |
| GET | `/api/n8n/lead-state` | Consulta da automação |

---

## Rodar local

```bash
cp .env.example .env   # ajuste DATABASE_URL
npm install
npm run dev
```

Abra `http://localhost:3000`.

---

## Próximos passos sugeridos

- Painel admin para criar clientes sem mexer no SQL.
- Resumo da conversa e classificação do lead com o Gemini (a chave já está na sua conta).
- Backup diário do Postgres.
- LGPD: como são clínicas, vale ter termo de uso e log de acesso aos dados.
