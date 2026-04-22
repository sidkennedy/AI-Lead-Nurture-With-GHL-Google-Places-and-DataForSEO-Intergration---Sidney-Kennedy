const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const conversations = require('./conversations');
const ghl = require('./ghl');
const brain = require('./brain');

const FILE = path.join(__dirname, 'data', 'followups.json');

// Lazy-init Anthropic client (avoids issues if env isn't loaded yet)
let _ai = null;
function getAI() {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _ai;
}

// ─── Timing Constants ─────────────────────────────────────────────────────────

const TZ = 'America/New_York'; // default — all window calculations in EST
const SILENCE_CHECK_MS = 5 * 60 * 1000; // 5 minutes
const MORNING_START = 7;  // 7am EST
const MORNING_END = 8;    // 8am EST
const EVENING_START = 16; // 4pm EST
const EVENING_END = 20;   // 8pm EST

// ─── Window Helpers ───────────────────────────────────────────────────────────

function estHour(ts) {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false })
      .format(new Date(ts || Date.now())),
    10
  );
}

function isInWindow(ts) {
  const h = estHour(ts || Date.now());
  return (h >= MORNING_START && h < MORNING_END) || (h >= EVENING_START && h < EVENING_END);
}

/**
 * Find the next allowed window start timestamp, scanning forward in 1-hour
 * increments until we find a slot in the morning or evening window.
 */
function nextWindowMs(fromMs) {
  // Snap forward to the next hour boundary (avoid firing at exact :00)
  let t = Math.ceil((fromMs + 60_000) / 3_600_000) * 3_600_000;
  const limit = fromMs + 8 * 24 * 60 * 60 * 1000; // search up to 8 days out
  while (t < limit) {
    const h = estHour(t);
    if ((h >= MORNING_START && h < MORNING_END) || (h >= EVENING_START && h < EVENING_END)) {
      return t;
    }
    t += 3_600_000; // advance 1 hour
  }
  return fromMs + 24 * 60 * 60 * 1000; // fallback: 24h from now
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

function ensureDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(FILE)) return [];
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return []; }
}

function save(jobs) {
  try {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(jobs, null, 2));
  } catch (err) {
    console.error('[Followups] Write error:', err.message);
  }
}

