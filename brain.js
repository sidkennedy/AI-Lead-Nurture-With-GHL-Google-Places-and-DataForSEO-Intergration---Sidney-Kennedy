const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

const MESSAGES_FILE = path.join(__dirname, 'data', 'messages.json');
const PATTERNS_FILE = path.join(__dirname, 'data', 'winning-patterns.json');
const REPLY_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

// ─── DB pool ──────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Reads are always synchronous from here; writes go to cache + DB asynchronously.
let _messagesCache = [];
let _ready = false;

// ─── DB bootstrap ─────────────────────────────────────────────────────────────

function _rowToMsg(row) {
  return {
    id:                  row.id,
    contactId:           row.contact_id,
    direction:           row.direction,
    body:                row.body,
    stage:               row.stage,
    step:                row.step,
    message_type:        row.message_type,
    messageClass:        row.message_class,
    position:            row.position,
    had_enrichment_data: row.had_enrichment_data,
    variant:             row.variant,
    leadForm:            row.lead_form || null,
    length_chars:        row.length_chars,
    timestamp:           Number(row.timestamp),
    repliedWithin48h:    row.replied_within_48h,
    repliedAt:           row.replied_at !== null ? Number(row.replied_at) : null,
    booked:              row.booked
  };
}

async function initFromDb() {
  try {
    // Auto-create the table — safe to run on every startup (idempotent)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brain_messages (
        id                  TEXT    PRIMARY KEY,
        contact_id          TEXT    NOT NULL,
        direction           TEXT    NOT NULL,
        body                TEXT,
        stage               TEXT,
        step                INTEGER,
        message_type        TEXT,
        message_class       TEXT,
        position            INTEGER,
        had_enrichment_data BOOLEAN,
        variant             TEXT,
        length_chars        INTEGER,
        timestamp           BIGINT  NOT NULL,
        replied_within_48h  BOOLEAN,
        replied_at          BIGINT,
        booked              BOOLEAN NOT NULL DEFAULT false
      )
    `);
    // Migrate existing tables that predate the message_class / lead_form columns
    await pool.query(
      `ALTER TABLE brain_messages ADD COLUMN IF NOT EXISTS message_class TEXT`
    ).catch(() => {});
    await pool.query(
      `ALTER TABLE brain_messages ADD COLUMN IF NOT EXISTS lead_form TEXT`
    ).catch(() => {});

    const { rows } = await pool.query('SELECT * FROM brain_messages ORDER BY timestamp ASC');
    if (rows.length === 0) {
      // Try JSON migration first (legacy path), then fall back to exchange backfill
      const jsonOk = _migrateFromJson();
      if (!jsonOk) {
        await _backfillFromExchanges();
      }
    } else {
      _messagesCache = rows.map(_rowToMsg);
      console.log(`[Brain] DB loaded: ${_messagesCache.length} messages`);
    }
  } catch (err) {
    console.error('[Brain] DB init error:', err.message);
  }
  // Restore winning patterns from DB if the local file is missing (e.g. after redeploy)
  await _restorePatternsFromDb();
  _ready = true;
}

// Returns true if messages were loaded from the JSON file, false otherwise
function _migrateFromJson() {
  try {
    if (!fs.existsSync(MESSAGES_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    if (!Array.isArray(data) || data.length === 0) return false;
    _messagesCache = data;
    console.log(`[Brain] Migrating ${data.length} messages from JSON to DB`);
    for (const msg of data) {
      _dbInsertMessage(msg);
    }
    return true;
  } catch (err) {
    console.error('[Brain] JSON migration error:', err.message);
    return false;
  }
}

// Reconstruct brain_messages from the exchanges table when brain_messages is empty.
// Computes replied_within_48h by checking for an inbound exchange within 48h of each
// outbound exchange from the same contact. Booking status is taken from contacts.booked.
async function _backfillFromExchanges() {
  try {
    const { rows: inserted } = await pool.query(`
      WITH first_reply AS (
        SELECT
          o.id   AS outbound_id,
          MIN(i.ts)::bigint AS replied_at
        FROM exchanges o
        JOIN exchanges i
          ON  i.contact_id = o.contact_id
          AND i.direction  = 'inbound'
          AND i.ts > o.ts
          AND i.ts <= o.ts + 172800000
        WHERE o.direction = 'outbound'
        GROUP BY o.id
      )
      INSERT INTO brain_messages
        (id, contact_id, direction, body, step, length_chars, timestamp,
         variant, booked, replied_within_48h, replied_at)
      SELECT
        'bk-' || e.id::text,
        e.contact_id,
        e.direction,
        e.content,
        e.step,
        LENGTH(COALESCE(e.content, '')),
        e.ts::bigint,
        COALESCE(e.extra->>'variant', c.variant),
        CASE WHEN e.direction = 'outbound' THEN COALESCE(c.booked, false) ELSE false END,
        CASE WHEN e.direction = 'outbound' THEN (fr.replied_at IS NOT NULL)  ELSE NULL END,
        fr.replied_at
      FROM exchanges e
      LEFT JOIN contacts c ON c.contact_id = e.contact_id
      LEFT JOIN first_reply fr ON fr.outbound_id = e.id
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `);

    if (inserted.length > 0) {
      const { rows } = await pool.query('SELECT * FROM brain_messages ORDER BY timestamp ASC');
      _messagesCache = rows.map(_rowToMsg);
      console.log(`[Brain] Backfilled ${inserted.length} messages from exchanges table`);
    }
  } catch (err) {
    console.error('[Brain] Exchange backfill error:', err.message);
  }
}

// ─── DB write helpers (fire-and-forget) ───────────────────────────────────────

function _dbInsertMessage(msg) {
  pool.query(
    `INSERT INTO brain_messages
       (id, contact_id, direction, body, stage, step, message_type, message_class, position,
        had_enrichment_data, variant, length_chars, timestamp,
        replied_within_48h, replied_at, booked, lead_form)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (id) DO NOTHING`,
    [
      msg.id, msg.contactId, msg.direction, msg.body || null,
      msg.stage || null, msg.step ?? null, msg.message_type || null,
      msg.messageClass || null,
      msg.position ?? null, msg.had_enrichment_data ?? null,
      msg.variant ?? null, msg.length_chars ?? null,
      msg.timestamp, msg.repliedWithin48h ?? null,
      msg.repliedAt ?? null, msg.booked || false,
      msg.leadForm ?? null
    ]
  ).catch(err => console.error('[Brain] DB insert error:', err.message));
}

function _dbUpdateMessage(id, updates) {
  const fields = [];
  const vals = [];
  let idx = 1;
  if ('repliedWithin48h' in updates) { fields.push(`replied_within_48h = $${idx++}`); vals.push(updates.repliedWithin48h); }
  if ('repliedAt'        in updates) { fields.push(`replied_at = $${idx++}`);          vals.push(updates.repliedAt); }
  if ('booked'           in updates) { fields.push(`booked = $${idx++}`);               vals.push(updates.booked); }
  if ('message_type'     in updates) { fields.push(`message_type = $${idx++}`);         vals.push(updates.message_type); }
  if ('messageClass'     in updates) { fields.push(`message_class = $${idx++}`);        vals.push(updates.messageClass); }
  if ('position'         in updates) { fields.push(`position = $${idx++}`);             vals.push(updates.position); }
  if ('had_enrichment_data' in updates) { fields.push(`had_enrichment_data = $${idx++}`); vals.push(updates.had_enrichment_data); }
  if ('length_chars'     in updates) { fields.push(`length_chars = $${idx++}`);         vals.push(updates.length_chars); }
  if (fields.length === 0) return;
  vals.push(id);
  pool.query(
    `UPDATE brain_messages SET ${fields.join(', ')} WHERE id = $${idx}`,
    vals
  ).catch(err => console.error('[Brain] DB update error:', err.message));
}

function _dbUpdateBookingForContact(contactId) {
  pool.query(
    `UPDATE brain_messages SET booked = true WHERE contact_id = $1 AND direction = 'outbound'`,
    [contactId]
  ).catch(err => console.error('[Brain] DB booking update error:', err.message));
}

function _dbSavePatterns(patterns) {
  pool.query(
    `INSERT INTO winning_patterns (key, data, updated_at)
     VALUES ('main', $1, $2)
     ON CONFLICT (key) DO UPDATE SET data = $1, updated_at = $2`,
    [JSON.stringify(patterns), Date.now()]
  ).catch(err => console.error('[Brain] DB patterns save error:', err.message));
}

async function _restorePatternsFromDb() {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS winning_patterns (
         key        TEXT    PRIMARY KEY,
         data       TEXT    NOT NULL,
         updated_at BIGINT  NOT NULL DEFAULT 0
       )`
    );
    const { rows } = await pool.query(`SELECT data FROM winning_patterns WHERE key = 'main'`);
    if (rows.length === 0) {
      // DB is empty — seed from local file if it exists (first-time backup)
      if (fs.existsSync(PATTERNS_FILE)) {
        const fileData = fs.readFileSync(PATTERNS_FILE, 'utf8');
        await pool.query(
          `INSERT INTO winning_patterns (key, data, updated_at) VALUES ('main', $1, $2)
           ON CONFLICT (key) DO NOTHING`,
          [fileData, Date.now()]
        );
        console.log('[Brain] Winning patterns backed up to DB');
      }
    } else {
      // DB has data — always sync to file so loadPatterns() stays current
      ensureDir();
      fs.writeFileSync(PATTERNS_FILE, rows[0].data);
      console.log('[Brain] Winning patterns synced from DB');
    }
  } catch (err) {
    console.error('[Brain] DB patterns restore error:', err.message);
  }
}

