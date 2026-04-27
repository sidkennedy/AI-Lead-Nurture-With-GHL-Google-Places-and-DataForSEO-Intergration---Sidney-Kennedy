/**
 * prompts.js — Runtime-editable AI prompt storage.
 *
 * Prompts are seeded from config.js defaults on first run,
 * then stored in data/prompts.json. Changes take effect immediately
 * on the next AI call — no restart required.
 *
 * Names:
 *   conversationPrompt   — Discovery script (steps 1-9)
 *   systemPrompt         — GMB one-shot message generator
 *   followup.hook        — Shared re-engagement hook (positions 2 & 3, full history)
 *   followup.nurture     — Monthly nurture message (full history)
 *   followup.system      — System role for follow-up hook generator
 *   brain.analysisPrompt — Learning brain 72hr analysis prompt
 *
 * NOTE: Hook 1 (5-min silence) is a static "Hi [firstName]" — no prompt needed.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(__dirname, 'data', 'prompts.json');

// UI edits are always authoritative — the code default only applies when no
// override has been saved. There is no version-wipe mechanism.

// ─── Default Prompt Definitions ───────────────────────────────────────────────

const PROMPT_META = [
  {
    name: 'conversationPrompt',
    label: 'Conversation Flow (Discovery Script)',
    description: 'The full discovery script the AI runs via SMS — including RULES, ACKNOWLEDGMENTS, REFRAMES, OBJECTIONS, and the booking step. Every inbound GHL message runs through this prompt.'
  },
  {
    name: 'systemPrompt',
    label: 'GMB One-Shot Message Generator',
    description: 'Used by the /api/generate endpoint to craft a single outreach message based on Google My Business data (reviews, competitors, visibility scan).'
  },
  {
    name: 'followup.hook',
    label: 'Follow-Up Re-Engagement Hook (Hooks 2–5)',
    description: 'AI-generated re-engagement messages for Hooks 2–5 (first 7 days). Receives full conversation history, winning patterns, and live enrichment data (recent Google reviews, competitor velocity, referral sources). First sentence is the SMS preview — must create curiosity. Hook 1 (5-min silence) is a static "Hi [firstName]" — no prompt needed.'
  },
  {
    name: 'followup.nurture',
    label: 'Sustained Nurture Message (Bi-weekly & Monthly)',
    description: 'Nurture message for prospects who never booked. Used for bi-weekly follow-ups (positions 6–21, every 3–4 days for 8 weeks) and monthly follow-ups (position 22+) indefinitely. Receives full conversation history and live enrichment data — recent reviews, competitor velocity, nearby referral sources.'
  },
  {
    name: 'followup.system',
    label: 'Follow-Up Generator System Role',
    description: 'The system role instruction given to Claude when generating hook/nurture messages. Defines its persona and output format.'
  },
  {
    name: 'brain.analysisPrompt',
    label: 'Learning Brain Analysis Prompt',
    description: 'Sent to Claude during the 72-hour learning brain analysis job. Receives reply-rate and booking-rate statistics per stage and message cluster, and should return actionable messaging insights. Insights are stored in winning-patterns.json and injected into conversation prompts.'
  },
  {
    name: 'email.system',
    label: 'Email Generator System Role',
    description: 'The system role given to Claude when generating email follow-ups. Defines persona, style, and output format. Must instruct Claude to return JSON { "subject": "...", "body": "..." } only.',
    sectionLabel: 'Email Prompts'
  },
  {
    name: 'email.hook',
    label: 'Email Hook (First-Week Emails, Positions 1–4)',
    description: 'Prompt for AI-generated emails during the first week (positions 1–4). Must return JSON { "subject": "...", "body": "..." }. Body: 1–2 casual sentences, no paragraphs, no greetings or sign-offs.'
  },
  {
    name: 'email.nurture',
    label: 'Email Nurture (Weekly, Positions 5–8)',
    description: 'Prompt for weekly nurture emails (positions 5–8). Must return JSON { "subject": "...", "body": "..." }. Body: 1–2 casual sentences.'
  },
  {
    name: 'email.monthly',
    label: 'Email Monthly (Position 9+)',
    description: 'Prompt for monthly long-arc emails (positions 9+). Must return JSON { "subject": "...", "body": "..." }. Body: 1–2 casual sentences, fresh angle each time.'
  }
];

// ─── Hardcoded Defaults ───────────────────────────────────────────────────────

const DEFAULTS = {
  conversationPrompt: config.conversationPrompt,
  // A/B/C variant scripts — each starts as a copy of the base script.
  // Edit them independently in the Variant A/B/C tabs of the prompt editor.
  'conversationPrompt.A': config.conversationPrompt,
  'conversationPrompt.B': config.conversationPrompt,
  'conversationPrompt.C': config.conversationPrompt,
  'conversationPrompt.D': config.conversationPrompt,
  // Enabled flags for each variant ('true' / 'false')
  'conversationPrompt.A.enabled': 'true',
  'conversationPrompt.B.enabled': 'true',
  'conversationPrompt.C.enabled': 'true',
  'conversationPrompt.D.enabled': 'false',
  systemPrompt: config.systemPrompt,
  'followup.hook': config.followUpPrompts?.hook || '',
  'followup.nurture': config.followUpPrompts?.nurture || '',
  'followup.system': 'You are a sales text-message copywriter. Return ONLY the message text — no quotes, no preamble, no explanation.',
  'email.system': 'You are a sales assistant emailing audiology practice owners on behalf of Powered Up AI. Your emails are extremely short — 1 to 2 sentences max, no paragraphs, no greetings, no formal sign-offs. Write like a quick note from someone who already knows their situation. Always return valid JSON only: {"subject": "...", "body": "..."}. No preamble, no explanation, no markdown.',

  'email.hook': `Write a short follow-up email to {{firstName}}{{practiceName}}.

This is email #{{position}} in our outreach sequence. Their conversation history with us:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences max. Reference something real and specific about their practice or situation. Create enough curiosity that they reply. No greetings, no sign-off, no "Hope this finds you well." Mention a specific gap or opportunity (dormant patients, expiring benefits, competitors gaining ground) if supported by the data.

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}`,

  'email.nurture': `Write a short nurture email to {{firstName}}{{practiceName}}.

This is email #{{position}} — they haven't responded yet. Their conversation history:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences. Try a different angle than what was already sent — a competitor gaining ground, a recent patient review, expiring insurance benefits, or a nearby referral source. Be specific where data allows. No greetings, no sign-off, no "just checking in."

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}`,

  'email.monthly': `Write a monthly check-in email to {{firstName}}{{practiceName}}.

They haven't engaged in a while. Conversation history:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences. Take a fresh angle — something that feels new, not repetitive. Reference real data if available (recent reviews, a competitor milestone, year-end benefits). Easy to reply to with a simple yes or no.

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}`,

  'brain.analysisPrompt': `You are an AI sales coach analyzing performance data from an audiology practice outreach campaign.

You have been given reply-rate and booking-rate statistics for outbound SMS messages, grouped by conversation stage and message pattern cluster.

Your job: Identify the 2–3 most actionable insights from this data. Focus on:
- Which stages have the lowest reply rates and why (based on the message examples shown)
- What tones, openers, or angles are outperforming — and what makes them work
- Specific, concrete recommendations the sales team should apply to the next batch of messages

RULES:
- Be direct and specific. Reference actual message examples from the data.
- No generic advice. Every insight must connect to a pattern visible in the data.
- 2–3 insights max. Each insight: 2–4 sentences.
- Plain text only. No markdown, no headers, no bullet points.

OUTPUT: Return only the insights text. No preamble, no labels.`
};

// ─── File I/O ─────────────────────────────────────────────────────────────────

function ensureDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return {}; }
}

function save(data) {
  try {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Prompts] Write error:', err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current active text for a prompt.
 * Reads from disk every call — no caching — so edits take effect immediately.
 * Falls back to the hardcoded default from config.js if not overridden.
 */
