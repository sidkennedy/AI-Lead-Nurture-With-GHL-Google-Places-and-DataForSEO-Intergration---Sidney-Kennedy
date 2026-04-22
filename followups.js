const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const prompts = require('./prompts');
const conversations = require('./conversations');
const ghl = require('./ghl');
const brain = require('./brain');
const { fetchCompetitorVelocity, findReferralSources, refreshRecentReviews } = require('./research');

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

// ─── Cadence Constants ────────────────────────────────────────────────────────

// Positions 2-5: first-week hooks (days 0, 2, 4, 7 from first follow-up)
// Positions 6-21: bi-weekly nurtures (every 3-4 days for 8 weeks = 16 messages)
// Position 22+: monthly nurtures indefinitely

const BIWEEKLY_START = 6;   // first bi-weekly position
const BIWEEKLY_END = 21;    // last bi-weekly position (16 messages over ~8 weeks)
const BIWEEKLY_DAYS_MIN = 3;
const BIWEEKLY_DAYS_MAX = 4;
const MONTHLY_DAYS = 30;

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

// ─── Email Window Helpers ─────────────────────────────────────────────────────

// Email send windows (local time):
//   Morning:  8:30am – 9:00am
//   Noon:    12:00pm – 1:00pm

function tzHourMinute(ts, tz) {
  const d = new Date(ts || Date.now());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || DEFAULT_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d);
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return { h, m };
}

function isInEmailWindow(ts, tz) {
  const { h, m } = tzHourMinute(ts || Date.now(), tz || DEFAULT_TZ);
  const inMorning = (h === 8 && m >= 30);
  const inNoon    = (h === 12);
  return inMorning || inNoon;
}

/**
 * Find the next email send window, scanning forward in 30-minute increments.
 * Windows: 8:30–9:00am and 12:00–1:00pm local time.
 */
function nextEmailWindowMs(fromMs, tz) {
  const timezone = tz || DEFAULT_TZ;
  const STEP = 30 * 60 * 1000;
  let t = Math.ceil((fromMs + 60_000) / STEP) * STEP;
  const limit = fromMs + 8 * 24 * 60 * 60 * 1000;
  while (t < limit) {
    if (isInEmailWindow(t, timezone)) return t;
    t += STEP;
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
    if (
      j.contactId === contactId &&
      j.status === 'pending' &&
      !j.type.startsWith('email-')
    ) {
      count++;
      return { ...j, status: 'cancelled' };
    }
    return j;
  });
  if (count > 0) {
    save(updated);
    console.log(`[Followups] Cancelled ${count} pending SMS jobs for ${contactId} (email jobs preserved)`);
  }
  return count;
}

