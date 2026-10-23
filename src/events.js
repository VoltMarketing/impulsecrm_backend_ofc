// SSE: um canal por tenant. É isso que faz a tela atualizar sozinha.
const channels = new Map(); // tenantId -> Set(res)

export function subscribe(tenantId, res) {
  const key = String(tenantId);
  if (!channels.has(key)) channels.set(key, new Set());
  channels.get(key).add(res);
  return () => {
    const set = channels.get(key);
    if (!set) return;
    set.delete(res);
    if (!set.size) channels.delete(key);
  };
}

export function emit(tenantId, payload) {
  const set = channels.get(String(tenantId));
  if (!set) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(line);
    } catch {
      set.delete(res);
    }
  }
}
