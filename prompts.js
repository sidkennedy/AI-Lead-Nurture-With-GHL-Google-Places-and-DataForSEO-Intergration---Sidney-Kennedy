/**
 * prompts.js — Runtime-editable AI prompt storage.
 *
 * Prompts are seeded from config.js defaults on first run,
 * then stored in data/prompts.json. Changes take effect immediately
 * on the next AI call — no restart required.
 *
 * Names:
 *   conversationPrompt   — 9-step GHL discovery script
 *   systemPrompt         — GMB one-shot message generator
 *   followup.hook1       — Hook 1 re-engagement template
 *   followup.hook2       — Hook 2 second-touch template
 *   followup.hook3       — Hook 3 third-touch template
 *   followup.nurture     — Monthly nurture template
 *   followup.system      — System role for follow-up hook generator
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(__dirname, 'data', 'prompts.json');

// ─── Default Prompt Definitions ───────────────────────────────────────────────

const PROMPT_META = [
  {
    name: 'conversationPrompt',
    label: 'Conversation Flow (9-Step Discovery Script)',
    description: 'The full 9-step discovery script the AI runs via SMS — including RULES, ACKNOWLEDGMENTS, REFRAMES, OBJECTIONS, and the booking step. Every inbound GHL message runs through this prompt.'
  },
  {
    name: 'systemPrompt',
    label: 'GMB One-Shot Message Generator',
    description: 'Used by the /api/generate endpoint to craft a single outreach message based on Google My Business data (reviews, competitors, visibility scan).'
  },
  {
    name: 'followup.hook1',
    label: 'Follow-Up Hook 1 — Re-Engagement (5-min silence)',
    description: 'Template sent when a prospect goes quiet mid-conversation (5 minutes of silence). The FIRST SENTENCE is the SMS text preview — it must create curiosity on its own.'
  },
  {
    name: 'followup.hook2',
    label: 'Follow-Up Hook 2 — Second Touch',
    description: 'Second follow-up message sent 1–3 days after Hook 1 if there\'s still no reply. Different angle from Hook 1.'
  },
  {
    name: 'followup.hook3',
    label: 'Follow-Up Hook 3 — Third Touch',
    description: 'Third and final hook sent after no reply to Hooks 1 and 2. Lighter tone, acknowledges silence without awkwardness.'
  },
  {
    name: 'followup.nurture',
    label: 'Monthly Nurture Message',
    description: 'Monthly check-in message for prospects who never booked a call. Very light touch — one fresh data point, no pressure.'
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
  }
];

// ─── Hardcoded Defaults ───────────────────────────────────────────────────────

const DEFAULTS = {
  conversationPrompt: config.conversationPrompt,
  systemPrompt: config.systemPrompt,
  'followup.hook1': config.followUpPrompts?.hook1 || '',
  'followup.hook2': config.followUpPrompts?.hook2 || '',
  'followup.hook3': config.followUpPrompts?.hook3 || '',
  'followup.nurture': config.followUpPrompts?.nurture || '',
  'followup.system': 'You are a sales text-message copywriter. Return ONLY the message text — no quotes, no preamble, no explanation.',
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

module.exports = { get, getDefault, set, reset, listAll };
