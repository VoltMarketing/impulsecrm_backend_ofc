import './async-safe.js';
import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initDb, q } from './db.js';
import { ensureWebhook } from './waha.js';
import routes from './routes.js';
import webhook from './webhook.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: false }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/webhooks', webhook);
app.use('/api', routes);

/**
 * Serve o HTML do CRM já com a configuração injetada, para não precisar
 * editar o arquivo gerado pelo Claude Design.
 */
let cachedHtml = null;
app.get(['/', '/index.html'], async (_req, res) => {
  try {
    if (!cachedHtml || process.env.NODE_ENV !== 'production') {
      const raw = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
      const inject = `<script>window.IMPULSE_CONFIG={apiBaseUrl:${JSON.stringify(
        process.env.API_BASE_URL || '/api'
      )}};</script>`;
      cachedHtml = raw.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
    }
    res.type('html').send(cachedHtml);
  } catch {
    res.status(404).send('Coloque o arquivo do CRM em public/index.html');
  }
});
app.use(express.static(PUBLIC_DIR));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Erro interno' });
});

const port = Number(process.env.PORT) || 3000;

/** Ao iniciar, garante que cada WAHA conectado sabe avisar o CRM */
async function syncWebhooks() {
  if (!process.env.PUBLIC_URL) {
    console.error('[waha] PUBLIC_URL vazio: o WAHA não tem para onde mandar as mensagens');
    return;
  }
  const { rows } = await q("SELECT * FROM tenants WHERE active AND waha_url <> ''");
  for (const t of rows) {
    try {
      await ensureWebhook(t);
    } catch (e) {
      console.error(`[waha] tenant ${t.id}: não consegui cadastrar o webhook (${e.message})`);
    }
  }
}
initDb()
  .then(() => {
    app.listen(port, () => console.log(`Impulse CRM API na porta ${port}`));
    syncWebhooks();
  })
  .catch((e) => {
    console.error('Falha ao iniciar o banco:', e);
    process.exit(1);
  });
