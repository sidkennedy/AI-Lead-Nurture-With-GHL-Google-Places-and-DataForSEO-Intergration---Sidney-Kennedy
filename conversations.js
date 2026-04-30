const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// In-memory cache — reads are always sync from here; writes go to cache + DB async
let _cache = {};
let _ready = false;

// ─── DB bootstrap ─────────────────────────────────────────────────────────────

async function initFromDb() {
  try {
    // Ensure the variant + lead_form + paused_reason columns exist before reading —
    // idempotent, safe on every start.
    // paused_reason classifies why contacts.booked was flipped:
    //   'verbal-commit' — AI fired [BOOKED] (prospect agreed to book)
    //   'declined'      — AI fired [DECLINED] (prospect said no — terminal)
    //   null            — legacy rows (treated as verbal-commit for back-compat)
    await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS variant varchar(1)').catch(() => {});
    await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lead_form TEXT').catch(() => {});
    await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS paused_reason TEXT').catch(() => {});
    const { rows: contacts } = await pool.query('SELECT * FROM contacts');
    for (const c of contacts) {
      _cache[c.contact_id] = {
        contactId:             c.contact_id,
        firstName:             c.first_name,
        city:                  c.city,
        phone:                 c.phone,
        email:                 c.email,
        practiceName:          c.practice_name,
        tags:                  c.tags || [],
        currentStep:           c.current_step,
        booked:                c.booked,
        bookedAt:              c.booked_at,
        lastMessageAt:         c.last_message_at,
        createdAt:             c.created_at,
        totalApiSpend:         c.total_api_spend || 0,
        apiSpendLimitReached:  c.api_spend_limit_reached || false,
        variant:               c.variant || null,
        leadForm:              c.lead_form || 'unknown',
        pausedReason:          c.paused_reason || null,
        ...(c.extra || {}),
        exchanges: []
      };
    }
    const { rows: exRows } = await pool.query('SELECT * FROM exchanges ORDER BY ts ASC');
    for (const ex of exRows) {
      if (_cache[ex.contact_id]) {
        _cache[ex.contact_id].exchanges.push({
          direction:      ex.direction,
          body:           ex.content,
          step:           ex.step,
          conversationId: ex.extra?.conversationId || null,
          // `type` is stored inside `extra` (e.g. 'followup-hook-pos1',
          // 'silence-nudge'). Dedup checks across the codebase rely on this
          // marker; without restoring it on boot, those checks always failed
          // after a restart and let dupes through.
          type:           ex.extra?.type || null,
          variant:        ex.extra?.variant || null,
          messageId:      ex.message_id || null,
          timestamp:      ex.ts
        });
      }
    }
    // Partial unique index on message_id — defense-in-depth so the DB itself
    // refuses two inbound rows for the same GHL message even if the app-layer
    // dedup check races. Existing rows with NULL message_id are unaffected
    // (PostgreSQL allows multiple NULLs in a unique index, and the partial
    // WHERE clause makes that explicit). Idempotent — safe on every boot.
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS exchanges_message_id_unique
         ON exchanges (message_id) WHERE message_id IS NOT NULL`
    ).catch(err => console.error('[Conversations] message_id unique index ensure error:', err.message));
    _ready = true;
    console.log(`[Conversations] DB loaded: ${Object.keys(_cache).length} contacts, ${exRows.length} exchanges`);
  } catch (err) {
    console.error('[Conversations] DB init error:', err.message, '— falling back to JSON');
    _loadFromJson();
    _ready = true;
  }
}

function _loadFromJson() {
  try {
    const FILE = path.join(__dirname, 'data', 'conversations.json');
    if (!fs.existsSync(FILE)) return;
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [id, rec] of Object.entries(data)) {
      if (!_cache[id]) _cache[id] = rec;
    }
    console.log('[Conversations] Imported', Object.keys(data).length, 'contacts from JSON backup');
  } catch {}
}

// ─── DB write helpers (fire-and-forget) ───────────────────────────────────────

function _dbUpsertContact(record) {
  const extra = {
    researchData:        record.researchData        || null,
    scanResults:         record.scanResults         || null,
    // Mid-conversation state that must survive server restarts so the
    // deterministic Maps-confirmation handlers don't fall back to Claude
    // and start re-asking earlier scripted questions.
    confirmationPending: record.confirmationPending || null,
    awaitingRetryName:   record.awaitingRetryName   || false,
    practiceName:        record.practiceName        || null,
    practiceStreet:      record.practiceStreet      || null,
    practiceCity:        record.practiceCity        || null,
    // Variant E branch lock — once set, server.js's buildVariantESystemPrompt()
    // selects the branch script by this letter instead of currentStep, so an
    // out-of-sequence step marker can't flip the active branch mid-conversation.
    variantEBranch:      record.variantEBranch      || null
  };
  pool.query(
    `INSERT INTO contacts
       (contact_id, first_name, city, phone, email, practice_name, tags,
        current_step, booked, booked_at, last_message_at, created_at, extra,
        total_api_spend, api_spend_limit_reached, variant, lead_form, paused_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (contact_id) DO UPDATE SET
       first_name              = EXCLUDED.first_name,
       city                    = EXCLUDED.city,
       phone                   = EXCLUDED.phone,
       email                   = EXCLUDED.email,
       practice_name           = EXCLUDED.practice_name,
       tags                    = EXCLUDED.tags,
       current_step            = EXCLUDED.current_step,
       booked                  = EXCLUDED.booked,
       booked_at               = EXCLUDED.booked_at,
       last_message_at         = EXCLUDED.last_message_at,
       extra                   = EXCLUDED.extra,
       total_api_spend         = EXCLUDED.total_api_spend,
       api_spend_limit_reached = EXCLUDED.api_spend_limit_reached,
       variant                 = EXCLUDED.variant,
       lead_form               = EXCLUDED.lead_form,
       paused_reason           = EXCLUDED.paused_reason`,
    [
      record.contactId, record.firstName, record.city,
      record.phone, record.email, record.practiceName,
      JSON.stringify(record.tags || []),
      record.currentStep || 0, record.booked || false,
      record.bookedAt || null, record.lastMessageAt || null,
      record.createdAt || Date.now(),
      JSON.stringify(extra),
      record.totalApiSpend || 0,
      record.apiSpendLimitReached || false,
      record.variant || null,
      record.leadForm || 'unknown',
      record.pausedReason || null
    ]
  ).catch(err => console.error('[Conversations] DB upsert error:', err.message));
}

// Returns a promise that resolves to the rowCount of the insert. Outbound
// rows always have null messageId so ON CONFLICT never fires; inbound rows
// with a duplicate messageId silently no-op (returning rowCount=0), which
// `tryClaimInbound` uses to detect a lost race against another caller.
function _dbInsertExchange(contactId, exchange) {
  return pool.query(
    `INSERT INTO exchanges (contact_id, role, content, step, ts, direction, extra, message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [
      contactId,
      exchange.direction === 'outbound' ? 'assistant' : 'user',
      exchange.body,
      exchange.step || null,
      exchange.timestamp || Date.now(),
      exchange.direction || null,
      JSON.stringify({
        conversationId: exchange.conversationId || null,
        variant: exchange.variant || null,
        // Persist the message-class marker (e.g. 'followup-hook-pos1',
        // 'silence-nudge') so dedup checks survive a server restart.
        type: exchange.type || null
      }),
      exchange.messageId || null
    ]
  ).catch(err => { console.error('[Conversations] DB exchange insert error:', err.message); return { rowCount: 0 }; });
}

// Look up an exchange row by GHL messageId. Returns the row if found, null
// otherwise. Used by the reconciliation poller to dedup — if a missed inbound
// later arrives via the webhook (or vice versa), we never double-process it.
async function hasExchangeWithMessageId(messageId) {
  if (!messageId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM exchanges WHERE message_id = $1 LIMIT 1`,
      [messageId]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[Conversations] hasExchangeWithMessageId error:', err.message);
    return false;
  }
}

// ─── Public sync API (reads from cache) ───────────────────────────────────────

function get(contactId) {
  return _cache[contactId] || null;
}

function set(contactId, record) {
  _cache[contactId] = record;
  _dbUpsertContact(record);
}

function update(contactId, updates) {
  if (!_cache[contactId]) return;
  _cache[contactId] = { ..._cache[contactId], ...updates };
  _dbUpsertContact(_cache[contactId]);
  return _cache[contactId];
}

function getAll() {
  return _cache;
}

function ensureContact(contactId, defaults = {}) {
  if (!_cache[contactId]) {
    _cache[contactId] = {
      contactId,
      firstName:            null,
      city:                 null,
      phone:                null,
      email:                null,
      practiceName:         null,
      researchData:         null,
      scanResults:          null,
      booked:               false,
      currentStep:          0,
      lastMessageAt:        null,
      createdAt:            Date.now(),
      exchanges:            [],
      totalApiSpend:        0,
      apiSpendLimitReached: false,
      variant:              null,
      leadForm:             'unknown',
      ...defaults
    };
    _dbUpsertContact(_cache[contactId]);
  }
  return _cache[contactId];
}

function addExchange(contactId, exchange) {
  if (!_cache[contactId]) return;
  _cache[contactId].exchanges = _cache[contactId].exchanges || [];
  const ts = exchange.timestamp && typeof exchange.timestamp === 'number' && exchange.timestamp > 0
    ? exchange.timestamp : Date.now();
  const ex = {
    direction:      exchange.direction,
    body:           exchange.body,
    step:           exchange.step || null,
    conversationId: exchange.conversationId || null,
    variant:        exchange.variant || null,
    // Message-class marker (e.g. 'followup-hook-pos1', 'silence-nudge') —
    // dedup checks throughout the codebase look at this field. Previously
    // dropped silently, which made every dedup check a no-op.
    type:           exchange.type || null,
    // GHL messageId — required for the reconciliation poller's dedup check
    // (`hasExchangeWithMessageId`). For outbound rows this is always null
    // and `_dbInsertExchange`'s ON CONFLICT clause never fires.
    messageId:      exchange.messageId || null,
    timestamp:      ts
  };
  _cache[contactId].exchanges.push(ex);
  _cache[contactId].lastMessageAt = Date.now();
  _dbInsertExchange(contactId, ex);
  _dbUpsertContact(_cache[contactId]);
}

// Atomic inbound claim. Used by `handleInbound` to guarantee that the
// webhook and the reconciliation poller cannot both proceed past the
// recording step for the same GHL message — only one wins, the other gets
// `false` back and bails before calling Claude. Resolves the race window
// between the cheap-dedup check at the top of handleInbound and the
// addExchange call further down (during which the other caller could
// also have passed the same cheap check).
//
// Returns true if we won (caller should continue), false if the messageId
// was already claimed by another path (caller should silently return).
async function tryClaimInbound(contactId, exchange) {
  if (!_cache[contactId]) return false;
  const ts = exchange.timestamp && typeof exchange.timestamp === 'number' && exchange.timestamp > 0
    ? exchange.timestamp : Date.now();
  const ex = {
    direction:      'inbound',
    body:           exchange.body,
    step:           exchange.step || null,
    conversationId: exchange.conversationId || null,
    variant:        exchange.variant || null,
    type:           exchange.type || null,
    messageId:      exchange.messageId || null,
    timestamp:      ts
  };
  // No messageId means no atomic claim possible — fall back to the
  // pre-existing fire-and-forget behavior. (Should not happen in practice
  // since handleInbound only reaches this for inbounds, but kept for safety.)
  if (!ex.messageId) {
    _cache[contactId].exchanges = _cache[contactId].exchanges || [];
    _cache[contactId].exchanges.push(ex);
    _cache[contactId].lastMessageAt = Date.now();
    _dbInsertExchange(contactId, ex);
    _dbUpsertContact(_cache[contactId]);
    return true;
  }
  const result = await _dbInsertExchange(contactId, ex);
  if (!result || result.rowCount === 0) return false; // lost the race
  _cache[contactId].exchanges = _cache[contactId].exchanges || [];
  _cache[contactId].exchanges.push(ex);
  _cache[contactId].lastMessageAt = Date.now();
  _dbUpsertContact(_cache[contactId]);
  return true;
}

// ─── Lead Form parsing ────────────────────────────────────────────────────────
// Convention: any GHL tag of the form `ampifyform:<slug>` (canonical, e.g.
// `ampifyform:high-volume`, `ampifyform:high-intent`, `ampifyform:high-intent-2FA`)
// is interpreted as the Facebook lead form the contact came from. The `<slug>`
// portion becomes the contact's `leadForm` analytics bucket. Adding a new form
// in GHL (e.g. `ampifyform:high-touch`) automatically creates a new bucket —
// no code change required. The shorter `form:<slug>` prefix is also accepted
// for backward compatibility with any older tag naming. When no matching tag
// is present, the contact is bucketed as `unknown`.
const LEAD_FORM_PREFIXES = ['ampifyform:', 'form:'];
function parseLeadForm(tags) {
  if (!Array.isArray(tags)) return 'unknown';
  for (const t of tags) {
    const s = (typeof t === 'string' ? t : (t?.name || '')).toLowerCase().trim();
    for (const prefix of LEAD_FORM_PREFIXES) {
      if (s.startsWith(prefix)) {
        const slug = s.slice(prefix.length).trim();
        if (slug) return slug;
      }
    }
  }
  return 'unknown';
}

// Kick off DB load immediately — store the promise so callers can await readiness
const _initPromise = initFromDb();

module.exports = { get, set, update, getAll, ensureContact, addExchange, tryClaimInbound, hasExchangeWithMessageId, initFromDb, parseLeadForm, whenReady: () => _initPromise };
