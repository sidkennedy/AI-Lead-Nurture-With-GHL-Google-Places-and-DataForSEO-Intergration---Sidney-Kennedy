const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const prompts = require('./prompts');
const conversations = require('./conversations');
const ghl = require('./ghl');
const brain = require('./brain');

const FILE = path.join(__dirname, 'data', 'followups.json');

// Lazy-init Anthropic client
let _ai = null;
function getAI() {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _ai;
}

// ─── Timing Constants ─────────────────────────────────────────────────────────

const DEFAULT_TZ = 'America/New_York'; // EST fallback
const SILENCE_CHECK_MS = 5 * 60 * 1000; // 5 minutes
const MORNING_START = 7;  // 7am
const MORNING_END = 8;    // 8am
const EVENING_START = 16; // 4pm
const EVENING_END = 20;   // 8pm

// ─── Timezone Estimation ──────────────────────────────────────────────────────

/**
 * Estimate the prospect's IANA timezone from their city name.
 * Uses a simple keyword heuristic for US regions; defaults to EST.
 * This covers the most common cases without a full geolocation database.
 */
function estimateTimezone(city) {
  if (!city) return DEFAULT_TZ;
  const c = city.toLowerCase();

  // Pacific — CA, WA, OR, NV (major cities)
  if (/\b(los angeles|san francisco|san diego|sacramento|fresno|san jose|oakland|berkeley|anaheim|riverside|long beach|santa ana|irvine|seattle|portland|spokane|tacoma|las vegas|reno|henderson)\b/.test(c)) {
    return 'America/Los_Angeles';
  }

  // Mountain — CO, UT, ID, NM, MT, WY, AZ (most of AZ is no DST, but Denver is standard)
  if (/\b(denver|colorado springs|aurora|boulder|salt lake city|provo|ogden|boise|albuquerque|tucson|phoenix|tempe|mesa|chandler|scottsdale|flagstaff|billings|casper|cheyenne)\b/.test(c)) {
    return 'America/Denver';
  }

  // Central — TX, IL, MN, WI, MO, TN, LA, AR, OK, IA, KS, ND, SD, NE
  if (/\b(chicago|houston|dallas|san antonio|austin|fort worth|el paso|memphis|nashville|new orleans|oklahoma city|tulsa|kansas city|wichita|omaha|minneapolis|saint paul|madison|milwaukee|st louis|little rock|baton rouge|jackson|des moines|sioux falls|fargo|bismarck)\b/.test(c)) {
    return 'America/Chicago';
  }

  // Default: Eastern
  return DEFAULT_TZ;
}

/**
 * Get the estimated timezone for a contact by looking up their city.
 */
function getContactTimezone(contactId) {
  const contact = conversations.get(contactId);
  return estimateTimezone(contact?.city || '');
}

// ─── Window Helpers ───────────────────────────────────────────────────────────

function tzHour(ts, tz) {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz || DEFAULT_TZ, hour: '2-digit', hour12: false })
      .format(new Date(ts || Date.now())),
    10
  );
}

function isInWindow(ts, tz) {
  const h = tzHour(ts || Date.now(), tz || DEFAULT_TZ);
  return (h >= MORNING_START && h < MORNING_END) || (h >= EVENING_START && h < EVENING_END);
}

/**
 * Find the next allowed send window, scanning forward in 1-hour increments.
 * Uses the contact's estimated timezone (with EST fallback).
 */
