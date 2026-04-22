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
  4: 'referral',
  5: 'referral',
  6: 'visibility',
  7: 'close-prep',
  8: 'booking',
  9: 'booked'
};

function classifyStage(step) {
  if (step === null || step === undefined) return 'unknown';
  return STAGE_MAP[step] || (step > 9 ? 'booked' : 'unknown');
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
// Cluster messages by the first 60 characters of their body, lowercased and
// stripped of punctuation — a simple but effective proxy for message "template".

function patternKey(body) {
  return (body || '')
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record an outbound message from the AI.
 * @param {string} contactId
 * @param {string} body        — cleaned message text (no hidden markers)
 * @param {number|null} step   — conversation step (from [STEP:N])
 */
function recordOutbound(contactId, body, step) {
  const messages = loadMessages();
  const stage = classifyStage(step);
  messages.push({
    id: makeId(),
    contactId,
    direction: 'outbound',
    body,
    stage,
    step: step ?? null,
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

// ─── Analysis ────────────────────────────────────────────────────────────────

/**
 * Run the analysis job. Groups outbound messages by stage + pattern cluster,
 * calculates reply rates and booking rates, and writes the top 3 per stage
 * to winning-patterns.json.
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

  // Only count settled outbound messages (exclude null/pending) in analysis
  const outbound = messages.filter(m => m.direction === 'outbound' && m.repliedWithin48h !== null);

  if (outbound.length === 0) {
    console.log('[Brain] No settled outbound messages yet — skipping analysis');
    return {};
  }

  // Group by stage → pattern cluster
  const grouped = {};
  for (const msg of outbound) {
    const stage = msg.stage || 'unknown';
    const key = patternKey(msg.body);
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
    if (msg.booked) grouped[stage][key].bookings++;
  }

  // Rank patterns per stage and take top 3
  const winning = {};
  for (const [stage, patterns] of Object.entries(grouped)) {
    const ranked = Object.values(patterns)
      .filter(p => p.count >= 2) // need at least 2 sends to be meaningful
      .map(p => ({
        ...p,
        replyRate: p.count > 0 ? Math.round((p.replies / p.count) * 100) : 0,
        bookingRate: p.count > 0 ? Math.round((p.bookings / p.count) * 100) : 0
      }))
      .sort((a, b) => b.replyRate - a.replyRate || b.bookingRate - a.bookingRate)
      .slice(0, 3);

    if (ranked.length > 0) {
      winning[stage] = ranked;
    }
  }

  winning._meta = {
    analyzedAt: Date.now(),
    totalMessages: outbound.length,
    distinctContacts: new Set(outbound.map(m => m.contactId)).size
  };

  savePatterns(winning);
  console.log(`[Brain] Analysis complete — ${outbound.length} messages, ${Object.keys(winning).length - 1} stages with patterns`);
  return winning;
}

/**
 * Return the current winning patterns for a given stage (from last analysis run).
 * Returns null if no patterns exist yet or fewer than 2 data points.
 * @param {string} stage
 */
function getWinningPatterns(stage) {
  const patterns = loadPatterns();
  const stagePatterns = patterns[stage];
  if (!stagePatterns || stagePatterns.length === 0) return null;
  return stagePatterns;
}

/**
 * Return full stats summary (all stages + meta).
 */
function getStats() {
  const messages = loadMessages();
  const patterns = loadPatterns();

  const outbound = messages.filter(m => m.direction === 'outbound');
  const inbound = messages.filter(m => m.direction === 'inbound');

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
      outbound: outbound.length,
      inbound: inbound.length,
      contacts: new Set(messages.map(m => m.contactId)).size,
      booked: new Set(outbound.filter(m => m.booked).map(m => m.contactId)).size
    },
    byStage,
    winningPatterns: patterns,
    patternsUpdatedAt: patterns._meta?.analyzedAt || null
  };
}

// ─── Build prompt snippet for winning patterns ────────────────────────────────

/**
 * Returns a short text block to inject into the system prompt,
 * highlighting what's been working for this stage.
 * @param {string} stage
 */
function buildWinningPatternsPrompt(stage) {
  const patterns = getWinningPatterns(stage);
  if (!patterns || patterns.length === 0) return '';

  const lines = patterns.map((p, i) =>
    `  ${i + 1}. "${p.example.slice(0, 80)}..." — ${p.replyRate}% reply rate${p.bookingRate > 0 ? `, ${p.bookingRate}% booking rate` : ''}`
  );

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

  const patternSummary = Object.entries(patterns)
    .filter(([k]) => k !== '_meta' && k !== '_qualitativeInsights')
    .map(([stage, pats]) => `Stage: ${stage}\n${pats.map(p =>
      `  Pattern: "${p.example.slice(0, 100)}..." | Sends: ${p.count} | Reply rate: ${p.replyRate}% | Booking rate: ${p.bookingRate}%`
    ).join('\n')}`)
    .join('\n\n');

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
  startScheduledAnalysis
};
