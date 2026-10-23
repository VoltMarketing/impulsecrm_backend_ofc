import { q } from './db.js';
import { emit } from './events.js';

export function serializeMessage(m) {
  return {
    id: Number(m.id),
    clientId: m.client_id || undefined,
    direction: m.direction,
    sender: m.sender,
    text: m.text,
    status: m.status,
    createdAt: m.created_at
  };
}

export function serializeLead(l, messages = []) {
  return {
    id: Number(l.id),
    name: l.name,
    phone: l.phone || '',
    chatId: l.chat_id,
    stage: l.stage,
    value: Number(l.value),
    owner: l.owner,
    tags: l.tags || [],
    notes: l.notes || '',
    origin: l.origin,
    aiEnabled: l.ai_enabled,
    unreadCount: l.unread_count,
    createdAt: l.created_at,
    messages: messages.map(serializeMessage)
  };
}

export async function listLeads(tenantId) {
  const { rows: leads } = await q(
    'SELECT * FROM leads WHERE tenant_id = $1 ORDER BY updated_at DESC',
    [tenantId]
  );
  if (!leads.length) return [];
  const ids = leads.map((l) => l.id);
  const { rows: msgs } = await q(
    `SELECT * FROM messages WHERE lead_id = ANY($1::bigint[]) ORDER BY created_at ASC`,
    [ids]
  );
  const byLead = new Map();
  for (const m of msgs) {
    const k = String(m.lead_id);
    if (!byLead.has(k)) byLead.set(k, []);
    byLead.get(k).push(m);
  }
  return leads.map((l) => serializeLead(l, byLead.get(String(l.id)) || []));
}

export async function getLead(tenantId, id) {
  const { rows } = await q('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (!rows.length) return null;
  const { rows: msgs } = await q(
    'SELECT * FROM messages WHERE lead_id = $1 ORDER BY created_at ASC',
    [id]
  );
  return serializeLead(rows[0], msgs);
}

export async function logEvent(tenantId, who, action) {
  const { rows } = await q(
    'INSERT INTO logs (tenant_id, who, action) VALUES ($1,$2,$3) RETURNING *',
    [tenantId, who, action]
  );
  emit(tenantId, { type: 'log', who: rows[0].who, action: rows[0].action, createdAt: rows[0].created_at });
  return rows[0];
}

/** Acha o lead pelo chatId, ou cria um novo (entrada automática do WhatsApp).
 *  À prova de corrida: se dois eventos chegarem juntos, só um lead é criado. */
export async function findOrCreateLeadByChat(tenant, chatId, pushName, phone) {
  const tenantId = tenant.id;
  const find = () => q('SELECT * FROM leads WHERE tenant_id = $1 AND chat_id = $2', [tenantId, chatId]);
  const { rows: found } = await find();
  if (found.length) return { lead: found[0], created: false };

  const { rows: st } = await q('SELECT * FROM settings WHERE tenant_id = $1', [tenantId]);
  const settings = st[0] || { auto_create_leads: true, entry_stage: 'novo', default_owner: '' };
  if (!settings.auto_create_leads) return { lead: null, created: false };

  const { rows } = await q(
    `INSERT INTO leads (tenant_id, name, phone, chat_id, stage, owner, origin)
     VALUES ($1,$2,$3,$4,$5,$6,'WhatsApp')
     ON CONFLICT (tenant_id, chat_id) WHERE chat_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [tenantId, pushName || null, phone || '', chatId, settings.entry_stage, settings.default_owner || '']
  );
  if (rows.length) return { lead: rows[0], created: true, stage: settings.entry_stage };
  const { rows: again } = await find(); // outro evento criou ao mesmo tempo
  return { lead: again[0] || null, created: false };
}

export async function touchLead(id) {
  await q('UPDATE leads SET updated_at = now() WHERE id = $1', [id]);
}