function get(name) {
  const stored = load();
  return stored[name] !== undefined ? stored[name] : (DEFAULTS[name] || '');
}

/**
 * Get the hardcoded default for a prompt (from config.js).
 */
function getDefault(name) {
  return DEFAULTS[name] || '';
}

/**
 * Save a new value for a prompt.
 * Takes effect immediately on the next AI call.
 */
function set(name, text) {
  if (!(name in DEFAULTS)) throw new Error(`Unknown prompt: ${name}`);
  const stored = load();
  stored[name] = text;
  save(stored);
}

/**
 * Reset a prompt to its hardcoded default.
 * Removes the override from prompts.json.
 */
function reset(name) {
  if (!(name in DEFAULTS)) throw new Error(`Unknown prompt: ${name}`);
  const stored = load();
  delete stored[name];
  save(stored);
}

/**
 * Return the list of currently-enabled variants (['A'], ['A','B'], etc.)
 */
function getEnabledVariants() {
  return ['A', 'B', 'C', 'D'].filter(v => get(`conversationPrompt.${v}.enabled`) === 'true');
}

/**
 * Set enabled state for a specific variant.
 * @param {string} variant — 'A', 'B', 'C', or 'D'
 * @param {boolean} enabled
 */
function setVariantEnabled(variant, enabled) {
  const name = `conversationPrompt.${variant}.enabled`;
  if (!(name in DEFAULTS)) throw new Error(`Unknown variant: ${variant}`);
  const stored = load();
  stored[name] = enabled ? 'true' : 'false';
  save(stored);
}