// Lazy-init Anthropic (avoids issues if env isn't loaded yet)
let _ai = null;
function getAI() {
  if (!_ai) {
    const Anthropic = require('@anthropic-ai/sdk');
    _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _ai;
}

// ─── Stage Classification ─────────────────────────────────────────────────────
// Maps conversation step number to a human-readable stage label.
// Steps come from the [STEP:N] markers in config.js conversation flow.

const STAGE_MAP = {
  0: 'unknown',
  1: 'first-touch',
  2: 'gap-exposure',
  3: 'gap-exposure',
  4: 'data-reveal',
  5: 'booking',
  6: 'booked'
};

function classifyStage(step) {
  if (step === null || step === undefined) return 'unknown';
  return STAGE_MAP[step] || (step > 6 ? 'booked' : 'unknown');
}

// ─── File Helpers ─────────────────────────────────────────────────────────────

function ensureDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Returns the current in-memory cache (sync). Replaces the old file-based loadMessages().
function loadMessages() {
  return _messagesCache;
}

function loadPatterns() {
  try {
    ensureDir();
    if (!fs.existsSync(PATTERNS_FILE)) return {};
    return JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
  } catch { return {}; }
}

function savePatterns(patterns) {
  try {
    ensureDir();
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
  } catch (err) {
    console.error('[Brain] Write error (patterns):', err.message);
  }
  _dbSavePatterns(patterns);
}

// ─── Message ID ───────────────────────────────────────────────────────────────

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Pattern Key ─────────────────────────────────────────────────────────────
// Cluster messages by their first sentence (split on ./?/!), lowercased and
// stripped of punctuation — a more meaningful proxy for message "template" than
// a fixed character count.

function patternKey(body) {
  const text = (body || '');
  const m = text.match(/^[^.?!]+[.?!]?/);
  const first = m ? m[0] : text.slice(0, 120);
  return first
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record an outbound message from the AI.
 * @param {string} contactId
 * @param {string} body        — cleaned message text (no hidden markers)
 * @param {number|null} step   — conversation step (from [STEP:N])
 * @param {object} [meta]      — optional metadata
 * @param {string} [meta.message_type]       — 'scripted-sms' | 'followup-sms' | 'email'
 * @param {string} [meta.messageClass]       — 'conversation'|'hook-1'|'hook-2'|'hook-3'|'nurture'
 * @param {number|null} [meta.position]      — follow-up hook/nurture position (1-5)
 * @param {boolean|null} [meta.had_enrichment_data] — research data was available when sent
 * @param {string|null} [meta.variant]       — A/B/C discovery script variant (null = legacy)
 * @param {string} [meta.leadForm]            — Lead form bucket (`high-volume`, `high-intent`, `high-intent-2fa`, `unknown`).
 *                                              When omitted, the current value on the contact record is snapshotted.
 */
function recordOutbound(contactId, body, step, meta = {}) {
  const stage = classifyStage(step);
  const message_type = meta.message_type ||
    (step !== null && step !== undefined ? 'scripted-sms' : 'followup-sms');
  // Snapshot the contact's current leadForm onto the message so historical
  // analytics stay accurate even if the contact's GHL tags change later.
  // Lazy-require avoids a circular dep between brain.js and conversations.js.
  let leadForm = meta.leadForm;
  if (leadForm === undefined) {
    try { leadForm = require('./conversations').get(contactId)?.leadForm || 'unknown'; }
    catch { leadForm = 'unknown'; }
  }
  const msg = {
    id: makeId(),
    contactId,
    direction: 'outbound',
    body,
    stage,
    step: step ?? null,
    message_type,
    messageClass: meta.messageClass ?? null,
    position: meta.position ?? null,
    had_enrichment_data: meta.had_enrichment_data ?? null,
    variant: meta.variant ?? null,
    leadForm: leadForm || 'unknown',
    length_chars: (body || '').length,
    timestamp: Date.now(),
    repliedWithin48h: null,
    repliedAt: null,
    booked: false
  };
  _messagesCache.push(msg);
  _dbInsertMessage(msg);
}

/**
 * Record an inbound message from the prospect.
 * Stored for contact history and inbound counting in stats.
 * @param {string} contactId
 * @param {string} body       — raw message text from prospect
 * @param {number|null} step  — current conversation step at time of receipt
 */
function recordInbound(contactId, body, step) {
  const stage = classifyStage(step);
  const msg = {
    id: makeId(),
    contactId,
    direction: 'inbound',
    body,
    stage,
    step: step ?? null,
    timestamp: Date.now(),
    repliedWithin48h: null,
    repliedAt: null,
    booked: false
  };
  _messagesCache.push(msg);
  _dbInsertMessage(msg);
}

/**
 * When an inbound message arrives, mark the most recent outbound for this
 * contact as replied (if within the 48-hour window).
 * @param {string} contactId
 */
function recordReply(contactId) {
  const now = Date.now();

  // Cross-channel attribution: credit the last unreplied outbound message for
  // this contact regardless of channel (sms_scripted, followup-sms, or email).
  // If the last thing we sent was an email and the prospect replies via SMS,
  // the email gets the credit — and vice versa. "Last outbound wins" is the
  // rule. No channel filter is applied intentionally.
  let lastOutboundIdx = -1;
  for (let i = _messagesCache.length - 1; i >= 0; i--) {
    const m = _messagesCache[i];
    if (m.contactId === contactId && m.direction === 'outbound' && m.repliedAt === null) {
      lastOutboundIdx = i;
      break;
    }
  }

  if (lastOutboundIdx === -1) return;

  const msg = _messagesCache[lastOutboundIdx];
  const withinWindow = now - msg.timestamp <= REPLY_WINDOW_MS;
  const updates = { repliedWithin48h: withinWindow, repliedAt: now };

  const channel = msg.message_type || 'sms_scripted';
  console.log(`[Brain] Crediting reply to ${channel} message (id=${msg.id}) for contact ${contactId} — within48h=${withinWindow}`);

  _messagesCache[lastOutboundIdx] = { ...msg, ...updates };
  _dbUpdateMessage(msg.id, updates);
}

/**
 * Mark all outbound messages for a contact as booked (the ultimate signal).
 * @param {string} contactId
 */
function recordBooking(contactId) {
  let changed = false;
  for (let i = 0; i < _messagesCache.length; i++) {
    if (_messagesCache[i].contactId === contactId && _messagesCache[i].direction === 'outbound') {
      _messagesCache[i] = { ..._messagesCache[i], booked: true };
      changed = true;
    }
  }
  if (changed) _dbUpdateBookingForContact(contactId);
}

// ─── Backfill ─────────────────────────────────────────────────────────────────
// Add any metadata fields that are missing on old outbound records so existing
// data participates in 3-channel analysis without breaking anything.

function backfillMessages(messages) {
  let anyChanged = false;
  const result = messages.map(m => {
    if (m.direction !== 'outbound') return m;
    const updates = {};
    if (m.message_type === undefined) {
      // Infer channel: records without a step came from follow-up code paths
      updates.message_type = (m.step !== null && m.step !== undefined)
        ? 'scripted-sms'
        : 'followup-sms';
    }
    if (m.position          === undefined) updates.position          = null;
    if (m.had_enrichment_data === undefined) updates.had_enrichment_data = null;
    if (m.length_chars      === undefined) updates.length_chars      = (m.body || '').length;
    // Derive messageClass from position for followup-sms records that are missing it
    const effectiveType     = updates.message_type ?? m.message_type;
    const effectivePosition = updates.position     ?? m.position;
    if (
      (m.messageClass === undefined || m.messageClass === null) &&
      effectiveType === 'followup-sms' &&
      effectivePosition !== null && effectivePosition !== undefined
    ) {
      updates.messageClass = effectivePosition >= 4 ? 'nurture'
        : effectivePosition === 3               ? 'hook-3'
        : effectivePosition === 2               ? 'hook-2'
        : 'hook-1';
    }
    if (Object.keys(updates).length > 0) {
      anyChanged = true;
      return { ...m, ...updates };
    }
    return m;
  });
  return { messages: result, changed: anyChanged };
}

// ─── Analysis ────────────────────────────────────────────────────────────────

/**
 * Run the analysis job. Splits outbound messages into three channels
 * (sms_scripted, sms_followups, email), groups each by stage + first-sentence
 * pattern cluster, calculates reply/booking rates, adds sample_size and
 * confidence_level, and writes the top 3 per stage/channel to
 * winning-patterns.json.
 *
 * @returns {object} The winning patterns object
 */
function runAnalysis() {
  const now = Date.now();

  // Settle any pending outbound messages older than 48h with no reply → mark false
  for (let i = 0; i < _messagesCache.length; i++) {
    const m = _messagesCache[i];
    if (
      m.direction === 'outbound' &&
      m.repliedWithin48h === null &&
      m.repliedAt === null &&
      now - m.timestamp > REPLY_WINDOW_MS
    ) {
      _messagesCache[i] = { ...m, repliedWithin48h: false };
      _dbUpdateMessage(m.id, { repliedWithin48h: false });
    }
  }

  // Backfill any missing metadata fields on old records
  const { messages: backfilled, changed } = backfillMessages(_messagesCache);
  if (changed) {
    for (let i = 0; i < backfilled.length; i++) {
      const orig = _messagesCache[i];
      const updated = backfilled[i];
      if (orig !== updated) {
        _messagesCache[i] = updated;
        const updates = {};
        if (orig.message_type      !== updated.message_type)      updates.message_type      = updated.message_type;
        if (orig.position          !== updated.position)          updates.position          = updated.position;
        if (orig.had_enrichment_data !== updated.had_enrichment_data) updates.had_enrichment_data = updated.had_enrichment_data;
        if (orig.length_chars      !== updated.length_chars)      updates.length_chars      = updated.length_chars;
        if (orig.messageClass      !== updated.messageClass)      updates.messageClass      = updated.messageClass;
        if (Object.keys(updates).length > 0) _dbUpdateMessage(updated.id, updates);
      }
    }
    console.log('[Brain] Backfilled metadata fields on existing messages');
  }

  let messages = _messagesCache;

  // Only count settled outbound messages (exclude null/pending) in analysis
  const outbound = messages.filter(m => m.direction === 'outbound' && m.repliedWithin48h !== null);

  if (outbound.length === 0) {
    console.log('[Brain] No settled outbound messages yet — skipping analysis');
    return {};
  }

  // Split by channel (messages without message_type default to scripted-sms)
  const channels = {
    sms_scripted:  outbound.filter(m => (m.message_type || 'scripted-sms') === 'scripted-sms'),
    sms_followups: outbound.filter(m => m.message_type === 'followup-sms'),
    email:         outbound.filter(m => m.message_type === 'email')
  };

  const winning = {};

  for (const [channel, msgs] of Object.entries(channels)) {
    if (msgs.length === 0) continue;

    // Group by stage → first-sentence pattern cluster
    const grouped = {};
    for (const msg of msgs) {
      const stage = msg.stage || 'unknown';
      const key   = patternKey(msg.body);
      if (!grouped[stage]) grouped[stage] = {};
      if (!grouped[stage][key]) {
        grouped[stage][key] = {
          pattern: key,
          example: msg.body.slice(0, 120),
          count: 0,
          replies: 0,
          bookings: 0
        };
      }
      grouped[stage][key].count++;
      if (msg.repliedWithin48h) grouped[stage][key].replies++;
      if (msg.booked)           grouped[stage][key].bookings++;
    }

    // Rank patterns per stage and take top 3
    const channelWinning = {};
    for (const [stage, patterns] of Object.entries(grouped)) {
      // Email needs more sends before a pattern is worth ranking (higher noise floor)
      const minSends = channel === 'email' ? 5 : 2;

      const ranked = Object.values(patterns)
        .filter(p => p.count >= minSends)
        .map(p => ({
          ...p,
          replyRate:   p.count > 0 ? Math.round((p.replies  / p.count) * 100) : 0,
          bookingRate: p.count > 0 ? Math.round((p.bookings / p.count) * 100) : 0,
          sample_size: p.count,
          reply_count: p.replies,
          // Both channels use actual reply count as the confidence signal.
          // Volume alone (sends) is not a performance indicator — replies are.
          // SMS thresholds are set higher than email because SMS operates at
          // greater volume and needs more reply signal before the pattern is reliable.
          //
          // Email: low = <10 replies  → don't inject (too little data)
          //        medium = 10–29     → promising, lean toward it
          //        high   = 30+       → strong signal, default to this
          //
          // SMS:   low = <20 replies  → don't inject (too little data)
          //        medium = 20–49     → promising, lean toward it
          //        high   = 50+       → strong signal, default to this
          confidence_level: channel === 'email'
            ? (p.replies >= 30 ? 'high' : p.replies >= 10 ? 'medium' : 'low')
            : (p.replies >= 50 ? 'high' : p.replies >= 20 ? 'medium' : 'low')
        }))
        .sort((a, b) => b.replyRate - a.replyRate || b.bookingRate - a.bookingRate)
        .slice(0, 3);

      if (ranked.length > 0) channelWinning[stage] = ranked;
    }

    channelWinning._meta = {
      analyzedAt:       Date.now(),
      totalMessages:    msgs.length,
      distinctContacts: new Set(msgs.map(m => m.contactId)).size
    };

    winning[channel] = channelWinning;
  }

  winning._meta = {
    analyzedAt:       Date.now(),
    totalMessages:    outbound.length,
    distinctContacts: new Set(outbound.map(m => m.contactId)).size
  };

  // ── Hook-position performance summary ──────────────────────────────────────
  // Counts settled outbound messages grouped by messageClass (hook-1, hook-2, etc.)
  const HOOK_CLASSES = ['conversation', 'hook-1', 'hook-2', 'hook-3', 'nurture'];
  const hookPositionStats = {};
  for (const cls of HOOK_CLASSES) {
    hookPositionStats[cls] = { sent: 0, replied: 0, replyRate: null };
  }
  for (const m of outbound) {
    const cls = m.messageClass;
    if (!cls || !hookPositionStats[cls]) continue;
    hookPositionStats[cls].sent++;
    if (m.repliedWithin48h) hookPositionStats[cls].replied++;
  }
  for (const cls of HOOK_CLASSES) {
    const h = hookPositionStats[cls];
    h.replyRate = h.sent > 0 ? Math.round((h.replied / h.sent) * 100) : null;
  }
  winning.hookPositionStats = hookPositionStats;

  // ── Variant performance summary ────────────────────────────────────────────
  // Group settled scripted-sms messages by variant and store alongside patterns.
  // `messages` at this point already has pending > 48h resolved to repliedWithin48h:false.
  const variantMsgs = messages.filter(m =>
    m.direction === 'outbound' &&
    (m.message_type === 'scripted-sms' || (m.step !== null && m.step !== undefined)) &&
    m.variant !== null && m.variant !== undefined &&
    m.repliedWithin48h !== null
  );

  const vByVariant = {};
  const vContactsByVariant = {};
  for (const m of variantMsgs) {
    const v = m.variant;
    if (!vByVariant[v]) { vByVariant[v] = { sent: 0, replied: 0, booked: 0 }; vContactsByVariant[v] = new Set(); }
    vByVariant[v].sent++;
    vContactsByVariant[v].add(m.contactId);
    if (m.repliedWithin48h) vByVariant[v].replied++;
    if (m.booked)           vByVariant[v].booked++;
  }
  winning.variantStats = [...config.SCRIPTED_VARIANTS, 'E'].map(v => {
    const s = vByVariant[v] || { sent: 0, replied: 0, booked: 0 };
    const contacts = vContactsByVariant[v]?.size || 0;
    return {
      variant: v,
      contactsAssigned: contacts,
      sent: s.sent,
      replied: s.replied,
      replyRate: s.sent > 0 ? Math.round((s.replied / s.sent) * 100) : null,
      booked: s.booked,
      bookingRate: s.sent > 0 ? Math.round((s.booked / s.sent) * 100) : null,
      analyzedAt: Date.now()
    };
  });

  savePatterns(winning);

  const stageCount = ['sms_scripted', 'sms_followups', 'email'].reduce((acc, ch) => {
    if (!winning[ch]) return acc;
    return acc + Object.keys(winning[ch]).filter(k => k !== '_meta').length;
  }, 0);
  console.log(`[Brain] Analysis complete — ${outbound.length} messages across 3 channels, ${stageCount} stage/channel combos with patterns`);
  return winning;
}

/**
 * Return the current winning patterns for a given stage (from last analysis run).
 * Returns null if no patterns exist yet or fewer than 2 data points.
 * @param {string} stage
 * @param {string} [channel] — 'sms_scripted' | 'sms_followups' | 'email' (default: 'sms_scripted')
 */
function getWinningPatterns(stage, channel = 'sms_scripted') {
  const patterns = loadPatterns();
  // New 3-channel structure
  const channelData = patterns[channel];
  if (channelData) {
    const stagePatterns = channelData[stage];
    if (stagePatterns && stagePatterns.length > 0) return stagePatterns;
  }
  // Backward compatibility: old flat structure (stage at top level)
  const flat = patterns[stage];
  if (flat && Array.isArray(flat) && flat.length > 0) return flat;
  return null;
}

/**
 * Return full stats summary (all stages + meta).
 *
 * Lead-form analytics: every outbound message snapshots the contact's
 * `leadForm` at send time. We aggregate two views:
 *   - `byLeadForm`   — sent / replied / booked / replyRate / bookingRate per form
 *   - `byLeadFormVariant` — same metrics broken down by (leadForm × A/B/C/D variant)
 * so the dashboard can both show overall form performance and filter the
 * variant performance view by form. Forms appear automatically as soon as
 * the matching `ampifyform:<slug>` GHL tag shows up.
 */
function getStats(contactIdFilter) {
  const messages = loadMessages();
  const patterns = loadPatterns();

  // When a contactIdFilter Set is provided, restrict all calculations to that cohort
  const msgs = contactIdFilter
    ? messages.filter(m => contactIdFilter.has(m.contactId))
    : messages;

  const outbound = msgs.filter(m => m.direction === 'outbound');
  const inbound = msgs.filter(m => m.direction === 'inbound');

  const settled = outbound.filter(m => m.repliedWithin48h !== null);
  const repliedMsgs = settled.filter(m => m.repliedWithin48h === true);

  const inboundByContact = {};
  for (const m of inbound) {
    inboundByContact[m.contactId] = (inboundByContact[m.contactId] || 0) + 1;
  }
  const contactsRepliedOnce  = Object.values(inboundByContact).filter(n => n >= 1).length;
  const contactsReplied4Plus = Object.values(inboundByContact).filter(n => n >= 4).length;

  const byStage = {};
  for (const msg of outbound) {
    const stage = msg.stage || 'unknown';
    if (!byStage[stage]) byStage[stage] = { sent: 0, replied: 0, booked: 0 };
    byStage[stage].sent++;
    if (msg.repliedWithin48h) byStage[stage].replied++;
    if (msg.booked) byStage[stage].booked++;
  }

  // Per-hook-position breakdown — only settled messages (repliedWithin48h !== null)
  // are counted so pending sends don't dilute the reply rate, matching runAnalysis().
  const HOOK_CLASSES = ['conversation', 'hook-1', 'hook-2', 'hook-3', 'nurture'];
  const byHookPosition = {};
  for (const cls of HOOK_CLASSES) {
    byHookPosition[cls] = { sent: 0, replied: 0, replyRate: null };
  }
  for (const msg of settled) {
    const cls = msg.messageClass;
    if (!cls || !byHookPosition[cls]) continue;
    byHookPosition[cls].sent++;
    if (msg.repliedWithin48h) byHookPosition[cls].replied++;
  }
  for (const cls of HOOK_CLASSES) {
    const b = byHookPosition[cls];
    b.replyRate = b.sent > 0 ? Math.round((b.replied / b.sent) * 100) : null;
  }

  // ── Per-Lead-Form breakdown ────────────────────────────────────────────────
  // Reply / booking rates are calculated against settled outbound messages so
  // pending sends don't dilute the rate. Booked count is per-contact (not per
  // message) so a single booking isn't multi-counted across hooks.
  const byLeadForm = {};
  function ensureForm(name) {
    if (!byLeadForm[name]) {
      byLeadForm[name] = {
        sent: 0, settled: 0, replied: 0,
        bookedContacts: new Set(),
        contacts: new Set(),
        replyRate: null,
        bookingRate: null
      };
    }
    return byLeadForm[name];
  }
  for (const msg of outbound) {
    const lf = msg.leadForm || 'unknown';
    const b = ensureForm(lf);
    b.sent++;
    b.contacts.add(msg.contactId);
    if (msg.repliedWithin48h !== null) b.settled++;
    if (msg.repliedWithin48h === true) b.replied++;
    if (msg.booked) b.bookedContacts.add(msg.contactId);
  }
  // Finalize: convert Sets → counts and compute rates
  const byLeadFormFinal = {};
  for (const [name, b] of Object.entries(byLeadForm)) {
    byLeadFormFinal[name] = {
      leads:       b.contacts.size,
      sent:        b.sent,
      settled:     b.settled,
      replied:     b.replied,
      booked:      b.bookedContacts.size,
      replyRate:   b.settled > 0       ? Math.round((b.replied / b.settled) * 100) : null,
      bookingRate: b.contacts.size > 0 ? Math.round((b.bookedContacts.size / b.contacts.size) * 100) : null
    };
  }

  // ── Per-(Lead-Form × Variant) cross-tab ────────────────────────────────────
  // Restricted to scripted-sms messages with a non-null variant assignment so it
  // matches the existing variant-performance view.
  const byLeadFormVariant = {};
  function ensureCell(form, variant) {
    if (!byLeadFormVariant[form]) byLeadFormVariant[form] = {};
    if (!byLeadFormVariant[form][variant]) {
      byLeadFormVariant[form][variant] = {
        sent: 0, settled: 0, replied: 0,
        bookedContacts: new Set(),
        contacts: new Set()
      };
    }
    return byLeadFormVariant[form][variant];
  }
  for (const msg of outbound) {
    if (!msg.variant) continue;
    const isScripted = msg.message_type === 'scripted-sms' ||
                       (msg.step !== null && msg.step !== undefined);
    if (!isScripted) continue;
    const cell = ensureCell(msg.leadForm || 'unknown', msg.variant);
    cell.sent++;
    cell.contacts.add(msg.contactId);
    if (msg.repliedWithin48h !== null) cell.settled++;
    if (msg.repliedWithin48h === true) cell.replied++;
    if (msg.booked) cell.bookedContacts.add(msg.contactId);
  }
  const byLeadFormVariantFinal = {};
  for (const [form, variants] of Object.entries(byLeadFormVariant)) {
    byLeadFormVariantFinal[form] = {};
    for (const [variant, c] of Object.entries(variants)) {
      byLeadFormVariantFinal[form][variant] = {
        contactsAssigned: c.contacts.size,
        sent:        c.sent,
        settled:     c.settled,
        replied:     c.replied,
        booked:      c.bookedContacts.size,
        replyRate:   c.settled > 0       ? Math.round((c.replied / c.settled) * 100) : null,
        bookingRate: c.contacts.size > 0 ? Math.round((c.bookedContacts.size / c.contacts.size) * 100) : null
      };
    }
  }

  return {
    totals: {
      outbound:             outbound.length,
      inbound:              inbound.length,
      settled:              settled.length,
      repliedMsgs:          repliedMsgs.length,
      contacts:             new Set(msgs.map(m => m.contactId)).size,
      booked:               new Set(outbound.filter(m => m.booked).map(m => m.contactId)).size,
      contactsRepliedOnce:  contactsRepliedOnce,
      contactsReplied4Plus: contactsReplied4Plus
    },
    byStage,
    byHookPosition,
    byLeadForm:        byLeadFormFinal,
    byLeadFormVariant: byLeadFormVariantFinal,
    winningPatterns: patterns,
    patternsUpdatedAt: patterns._meta?.analyzedAt || null
  };
}

// ─── Variant Performance Stats ───────────────────────────────────────────────

/**
 * Return per-variant performance stats for discovery-script messages (scripted-sms).
 * Only counts settled messages (repliedWithin48h !== null).
 * Returns an array of { variant, contactsAssigned, sent, replied, replyRate, booked, bookingRate }
 */
function getVariantStats() {
  const messages = loadMessages();
  const now = Date.now();

  // Settle any pending > 48h first (read-only view — don't save)
  const settled = messages.map(m => {
    if (
      m.direction === 'outbound' &&
      m.repliedWithin48h === null &&
      m.repliedAt === null &&
      now - m.timestamp > REPLY_WINDOW_MS
    ) {
      return { ...m, repliedWithin48h: false };
    }
    return m;
  });

  // Only scripted discovery messages with a non-null variant assignment
  const scripted = settled.filter(m =>
    m.direction === 'outbound' &&
    (m.message_type === 'scripted-sms' || (m.step !== null && m.step !== undefined)) &&
    m.variant !== null && m.variant !== undefined &&
    m.repliedWithin48h !== null
  );

  const byVariant = {};
  const contactsByVariant = {};

  for (const m of scripted) {
    const v = m.variant;
    if (!byVariant[v]) {
      byVariant[v] = { sent: 0, replied: 0, booked: 0 };
      contactsByVariant[v] = new Set();
    }
    byVariant[v].sent++;
    contactsByVariant[v].add(m.contactId);
    if (m.repliedWithin48h) byVariant[v].replied++;
    if (m.booked)           byVariant[v].booked++;
  }

  return [...config.SCRIPTED_VARIANTS, 'E'].map(v => {
    const s = byVariant[v] || { sent: 0, replied: 0, booked: 0 };
    const contacts = contactsByVariant[v]?.size || 0;
    return {
      variant: v,
      contactsAssigned: contacts,
      sent: s.sent,
      replied: s.replied,
      replyRate: s.sent > 0 ? Math.round((s.replied / s.sent) * 100) : null,
      booked: s.booked,
      bookingRate: s.sent > 0 ? Math.round((s.booked / s.sent) * 100) : null
    };
  });
}

// ─── Build prompt snippet for winning patterns ────────────────────────────────

/**
 * Returns a short text block to inject into the system prompt,
 * highlighting what's been working for this stage.
 * Only high and medium confidence patterns are included.
 * Low confidence = not enough actual replies yet (email: <10, SMS: <20).
 * @param {string} stage
 * @param {string} [channel] — 'sms_scripted' | 'sms_followups' | 'email'
 */
function buildWinningPatternsPrompt(stage, channel = 'sms_scripted') {
  const patterns = getWinningPatterns(stage, channel);
  if (!patterns || patterns.length === 0) return '';

  // Filter out low-confidence patterns — not enough data to be reliable
  const confident = patterns.filter(p =>
    !p.confidence_level || p.confidence_level !== 'low'
  );
  if (confident.length === 0) return '';

  const lines = confident.map((p, i) => {
    const conf = p.confidence_level ? ` [${p.confidence_level} confidence, ${p.sample_size ?? p.count} samples]` : '';
    return `  ${i + 1}. "${p.example.slice(0, 80)}..." — ${p.replyRate}% reply rate${p.bookingRate > 0 ? `, ${p.bookingRate}% booking rate` : ''}${conf}`;
  });

  return `\n\nWINNING PATTERNS FOR STAGE "${stage}" (based on real conversation data — lean toward these openings):\n${lines.join('\n')}`;
}

// ─── LLM Qualitative Analysis ────────────────────────────────────────────────

/**
 * Run a Claude-powered qualitative analysis of the statistical patterns.
 * Uses the configurable brain.analysisPrompt (editable via prompt editor UI).
 * Stores the result in winning-patterns.json as _qualitativeInsights.
 *
 * This is called after runAnalysis() during each scheduled 72h analysis job.
 */
async function runLlmAnalysis(patterns) {
  const prompts = require('./prompts');
  const systemPrompt = prompts.get('brain.analysisPrompt');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[Brain] LLM analysis skipped — ANTHROPIC_API_KEY not set');
    return;
  }

  // Build a summary across all three channels
  const CHANNELS = ['sms_scripted', 'sms_followups', 'email'];
  const summaryParts = [];
  for (const channel of CHANNELS) {
    const channelData = patterns[channel];
    if (!channelData) continue;
    const section = Object.entries(channelData)
      .filter(([k]) => k !== '_meta')
      .map(([stage, pats]) => `  Stage: ${stage}\n${pats.map(p =>
        `    Pattern: "${p.example.slice(0, 100)}..." | Sends: ${p.count} | Reply: ${p.replyRate}% | Booked: ${p.bookingRate}% | Confidence: ${p.confidence_level || 'unknown'}`
      ).join('\n')}`)
      .join('\n');
    if (section) summaryParts.push(`=== Channel: ${channel} ===\n${section}`);
  }

  // Fallback to old flat structure if the new channels aren't populated
  if (summaryParts.length === 0) {
    const flat = Object.entries(patterns)
      .filter(([k]) => !['_meta', '_qualitativeInsights', ...CHANNELS].includes(k))
      .map(([stage, pats]) => `Stage: ${stage}\n${pats.map(p =>
        `  Pattern: "${(p.example || '').slice(0, 100)}..." | Sends: ${p.count} | Reply: ${p.replyRate}% | Booked: ${p.bookingRate}%`
      ).join('\n')}`)
      .join('\n\n');
    if (flat) summaryParts.push(flat);
  }

  // Include variant performance data so LLM analysis is variant-aware
  const variantStats = patterns.variantStats;
  if (variantStats && variantStats.some(v => v.sent > 0)) {
    const variantLines = variantStats
      .filter(v => v.sent > 0)
      .map(v =>
        `  Variant ${v.variant}: ${v.sent} msgs sent | Reply: ${v.replyRate !== null ? v.replyRate + '%' : '—'} | Booked: ${v.booked} | Book Rate: ${v.bookingRate !== null ? v.bookingRate + '%' : '—'} | Contacts: ${v.contactsAssigned}`
      ).join('\n');
    const variantLabel = [...config.SCRIPTED_VARIANTS, 'E'].join('/');
    summaryParts.push(`=== ${variantLabel} Discovery Script Variant Performance ===\n${variantLines}`);
  }

  const patternSummary = summaryParts.join('\n\n');

  if (!patternSummary) {
    console.log('[Brain] LLM analysis skipped — no pattern data');
    return;
  }

  try {
    const response = await getAI().messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Here is the performance data:\n\n${patternSummary}` }]
    });

    const insights = response.content[0]?.text?.trim();
    if (insights) {
      const stored = loadPatterns();
      stored._qualitativeInsights = {
        text: insights,
        generatedAt: Date.now()
      };
      savePatterns(stored);
      console.log('[Brain] LLM qualitative analysis complete');
    }
  } catch (err) {
    console.error('[Brain] LLM analysis error:', err.message);
  }
}

// ─── Scheduled Analysis ───────────────────────────────────────────────────────

const ANALYSIS_INTERVAL_MS = 72 * 60 * 60 * 1000; // 72 hours
let analysisTimer = null;

async function runFullAnalysis() {
  const patterns = runAnalysis();
  if (Object.keys(patterns).length > 0) {
    await runLlmAnalysis(patterns);
  }
}

function startScheduledAnalysis() {
  if (analysisTimer) return;
  // Run once on startup after a 5-second delay (server needs to be ready)
  setTimeout(() => {
    runFullAnalysis();
    analysisTimer = setInterval(runFullAnalysis, ANALYSIS_INTERVAL_MS);
  }, 5000);
  console.log('[Brain] Scheduled analysis every 72h');
}

// Kick off DB load immediately — store the promise so callers can await readiness
const _initPromise = initFromDb();

// Returns the set of contactIds that have at least one outbound brain_messages
// row marked booked. brain_messages.booked is only flipped by recordBooking(),
// which is called from confirmed booking sources (the GHL appointment webhook
// and the manual admin backfill) — NOT from the AI's [BOOKED] marker. So this
// is the source-of-truth set of "real" bookings for any dashboard stat.
function getBookedContactIds() {
  const ids = new Set();
  for (const m of _messagesCache) {
    if (m.direction === 'outbound' && m.booked) ids.add(m.contactId);
  }
  return ids;
}

function getQualitativeInsights() {
  const p = loadPatterns();
  return p._qualitativeInsights || null;
}

module.exports = {
  classifyStage,
  recordInbound,
  recordOutbound,
  recordReply,
  recordBooking,
  runAnalysis,
  runLlmAnalysis,
  getWinningPatterns,
  buildWinningPatternsPrompt,
  getStats,
  getVariantStats,
  getBookedContactIds,
  getQualitativeInsights,
  startScheduledAnalysis,
  initFromDb,
  whenReady: () => _initPromise
};
