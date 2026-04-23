const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const spend = require('./spend');
const optouts = require('./optouts');
const config = require('./config');
const prompts = require('./prompts');
const conversations = require('./conversations');
const ghl = require('./ghl');
const brain = require('./brain');
const { fetchCompetitorVelocity, findReferralSources, refreshRecentReviews, fetchReviewCount } = require('./research');

const _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// In-memory job cache — load() reads sync from here; DB is the persistence layer
let _jobCache = [];

async function _initJobsFromDb() {
  try {
    const { rows } = await _pool.query('SELECT * FROM followup_jobs ORDER BY send_at ASC');
    if (rows.length === 0) {
      // DB is empty — attempt a one-time migration from the JSON backup file.
      // This recovers jobs for existing contacts after the first deployment that
      // introduced DB persistence (previously jobs only lived in the flat file).
      _loadJobsFromJson();
      return;
    }
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
    console.error('[Followups] DB init error:', err.message, '— falling back to JSON');
    _loadJobsFromJson();
  }
}

function _loadJobsFromJson() {
  try {
    const FILE = path.join(__dirname, 'data', 'followups.json');
    if (!fs.existsSync(FILE)) return;
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(data) && data.length > 0) {
      _jobCache = data;
      // Migrate to DB silently
      _jobCache.forEach(j => _dbUpsertJob(j));
      console.log('[Followups] Imported', _jobCache.length, 'jobs from JSON backup');
    }
  } catch {}
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
 * Find the next email send window and return a randomly scattered time within it.
 * Windows: 8:30–9:00am (30-min window) and 12:00–1:00pm (60-min window) local time.
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
      // Morning anchor (8:30am) — scatter across 30-min window (8:30–8:59)
      return t + Math.floor(Math.random() * 30) * 60 * 1000;
    }
    if (h === 12 && m === 0) {
      // Noon anchor (12:00pm) — scatter across 60-min window (12:00–12:59)
      return t + Math.floor(Math.random() * 60) * 60 * 1000;
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
  return load().filter(j => j.status === 'pending' && j.sendAt <= now);
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

  brain.recordOutbound(job.contactId, hookText, contact.currentStep ?? null,
    { message_type: 'followup-sms', position: 1 });

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

  brain.recordOutbound(job.contactId, hookText, freshContact.currentStep ?? null,
    { message_type: 'followup-sms', position });

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

  const hasReplied = lastInbound && lastOutbound && lastInbound.timestamp > lastOutbound.timestamp;

  if (hasReplied) {
    updateJob(job.id, { status: 'cancelled', error: 'Contact replied' });
    console.log(`[Followups] Silence check for ${job.contactId}: replied — done`);
    return;
  }

  // Only ever send "Hey, you there?" once per conversation — even if there
  // are multiple silence-check jobs queued across multiple outbound turns.
  const alreadySentHook1 = exchanges.some(e => e.type === 'followup-hook-pos1');
  if (alreadySentHook1) {
    updateJob(job.id, { status: 'cancelled', error: 'Hook 1 already sent once this conversation' });
    console.log(`[Followups] Silence check for ${job.contactId}: Hook 1 already sent — skipping repeat`);
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
