'use strict';

/**
 * enrollment.js
 *
 * Shared enrollment logic used by both the CLI script and the admin panel.
 * Exports: runEnrollment({ tag, dryRun, delayMs })
 */

const path = require('path');
const fs   = require('fs');

const ghl           = require('./ghl');
const conversations = require('./conversations');
const { nextWindowMs, nextEmailWindowMs, estimateTimezone } = require('./followups');

const FOLLOWUPS_FILE = path.join(__dirname, 'data', 'followups.json');

// ─── Anthropic (lazy) ─────────────────────────────────────────────────────────

let _ai = null;
function getAI() {
  if (!_ai) {
    const Anthropic = require('@anthropic-ai/sdk');
    _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _ai;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadFollowupJobs() {
  try {
    if (!fs.existsSync(FOLLOWUPS_FILE)) return [];
    return JSON.parse(fs.readFileSync(FOLLOWUPS_FILE, 'utf8'));
  } catch { return []; }
}

function saveFollowupJobs(jobs) {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FOLLOWUPS_FILE, JSON.stringify(jobs, null, 2));
}

function makeJobId() {
  return `fu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function hasPendingJob(contactId) {
  const jobs = loadFollowupJobs();
  return jobs.some(j => j.contactId === contactId && j.status === 'pending');
}

function scheduleJob({ contactId, type, position, sendAt, context }) {
  const jobs = loadFollowupJobs();
  jobs.push({
    id:        makeJobId(),
    contactId,
    type,
    position,
    sendAt,
    status:    'pending',
    context:   context || {},
    createdAt: Date.now(),
    sentAt:    null,
    error:     null
  });
  saveFollowupJobs(jobs);
}

// ─── Message parsing ───────────────────────────────────────────────────────────

function isInbound(m) {
  return m.direction === 'inbound' || m.direction === 2 ||
         m.messageType === 'inbound' || m.type === 2;
}

function parseDate(val) {
  if (!val) return 0;
  const t = new Date(val).getTime();
  return isNaN(t) ? 0 : t;
}

function isRealMessage(m) {
  const text = (m.body || m.message || '').trim();
  if (!text) return false;
  if (/CRM ID:/i.test(text)) return false;
  if (/opportunity created/i.test(text)) return false;
  if (/reply STOP to unsubscribe/i.test(text)) return false;
  return true;
}

// ─── Claude-based analysis ────────────────────────────────────────────────────

async function claudeAnalyseConversation(ghlMessages) {
  const real = ghlMessages.filter(isRealMessage);
  const sorted = [...real].sort((a, b) => {
    return parseDate(a.dateAdded || a.createdAt) - parseDate(b.dateAdded || b.createdAt);
  });

  const transcript = sorted.map(m => {
    const who  = isInbound(m) ? 'PROSPECT' : 'US';
    const text = (m.body || m.message || '').trim();
    return `${who}: ${text}`;
  }).join('\n');

  const prompt = `You are analyzing an SMS conversation between a sales rep and an audiology practice owner to determine the best way to re-engage the prospect.

CONVERSATION TRANSCRIPT:
${transcript}

Our 8-step SMS sales flow:
- Step 1: Introduction / initial hook (who we are, curious about their practice)
- Step 2: Benefits angle (insurance resets, percentage not captured)
- Step 3: Dormant patients angle (patients not seen in 2+ years)
- Step 4: Practice research reveal (mention specific gap we found)
- Step 5: Objection handling / follow-up
- Step 6: Social proof / case study
- Step 7: Booking pitch (stack 2-4 revenue gaps, pitch 10-min Zoom)
- Step 8: Final close / last attempt

Analyze the conversation and return a JSON object with exactly these fields:
{
  "currentStep": <number 0-8, the step they were on when conversation stalled>,
  "enrollPosition": <number 2-5, which follow-up hook position to start them at>,
  "reasoning": "<one sentence explanation>"
}

Rules:
- If the conversation used a clearly different sales approach than the 8-step flow above, set currentStep to 0.
- enrollPosition 2 = send the next follow-up soon (1–2 days), for warm or semi-engaged leads.
- enrollPosition 3 = send in 3–4 days, for moderately stale leads.
- enrollPosition 4 = send in 5–7 days, for colder leads who engaged briefly but faded.
- enrollPosition 5 = longer re-engagement arc for very cold leads.
- Never set confirmationPending or awaitingRetryName fields — ignore those.
- Respond with ONLY the raw JSON object, no markdown, no explanation outside the JSON.`;

  try {
    const res = await getAI().messages.create({
      model:      process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 300,
      messages:   [{ role: 'user', content: prompt }]
    });

    const raw  = (res.content[0]?.text || '').trim();
    const json = JSON.parse(raw);
    return {
      currentStep:    Number(json.currentStep)    || 0,
      enrollPosition: Number(json.enrollPosition) || 3,
      reasoning:      String(json.reasoning || '')
    };
  } catch (err) {
    console.warn(`  [Claude] Analysis failed: ${err.message} — using fallback heuristics`);
    return null;
  }
}

// ─── Heuristic fallback analysis ──────────────────────────────────────────────

function heuristicAnalysis(ghlMessages) {
  const real   = (ghlMessages || []).filter(isRealMessage);
  const sorted = [...real].sort((a, b) =>
    parseDate(b.dateAdded || b.createdAt) - parseDate(a.dateAdded || a.createdAt)
  );
  const outbounds = sorted.filter(m => !isInbound(m));
  const inbounds  = sorted.filter(m =>  isInbound(m));
  const outboundCount = outbounds.length;
  const inboundCount  = inbounds.length;

  const lastOutTime = outboundCount > 0 ? parseDate(outbounds[0].dateAdded || outbounds[0].createdAt) : 0;
  const lastInTime  = inboundCount  > 0 ? parseDate(inbounds[0].dateAdded  || inbounds[0].createdAt)  : 0;

  const hasReplied       = inboundCount > 0;
  const lastReplyAfterUs = hasReplied && lastInTime > lastOutTime;

  const allText = real.map(m => (m.body || m.message || '').toLowerCase()).join(' ');
  const usedCurrentScript =
    allText.includes('percentage actually went through') ||
    allText.includes('insurance benefits reset') ||
    allText.includes('benefits have reset') ||
    allText.includes("haven't seen in 2+");

  let detectedStep = 0;
  if (allText.includes("haven't seen in 2+") || allText.includes('bring them back in')) {
    detectedStep = 3;
  } else if (allText.includes('i pulled up') && allText.includes('while we were talking')) {
    detectedStep = 4;
  } else if (allText.includes('lot not being captured') || (allText.includes('expiring') && allText.includes('dormant'))) {
    detectedStep = 7;
  } else if (allText.includes('sid, our founder')) {
    detectedStep = 8;
  } else if (allText.includes('insurance benefits') || allText.includes('benefits reset') || allText.includes('percentage')) {
    detectedStep = 2;
  } else if (outboundCount > 0) {
    detectedStep = 1;
  }

  if (!usedCurrentScript && outboundCount > 0) detectedStep = 0;

  let enrollPosition;
  if (outboundCount === 0) {
    enrollPosition = 2;
  } else if (!hasReplied) {
    if (outboundCount <= 2) enrollPosition = 2;
    else if (outboundCount <= 4) enrollPosition = 3;
    else enrollPosition = 4;
  } else if (!lastReplyAfterUs) {
    enrollPosition = 3;
  } else {
    enrollPosition = 2;
  }

  return {
    currentStep: detectedStep,
    enrollPosition,
    hasReplied,
    inboundCount,
    outboundCount,
    usedCurrentScript,
    neverContacted: outboundCount === 0,
    reasoning: hasReplied
      ? `Heuristic: ${inboundCount} reply/replies detected, step ~${detectedStep}`
      : outboundCount === 0
        ? 'Never contacted'
        : `No reply to ${outboundCount} message(s)`
  };
}

// ─── Format exchanges for local import ───────────────────────────────────────

function formatExchanges(ghlMessages, convId) {
  const real = (ghlMessages || []).filter(isRealMessage);
  return [...real].sort((a, b) =>
    parseDate(a.dateAdded || a.createdAt) - parseDate(b.dateAdded || b.createdAt)
  ).map(m => ({
    direction:      isInbound(m) ? 'inbound' : 'outbound',
    body:           (m.body || m.message || '').trim(),
    step:           null,
    conversationId: convId || null,
    timestamp:      parseDate(m.dateAdded || m.createdAt) || Date.now()
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run enrollment analysis (and optionally write) for all contacts with `tag`.
 *
 * @param {object} opts
 * @param {string}  opts.tag      - GHL tag to filter by (default: 'amplify')
 * @param {boolean} opts.dryRun   - If true, no writes are made (default: true)
 * @param {number}  opts.delayMs  - Pause between contacts in execute mode (default: 2000)
 * @returns {Promise<{ stats, rows }>}
 */
async function runEnrollment({ tag = 'amplify', dryRun = true, delayMs = 2000 } = {}) {
  const missingEnv = [];
  if (!process.env.GHL_API_KEY)     missingEnv.push('GHL_API_KEY');
  if (!process.env.GHL_LOCATION_ID) missingEnv.push('GHL_LOCATION_ID');
  if (missingEnv.length) {
    throw new Error(`Missing required environment variable(s): ${missingEnv.join(', ')}`);
  }

  const ghlContacts = await ghl.fetchContactsByTag(tag);

  const stats = { total: ghlContacts.length, enrolled: 0, skipped: 0, errors: 0 };
  const rows  = [];

  const DAY = 24 * 60 * 60 * 1000;
  const POSITION_DELAY = { 2: 0, 3: 2, 4: 4, 5: 7 };

  for (const ghlContact of ghlContacts) {
    const contactId = ghlContact.id;
    const firstName = ghlContact.firstName || ghlContact.name || '—';
    const phone     = ghlContact.phone     || '—';
    const city      = ghlContact.city      || ghlContact.address?.city || '';
    const email     = ghlContact.email     || '';
    const tags      = (ghlContact.tags || []).map(t =>
      (typeof t === 'string' ? t : (t.name || '')).toLowerCase()
    );

    const row = {
      contactId, firstName, phone, city,
      action: '', reason: '', position: null, step: null
    };

    try {
      if (tags.some(t => t === 'disable ai')) {
        row.action = 'SKIP';
        row.reason = 'Has "Disable AI" tag';
        stats.skipped++;
        rows.push(row);
        continue;
      }

      const localContact = conversations.get(contactId);
      if (localContact?.booked) {
        row.action = 'SKIP';
        row.reason = 'Already booked';
        stats.skipped++;
        rows.push(row);
        continue;
      }

      if (hasPendingJob(contactId)) {
        row.action = 'SKIP';
        row.reason = 'Already has pending follow-up job';
        stats.skipped++;
        rows.push(row);
        continue;
      }

      const convId      = await ghl.getOrCreateConversation(contactId);
      const ghlMessages = convId ? await ghl.fetchMessages(convId) : [];
      const realMessages = (ghlMessages || []).filter(isRealMessage);
      const hasAnyInbound = realMessages.some(m => isInbound(m));

      let analysis;
      if (hasAnyInbound) {
        const claudeResult = await claudeAnalyseConversation(ghlMessages);
        if (claudeResult) {
          const heuristic = heuristicAnalysis(ghlMessages);
          analysis = {
            ...heuristic,
            currentStep:    claudeResult.currentStep,
            enrollPosition: claudeResult.enrollPosition,
            reasoning:      `Claude: ${claudeResult.reasoning}`
          };
        } else {
          analysis = heuristicAnalysis(ghlMessages);
        }
      } else {
        analysis = heuristicAnalysis(ghlMessages);
      }

      const tz      = estimateTimezone(city);
      const daysOut = POSITION_DELAY[analysis.enrollPosition] ?? (analysis.enrollPosition - 2);
      const sendAt  = nextWindowMs(Date.now() + daysOut * DAY, tz);

      row.position = analysis.enrollPosition;
      row.step     = analysis.currentStep;
      row.action   = 'ENROLL';
      row.reason   = analysis.reasoning;

      if (!dryRun) {
        conversations.ensureContact(contactId, { firstName, city, phone, email, tags });

        const fresh = conversations.get(contactId);
        if (!fresh?.exchanges?.length && ghlMessages.length > 0) {
          const exchanges = formatExchanges(ghlMessages, convId);
          for (const ex of exchanges) {
            conversations.addExchange(contactId, ex);
          }
        }

        conversations.update(contactId, { currentStep: analysis.currentStep, email, tags });

        scheduleJob({
          contactId,
          type:     'hook',
          position: analysis.enrollPosition,
          sendAt,
          context: {
            lastOutboundBody:   '',
            lastOutboundStep:   analysis.currentStep,
            timezone:           tz,
            enrolledFromScript: true
          }
        });

        // Schedule email-hook position 2 in parallel if the contact has an email
        if (email && !tags.includes('disable ai')) {
          const emailSendAt = nextEmailWindowMs(sendAt, tz);
          const allJobs = loadFollowupJobs();
          const hasPendingEmail = allJobs.some(
            j => j.contactId === contactId && j.type.startsWith('email-') && j.status === 'pending'
          );
          if (!hasPendingEmail) {
            scheduleJob({
              contactId,
              type:     'email-hook',
              position: 2,
              sendAt:   emailSendAt,
              context:  { timezone: tz, enrolledFromScript: true }
            });
          }
        }

        await sleep(delayMs);
      }

      stats.enrolled++;

    } catch (err) {
      row.action = 'ERROR';
      row.reason = err.message;
      stats.errors++;
    }

    rows.push(row);
  }

  return { stats, rows };
}

module.exports = { runEnrollment };