/**
 * Pick the next variant to assign to a new contact (round-robin by count).
 * Returns null if no variants are enabled.
 * @param {object} allContacts — from conversations.getAll()
 */
function pickVariant(allContacts) {
  const enabled = getEnabledVariants();
  if (enabled.length === 0) return null;
  if (enabled.length === 1) return enabled[0];
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const c of Object.values(allContacts)) {
    if (c.variant && counts[c.variant] !== undefined) counts[c.variant]++;
  }
  return enabled.slice().sort((a, b) => counts[a] - counts[b])[0];
}

/**
 * Return metadata + current value for all prompts, for the admin editor.
 */
function listAll() {
  const stored = load();
  return PROMPT_META.map(meta => ({
    ...meta,
    current: stored[meta.name] !== undefined ? stored[meta.name] : DEFAULTS[meta.name],
    isModified: stored[meta.name] !== undefined,
    defaultValue: DEFAULTS[meta.name]
  }));
}

/**
 * Seed prompts.json on startup.
 * - Creates the file if missing.
 * - Removes stale legacy prompt keys.
 * UI-saved overrides are never touched — they are always authoritative.
 */
function seed() {
  ensureDir();

  // Remove legacy hook prompt keys no longer in use
  if (fs.existsSync(FILE)) {
    const stored = load();
    const legacyKeys = ['followup.hook1', 'followup.hook2', 'followup.hook3', '_conversationPromptVersion'];
    const hadLegacy = legacyKeys.some(k => k in stored);
    if (hadLegacy) {
      for (const key of legacyKeys) delete stored[key];
      save(stored);
      console.log('[Prompts] Removed legacy prompt keys from prompts.json');
    }
  } else {
    fs.writeFileSync(FILE, JSON.stringify({}, null, 2));
    console.log('[Prompts] data/prompts.json created (no overrides; all defaults active)');
  }
}

// ─── PostgreSQL Sync ──────────────────────────────────────────────────────────
// Prompts live in BOTH data/prompts.json (fast sync reads) and ai_prompts (DB).
// Boot sync uses file-mtime vs DB-updated_at to decide which side wins, so:
//   • A fresh deploy (file mtime = checkout time) → file is newer → file→DB push
//     (this auto-heals the "I edited the file but the DB has stale prompts that
//     keep overriding it" trap that bit us repeatedly — see replit.md trap #6).
//   • A UI prompt save (DB updated_at = now, file untouched on disk by deploys
//     since) → DB is newer → DB→file pull (UI edits persist across restarts).
// Per-key save (POST /admin/prompts/:name) writes to both file AND DB
// simultaneously via syncToDb, so they stay aligned during normal operation.

