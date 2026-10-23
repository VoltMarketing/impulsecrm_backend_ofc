import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10
});

export const q = (text, params) => pool.query(text, params);

export async function initDb() {
  const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);

  // Garante o tenant inicial (o primeiro cliente / sua própria conta de teste)
  const slug = process.env.DEFAULT_TENANT_SLUG || 'principal';
  const { rows } = await q('SELECT id FROM tenants WHERE slug = $1', [slug]);
  if (!rows.length) {
    const token = randomBytes(16).toString('hex');
    const t = await q(
      `INSERT INTO tenants (name, slug, waha_url, waha_api_key, waha_session, webhook_token, n8n_webhook_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        process.env.DEFAULT_TENANT_NAME || 'Cliente principal',
        slug,
        process.env.WAHA_URL || '',
        process.env.WAHA_API_KEY || '',
        process.env.WAHA_SESSION || 'default',
        token,
        process.env.N8N_WEBHOOK_URL || null
      ]
    );
    await q('INSERT INTO settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [t.rows[0].id]);
    console.log(`[db] tenant "${slug}" criado (id ${t.rows[0].id}). webhook_token=${token}`);
  } else {
    // As variáveis do EasyPanel mandam: se mudar WAHA_SESSION, WAHA_URL etc. e
    // der Deploy, o tenant principal é atualizado sozinho.
    await q(
      `UPDATE tenants SET
         name            = COALESCE(NULLIF($2,''), name),
         waha_url        = COALESCE(NULLIF($3,''), waha_url),
         waha_api_key    = COALESCE(NULLIF($4,''), waha_api_key),
         waha_session    = COALESCE(NULLIF($5,''), waha_session),
         n8n_webhook_url = COALESCE(NULLIF($6,''), n8n_webhook_url)
       WHERE slug = $1`,
      [
        slug,
        process.env.DEFAULT_TENANT_NAME || '',
        process.env.WAHA_URL || '',
        process.env.WAHA_API_KEY || '',
        process.env.WAHA_SESSION || '',
        process.env.N8N_WEBHOOK_URL || ''
      ]
    );
    console.log(`[db] tenant "${slug}" sincronizado com as variáveis (sessão: ${process.env.WAHA_SESSION || '-'})`);
  }
}

export async function getTenant(id) {
  const { rows } = await q('SELECT * FROM tenants WHERE id = $1', [id]);
  return rows[0] || null;
}
