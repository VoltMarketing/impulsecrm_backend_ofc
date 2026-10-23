import { Router } from 'express';
import { q, getTenant } from './db.js';
import { hashPassword, verifyPassword, signToken, requireAuth, readToken } from './auth.js';
import { emit, subscribe } from './events.js';
import { listLeads, getLead, serializeLead, serializeMessage, logEvent, touchLead } from './repo.js';
import * as waha from './waha.js';

const router = Router();

/* ---------------------------------- auth --------------------------------- */

router.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Dados incompletos' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Senha muito curta' });

  // Registro aberto só se ALLOW_SIGNUP=true. Em produção crie as contas pelo admin.
  if (process.env.ALLOW_SIGNUP !== 'true') {
    return res.status(403).json({ error: 'Cadastro desabilitado. Peça acesso ao administrador.' });
  }

  const tenantSlug = process.env.DEFAULT_TENANT_SLUG || 'principal';
  const { rows: t } = await q('SELECT id FROM tenants WHERE slug = $1', [tenantSlug]);
  if (!t.length) return res.status(500).json({ error: 'Tenant padrão não encontrado' });

  const exists = await q('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
  if (exists.rowCount) return res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });

  const { rows } = await q(
    'INSERT INTO users (tenant_id, name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING *',
    [t[0].id, name, email, hashPassword(password)]
  );
  res.json({ token: signToken(rows[0]), name: rows[0].name, email: rows[0].email });
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await q('SELECT * FROM users WHERE lower(email) = lower($1)', [email || '']);
  const user = rows[0];
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  res.json({ token: signToken(user), name: user.name, email: user.email });
});

router.post('/auth/logout', (_req, res) => res.status(204).end());

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ name: req.user.name, email: req.user.email, isAdmin: req.user.is_admin });
});

/* ------------------------------ tempo real ------------------------------- */

router.get('/events', async (req, res) => {
  const payload = readToken(req.query.token);
  if (!payload) return res.status(401).end();
  const { rows } = await q('SELECT tenant_id FROM users WHERE id = $1', [payload.uid]);
  if (!rows.length) return res.status(401).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(': conectado\n\n');

  const unsubscribe = subscribe(rows[0].tenant_id, res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

/* --------------------------------- leads --------------------------------- */

router.get('/leads', requireAuth, async (req, res) => {
  res.json(await listLeads(req.tenantId));
});

router.post('/leads', requireAuth, async (req, res) => {
  const { stage = 'novo', owner = '', origin = 'Manual', name = '', phone = '' } = req.body || {};
  const { rows } = await q(
    `INSERT INTO leads (tenant_id, name, phone, stage, owner, origin)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.tenantId, name || null, phone, stage, owner, origin]
  );
  const lead = serializeLead(rows[0], []);
  emit(req.tenantId, { type: 'lead.created', lead });
  res.json(lead);
});

const EDITABLE = {
  name: 'name',
  phone: 'phone',
  stage: 'stage',
  value: 'value',
  owner: 'owner',
  tags: 'tags',
  notes: 'notes',
  aiEnabled: 'ai_enabled'
};

router.patch('/leads/:id', requireAuth, async (req, res) => {
  const sets = [];
  const vals = [];
  for (const [key, col] of Object.entries(EDITABLE)) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      vals.push(req.body[key]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
  vals.push(req.tenantId, req.params.id);
  const { rows } = await q(
    `UPDATE leads SET ${sets.join(', ')}, updated_at = now()
     WHERE tenant_id = $${vals.length - 1} AND id = $${vals.length} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'Lead não encontrado' });
  const lead = serializeLead(rows[0], []);
  emit(req.tenantId, { type: 'lead.updated', lead });
  res.json(lead);
});

router.delete('/leads/:id', requireAuth, async (req, res) => {
  await q('DELETE FROM leads WHERE tenant_id = $1 AND id = $2', [req.tenantId, req.params.id]);
  emit(req.tenantId, { type: 'lead.deleted', leadId: Number(req.params.id) });
  res.status(204).end();
});

router.post('/leads/:id/read', requireAuth, async (req, res) => {
  const { rows } = await q(
    'UPDATE leads SET unread_count = 0 WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [req.tenantId, req.params.id]
  );
  if (rows.length && rows[0].chat_id) {
    const tenant = await getTenant(req.tenantId);
    if (tenant?.waha_url) waha.sendSeen(tenant, rows[0].chat_id);
  }
  res.status(204).end();
});

/** Envio de mensagem pelo CRM → WAHA */
router.post('/leads/:id/messages', requireAuth, async (req, res) => {
  const { text, clientId } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Mensagem vazia' });

  const { rows } = await q('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2', [
    req.tenantId,
    req.params.id
  ]);
  const lead = rows[0];
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

  const tenant = await getTenant(req.tenantId);
  let waId = null;
  let status = 'sent';

  if (lead.chat_id && tenant?.waha_url) {
    try {
      const sent = await waha.sendText(tenant, lead.chat_id, text);
      waId = (sent && (sent.id?._serialized || sent.id)) || null;
    } catch (e) {
      return res.status(502).json({ error: 'Falha ao enviar no WhatsApp: ' + e.message });
    }
  } else {
    status = 'failed';
  }

  const { rows: saved } = await q(
    `INSERT INTO messages (tenant_id, lead_id, client_id, wa_id, direction, sender, text, status)
     VALUES ($1,$2,$3,$4,'out','human',$5,$6) RETURNING *`,
    [req.tenantId, lead.id, clientId || null, waId ? String(waId) : null, text, status]
  );
  await touchLead(lead.id);

  const message = serializeMessage(saved[0]);
  emit(req.tenantId, { type: 'message.created', leadId: Number(lead.id), message });
  res.json(message);
});

/* ------------------------------- settings -------------------------------- */

router.get('/settings', requireAuth, async (req, res) => {
  const { rows } = await q('SELECT * FROM settings WHERE tenant_id = $1', [req.tenantId]);
  const s = rows[0] || { auto_create_leads: true, entry_stage: 'novo', default_owner: '' };
  res.json({
    autoCreateLeads: s.auto_create_leads,
    entryStage: s.entry_stage,
    defaultOwner: s.default_owner
  });
});

router.patch('/settings', requireAuth, async (req, res) => {
  const { autoCreateLeads, entryStage, defaultOwner } = req.body || {};
  await q(
    `INSERT INTO settings (tenant_id, auto_create_leads, entry_stage, default_owner)
     VALUES ($1, COALESCE($2, TRUE), COALESCE($3,'novo'), COALESCE($4,''))
     ON CONFLICT (tenant_id) DO UPDATE SET
       auto_create_leads = COALESCE($2, settings.auto_create_leads),
       entry_stage       = COALESCE($3, settings.entry_stage),
       default_owner     = COALESCE($4, settings.default_owner)`,
    [req.tenantId, autoCreateLeads ?? null, entryStage ?? null, defaultOwner ?? null]
  );
  const { rows } = await q('SELECT * FROM settings WHERE tenant_id = $1', [req.tenantId]);
  res.json({
    autoCreateLeads: rows[0].auto_create_leads,
    entryStage: rows[0].entry_stage,
    defaultOwner: rows[0].default_owner
  });
});

router.get('/users', requireAuth, async (req, res) => {
  const { rows } = await q(
    'SELECT name, email FROM users WHERE tenant_id = $1 ORDER BY created_at',
    [req.tenantId]
  );
  res.json(rows);
});

router.get('/logs', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 200);
  const { rows } = await q(
    'SELECT who, action, created_at FROM logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
    [req.tenantId, limit]
  );
  res.json(rows.map((r) => ({ who: r.who, action: r.action, createdAt: r.created_at })));
});

