// Cliente do WAHA. No Core, cada cliente tem a SUA instância (waha_url próprio)
// e normalmente uma única sessão por instância.

function headers(tenant) {
  const h = { 'Content-Type': 'application/json' };
  if (tenant.waha_api_key) h['X-Api-Key'] = tenant.waha_api_key;
  return h;
}

function base(tenant) {
  if (!tenant.waha_url) throw new Error('WAHA não configurado para este cliente');
  return tenant.waha_url.replace(/\/$/, '');
}

async function call(tenant, path, { method = 'GET', body, accept } = {}) {
  const h = headers(tenant);
  if (accept) h.Accept = accept;
  const res = await fetch(base(tenant) + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `WAHA ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : `WAHA ${res.status}`);
  }
  return data;
}

/** URL que o WAHA deve chamar quando chegar uma mensagem */
export function webhookUrl(tenant) {
  const pub = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return `${pub}/api/webhooks/waha/${tenant.id}?token=${tenant.webhook_token}`;
}

/** Cria (ou atualiza) a sessão já com o webhook apontando para o CRM */
export async function ensureSession(tenant) {
  const sessionCfg = {
    name: tenant.waha_session,
    start: true,
    config: {
      webhooks: [
        {
          url: webhookUrl(tenant),
          events: ['message', 'message.any', 'message.ack', 'session.status']
        }
      ]
    }
  };
  try {
    return await call(tenant, '/api/sessions', { method: 'POST', body: sessionCfg });
  } catch (e) {
    // Já existe: atualiza a config e garante que está iniciada
    try {
      await call(tenant, `/api/sessions/${tenant.waha_session}`, { method: 'PUT', body: sessionCfg });
    } catch {}
    try {
      await call(tenant, `/api/sessions/${tenant.waha_session}/start`, { method: 'POST' });
    } catch {}
    return null;
  }
}

export async function stopSession(tenant) {
  try {
    await call(tenant, `/api/sessions/${tenant.waha_session}/stop`, { method: 'POST' });
  } catch {}
  try {
    await call(tenant, `/api/sessions/${tenant.waha_session}/logout`, { method: 'POST' });
  } catch {}
}

export async function sessionInfo(tenant) {
  return call(tenant, `/api/sessions/${tenant.waha_session}`);
}

/** QR como data URL, pronto pra jogar em background-image */
export async function getQr(tenant) {
  try {
    const data = await call(tenant, `/api/${tenant.waha_session}/auth/qr?format=image`, {
      accept: 'application/json'
    });
    if (data && data.data) return `data:${data.mimetype || 'image/png'};base64,${data.data}`;
  } catch {}
  return null;
}

export async function sendText(tenant, chatId, text) {
  return call(tenant, '/api/sendText', {
    method: 'POST',
    body: { session: tenant.waha_session, chatId, text }
  });
}

export async function sendSeen(tenant, chatId) {
  try {
    await call(tenant, '/api/sendSeen', {
      method: 'POST',
      body: { session: tenant.waha_session, chatId }
    });
  } catch {}
}

/** Traduz o status do WAHA para o que o front entende */
export function mapStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'WORKING') return 'connected';
  if (s === 'STARTING' || s === 'SCAN_QR_CODE') return 'connecting';
  return 'disconnected';
}

/** Monta o objeto que o front espera em /whatsapp/status */
export async function statusPayload(tenant) {
  if (!tenant.waha_url) {
    return { type: 'whatsapp.status', status: 'disconnected', qr: null, phone: '', name: '' };
  }
  try {
    const info = await sessionInfo(tenant);
    const status = mapStatus(info && info.status);
    const me = (info && info.me) || {};
    return {
      type: 'whatsapp.status',
      status,
      qr: status === 'connecting' ? await getQr(tenant) : null,
      phone: me.id ? '+' + String(me.id).split('@')[0] : '',
      name: me.pushName || ''
    };
  } catch {
    return { type: 'whatsapp.status', status: 'disconnected', qr: null, phone: '', name: '' };
  }
}