function cancelEmailJobs(contactId) {
  const jobs = load();
  let count = 0;
  const updated = jobs.map(j => {
    if (
      j.contactId === contactId &&
      j.status === 'pending' &&
      j.type.startsWith('email-')
    ) {
      count++;
      return { ...j, status: 'cancelled' };
    }
    return j;
  });
  if (count > 0) {
    save(updated);
    console.log(`[Followups] Cancelled ${count} pending email jobs for ${contactId} (Disable AI tag)`);
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

// ─── Enrichment Fetching ──────────────────────────────────────────────────────

/**
 * Fetch all three enrichment data points fresh at follow-up generation time:
 * 1. recentReviews — live re-fetch from Google Place Details using stored placeId
 * 2. competitorVelocityDelta — live diff vs stored competitor review counts
 * 3. nearbyReferralSources — fetch once if not already stored (or if empty)
 *
 * Mutates researchData in place and persists back to the conversation record.
 * Returns an enrichment summary object for prompt injection.
 */
async function fetchEnrichments(contactId, researchData) {
  const apiKey = process.env.GOOGLE_PLACES_KEY;
  const enrichment = {
    recentReviews: researchData?.recentReviews || [],
    competitorVelocityDelta: null,
    nearbyReferralSources: researchData?.nearbyReferralSources || []
  };

  if (!researchData) return enrichment;

  let needsPersist = false;

  // 1. Recent reviews — always re-fetched live so they stay current
  if (researchData.placeId) {
    try {
      const freshReviews = await refreshRecentReviews(researchData.placeId, apiKey);
      if (freshReviews.length > 0) {
        enrichment.recentReviews = freshReviews;
        researchData.recentReviews = freshReviews;
        needsPersist = true;
        console.log(`[Followups] Refreshed ${freshReviews.length} reviews for ${contactId}`);
      }
    } catch (err) {
      console.log(`[Followups] Review refresh error for ${contactId}:`, err.message);
    }
  }

  // 2. Competitor velocity — always re-fetched to get a fresh diff
  try {
    const delta = await fetchCompetitorVelocity(researchData, apiKey);
    if (delta) {
      enrichment.competitorVelocityDelta = delta;
      console.log(`[Followups] Competitor velocity for ${contactId}: "${delta}"`);
    }
    // Persist if baseline counts were updated (even when no positive delta)
    if (researchData._competitorBaselineUpdated) {
      needsPersist = true;
      delete researchData._competitorBaselineUpdated;
    }
  } catch (err) {
    console.log(`[Followups] Competitor velocity fetch error for ${contactId}:`, err.message);
  }

  // 3. Referral sources — fetch once; re-fetch if empty (e.g. pre-existing contacts)
  if (enrichment.nearbyReferralSources.length === 0 && researchData.lat != null && researchData.lng != null) {
    try {
      const sources = await findReferralSources(researchData.lat, researchData.lng, apiKey);
      if (sources.length > 0) {
        enrichment.nearbyReferralSources = sources;
        researchData.nearbyReferralSources = sources;
        needsPersist = true;
        console.log(`[Followups] Found ${sources.length} referral sources for ${contactId}`);
      }
    } catch (err) {
      console.log(`[Followups] Referral source fetch error for ${contactId}:`, err.message);
    }
  }

  // Persist any updated enrichment data back to the conversation record
  if (needsPersist) {
    conversations.update(contactId, { researchData });
  }

  return enrichment;
}

/**
 * Format enrichment data into prompt-ready strings.
 */
function formatEnrichmentContext(enrichment) {
  const parts = [];

  if (enrichment.recentReviews && enrichment.recentReviews.length > 0) {
    const reviewLines = enrichment.recentReviews
      .map(r => `- ${r.author}: "${r.text}"`)
      .join('\n');
    parts.push(`RECENT GOOGLE REVIEWS (their actual patients, use names/quotes directly):\n${reviewLines}`);
  }

  if (enrichment.competitorVelocityDelta) {
    parts.push(`COMPETITOR REVIEW VELOCITY (fresh as of now):\n- ${enrichment.competitorVelocityDelta}`);
  }

  if (enrichment.nearbyReferralSources && enrichment.nearbyReferralSources.length > 0) {
    const sourceLines = enrichment.nearbyReferralSources
      .map(s => `- ${s.name} (${s.distKm}km away)`)
      .join('\n');
    parts.push(`NEARBY REFERRAL SOURCES (real businesses within 2km):\n${sourceLines}`);
  }

  return parts.join('\n\n');
}

// ─── Hook Message Generation ──────────────────────────────────────────────────

/**
 * Generate a hook or nurture message using AI.
 * Position 1 (Hook 1) is handled separately as a static send — this is only
 * called for positions 2+ where full conversation context is passed.
 */
async function generateHookMessage(contact, position, jobType, contactId) {
  const isNurture = jobType === 'nurture' || position >= BIWEEKLY_START;
  const promptName = isNurture ? 'followup.nurture' : 'followup.hook';

  const rawTemplate = prompts.get(promptName);
  const stage = brain.classifyStage(contact.currentStep ?? null);

  const conversationHistory = formatConversationHistory(contact.exchanges || []);

  const patterns = brain.getWinningPatterns(stage);
  const winningPatterns = (patterns && patterns.length > 0)
    ? `Opening styles that have generated replies: ${patterns.slice(0, 2).map(p => `"${(p.example || '').slice(0, 80)}"`).join(' | ')}. Lean toward similar energy.`
    : '';

  // Fetch live enrichments at generation time so they stay fresh
  const enrichment = await fetchEnrichments(contactId, contact.researchData || null);
  const enrichmentContext = formatEnrichmentContext(enrichment);

  const userPrompt = interpolate(rawTemplate, {
    firstName: contact.firstName || 'there',
    step: contact.currentStep ?? 1,
    stage,
    position,
    conversationHistory,
    winningPatterns,
    enrichmentContext
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

/**
 * Schedule the next follow-up in the aggressive sustained sequence:
 *
 * Week 1 hooks (positions 2–5):
 *   pos 2 → next available window (same day)
 *   pos 3 → +2 days
 *   pos 4 → +4 days
 *   pos 5 → +7 days
 *
 * Bi-weekly nurtures (positions 6–21, 16 messages over ~8 weeks):
 *   every 3–4 days
 *
 * Monthly nurtures (position 22+):
 *   every 30 days indefinitely
 */
function scheduleNext(contactId, sentPosition, currentStep, lastBody, tz) {
  const context = { lastOutboundBody: lastBody, lastOutboundStep: currentStep, timezone: tz };
  const DAY = 24 * 60 * 60 * 1000;

  if (sentPosition === 1) {
    // Same-day next window
    scheduleJob({ contactId, type: 'hook', position: 2, sendAt: nextWindowMs(Date.now(), tz), context });
  } else if (sentPosition === 2) {
    // Day 2
    scheduleJob({ contactId, type: 'hook', position: 3, sendAt: nextWindowMs(Date.now() + 2 * DAY, tz), context });
  } else if (sentPosition === 3) {
    // Day 4 (2 more days)
    scheduleJob({ contactId, type: 'hook', position: 4, sendAt: nextWindowMs(Date.now() + 2 * DAY, tz), context });
  } else if (sentPosition === 4) {
    // Day 7 (3 more days)
    scheduleJob({ contactId, type: 'hook', position: 5, sendAt: nextWindowMs(Date.now() + 3 * DAY, tz), context });
  } else if (sentPosition >= 5 && sentPosition < BIWEEKLY_END) {
    // Bi-weekly nurtures: every 3–4 days for 8 weeks
    const days = BIWEEKLY_DAYS_MIN + Math.floor(Math.random() * (BIWEEKLY_DAYS_MAX - BIWEEKLY_DAYS_MIN + 1));
    const nextPosition = sentPosition + 1;
    scheduleJob({ contactId, type: 'nurture', position: nextPosition, sendAt: nextWindowMs(Date.now() + days * DAY, tz), context });
  } else {
    // Monthly nurtures indefinitely
    scheduleJob({ contactId, type: 'nurture', position: sentPosition + 1, sendAt: nextWindowMs(Date.now() + MONTHLY_DAYS * DAY, tz), context });
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

// ─── AI-Generated Send (Hooks 2–5 + Nurture) ─────────────────────────────────

async function sendFollowUp(job, contact, position) {
  const freshContact = conversations.get(job.contactId) || contact;

  let hookText = '';
  try {
    hookText = await generateHookMessage(freshContact, position, job.type, job.contactId);
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

  console.log(`[Followups] ${job.type} pos=${position} sent to ${job.contactId}: "${hookText.slice(0, 80)}"`);
}

// ─── Email Stop / Defer Guards ────────────────────────────────────────────────

/**
 * Permanently stop email for this contact?
 * Returns { stop: true, reason } if booked or has Disable AI tag.
 */
function shouldStopEmail(contactId) {
  const contact = conversations.get(contactId);
  if (!contact) return { stop: true, reason: 'Contact not found' };
  if (contact.booked) return { stop: true, reason: 'Already booked' };
  const tags = (contact.tags || []).map(t => t.toLowerCase());
  if (tags.includes('disable ai')) return { stop: true, reason: 'Has Disable AI tag' };
  return { stop: false };
}

/**
 * Defer email because the lead is actively texting us?
 * Returns true if the most recent inbound SMS exchange was within the last 4 hours.
 */
function shouldDeferEmail(contactId) {
  const contact = conversations.get(contactId);
  if (!contact) return false;
  const exchanges = contact.exchanges || [];
  const lastInbound = [...exchanges].reverse().find(e => e.direction === 'inbound');
  if (!lastInbound) return false;
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
  return (lastInbound.timestamp || 0) > fourHoursAgo;
}

// ─── Email Message Generation ─────────────────────────────────────────────────

/**
 * Generate a subject + body for an email follow-up using Claude.
 * Returns { subject, body } or a static fallback on failure.
 */
async function generateEmailMessage(contact, position, jobType, contactId) {
  const isMonthly = position >= 9;
  const isNurture = jobType === 'email-nurture' || (position >= 5 && !isMonthly);
  const promptName = isMonthly ? 'email.monthly' : (isNurture ? 'email.nurture' : 'email.hook');

  const rawTemplate = prompts.get(promptName);
  const conversationHistory = formatConversationHistory(contact.exchanges || []);
  const enrichment = await fetchEnrichments(contactId, contact.researchData || null);
  const enrichmentContext = formatEnrichmentContext(enrichment);

  const practiceName = contact.practiceName ? ` at ${contact.practiceName}` : '';

  const userPrompt = interpolate(rawTemplate, {
    firstName: contact.firstName || 'there',
    practiceName,
    position,
    conversationHistory,
    enrichmentContext
  });

  const systemPrompt = prompts.get('email.system');

  try {
    const response = await getAI().messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const raw = response.content[0]?.text?.trim() || '';
    const parsed = JSON.parse(raw);
    if (parsed.subject && parsed.body) return parsed;
    throw new Error('Missing subject or body in Claude response');
  } catch (err) {
    console.error(`[Followups] Email generation error for ${contactId}:`, err.message);
    return {
      subject: 'Quick note',
      body: `Hi ${contact.firstName || 'there'} — wanted to follow up and see if now's a better time to connect.`
    };
  }
}

// ─── Email Sequence Progression ───────────────────────────────────────────────

/**
 * Schedule the next email in the sequence after one has been sent.
 *
 * Cadence (days after sent):
 *   pos 1 → 2: +2d  (day 2)
 *   pos 2 → 3: +2d  (day 4)
 *   pos 3 → 4: +3d  (day 7)
 *   pos 4 → 5: +7d  (week 2)
 *   pos 5–8:   +7d each (weekly)
 *   pos 9+:    +30d (monthly indefinitely)
 */
function scheduleEmailNext(contactId, sentPosition, tz) {
  const DAY = 24 * 60 * 60 * 1000;
  let daysOut;
  let nextType;

  if (sentPosition === 1) {
    daysOut = 2; nextType = 'email-hook';
  } else if (sentPosition === 2) {
    daysOut = 2; nextType = 'email-hook';
  } else if (sentPosition === 3) {
    daysOut = 3; nextType = 'email-hook';
  } else if (sentPosition === 4) {
    daysOut = 7; nextType = 'email-nurture';
  } else if (sentPosition >= 5 && sentPosition < 9) {
    daysOut = 7; nextType = 'email-nurture';
  } else {
    daysOut = 30; nextType = 'email-nurture';
  }

  const nextPosition = sentPosition + 1;

  // Dedupe: skip if a pending email job for this contact+position already exists
  const existingPending = load().some(
    j => j.contactId === contactId && j.type.startsWith('email-') &&
         j.position === nextPosition && j.status === 'pending'
  );
  if (existingPending) {
    console.log(`[Followups] Email pos=${nextPosition} already pending for ${contactId} — skipping duplicate`);
    return;
  }

  const sendAt = nextEmailWindowMs(Date.now() + daysOut * DAY, tz || DEFAULT_TZ);
  scheduleJob({
    contactId,
    type:     nextType,
    position: nextPosition,
    sendAt,
    context:  { timezone: tz || DEFAULT_TZ }
  });
}

// ─── Email Job Processor ──────────────────────────────────────────────────────

async function processEmailJob(job) {
  const tz = job.context?.timezone || getContactTimezone(job.contactId);

  // 1. Permanent stop check (booked or Disable AI tag)
  const stopCheck = shouldStopEmail(job.contactId);
  if (stopCheck.stop) {
    updateJob(job.id, { status: 'cancelled', error: stopCheck.reason });
    console.log(`[Followups] Email ${job.type} pos=${job.position} for ${job.contactId}: stopped — ${stopCheck.reason}`);
    return;
  }

  // 2. Defer if lead is actively texting (last inbound within 4 hours)
  if (shouldDeferEmail(job.contactId)) {
    const deferTo = nextEmailWindowMs(Date.now() + 4 * 60 * 60 * 1000, tz);
    updateJob(job.id, { sendAt: deferTo });
    console.log(`[Followups] Email ${job.type} pos=${job.position} for ${job.contactId}: active conversation — deferring to ${new Date(deferTo).toISOString()}`);
    return;
  }

  // 3. Defer if outside email window
  if (!isInEmailWindow(Date.now(), tz)) {
    const nextWindow = nextEmailWindowMs(Date.now(), tz);
    updateJob(job.id, { sendAt: nextWindow });
    console.log(`[Followups] Email ${job.type} pos=${job.position} for ${job.contactId}: outside email window — deferring to ${new Date(nextWindow).toISOString()}`);
    return;
  }

  // 4. Check contact has email on file
  const contact = conversations.get(job.contactId);
  if (!contact?.email) {
    updateJob(job.id, { status: 'skipped', error: 'No email on file' });
    console.log(`[Followups] Email ${job.type} pos=${job.position} for ${job.contactId}: skipped — no email on file`);
    return;
  }

  // 5. Generate email content
  let emailContent;
  try {
    emailContent = await generateEmailMessage(contact, job.position, job.type, job.contactId);
  } catch (err) {
    console.error(`[Followups] Email generation failed for ${job.contactId}:`, err.message);
    updateJob(job.id, { status: 'skipped', error: err.message });
    return;
  }

  // 6. Send via GHL
  let sendResult;
  try {
    sendResult = await ghl.sendEmail(job.contactId, emailContent.subject, emailContent.body);
  } catch (err) {
    console.error(`[Followups] GHL email send error for ${job.contactId}:`, err.message);
    updateJob(job.id, { status: 'skipped', error: `GHL: ${err.message}` });
    return;
  }

  if (!sendResult) {
    updateJob(job.id, { status: 'skipped', error: 'GHL returned null (email send failed)' });
    return;
  }

  // 7. Record exchange and schedule next
  conversations.addExchange(job.contactId, {
    direction: 'outbound',
    body: `[Email] ${emailContent.subject}: ${emailContent.body}`,
    step: contact.currentStep ?? null,
    conversationId: null,
    type: `email-pos${job.position}`
  });

  updateJob(job.id, { status: 'sent', sentAt: Date.now() });
  scheduleEmailNext(job.contactId, job.position, tz);

  console.log(`[Followups] Email pos=${job.position} sent to ${job.contactId}: "${emailContent.subject}"`);
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

  // Schedule Email #1 in parallel (next available email window)
  const tags = (contact.tags || []).map(t => t.toLowerCase());
  const hasDisableAI = tags.includes('disable ai');
  if (contact.email && !hasDisableAI && !contact.booked) {
    const tz = job.context?.timezone || getContactTimezone(job.contactId);
    const emailSendAt = nextEmailWindowMs(Date.now(), tz);
    // Dedupe: skip if an email-hook pos=1 already exists (pending or already sent)
    // This prevents a second pos1 if Email #1 sent before the silence check ran.
    const existing = load().some(
      j => j.contactId === job.contactId && j.type === 'email-hook' &&
           j.position === 1 && (j.status === 'pending' || j.status === 'sent')
    );
    if (!existing) {
      scheduleJob({
        contactId: job.contactId,
        type:      'email-hook',
        position:  1,
        sendAt:    emailSendAt,
        context:   { timezone: tz }
      });
      console.log(`[Followups] Email #1 scheduled for ${job.contactId} at ${new Date(emailSendAt).toISOString()}`);
    }
  }
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
  } else if (job.type === 'email-hook' || job.type === 'email-nurture') {
    await processEmailJob(job);
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
  cancelEmailJobs,
  getDueJobs,
  getContactJobs,
  getAllJobs,
  drainJobs,
  estimateTimezone,
  isInWindow,
  nextWindowMs,
  nextEmailWindowMs,
  scheduleEmailNext,
  scheduleJob
};
