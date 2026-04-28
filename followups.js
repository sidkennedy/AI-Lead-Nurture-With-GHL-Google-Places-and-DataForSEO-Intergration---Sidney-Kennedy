const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const spend = require('./spend');
const optouts = require('./optouts');
const config = require('./config');
const prompts = require('./prompts');
const conversations = require('./conversations');
const ghl = require('./ghl');
const brain = require('./brain');
const outboundLock = require('./outbound-lock');
const { fetchCompetitorVelocity, findReferralSources, refreshRecentReviews, fetchReviewCount } = require('./research');

const _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// In-memory job cache — load() reads sync from here; DB is the persistence layer
let _jobCache = [];

async function _initJobsFromDb() {
  try {
    const { rows } = await _pool.query('SELECT * FROM followup_jobs ORDER BY send_at ASC');
    _jobCache = rows.map(r => ({
      id:        r.id,
      contactId: r.contact_id,
      type:      r.type,
      position:  r.position,
      sendAt:    r.send_at    ? Number(r.send_at)    : null,
      status:    r.status,
      sentAt:    r.sent_at    ? Number(r.sent_at)    : null,
      createdAt: r.created_at ? Number(r.created_at) : null,
      context:   r.context || {},
      error:     r.context?.error || null
    }));
    console.log(`[Followups] DB loaded: ${_jobCache.length} jobs`);
  } catch (err) {
    console.error('[Followups] DB init error:', err.message);
  }
}

function _dbUpsertJob(j) {
  _pool.query(
    `INSERT INTO followup_jobs (id, contact_id, type, position, send_at, status, sent_at, created_at, context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       status=$6, sent_at=$7, context=$9`,
    [j.id, j.contactId, j.type, j.position ?? null, j.sendAt ?? null,
     j.status, j.sentAt ?? null, j.createdAt ?? Date.now(),
     JSON.stringify({ ...j.context, error: j.error || undefined })]
  ).catch(err => console.error('[Followups] DB upsert error:', err.message));
}

function _dbBulkUpdateStatus(ids, status) {
  if (!ids.length) return;
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(',');
  _pool.query(
    `UPDATE followup_jobs SET status=$1 WHERE id IN (${placeholders})`,
    [status, ...ids]
  ).catch(err => console.error('[Followups] DB bulk update error:', err.message));
}

/**
 * Atomically claim a pending job at the DB level.
 *
 * Returns true if THIS process successfully transitioned the row from
 * 'pending' → 'sending', false if another process already owned it.
 *
 * This is the cross-process safety guard for duplicate sends during
 * deploy rollovers (when two app instances briefly co-exist and both
 * poll the shared DB). Single-process races are already handled by
 * the per-contact outbound lock + in-cache re-check; this function
 * adds the third defense for the multi-process case.
 *
 * Trade-off: if the process crashes AFTER claiming but BEFORE finalizing
 * to 'sent'/'skipped', the row sits in 'sending' indefinitely and the
 * job is silently dropped (getDueJobs filters by status='pending', so
 * 'sending' is never re-picked). For low-stakes messages like the
 * 5-min silence nudge, silent drop is preferable to a duplicate send.
 */
async function _dbAtomicClaim(jobId) {
  try {
    const { rowCount } = await _pool.query(
      `UPDATE followup_jobs SET status='sending'
       WHERE id=$1 AND status='pending'
       RETURNING id`,
      [jobId]
    );
    return rowCount === 1;
  } catch (err) {
    console.error(`[Followups] DB atomic claim error for ${jobId}:`, err.message);
    // On DB error, fail CLOSED (return false → skip the send) rather
    // than fail open (return true → potentially duplicate).
    return false;
  }
}

_initJobsFromDb();

// When a contact hits the $1 spend cap, immediately cancel all their pending jobs
spend.onLimitHit(contactId => {
  const cancelled = cancelContactJobs(contactId) + cancelEmailJobs(contactId);
  if (cancelled > 0) {
    console.warn(`[Spend] Cancelled ${cancelled} pending jobs for ${contactId}`);
  }
});

// Lazy-init Anthropic client
let _ai = null;
function getAI() {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _ai;
}

// ─── Timing Constants ─────────────────────────────────────────────────────────