function nextWindowMs(fromMs, tz) {
  const timezone = tz || DEFAULT_TZ;
  let t = Math.ceil((fromMs + 60_000) / 3_600_000) * 3_600_000;
  const limit = fromMs + 8 * 24 * 60 * 60 * 1000;
  while (t < limit) {
    const h = tzHour(t, timezone);
    if ((h >= MORNING_START && h < MORNING_END) || (h >= EVENING_START && h < EVENING_END)) {
      return t;
    }
    t += 3_600_000;
  }
  return fromMs + 24 * 60 * 60 * 1000;
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

function scheduleJob({ contactId, type, position, sendAt, context }) {
  const jobs = load();
  const job = {
    id: makeId(),
    contactId,
    type,
    position,
    sendAt,
    status: 'pending',
    context: context || {},
    createdAt: Date.now(),
    sentAt: null,
    error: null
  };
  jobs.push(job);
  save(jobs);
  console.log(`[Followups] Scheduled ${type} pos=${position} for ${contactId} at ${new Date(sendAt).toISOString()} (tz: ${context?.timezone || DEFAULT_TZ})`);
  return job;
}

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

function getDueJobs() {
  const now = Date.now();
  return load().filter(j => j.status === 'pending' && j.sendAt <= now);
}

function updateJob(jobId, updates) {
  const jobs = load();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;
  jobs[idx] = { ...jobs[idx], ...updates };
  save(jobs);
}

function getContactJobs(contactId) {
  return load().filter(j => j.contactId === contactId);
}

function getAllJobs(statusFilter) {
  const jobs = load();
  if (!statusFilter) return jobs;
  return jobs.filter(j => j.status === statusFilter);
}

// ─── Prompt Interpolation ─────────────────────────────────────────────────────

function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// ─── Conversation History Formatter ──────────────────────────────────────────

/**
 * Format a contact's exchanges array into a readable plain-text transcript
 * suitable for injection into follow-up prompts.
 */
function formatConversationHistory(exchanges) {
  if (!exchanges || exchanges.length === 0) return '(no conversation history available)';
  return exchanges
    .filter(e => e.body && e.body.trim())
    .map(e => {
      const role = e.direction === 'inbound' ? 'PROSPECT' : 'AI';
      return `${role}: ${e.body.trim()}`;
    })
    .join('\n');
}

// ─── Hook Message Generation ──────────────────────────────────────────────────

/**
 * Generate a hook or nurture message using AI.
 * Position 1 (Hook 1) is handled separately as a static send — this is only
 * called for positions 2+ where full conversation context is passed.
 */
async function generateHookMessage(contact, position, jobType) {
  const isNurture = jobType === 'nurture' || position >= 4;
  const promptName = isNurture ? 'followup.nurture' : 'followup.hook';

  const rawTemplate = prompts.get(promptName);
  const stage = brain.classifyStage(contact.currentStep ?? null);

  const conversationHistory = formatConversationHistory(contact.exchanges || []);

  const patterns = brain.getWinningPatterns(stage);
  const winningPatterns = (patterns && patterns.length > 0)
    ? `Opening styles that have generated replies: ${patterns.slice(0, 2).map(p => `"${(p.example || '').slice(0, 80)}"`).join(' | ')}. Lean toward similar energy.`
    : '';

  const userPrompt = interpolate(rawTemplate, {
    firstName: contact.firstName || 'there',
    step: contact.currentStep ?? 1,
    stage,
    conversationHistory,
    winningPatterns
  });

  const systemPrompt = prompts.get('followup.system');

  const response = await getAI().messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return response.content[0]?.text?.trim() || '';
}

// ─── Sequence Progression ─────────────────────────────────────────────────────

function scheduleNext(contactId, sentPosition, currentStep, lastBody, tz) {
  const context = { lastOutboundBody: lastBody, lastOutboundStep: currentStep, timezone: tz };

  if (sentPosition === 1) {
    scheduleJob({ contactId, type: 'hook', position: 2, sendAt: nextWindowMs(Date.now(), tz), context });
  } else if (sentPosition === 2) {
    const days = 1 + Math.floor(Math.random() * 3);
    const base = Date.now() + days * 24 * 60 * 60 * 1000;
    scheduleJob({ contactId, type: 'hook', position: 3, sendAt: nextWindowMs(base, tz), context });
  } else if (sentPosition === 3) {
    const base = Date.now() + 30 * 24 * 60 * 60 * 1000;
    scheduleJob({ contactId, type: 'nurture', position: 4, sendAt: nextWindowMs(base, tz), context });
  } else {
    const base = Date.now() + 30 * 24 * 60 * 60 * 1000;
    scheduleJob({ contactId, type: 'nurture', position: sentPosition + 1, sendAt: nextWindowMs(base, tz), context });
  }
}

// ─── Hook 1 Static Send ───────────────────────────────────────────────────────

/**
 * Send a plain static "Hey [firstName], you there?" — no AI call, no template.
 * This fires 5 minutes after silence and is intentionally minimal.
 */
async function sendHook1Static(job, contact) {
  const firstName = contact.firstName || '';
  const hookText = firstName ? `Hey ${firstName}, you there?` : 'Hey, you there?';

  let sendResult;
  try {
    sendResult = await ghl.sendMessage(job.contactId, hookText);
  } catch (err) {
    console.error(`[Followups] GHL send error (Hook 1) for ${job.contactId}:`, err.message);
    updateJob(job.id, { status: 'skipped', error: `GHL: ${err.message}` });
    return;
  }

  if (!sendResult) {
    console.error(`[Followups] GHL returned null (Hook 1) for ${job.contactId} — marking skipped`);
    updateJob(job.id, { status: 'skipped', error: 'GHL returned null (send failed)' });
    return;
  }

  conversations.addExchange(job.contactId, {
    direction: 'outbound',
    body: hookText,
    step: contact.currentStep ?? null,
    conversationId: null,
    type: 'followup-hook-pos1'
  });

  brain.recordOutbound(job.contactId, hookText, contact.currentStep ?? null);

  const tz = job.context?.timezone || getContactTimezone(job.contactId);
  updateJob(job.id, { status: 'sent', sentAt: Date.now() });
  scheduleNext(job.contactId, 1, contact.currentStep ?? null, hookText, tz);

  console.log(`[Followups] Hook 1 (static) sent to ${job.contactId}: "${hookText}"`);
}

// ─── AI-Generated Send (Hooks 2/3 + Nurture) ─────────────────────────────────

async function sendFollowUp(job, contact, position) {
  const freshContact = conversations.get(job.contactId) || contact;

  let hookText = '';
  try {
    hookText = await generateHookMessage(freshContact, position, job.type);
  } catch (err) {
    console.error(`[Followups] Claude error for ${job.contactId}:`, err.message);
    updateJob(job.id, { status: 'skipped', error: err.message });
    return;
  }

  if (!hookText) {
    updateJob(job.id, { status: 'skipped', error: 'Empty message generated' });
    return;
  }

  let sendResult;
  try {
    sendResult = await ghl.sendMessage(job.contactId, hookText);
  } catch (err) {
    console.error(`[Followups] GHL send error for ${job.contactId}:`, err.message);
    updateJob(job.id, { status: 'skipped', error: `GHL: ${err.message}` });
    return;
  }

  if (!sendResult) {
    console.error(`[Followups] GHL returned null for ${job.contactId} — marking skipped`);
    updateJob(job.id, { status: 'skipped', error: 'GHL returned null (send failed)' });
    return;
  }

  conversations.addExchange(job.contactId, {
    direction: 'outbound',
    body: hookText,
    step: freshContact.currentStep ?? null,
    conversationId: null,
    type: `followup-${job.type}-pos${position}`
  });

  brain.recordOutbound(job.contactId, hookText, freshContact.currentStep ?? null);

  const tz = job.context?.timezone || getContactTimezone(job.contactId);
  updateJob(job.id, { status: 'sent', sentAt: Date.now() });
  scheduleNext(job.contactId, position, freshContact.currentStep ?? null, hookText, tz);

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

  const exchanges = contact.exchanges || [];
  const lastInbound = [...exchanges].reverse().find(e => e.direction === 'inbound');
  const lastOutbound = [...exchanges].reverse().find(e => e.direction === 'outbound');

  const hasReplied = lastInbound && lastOutbound && lastInbound.timestamp > lastOutbound.timestamp;

  if (hasReplied) {
    updateJob(job.id, { status: 'cancelled', error: 'Contact replied' });
    console.log(`[Followups] Silence check for ${job.contactId}: replied — done`);
    return;
  }

  console.log(`[Followups] Silence check for ${job.contactId}: silent — sending Hook 1 (static)`);
  await sendHook1Static(job, contact);
}

async function processHookOrNurture(job) {
  const tz = job.context?.timezone || getContactTimezone(job.contactId);

  if (!isInWindow(Date.now(), tz)) {
    const nextWindow = nextWindowMs(Date.now(), tz);
    updateJob(job.id, { sendAt: nextWindow });
    console.log(`[Followups] ${job.type} pos=${job.position} for ${job.contactId}: outside window (${tz}) — deferring to ${new Date(nextWindow).toISOString()}`);
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
  schedulerTimer = setInterval(drainJobs, 60 * 1000);
  console.log('[Followups] Scheduler started (60s interval)');
}

// ─── Public Interface ─────────────────────────────────────────────────────────

/**
 * Schedule a 5-minute silence check after an outbound AI message.
 * Stores the estimated prospect timezone in the job context.
 */
function scheduleSilenceCheck(contactId, currentStep, lastOutboundBody) {
  const tz = getContactTimezone(contactId);
  scheduleJob({
    contactId,
    type: 'silence-check',
    position: 0,
    sendAt: Date.now() + SILENCE_CHECK_MS,
    context: { lastOutboundBody, lastOutboundStep: currentStep, timezone: tz }
  });
}

module.exports = {
  startScheduler,
  scheduleSilenceCheck,
  cancelContactJobs,
  getDueJobs,
  getContactJobs,
  getAllJobs,
  drainJobs,
  estimateTimezone,
  isInWindow,
  nextWindowMs
};