/* -------------------------------- whatsapp -------------------------------- */

router.get('/whatsapp/status', requireAuth, async (req, res) => {
  const tenant = await getTenant(req.tenantId);
  const payload = await waha.statusPayload(tenant);
  if (payload.status === 'connecting') waha.watchSession(tenant, emit);
  res.json(payload);
});

router.post('/whatsapp/connect', requireAuth, async (req, res) => {
  const tenant = await getTenant(req.tenantId);
  if (!tenant?.waha_url) return res.status(400).json({ error: 'WAHA não configurado' });
  try {
    await waha.ensureSession(tenant);
  } catch (e) {
    console.error('[whatsapp/connect]', e.message);
    return res.status(502).json({ error: e.message });
  }
  await logEvent(tenant.id, 'Sistema', 'Sessão do WhatsApp iniciada');

  // Espera o WAHA gerar o QR (até ~15s) antes de responder
  let payload = null;
  for (let i = 0; i < 10; i++) {
    payload = await waha.statusPayload(tenant);
    if (payload.qr || payload.status === 'connected' || payload.raw === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (payload.raw === 'FAILED') {
    return res.status(502).json({ error: 'O WAHA não conseguiu iniciar a sessão. Veja os logs do serviço waha.' });
  }
  if (payload.status !== 'connected') {
    // Mantém o QR atualizado na tela até o celular ler
    payload.status = 'connecting';
    waha.watchSession(tenant, emit);
  }
  emit(tenant.id, payload);
  res.json(payload);
});

router.post('/whatsapp/disconnect', requireAuth, async (req, res) => {
  const tenant = await getTenant(req.tenantId);
  await waha.stopSession(tenant);
  const payload = { type: 'whatsapp.status', status: 'disconnected', qr: null, phone: '', name: '' };
  await logEvent(tenant.id, 'Sistema', 'WhatsApp desconectado');
  emit(tenant.id, payload);
  res.json(payload);
});

/* ------------------- integração com o n8n (automação) --------------------- */
// O n8n consulta isto ANTES de responder. Se aiEnabled for false, o atendente
// humano assumiu a conversa e o bot deve ficar calado.
router.get('/n8n/lead-state', async (req, res) => {
  if ((req.headers['x-api-key'] || '') !== (process.env.INTERNAL_API_KEY || '')) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  const { tenantId, chatId } = req.query;
  const { rows } = await q('SELECT * FROM leads WHERE tenant_id = $1 AND chat_id = $2', [
    tenantId,
    chatId
  ]);
  if (!rows.length) return res.json({ found: false, aiEnabled: true });
  res.json({
    found: true,
    aiEnabled: rows[0].ai_enabled,
    leadId: Number(rows[0].id),
    stage: rows[0].stage,
    name: rows[0].name
  });
});

export default router;