function makeId() {
  return `fu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Job Management ───────────────────────────────────────────────────────────

/**
 * Create a new pending follow-up job.
 */
function scheduleJob({ contactId, type, position, sendAt, context }) {
  const jobs = load();
  const job = {
    id: makeId(),
    contactId,
    type,      // 'silence-check' | 'hook' | 'nurture'
    position,  // 0 = silence-check, 1-3 = hooks, 4+ = nurture
    sendAt,
    status: 'pending',
    context: context || {},
    createdAt: Date.now(),
    sentAt: null,
    error: null
  };
  jobs.push(job);
  save(jobs);
  console.log(`[Followups] Scheduled ${type} pos=${position} for ${contactId} at ${new Date(sendAt).toISOString()}`);
  return job;
}

/**
 * Cancel all pending follow-up jobs for a contact (called when they reply).
 */
function cancelContactJobs(contactId) {
  const jobs = load();
  let count = 0;
  const updated = jobs.map(j => {
    if (j.contactId === contactId && j.status === 'pending') {
      count++;
      return { ...j, status: 'cancelled' };
    }
    return j;
  });
  if (count > 0) {
    save(updated);
    console.log(`[Followups] Cancelled ${count} pending jobs for ${contactId}`);
  }
  return count;
}

/**
 * Return all jobs whose sendAt has passed and status is still pending.
 */
function getDueJobs() {
  const now = Date.now();
  return load().filter(j => j.status === 'pending' && j.sendAt <= now);
}

/**
 * Update a job record by ID.
 */
function updateJob(jobId, updates) {
  const jobs = load();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;
  jobs[idx] = { ...jobs[idx], ...updates };
  save(jobs);
}

/**
 * Return all jobs for a contact (for monitoring).
 */
function getContactJobs(contactId) {
  return load().filter(j => j.contactId === contactId);
}

/**
 * Return all jobs (optionally filtered by status).
 */
function getAllJobs(statusFilter) {
  const jobs = load();
  if (!statusFilter) return jobs;
  return jobs.filter(j => j.status === statusFilter);
}

// ─── Prompt Template Interpolation ───────────────────────────────────────────

function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// ─── Hook Message Generation ──────────────────────────────────────────────────

async function generateHookMessage(contact, position) {
  const templates = config.followUpPrompts || {};
  let templateKey = 'hook1';
  if (position === 2) templateKey = 'hook2';
  else if (position >= 3 && contact.type !== 'nurture') templateKey = 'hook3';
  else if (position >= 4 || contact.type === 'nurture') templateKey = 'nurture';

  const rawTemplate = templates[templateKey] || templates.hook1 || '';
  const stage = brain.classifyStage(contact.currentStep ?? null);

  const userPrompt = interpolate(rawTemplate, {
    firstName: contact.firstName || 'there',
    step: contact.currentStep ?? 1,
    stage,
    lastOutbound: contact.lastOutbound || '',
    lastReply: contact.lastReply || 'none'
  });

  // Build system prompt — inject winning patterns if available
  let systemPrompt = 'You are a sales text-message copywriter. Return ONLY the message text — no quotes, no preamble, no explanation.';
  const patterns = brain.getWinningPatterns(stage);
  if (patterns && patterns.length > 0) {
    const examples = patterns.slice(0, 2).map(p => `"${(p.example || '').slice(0, 80)}"`).join(' | ');
    systemPrompt += ` These opening styles have generated replies: ${examples}. Lean toward similar energy.`;
  }

  const response = await getAI().messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return response.content[0]?.text?.trim() || '';
}

// ─── Sequence Progression ────────────────────────────────────────────────────

function scheduleNext(contactId, sentPosition, currentStep, lastBody) {
  const context = { lastOutboundBody: lastBody, lastOutboundStep: currentStep };

  if (sentPosition === 1) {
    // Hook 1 sent → Hook 2 at next evening/morning window
    scheduleJob({ contactId, type: 'hook', position: 2, sendAt: nextWindowMs(Date.now()), context });
  } else if (sentPosition === 2) {
    // Hook 2 sent → Hook 3 in 1–3 days at a window
    const days = 1 + Math.floor(Math.random() * 3);
    const base = Date.now() + days * 24 * 60 * 60 * 1000;
    scheduleJob({ contactId, type: 'hook', position: 3, sendAt: nextWindowMs(base), context });
  } else if (sentPosition === 3) {
    // Hook 3 sent → first monthly nurture
    const base = Date.now() + 30 * 24 * 60 * 60 * 1000;
    scheduleJob({ contactId, type: 'nurture', position: 4, sendAt: nextWindowMs(base), context });
  } else {
    // Recurring monthly nurture
    const base = Date.now() + 30 * 24 * 60 * 60 * 1000;
    scheduleJob({ contactId, type: 'nurture', position: sentPosition + 1, sendAt: nextWindowMs(base), context });
  }
}

// ─── Send + Record ────────────────────────────────────────────────────────────

async function sendFollowUp(job, contact, position) {
  const exchanges = contact.exchanges || [];
  const lastInbound = [...exchanges].reverse().find(e => e.direction === 'inbound');
  const lastOutbound = [...exchanges].reverse().find(e => e.direction === 'outbound');

  const contactCtx = {
    ...contact,
    type: job.type,
    lastOutbound: lastOutbound?.body || job.context?.lastOutboundBody || '',
    lastReply: lastInbound?.body || ''
  };

  let hookText = '';
  try {
    hookText = await generateHookMessage(contactCtx, position);
  } catch (err) {
    console.error(`[Followups] Claude error for ${job.contactId}:`, err.message);
    updateJob(job.id, { status: 'skipped', error: err.message });
    return;
  }

  if (!hookText) {
    updateJob(job.id, { status: 'skipped', error: 'Empty message generated' });
    return;
  }

  try {
    await ghl.sendMessage(job.contactId, hookText);
  } catch (err) {
    console.error(`[Followups] GHL send error for ${job.contactId}:`, err.message);
    updateJob(job.id, { status: 'skipped', error: `GHL: ${err.message}` });
    return;
  }

  // Persist and record in learning brain
  brain.recordOutbound(job.contactId, hookText, contact.currentStep ?? null);

  updateJob(job.id, { status: 'sent', sentAt: Date.now() });
  scheduleNext(job.contactId, position, contact.currentStep ?? null, hookText);

  console.log(`[Followups] Hook pos=${position} sent to ${job.contactId}: "${hookText.slice(0, 80)}"`);
}

// ─── Job Processors ───────────────────────────────────────────────────────────

async function processSilenceCheck(job) {
  const contact = conversations.get(job.contactId);
  if (!contact) {
    updateJob(job.id, { status: 'skipped', error: 'Contact not found' });
    return;
  }
  if (contact.booked) {
    updateJob(job.id, { status: 'cancelled', error: 'Already booked' });
    return;
  }

  // Check if the contact replied since the last outbound
  const exchanges = contact.exchanges || [];
  const lastInbound = [...exchanges].reverse().find(e => e.direction === 'inbound');
  const lastOutbound = [...exchanges].reverse().find(e => e.direction === 'outbound');

  const hasReplied = lastInbound && lastOutbound && lastInbound.timestamp > lastOutbound.timestamp;

  if (hasReplied) {
    updateJob(job.id, { status: 'cancelled', error: 'Contact replied — no follow-up needed' });
    console.log(`[Followups] Silence check for ${job.contactId}: replied — done`);
    return;
  }

  // Contact is silent — send Hook 1 immediately (no window constraint)
  console.log(`[Followups] Silence check for ${job.contactId}: silent — sending Hook 1`);
  await sendFollowUp(job, contact, 1);
}

async function processHookOrNurture(job) {
  // Check if we're in an allowed window; if not, defer
  if (!isInWindow()) {
    const nextWindow = nextWindowMs(Date.now());
    updateJob(job.id, { sendAt: nextWindow });
    console.log(`[Followups] ${job.type} pos=${job.position} for ${job.contactId}: outside window — deferring to ${new Date(nextWindow).toISOString()}`);
    return;
  }

  const contact = conversations.get(job.contactId);
  if (!contact) {
    updateJob(job.id, { status: 'skipped', error: 'Contact not found' });
    return;
  }
  if (contact.booked) {
    updateJob(job.id, { status: 'cancelled', error: 'Already booked' });
    return;
  }

  await sendFollowUp(job, contact, job.position);
}

async function processJob(job) {
  if (job.type === 'silence-check') {
    await processSilenceCheck(job);
  } else {
    await processHookOrNurture(job);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let draining = false;

async function drainJobs() {
  if (draining) return;
  draining = true;
  try {
    const due = getDueJobs();
    if (due.length > 0) console.log(`[Followups] Processing ${due.length} due job(s)`);
    for (const job of due) {
      try {
        await processJob(job);
      } catch (err) {
        console.error(`[Followups] Job ${job.id} error:`, err.message);
        updateJob(job.id, { status: 'skipped', error: err.message });
      }
    }
  } finally {
    draining = false;
  }
}

let schedulerTimer = null;

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(drainJobs, 60 * 1000); // every 60s
  console.log('[Followups] Scheduler started (60s interval)');
}

// ─── Public Interface ─────────────────────────────────────────────────────────

/**
 * Schedule a silence check 5 minutes after an outbound AI message.
 * Call this immediately after every outbound send in handleInbound.
 */
function scheduleSilenceCheck(contactId, currentStep, lastOutboundBody) {
  scheduleJob({
    contactId,
    type: 'silence-check',
    position: 0,
    sendAt: Date.now() + SILENCE_CHECK_MS,
    context: { lastOutboundBody, lastOutboundStep: currentStep }
  });
}

module.exports = {
  startScheduler,
  scheduleSilenceCheck,
  cancelContactJobs,
  getDueJobs,
  getContactJobs,
  getAllJobs,
  drainJobs
};