const DEFAULT_TZ       = 'America/New_York'; // EST fallback when city unknown
const SILENCE_CHECK_MS = 5 * 60 * 1000;     // 5 minutes

// SMS send window: 7:00pm – 9:00pm local time (Eastern when city unknown).
// Jobs are scattered randomly within this window at scheduling time so texts
// drip out across 2 hours rather than blasting all at once.
const WINDOW_START_HOUR = 19; // 7pm
const WINDOW_END_HOUR   = 21; // 9pm (exclusive)

// ─── Cadence Constants ────────────────────────────────────────────────────────

// Positions 2-5: first-week hooks (days 0, 2, 4, 7 from first follow-up)
// Positions 6-9:  nurtures every 4 days for 2 weeks (4 messages)
// Position 10+: monthly nurtures indefinitely

const BIWEEKLY_START = 6;   // first nurture position
const BIWEEKLY_END = 9;     // last nurture position (4 messages over ~2 weeks)
const BIWEEKLY_DAYS_MIN = 4;
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

function tzTime(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || DEFAULT_TZ,
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ts || Date.now()));
  return {
    hour:   parseInt(parts.find(p => p.type === 'hour').value,   10),
    minute: parseInt(parts.find(p => p.type === 'minute').value, 10)
  };
}

// Keep tzHour for any callers that still use it
function tzHour(ts, tz) { return tzTime(ts, tz).hour; }

function isInWindow(ts, tz) {
  const { hour } = tzTime(ts || Date.now(), tz || DEFAULT_TZ);
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

/**
 * Find the next SMS send window and return a randomly scattered time within it.
 * Window: 7:00pm–9:00pm in the contact's local timezone (Eastern fallback).
 * Scatter: each call picks a random minute (0–119) within the 2-hour window
 * so texts drip out rather than blasting all at once.
 */
function nextWindowMs(fromMs, tz) {
  const timezone = tz || DEFAULT_TZ;
  const STEP = 30 * 60 * 1000; // 30-minute scan step
  // Snap to next 30-minute boundary at least 1 min ahead
  let t = Math.ceil((fromMs + 60_000) / STEP) * STEP;
  const limit = fromMs + 8 * 24 * 60 * 60 * 1000;
  while (t < limit) {
    const { hour } = tzTime(t, timezone);
    if (hour === WINDOW_START_HOUR) {
      // Found the 7pm anchor — scatter randomly across the full 2-hour window
      const scatterMs = Math.floor(Math.random() * 120) * 60 * 1000;
      return t + scatterMs;
    }
    t += STEP;
  }
  return fromMs + 24 * 60 * 60 * 1000;
}

// ─── Email Window Helpers ─────────────────────────────────────────────────────

// Email send windows (local time):
//   Morning:  8:30am – 9:30am  (60 min)
//   Noon:    12:00pm – 2:00pm  (120 min)

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
  const inMorning = (h === 8 && m >= 30) || (h === 9 && m < 30); // 8:30–9:29am
  const inNoon    = (h === 12 || h === 13);                        // 12:00–1:59pm
  return inMorning || inNoon;
}

/**
 * Find the next email send window and return a randomly scattered time within it.
 * Windows: 8:30–9:30am (60-min window) and 12:00–2:00pm (120-min window) local time.
 * Scatter: picks a random minute within whichever window it lands on so emails
 * drip out rather than blasting at the same moment.
 */
function nextEmailWindowMs(fromMs, tz) {
  const timezone = tz || DEFAULT_TZ;
  const STEP = 30 * 60 * 1000;
  let t = Math.ceil((fromMs + 60_000) / STEP) * STEP;
  const limit = fromMs + 8 * 24 * 60 * 60 * 1000;
  while (t < limit) {
    const { h, m } = tzHourMinute(t, timezone);
    if (h === 8 && m === 30) {
      // Morning anchor (8:30am) — scatter across 60-min window (8:30–9:29am)
      return t + Math.floor(Math.random() * 60) * 60 * 1000;
    }
    if (h === 12 && m === 0) {
      // Noon anchor (12:00pm) — scatter across 120-min window (12:00–1:59pm)
      return t + Math.floor(Math.random() * 120) * 60 * 1000;
    }
    t += STEP;
  }
  return fromMs + 24 * 60 * 60 * 1000;
}

