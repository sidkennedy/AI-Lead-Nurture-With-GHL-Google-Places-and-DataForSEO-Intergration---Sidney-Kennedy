const fs = require('fs');
const path = require('path');

const MESSAGES_FILE = path.join(__dirname, 'data', 'messages.json');
const PATTERNS_FILE = path.join(__dirname, 'data', 'winning-patterns.json');
const REPLY_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

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

function loadMessages() {
  try {
    ensureDir();
    if (!fs.existsSync(MESSAGES_FILE)) return [];
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch { return []; }
}

function saveMessages(messages) {
  try {
    ensureDir();
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch (err) {
    console.error('[Brain] Write error (messages):', err.message);
  }
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
 * @param {number|null} [meta.position]      — follow-up hook/nurture position (1-5)
 * @param {boolean|null} [meta.had_enrichment_data] — research data was available when sent
 * @param {string|null} [meta.variant]       — A/B/C discovery script variant (null = legacy)
 */
function recordOutbound(contactId, body, step, meta = {}) {
  const messages = loadMessages();
  const stage = classifyStage(step);
  const message_type = meta.message_type ||
    (step !== null && step !== undefined ? 'scripted-sms' : 'followup-sms');
  messages.push({
    id: makeId(),
    contactId,
    direction: 'outbound',
    body,
    stage,
    step: step ?? null,
    message_type,
    position: meta.position ?? null,
    had_enrichment_data: meta.had_enrichment_data ?? null,
    variant: meta.variant ?? null,
    length_chars: (body || '').length,
    timestamp: Date.now(),
    repliedWithin48h: null, // null = pending; true = replied ≤48h; false = no timely reply
    repliedAt: null,
    booked: false
  });
  saveMessages(messages);
}

/**
 * Record an inbound message from the prospect.
 * Stored for contact history and inbound counting in stats.
 * @param {string} contactId
 * @param {string} body       — raw message text from prospect
 * @param {number|null} step  — current conversation step at time of receipt
 */
function recordInbound(contactId, body, step) {
  const messages = loadMessages();
  const stage = classifyStage(step);
  messages.push({
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
  });
  saveMessages(messages);
}

/**
 * When an inbound message arrives, mark the most recent outbound for this
 * contact as replied (if within the 48-hour window).
 * @param {string} contactId
 */
function recordReply(contactId) {
  const messages = loadMessages();
  const now = Date.now();

  // Find the most recent outbound message for this contact that hasn't been replied to yet
  // Use repliedAt === null (not repliedWithin48h) to prevent re-attributing late replies
  let lastOutboundIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.contactId === contactId && m.direction === 'outbound' && m.repliedAt === null) {
      lastOutboundIdx = i;
      break;
    }
  }

  if (lastOutboundIdx === -1) return;

  const msg = messages[lastOutboundIdx];
  const withinWindow = now - msg.timestamp <= REPLY_WINDOW_MS;

  messages[lastOutboundIdx] = {
    ...msg,
    repliedWithin48h: withinWindow,
    repliedAt: now
  };

  saveMessages(messages);
}

/**
 * Mark all outbound messages for a contact as booked (the ultimate signal).
 * @param {string} contactId
 */
function recordBooking(contactId) {
  const messages = loadMessages();
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].contactId === contactId && messages[i].direction === 'outbound') {
      messages[i].booked = true;
      changed = true;
    }
  }
  if (changed) saveMessages(messages);
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
  let messages = loadMessages();
  const now = Date.now();

  // Settle any pending outbound messages older than 48h with no reply → mark false
  let settled = false;
  messages = messages.map(m => {
    if (
      m.direction === 'outbound' &&
      m.repliedWithin48h === null &&
      m.repliedAt === null &&
      now - m.timestamp > REPLY_WINDOW_MS
    ) {
      settled = true;
      return { ...m, repliedWithin48h: false };
    }
    return m;
  });
  if (settled) saveMessages(messages);

  // Backfill any missing metadata fields on old records
  const { messages: backfilled, changed } = backfillMessages(messages);
  if (changed) {
    messages = backfilled;
    saveMessages(messages);
    console.log('[Brain] Backfilled metadata fields on existing messages');
  }

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
  winning.variantStats = ['A', 'B', 'C'].map(v => {
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
 */
function getStats() {
  const messages = loadMessages();
  const patterns = loadPatterns();

  const outbound = messages.filter(m => m.direction === 'outbound');
  const inbound = messages.filter(m => m.direction === 'inbound');

  const settled = outbound.filter(m => m.repliedWithin48h !== null);
  const repliedMsgs = settled.filter(m => m.repliedWithin48h === true);

  const byStage = {};
  for (const msg of outbound) {
    const stage = msg.stage || 'unknown';
    if (!byStage[stage]) byStage[stage] = { sent: 0, replied: 0, booked: 0 };
    byStage[stage].sent++;
    if (msg.repliedWithin48h) byStage[stage].replied++;
    if (msg.booked) byStage[stage].booked++;
  }

  return {
    totals: {
      outbound:    outbound.length,
      inbound:     inbound.length,
      settled:     settled.length,
      repliedMsgs: repliedMsgs.length,
      contacts:    new Set(messages.map(m => m.contactId)).size,
      booked:      new Set(outbound.filter(m => m.booked).map(m => m.contactId)).size
    },
    byStage,
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

  return ['A', 'B', 'C'].map(v => {
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
    summaryParts.push(`=== A/B/C Discovery Script Variant Performance ===\n${variantLines}`);
  }

  const patternSummary = summaryParts.join('\n\n');

  if (!patternSummary) {
    console.log('[Brain] LLM analysis skipped — no pattern data');
    return;
  }

  try {
    const response = await getAI().messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
      max_tokens: 400,
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
  startScheduledAnalysis
};
