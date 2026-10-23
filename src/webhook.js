import { Router } from 'express';
import { q, getTenant } from './db.js';
import { emit } from './events.js';
import { serializeLead, serializeMessage, findOrCreateLeadByChat, logEvent, touchLead } from './repo.js';
import { mapStatus, getQr } from './waha.js';

const router = Router();

const ACK = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };

/**
 * Webhook do WAHA. É aqui que o lead "cai automaticamente no CRM".
 * URL: POST /api/webhooks/waha/:tenantId?token=...
 */
router.post('/waha/:tenantId', async (req, res) => {
  const tenant = await getTenant(req.params.tenantId);
  if (!tenant || req.query.token !== tenant.webhook_token) {
    return res.status(401).json({ error: 'token inválido' });
  }
  // Responde rápido: o WAHA não deve esperar o processamento.
  res.json({ ok: true });

  try {
    await handle(tenant, req.body || {});
  } catch (e) {
    console.error('[webhook]', e.message);
  }
});

async function handle(tenant, event) {
  const type = event.event;
  const p = event.payload || {};

  if (type === 'session.status') {
    const status = mapStatus(p.status);
    emit(tenant.id, {
      type: 'whatsapp.status',
      status,
      qr: status === 'connecting' ? await getQr(tenant) : null,
      phone: '',
      name: ''
    });
    await logEvent(tenant.id, 'Sistema', `Sessão do WhatsApp: ${p.status}`);
    return;
  }

  if (type === 'message.ack') {
    const waId = p.id?._serialized || p.id;
    const status = ACK[p.ack] || null;
    if (!waId || !status) return;
    const { rows } = await q(
      'UPDATE messages SET status = $1 WHERE tenant_id = $2 AND wa_id = $3 RETURNING id, lead_id',
      [status, tenant.id, String(waId)]
    );
    if (rows.length) {
      emit(tenant.id, {
        type: 'message.status',
        leadId: Number(rows[0].lead_id),
        messageId: Number(rows[0].id),
        status
      });
    }
    return;
  }

  // 'message' = recebida. 'message.any' = também as enviadas (inclusive pelo bot do n8n).
  if (type !== 'message' && type !== 'message.any') return;

  const chatId = p.fromMe ? p.to : p.from;
  if (!chatId || String(chatId).endsWith('@g.us') || chatId === 'status@broadcast') return;

  const waId = String(p.id?._serialized || p.id || '');
  if (waId) {
    const dup = await q('SELECT 1 FROM messages WHERE tenant_id = $1 AND wa_id = $2', [
      tenant.id,
      waId
    ]);
    if (dup.rowCount) return; // já registrada (ex.: enviada pelo próprio CRM)
  }

  const pushName = p._data?.notifyName || p.notifyName || null;
  const { lead, created, stage } = await findOrCreateLeadByChat(tenant, chatId, pushName);
  if (!lead) return; // criação automática desligada

  const text = p.body || p.caption || (p.hasMedia ? '[mídia recebida]' : '');
  const direction = p.fromMe ? 'out' : 'in';
  // Mensagem enviada que o CRM não registrou = foi a automação (n8n/Gemini)
  const sender = p.fromMe ? 'bot' : 'contact';

  const { rows: saved } = await q(
    `INSERT INTO messages (tenant_id, lead_id, wa_id, direction, sender, text, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenant.id, lead.id, waId || null, direction, sender, text, p.fromMe ? 'sent' : 'delivered']
  );

  if (direction === 'in') {
    await q('UPDATE leads SET unread_count = unread_count + 1 WHERE id = $1', [lead.id]);
    lead.unread_count = (lead.unread_count || 0) + 1;
  }
  if (!lead.name && pushName) {
    await q('UPDATE leads SET name = $1 WHERE id = $2', [pushName, lead.id]);
    lead.name = pushName;
  }
  await touchLead(lead.id);

  const message = serializeMessage(saved[0]);
  const who = lead.name || lead.phone;

  if (created) {
    emit(tenant.id, { type: 'lead.created', lead: serializeLead(lead, [saved[0]]) });
    await logEvent(tenant.id, who, `Lead criado em ${stage}`);
  } else {
    emit(tenant.id, { type: 'message.created', leadId: Number(lead.id), message });
    emit(tenant.id, { type: 'lead.updated', lead: serializeLead(lead, []) });
    await logEvent(tenant.id, who, 'Nova mensagem · conversa atualizada');
  }

  // Repasse para o n8n (automação), só para mensagens recebidas e com a IA ativa
  if (direction === 'in' && lead.ai_enabled && tenant.n8n_webhook_url) {
    fetch(tenant.n8n_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: tenant.id, leadId: Number(lead.id), chatId, text, raw: event })
    }).catch((e) => console.error('[n8n]', e.message));
  }
}

export default router;