// ─── In-Memory Store (backed by PostgreSQL) ───────────────────────────────────

function load() {
  return _jobCache;
}

function save(jobs) {
  // Find new/changed jobs and write to DB
  const oldIds = new Set(_jobCache.map(j => j.id));
  const newIds = new Set(jobs.map(j => j.id));
  // Upsert changed or new
  for (const j of jobs) {
    const old = _jobCache.find(o => o.id === j.id);
    if (!old || old.status !== j.status || old.sentAt !== j.sentAt) {
      _dbUpsertJob(j);
    }
  }
  _jobCache = jobs;
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
  _dbUpsertJob(job);
  console.log(`[Followups] Scheduled ${type} pos=${position} for ${contactId} at ${new Date(sendAt).toISOString()} (tz: ${context?.timezone || DEFAULT_TZ})`);
  return job;
}

function cancelContactJobs(contactId) {
  const jobs = load();
  let count = 0;
  const cancelledIds = [];
  const updated = jobs.map(j => {
    if (
      j.contactId === contactId &&
      j.status === 'pending' &&
      !j.type.startsWith('email-')
    ) {
      count++;
      cancelledIds.push(j.id);
      return { ...j, status: 'cancelled' };
    }
    return j;
  });
  if (count > 0) {
    save(updated);
    _dbBulkUpdateStatus(cancelledIds, 'cancelled');
    console.log(`[Followups] Cancelled ${count} pending SMS jobs for ${contactId} (email jobs preserved)`);
  }
  return count;
}

function cancelEmailJobs(contactId) {
  const jobs = load();
  let count = 0;
  const cancelledIds = [];
  const updated = jobs.map(j => {
    if (
      j.contactId === contactId &&
      j.status === 'pending' &&
      j.type.startsWith('email-')
    ) {
      count++;
      cancelledIds.push(j.id);
      return { ...j, status: 'cancelled' };
    }
    return j;
  });
  if (count > 0) {
    save(updated);
    _dbBulkUpdateStatus(cancelledIds, 'cancelled');
    console.log(`[Followups] Cancelled ${count} pending email jobs for ${contactId} (Disable AI tag)`);
  }
  return count;
}

function getDueJobs() {
  const now = Date.now();
  // Dedupe by job ID. The in-memory cache should never contain duplicates,
  // but if a corrupted save() ever produced one, two ticks of drainJobs
  // would process the same job twice (cause: duplicate outbound sends).
  // This is a cheap belt-and-suspenders guard.
  const seen = new Set();
  const out = [];
  for (const j of load()) {
    if (j.status !== 'pending' || j.sendAt > now) continue;
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
  }
  return out;
}

