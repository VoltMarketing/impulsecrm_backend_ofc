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

/** Cria (ou atualiza) a sessão já com o webhook apontando para o CRM.
 *  Se a sessão já existir (ex.: criada pelo n8n), MANTÉM os webhooks que já
 *  estavam lá e só acrescenta o do CRM. */
export async function ensureSession(tenant) {
  const name = tenant.waha_session;
  const ours = {
    url: webhookUrl(tenant),
    events: ['message', 'message.any', 'message.ack', 'session.status']
  };

  let existing = null;
  try {
    existing = await call(tenant, `/api/sessions/${name}`);
  } catch (e) {
    if (!/404|not found/i.test(e.message)) {
      throw new Error(`Não consegui falar com o WAHA (${e.message}). Confira WAHA_URL e WAHA_API_KEY.`);
    }
  }

  if (!existing) {
    await call(tenant, '/api/sessions', {
      method: 'POST',
      body: { name, start: true, config: { webhooks: [ours] } }
    });
    return;
  }

  const cfg = existing.config || {};
  const others = (cfg.webhooks || []).filter((w) => !String(w.url || '').includes('/api/webhooks/waha/'));
  try {
    await call(tenant, `/api/sessions/${name}`, {
      method: 'PUT',
      body: { name, config: { ...cfg, webhooks: [...others, ours] } }
    });
  } catch (e) {
    console.error('[waha] não consegui atualizar o webhook:', e.message);
  }

  const st = String(existing.status || '').toUpperCase();
  if (st === 'FAILED') {
    await call(tenant, `/api/sessions/${name}/restart`, { method: 'POST' }).catch(() =>
      call(tenant, `/api/sessions/${name}/start`, { method: 'POST' })
    );
  } else if (st === 'STOPPED' || !st) {
    await call(tenant, `/api/sessions/${name}/start`, { method: 'POST' });
  }
}

export async function stopSession(tenant) {
  stopWatch(tenant.id);
  try {
    await call(tenant, `/api/sessions/${tenant.waha_session}/logout`, { method: 'POST' });
  } catch {}
  try {
    await call(tenant, `/api/sessions/${tenant.waha_session}/stop`, { method: 'POST' });
  } catch {}
}

export async function sessionInfo(tenant) {
  return call(tenant, `/api/sessions/${tenant.waha_session}`);
}

/** QR como data URL. Aceita tanto a resposta em JSON quanto a imagem crua. */
export async function getQr(tenant) {
  try {
    const h = headers(tenant);
    h.Accept = 'application/json';
    const res = await fetch(`${base(tenant)}/api/${tenant.waha_session}/auth/qr?format=image`, { headers: h });
    if (!res.ok) {
      console.error('[waha] QR indisponível:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('json')) {
      const data = await res.json();
      if (data && data.data) return `data:${data.mimetype || 'image/png'};base64,${data.data}`;
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type || 'image/png'};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.error('[waha] erro ao buscar QR:', e.message);
    return null;
  }
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
  const off = { type: 'whatsapp.status', status: 'disconnected', qr: null, phone: '', name: '' };
  if (!tenant.waha_url) return off;
  try {
    const info = await sessionInfo(tenant);
    const raw = String((info && info.status) || '').toUpperCase();
    const status = mapStatus(raw);
    const me = (info && info.me) || {};
    return {
      type: 'whatsapp.status',
      status,
      raw,
      qr: raw === 'SCAN_QR_CODE' ? await getQr(tenant) : null,
      phone: me.id ? '+' + String(me.id).split('@')[0] : '',
      name: me.pushName || ''
    };
  } catch (e) {
    console.error('[waha] status:', e.message);
    return off;
  }
}

/* --------- Vigia da conexão: renova o QR na tela até o celular ler --------- */
// O QR do WhatsApp muda a cada ~20s e o WAHA não avisa por webhook a cada troca.
// Então, enquanto a sessão estiver aguardando leitura, o backend consulta o WAHA
// a cada 3s e empurra o QR novo para a tela via SSE.
const watchers = new Map();

export function stopWatch(tenantId) {
  const w = watchers.get(String(tenantId));
  if (w) clearInterval(w.timer);
  watchers.delete(String(tenantId));
}

export function watchSession(tenant, emit) {
  const key = String(tenant.id);
  if (watchers.has(key)) return;
  const startedAt = Date.now();
  const w = { lastQr: null, lastStatus: null, busy: false, timer: null };
  w.timer = setInterval(async () => {
    if (w.busy) return;
    w.busy = true;
    try {
      const p = await statusPayload(tenant);
      if (p.qr !== w.lastQr || p.status !== w.lastStatus) {
        w.lastQr = p.qr;
        w.lastStatus = p.status;
        emit(tenant.id, p);
      }
      const expired = Date.now() - startedAt > 5 * 60 * 1000;
      if (p.status === 'connected' || p.raw === 'STOPPED' || p.raw === 'FAILED' || expired) {
        if (expired && p.status !== 'connected') emit(tenant.id, { ...p, status: 'disconnected', qr: null });
        stopWatch(key);
      }
    } finally {
      w.busy = false;
    }
  }, 3000);
  watchers.set(key, w);
}
