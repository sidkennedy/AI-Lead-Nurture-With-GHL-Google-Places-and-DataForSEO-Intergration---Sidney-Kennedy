const { Pool } = require('pg');

const _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const OPT_OUT_KEYWORDS = /\b(stop|unsubscribe|quit|cancel|end|optout|opt[ -]out)\b/i;

const _ready = (async () => {
  await _pool.query(`
    CREATE TABLE IF NOT EXISTS optouts (
      contact_id   TEXT PRIMARY KEY,
      opted_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
})().catch(err => console.error('[Optouts] Bootstrap error:', err.message));

async function isOptedOut(contactId) {
  await _ready;
  const id = String(contactId);
  const { rows } = await _pool.query('SELECT 1 FROM optouts WHERE contact_id = $1', [id]);
  return rows.length > 0;
}

async function add(contactId) {
  await _ready;
  const id = String(contactId);
  const result = await _pool.query(
    'INSERT INTO optouts (contact_id) VALUES ($1) ON CONFLICT (contact_id) DO NOTHING',
    [id]
  );
  return result.rowCount > 0;
}

async function getAll() {
  await _ready;
  const { rows } = await _pool.query('SELECT contact_id FROM optouts ORDER BY opted_out_at ASC');
  return rows.map(r => r.contact_id);
}

function isOptOutKeyword(text) {
  return OPT_OUT_KEYWORDS.test((text || '').trim());
}

module.exports = { isOptedOut, add, getAll, isOptOutKeyword };
