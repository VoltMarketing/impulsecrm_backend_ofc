import express from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initDb } from './db.js';
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
initDb()
  .then(() => app.listen(port, () => console.log(`Impulse CRM API na porta ${port}`)))
  .catch((e) => {
    console.error('Falha ao iniciar o banco:', e);
    process.exit(1);
  });
