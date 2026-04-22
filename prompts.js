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

// ─── Prompt Version ───────────────────────────────────────────────────────────
// Bump this when the conversationPrompt default changes significantly so the
// stored version is automatically replaced on next server start.
const CONVERSATION_PROMPT_VERSION = 5;

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
  systemPrompt: config.systemPrompt,
  'followup.hook': config.followUpPrompts?.hook || '',
  'followup.nurture': config.followUpPrompts?.nurture || '',
  'followup.system': 'You are a sales text-message copywriter. Return ONLY the message text — no quotes, no preamble, no explanation.',
  'email.system': 'You are a sales assistant emailing audiology practice owners on behalf of Powered Up AI. Your emails are extremely short — 1 to 2 sentences max, no paragraphs, no greetings, no formal sign-offs. Write like a quick note from someone who already knows their situation. Always return valid JSON only: {"subject": "...", "body": "..."}. No preamble, no explanation, no markdown.',

  'email.hook': `Write a short follow-up email to {{firstName}}{{practiceName}}.

This is email #{{position}} in our outreach sequence. Their conversation history with us:
{{conversationHistory}}

{{enrichmentContext}}

Write 1–2 sentences max. Reference something real and specific about their practice or situation. Create enough curiosity that they reply. No greetings, no sign-off, no "Hope this finds you well." Mention a specific gap or opportunity (dormant patients, expiring benefits, competitors gaining ground) if supported by the data.

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}`,

  'email.nurture': `Write a short nurture email to {{firstName}}{{practiceName}}.

This is email #{{position}} — they haven't responded yet. Their conversation history:
{{conversationHistory}}

{{enrichmentContext}}

Write 1–2 sentences. Try a different angle than what was already sent — a competitor gaining ground, a recent patient review, expiring insurance benefits, or a nearby referral source. Be specific where data allows. No greetings, no sign-off, no "just checking in."

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}`,

  'email.monthly': `Write a monthly check-in email to {{firstName}}{{practiceName}}.

They haven't engaged in a while. Conversation history:
{{conversationHistory}}

{{enrichmentContext}}

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
 * - Removes stale hook1/hook2/hook3 keys (replaced by followup.hook).
 * - If conversationPrompt version in storage is older than CONVERSATION_PROMPT_VERSION,
 *   clears the stored override so the new default takes effect immediately.
 */
function seed() {
  ensureDir();

  const stored = load();
  let changed = false;

  // Remove legacy hook prompt keys no longer in use
  const legacyKeys = ['followup.hook1', 'followup.hook2', 'followup.hook3'];
  for (const key of legacyKeys) {
    if (key in stored) {
      delete stored[key];
      changed = true;
      console.log(`[Prompts] Removed legacy prompt key: ${key}`);
    }
  }

  // Force-update conversationPrompt if stored version is outdated
  const storedVersion = stored['_conversationPromptVersion'] || 0;
  if (storedVersion < CONVERSATION_PROMPT_VERSION) {
    delete stored['conversationPrompt'];
    stored['_conversationPromptVersion'] = CONVERSATION_PROMPT_VERSION;
    changed = true;
    console.log(`[Prompts] conversationPrompt updated to v${CONVERSATION_PROMPT_VERSION} — stored override cleared`);
  }

  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ _conversationPromptVersion: CONVERSATION_PROMPT_VERSION }, null, 2));
    console.log('[Prompts] data/prompts.json created (no overrides; all defaults active)');
  } else if (changed) {
    save(stored);
  }
}

module.exports = { get, getDefault, set, reset, listAll, seed };