/**
 * Smart bidirectional sync. Compares file mtime against the most recent DB
 * updated_at; whichever side is newer wins.
 * @param {import('pg').Pool} pool
 */
async function syncFromDb(pool) {
  try {
    const { rows } = await pool.query('SELECT name, value, updated_at FROM ai_prompts');
    const stored = load();

    if (rows.length === 0) {
      // Nothing in DB yet — push current file contents up to DB.
      for (const [name, value] of Object.entries(stored)) {
        await pool.query(
          'INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
          [name, value, Date.now()]
        );
      }
      console.log(`[Prompts] DB empty — seeded ${Object.keys(stored).length} prompts from file`);
      return;
    }

    // Determine direction by comparing file mtime against the newest DB write.
    let fileMtime = 0;
    try { fileMtime = fs.statSync(FILE).mtimeMs; } catch {}
    const dbMaxUpdatedAt = rows.reduce((m, r) => {
      const n = Number(r.updated_at);
      return Math.max(m, Number.isFinite(n) ? n : 0);
    }, 0);

    // Find which conversation prompt keys actually differ between file and DB.
    const diffs = rows.filter(r => stored[r.name] !== r.value);

    if (diffs.length === 0) {
      console.log(`[Prompts] DB sync complete — ${rows.length} prompt(s) already up to date`);
      return;
    }

    // 5-second slop tolerates the small mtime/updated_at skew that happens when
    // the same admin save writes file then DB within a few hundred ms.
    const fileWins = fileMtime > dbMaxUpdatedAt + 5000;

    if (fileWins) {
      // Fresh deploy / file edit — push file content to DB so the DB stops
      // overriding it on subsequent boots. Only push keys that the file knows
      // about; leave DB-only keys alone.
      let pushed = 0;
      for (const row of rows) {
        if (!(row.name in stored)) continue;
        if (stored[row.name] === row.value) continue;
        await pool.query(
          'INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value=$2, updated_at=$3',
          [row.name, stored[row.name], Date.now()]
        );
        pushed++;
      }
      console.log(`[Prompts] File is newer than DB (mtime ${new Date(fileMtime).toISOString()} > db ${new Date(dbMaxUpdatedAt).toISOString()}) — pushed ${pushed} prompt(s) FILE → DB (auto-heal of trap #6).`);
      const diffNames = diffs.map(r => r.name).join(', ');
      console.log(`[Prompts]   keys reconciled: ${diffNames}`);
      return;
    }

    // Default: DB-wins (preserves UI edits across restarts when the file
    // wasn't redeployed in between).
    let changed = 0;
    for (const row of diffs) {
      stored[row.name] = row.value;
      changed++;
    }
    save(stored);
    console.log(`[Prompts] DB is newer than file (db ${new Date(dbMaxUpdatedAt).toISOString()} > mtime ${new Date(fileMtime).toISOString()}) — pulled ${changed} prompt(s) DB → FILE.`);
    console.log(`[Prompts]   keys reconciled: ${diffs.map(r => r.name).join(', ')}`);
  } catch (err) {
    console.error('[Prompts] DB sync error:', err.message, '— continuing with local file');
  }
}

/**
 * Write a single prompt to the DB after it has been saved to the local file.
 * Called from the POST /admin/prompts/:name route.
 * @param {import('pg').Pool} pool
 * @param {string} name
 * @param {string} value
 */
async function syncToDb(pool, name, value) {
  try {
    await pool.query(
      'INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value=$2, updated_at=$3',
      [name, value, Date.now()]
    );
    console.log(`[Prompts] Saved "${name}" to DB (${value.length} chars)`);
  } catch (err) {
    console.error(`[Prompts] DB write error for "${name}":`, err.message);
  }
}

module.exports = { get, getDefault, set, reset, listAll, seed, syncFromDb, syncToDb, getEnabledVariants, setVariantEnabled, pickVariant };
