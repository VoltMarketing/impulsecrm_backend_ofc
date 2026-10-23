import { Router } from 'express';
import { q, getTenant } from './db.js';
import { emit } from './events.js';
import { serializeLead, serializeMessage, findOrCreateLeadByChat, logEvent, touchLead } from './repo.js';
import { statusPayload, watchSession, stopWatch } from './waha.js';

const router = Router();

const ACK = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };

/**
 * Webhook do WAHA. É aqui que o lead "cai automaticamente no CRM".
 * URL: POST /api/webhooks/waha/:tenantId?token=...
 */
router.post('/waha/:tenantId', async (req, res) => {
  const tenant = await getTenant(req.params.tenantId);
  if (!tenant || req.query.token !== tenant.webhook_token) {
    console.error(`[webhook] recusado: tenant ${req.params.tenantId} com token inválido`);
    return res.status(401).json({ error: 'token inválido' });
  }
  console.log(`[webhook] ${req.body?.event || '?'} recebido (tenant ${tenant.id})`);
  // Responde rápido: o WAHA não deve esperar o processamento.
  res.json({ ok: true });

  try {
    await handle(tenant, req.body || {});
  } catch (e) {
    console.error('[webhook] erro ao processar:', e.message);
  }
});

async function handle(tenant, event) {
  const type = event.event;
  const p = event.payload || {};

  if (type === 'session.status') {
    const payload = await statusPayload(tenant);
    emit(tenant.id, payload);
    if (payload.status === 'connecting') watchSession(tenant, emit);
    else stopWatch(tenant.id);
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

  // Assinamos só 'message.any' (recebidas + enviadas). Se a sessão também mandar
  // 'message', ignoramos para não processar a mesma mensagem duas vezes.
  if (type !== 'message.any') return;

  const rawChat = p.fromMe ? p.to : p.from;
  const chatId = normalizeJid(rawChat);
  if (!chatId || /@(g\.us|broadcast|newsletter)$/.test(chatId)) return;

  const waId = String(p.id?._serialized || p.id || '') || null;
  const pushName = p.fromMe ? null : p._data?.notifyName || p._data?.pushName || p.notifyName || null;
  const phone = resolvePhone(p, chatId);

  const { lead, created, stage } = await findOrCreateLeadByChat(tenant, chatId, pushName, phone);
  if (!lead) return; // criação automática desligada

  const text = p.body || p.caption || (p.hasMedia ? '[mídia]' : '');
  const direction = p.fromMe ? 'out' : 'in';
  // Enviada pela API (n8n/bot) = 'bot'. Digitada no celular = 'human'.
  const sender = !p.fromMe ? 'contact' : p.source === 'app' ? 'human' : 'bot';

  const { rows: saved } = await q(
    `INSERT INTO messages (tenant_id, lead_id, wa_id, direction, sender, text, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, wa_id) WHERE wa_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [tenant.id, lead.id, waId, direction, sender, text, p.fromMe ? 'sent' : 'delivered']
  );
  if (!saved.length) return; // já registrada (ex.: enviada pelo próprio CRM)

  if (direction === 'in') {
    await q('UPDATE leads SET unread_count = unread_count + 1 WHERE id = $1', [lead.id]);
    lead.unread_count = (lead.unread_count || 0) + 1;
  }
  if (!lead.name && pushName) {
    await q('UPDATE leads SET name = $1 WHERE id = $2', [pushName, lead.id]);
    lead.name = pushName;
  }
  if (!lead.phone && phone) {
    await q('UPDATE leads SET phone = $1 WHERE id = $2', [phone, lead.id]);
    lead.phone = phone;
  }
  await touchLead(lead.id);

  const message = serializeMessage(saved[0]);
  const who = lead.name || lead.phone || 'Contato';

  if (created) {
    emit(tenant.id, { type: 'lead.created', lead: serializeLead(lead, [saved[0]]) });
    await logEvent(tenant.id, who, `Lead criado em ${stage}`);
  } else {
    emit(tenant.id, { type: 'message.created', leadId: Number(lead.id), message });
    emit(tenant.id, { type: 'lead.updated', lead: serializeLead(lead) });
    if (direction === 'in') await logEvent(tenant.id, who, 'Nova mensagem · conversa atualizada');
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

/** 5561...@s.whatsapp.net -> 5561...@c.us (mesmo contato, formatos diferentes por engine) */
function normalizeJid(jid) {
  if (!jid) return null;
  return String(jid).replace(/@s\.whatsapp\.net$/, '@c.us');
}

/** Telefone legível. O WhatsApp agora pode mandar um id interno (@lid) no lugar
 *  do número; nesse caso procura o número real nos campos alternativos. */
function resolvePhone(p, chatId) {
  const candidates = [
    chatId,
    p._data?.key?.remoteJidAlt,
    p._data?.key?.senderPn,
    p._data?.key?.participantAlt,
    p._data?.from,
    p._data?.to
  ];
  for (const c of candidates) {
    const m = String(c || '').match(/^(\d{8,15})@(c\.us|s\.whatsapp\.net)$/);
    if (m) return '+' + m[1];
  }
  return '';
}

export default router;