function updateJob(jobId, updates) {
  const jobs = load();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;
  jobs[idx] = { ...jobs[idx], ...updates };
  save(jobs);
  _dbUpsertJob(jobs[idx]);
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

  // 2. Competitor velocity + prospect's own review gain — always re-fetched fresh
  try {
    const delta = await fetchCompetitorVelocity(researchData, apiKey);
    if (delta) {
      enrichment.competitorVelocityDelta = delta;
      console.log(`[Followups] Competitor velocity for ${contactId}: "${delta}"`);
    }
    if (researchData._competitorBaselineUpdated) {
      needsPersist = true;
      delete researchData._competitorBaselineUpdated;
    }
  } catch (err) {
    console.log(`[Followups] Competitor velocity fetch error for ${contactId}:`, err.message);
  }

  // 2b. Prospect's own review velocity — needed for Template 6 ("You added [N]")
  //     Re-fetch their current total and diff against the baseline stored in researchData.reviews
  if (researchData.placeId && typeof researchData.reviews === 'number') {
    try {
      const currentCount = await fetchReviewCount(researchData.placeId, apiKey);
      if (currentCount !== null) {
        const gained = Math.max(0, currentCount - researchData.reviews);
        enrichment.prospectReviewGain = gained;
        if (currentCount !== researchData.reviews) {
          researchData.reviews = currentCount;
          needsPersist = true;
        }
        console.log(`[Followups] Prospect review gain for ${contactId}: +${gained} (now ${currentCount})`);
      }
    } catch (err) {
      console.log(`[Followups] Prospect review count error for ${contactId}:`, err.message);
    }
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
    const prospectGain = typeof enrichment.prospectReviewGain === 'number'
      ? ` (prospect gained ${enrichment.prospectReviewGain} in the same period)`
      : '';
    parts.push(`COMPETITOR REVIEW VELOCITY (fresh as of now):\n- ${enrichment.competitorVelocityDelta}${prospectGain}`);
  }

  if (enrichment.nearbyReferralSources && enrichment.nearbyReferralSources.length > 0) {
    const sourceLines = enrichment.nearbyReferralSources
      .map(s => {
        const mi = Math.round((s.distKm || 0) * 0.621371 * 10) / 10;
        return `- ${s.name} (${mi} mile${mi === 1 ? '' : 's'} away)`;
      })
      .join('\n');
    parts.push(`NEARBY REFERRAL SOURCES (ENTs, health insurers, and audiologist referral offices within ~1.2 miles — use the name and distance directly in the message):\n${sourceLines}`);
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

  const patterns = brain.getWinningPatterns(stage, 'sms_followups');
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

  const now = new Date();
  const dateContext = `Today is ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}. Current time: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.`;
  const systemPrompt = `${dateContext}\n\n${prompts.get('followup.system')}`;

  if (spend.isAtLimit(contactId)) {
    console.warn(`[Followups] Skipping SMS generation for ${contactId} — spend limit reached`);
    return '';
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const response = await getAI().messages.create({
    model,
    max_tokens: 200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  spend.track(contactId, model, response.usage);

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

  // Acquire the outbound lock so an inbound webhook arriving between SEND and
  // PERSIST waits for state to settle before reading it. Without this, a fast
  // "you there?" → "yes!" round-trip can race ahead of addExchange and cause
  // duplicate sends or wrong-step replies.
  const _lock = outboundLock.acquire(job.contactId);
  try {
    // ── LOCK-TIME DEDUP (in-process) ──────────────────────────────────────
    // The dedup in processSilenceCheck (line ~1027) runs BEFORE the lock,
    // so two concurrent calls (e.g., a scheduler-tick race or a transient
    // duplicate cache entry) can both pass it on stale state and proceed
    // to call sendHook1Static. The lock serializes them per-contact, but
    // without re-checking inside the lock, both still send. Re-verify here:
    //   1. The job itself is still 'pending' in cache.
    //   2. No `silence-nudge` exchange already exists for this contact.
    // Either condition means a duplicate is in flight — abort silently.
    const freshJob = load().find(j => j.id === job.id);
    if (freshJob && freshJob.status !== 'pending') {
      console.log(`[Followups] Silence nudge for ${job.contactId}: job already ${freshJob.status} (lock-time dedup) — skipping duplicate send`);
      return;
    }
    const freshContact = conversations.get(job.contactId) || contact;
    const freshExchanges = freshContact?.exchanges || [];
    if (freshExchanges.some(e => e.type === 'silence-nudge')) {
      // Only rewrite status if the cached row is still 'pending' — never
      // overwrite a 'sent'/'skipped' final state with 'cancelled'.
      if (!freshJob || freshJob.status === 'pending') {
        updateJob(job.id, { status: 'cancelled', error: 'Silence nudge already sent (lock-time dedup)' });
      }
      console.log(`[Followups] Silence nudge for ${job.contactId}: nudge already in exchanges (lock-time dedup) — skipping duplicate send`);
      return;
    }

    // ── ATOMIC DB CLAIM (cross-process) ───────────────────────────────────
    // Reserved-VM deploys can briefly run two app instances during rollover.
    // Both have separate _jobCache copies, so the in-process lock above does
    // NOT protect against them. The atomic UPDATE...WHERE status='pending'
    // ensures only ONE process transitions the row from pending → sending,
    // so only that process proceeds to call ghl.sendMessage. The other one
    // sees rowCount=0 and aborts before sending.
    const claimed = await _dbAtomicClaim(job.id);
    if (!claimed) {
      console.log(`[Followups] Silence nudge for ${job.contactId}: another process owns job ${job.id} (DB claim failed) — skipping duplicate send`);
      return;
    }

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

    // Tagged as `silence-nudge` (not `followup-hook-pos1`) so it stays
    // INDEPENDENT from the AI opener. The opener uses `followup-hook-pos1`
    // for its own dedup; if we shared the marker, the opener would suppress
    // this 5-minute "you there?" nudge entirely. Keeping markers separate
    // lets both fire in sequence: opener first, then this nudge 5 min later.
    conversations.addExchange(job.contactId, {
      direction: 'outbound',
      body: hookText,
      step: contact.currentStep ?? null,
      conversationId: null,
      type: 'silence-nudge'
    });

    brain.recordOutbound(job.contactId, hookText, contact.currentStep ?? null,
      { message_type: 'followup-sms', messageClass: 'silence-nudge', position: 1 });

    updateJob(job.id, { status: 'sent', sentAt: Date.now() });
    // Do NOT call scheduleNext here — the opener already queued Hook 2.
    // Calling it again would create a duplicate Hook 2 job for this contact.

    console.log(`[Followups] Silence nudge ("you there?") sent to ${job.contactId}: "${hookText}"`);
  } finally {
    _lock.release();
  }
}

// ─── AI-Generated Send (Hooks 2–5 + Nurture) ─────────────────────────────────

async function sendFollowUp(job, contact, position) {
  // Acquire the outbound lock so any inbound webhook arriving mid-send waits
  // for our SEND→PERSIST window to fully close. Otherwise a fast prospect
  // reply can be processed against stale state and trigger duplicate or
  // wrong-step responses.
  const _lock = outboundLock.acquire(job.contactId);
  try {
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

    const messageClass = job.type === 'nurture' || position >= 4 ? 'nurture'
      : position === 3 ? 'hook-3'
      : position === 2 ? 'hook-2'
      : 'hook-1';
    brain.recordOutbound(job.contactId, hookText, freshContact.currentStep ?? null,
      { message_type: 'followup-sms', messageClass, position });

    const tz = job.context?.timezone || getContactTimezone(job.contactId);
    updateJob(job.id, { status: 'sent', sentAt: Date.now() });
    scheduleNext(job.contactId, position, freshContact.currentStep ?? null, hookText, tz);

    console.log(`[Followups] ${job.type} pos=${position} sent to ${job.contactId}: "${hookText.slice(0, 80)}"`);
  } finally {
    _lock.release();
  }
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
 * Returns true if the most recent inbound SMS exchange was within the last 14 hours.
 * Email #1 (position 1) is exempt — it always fires at the next window since it
 * is triggered specifically because the contact did NOT reply to initial outreach.
 */
function shouldDeferEmail(contactId, position) {
  if (position === 1) return false; // initial email is never deferred
  const contact = conversations.get(contactId);
  if (!contact) return false;
  const exchanges = contact.exchanges || [];
  const lastInbound = [...exchanges].reverse().find(e => e.direction === 'inbound');
  if (!lastInbound) return false;
  const fourteenHoursAgo = Date.now() - 14 * 60 * 60 * 1000;
  return (lastInbound.timestamp || 0) > fourteenHoursAgo;
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

  // Inject email-specific winning patterns from the learning brain.
  // Confidence is reply-based: low (<10 replies) = don't inject, still testing.
  // Medium (10–29 replies) = promising, lean toward it.
  // High (30+ replies) = strong signal, Claude should default to this style.
  const stage = brain.classifyStage(contact.currentStep ?? null);
  const emailPatterns = brain.getWinningPatterns(stage, 'email') || [];
  const actionable = emailPatterns.filter(p =>
    p.confidence_level === 'high' || p.confidence_level === 'medium'
  );

  let winningPatterns = '';
  if (actionable.length > 0) {
    const high = actionable.filter(p => p.confidence_level === 'high');
    const medium = actionable.filter(p => p.confidence_level === 'medium');

    if (high.length > 0) {
      const examples = high.slice(0, 2).map(p =>
        `"${(p.example || '').slice(0, 80)}" (${p.replyRate}% reply rate across ${p.reply_count} replies / ${p.sample_size} sent)`
      ).join('\n');
      winningPatterns = `STRONG SIGNAL — these email styles are consistently generating replies at scale. Default to this energy and structure unless the conversation context gives you a specific reason to diverge:\n${examples}`;
    } else if (medium.length > 0) {
      const examples = medium.slice(0, 2).map(p =>
        `"${(p.example || '').slice(0, 80)}" (${p.replyRate}% reply rate, ${p.reply_count} replies so far — still building data)`
      ).join('\n');
      winningPatterns = `Patterns showing early promise — lean toward this energy while we keep testing:\n${examples}`;
    }
  }
  // If no actionable patterns: winningPatterns stays '' and {{winningPatterns}}
  // renders as nothing — Claude keeps exploring freely until data is sufficient.

  const userPrompt = interpolate(rawTemplate, {
    firstName: contact.firstName || 'there',
    practiceName,
    position,
    conversationHistory,
    enrichmentContext,
    winningPatterns
  });

  const _emailNow = new Date();
  const _emailDateCtx = `Today is ${_emailNow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}. Current time: ${_emailNow.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.`;
  const systemPrompt = `${_emailDateCtx}\n\n${prompts.get('email.system')}`;

  if (spend.isAtLimit(contactId)) {
    console.warn(`[Followups] Skipping email generation for ${contactId} — spend limit reached`);
    return null;
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  try {
    const response = await getAI().messages.create({
      model,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    spend.track(contactId, model, response.usage);

    const raw = (response.content[0]?.text || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
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

  // 2. Defer if lead is actively texting (last inbound within 14 hours); pos 1 exempt
  if (shouldDeferEmail(job.contactId, job.position)) {
    const deferTo = nextEmailWindowMs(Date.now() + 14 * 60 * 60 * 1000, tz);
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

  // 5. Spend limit check
  if (spend.isAtLimit(job.contactId)) {
    updateJob(job.id, { status: 'cancelled', error: 'API spend limit reached' });
    cancelContactJobs(job.contactId);
    cancelEmailJobs(job.contactId);
    return;
  }

  // 6. Generate email content
  let emailContent;
  try {
    emailContent = await generateEmailMessage(contact, job.position, job.type, job.contactId);
  } catch (err) {
    console.error(`[Followups] Email generation failed for ${job.contactId}:`, err.message);
    updateJob(job.id, { status: 'skipped', error: err.message });
    return;
  }
  if (!emailContent) {
    updateJob(job.id, { status: 'cancelled', error: 'API spend limit reached' });
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
  const emailBody = `[Email] ${emailContent.subject}: ${emailContent.body}`;
  conversations.addExchange(job.contactId, {
    direction: 'outbound',
    body: emailBody,
    step: contact.currentStep ?? null,
    conversationId: null,
    type: `email-pos${job.position}`
  });
  brain.recordOutbound(job.contactId, emailBody, contact.currentStep ?? null,
    { message_type: 'email', position: job.position });

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

  // Cancel if they've replied since our last outbound — OR if they've replied at all
  // when we haven't sent anything yet (fresh contact, no prior outbound from us).
  const hasReplied = lastInbound && (!lastOutbound || lastInbound.timestamp > lastOutbound.timestamp);

  if (hasReplied) {
    updateJob(job.id, { status: 'cancelled', error: 'Contact replied' });
    console.log(`[Followups] Silence check for ${job.contactId}: replied — done`);
    return;
  }

  // Only ever send "Hey, you there?" once per conversation. We dedupe on
  // `silence-nudge` (the static nudge's own marker) — NOT `followup-hook-pos1`,
  // which the AI opener uses. If we deduped on the opener marker, this nudge
  // would never fire after enrollment because the opener is always sent first.
  const alreadySentNudge = exchanges.some(e => e.type === 'silence-nudge');
  if (alreadySentNudge) {
    updateJob(job.id, { status: 'cancelled', error: 'Silence nudge already sent once this conversation' });
    console.log(`[Followups] Silence check for ${job.contactId}: nudge already sent — skipping repeat`);
    return;
  }

  console.log(`[Followups] Silence check for ${job.contactId}: silent — sending "you there?" nudge`);
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

  if (spend.isAtLimit(job.contactId)) {
    updateJob(job.id, { status: 'cancelled', error: 'API spend limit reached' });
    cancelContactJobs(job.contactId);
    cancelEmailJobs(job.contactId);
    return;
  }

  await sendFollowUp(job, contact, job.position);
}

async function processJob(job) {
  if (await optouts.isOptedOut(job.contactId)) {
    console.log(`[Followups] Contact ${job.contactId} is opted out — cancelling job ${job.id}`);
    updateJob(job.id, { status: 'cancelled', error: 'Contact opted out' });
    return;
  }

  // Live "Disable AI" check — fetch fresh tags from GHL at fire time so we
  // honour any tag added since the last inbound (the contact-updated webhook
  // is an optional extra layer; this makes the tag effective even without it).
  try {
    const liveContact = await ghl.fetchContact(job.contactId);
    if (liveContact) {
      const liveTags = (liveContact.tags || []).map(t => t.toLowerCase());
      if (liveTags.includes('disable ai')) {
        updateJob(job.id, { status: 'cancelled', error: 'Disable AI tag' });
        cancelContactJobs(job.contactId);
        cancelEmailJobs(job.contactId);
        conversations.update(job.contactId, { tags: liveContact.tags });
        console.log(`[Followups] Contact ${job.contactId} has "Disable AI" tag (live GHL check) — all jobs cancelled`);
        return;
      }
      // Keep local tags in sync so shouldStopEmail and other checks see the latest
      conversations.update(job.contactId, { tags: liveContact.tags });
    }
  } catch (err) {
    console.warn(`[Followups] GHL tag check failed for ${job.contactId}: ${err.message} — proceeding without live check`);
  }

  if (job.type === 'silence-check') {
    await processSilenceCheck(job);
  } else if (job.type === 'email-hook' || job.type === 'email-nurture') {
    await processEmailJob(job);
  } else {
    await processHookOrNurture(job);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

// Pause state must SURVIVE server restarts (deploys, crashes, idle wake-ups).
// Previously this lived only in memory, so any restart silently wiped the
// admin's pause action — leading to inconsistent button state on refresh.
// We persist it to a tiny app_settings key/value table so the choice sticks.
let _paused = false;

async function _initPauseStateFromDb() {
  try {
    await _pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const { rows } = await _pool.query(
      `SELECT value FROM app_settings WHERE key = 'paused' LIMIT 1`
    );
    if (rows.length > 0) {
      _paused = rows[0].value === 'true';
      console.log(`[Followups] Pause state restored from DB: ${_paused ? 'PAUSED' : 'running'}`);
    } else {
      console.log('[Followups] No persisted pause state — defaulting to running');
    }
  } catch (err) {
    console.error('[Followups] Pause state init error:', err.message);
  }
}

function _persistPauseState(paused) {
  _pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('paused', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [paused ? 'true' : 'false']
  ).catch(err => console.error('[Followups] Pause state persist error:', err.message));
}

function _persistIssueLog(issues) {
  _pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('issue_log', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(issues || [])]
  ).catch(err => console.error('[Followups] Issue log persist error:', err.message));
}

_initPauseStateFromDb();

function pauseScheduler()  {
  _paused = true;
  _persistPauseState(true);
  console.log('[Followups] Scheduler PAUSED — no jobs will fire');
}
function resumeScheduler() {
  _paused = false;
  _persistPauseState(false);
  console.log('[Followups] Scheduler RESUMED');
}
function isPaused()        { return _paused; }

/**
 * Cancel every pending SMS job (hook + nurture) immediately.
 * Returns the number of jobs cancelled.
 */
function cancelAllPendingSmsJobs() {
  const jobs = load();
  const cancelledIds = [];
  const updated = jobs.map(j => {
    if (j.status === 'pending' && !j.type.startsWith('email-') && j.type !== 'silence-check') {
      cancelledIds.push(j.id);
      return { ...j, status: 'cancelled', error: 'Emergency cancel by admin' };
    }
    return j;
  });
  save(updated);
  _dbBulkUpdateStatus(cancelledIds, 'cancelled');
  console.log(`[Followups] Emergency cancel: ${cancelledIds.length} SMS job(s) cancelled`);
  return cancelledIds.length;
}

let draining = false;

async function drainJobs() {
  if (_paused) return;
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
  scheduleNext,
  cancelContactJobs,
  cancelEmailJobs,
  cancelAllPendingSmsJobs,
  getDueJobs,
  getContactJobs,
  getAllJobs,
  drainJobs,
  estimateTimezone,
  isInWindow,
  nextWindowMs,
  nextEmailWindowMs,
  scheduleEmailNext,
  scheduleJob,
  pauseScheduler,
  resumeScheduler,
  isPaused
};
