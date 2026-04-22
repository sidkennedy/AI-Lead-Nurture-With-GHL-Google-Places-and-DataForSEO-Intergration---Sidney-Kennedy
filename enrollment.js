'use strict';

/**
 * enrollment.js
 *
 * Shared enrollment logic used by both the CLI script and the admin panel.
 * Exports: runEnrollment({ tag, dryRun, delayMs })
 */

const ghl           = require('./ghl');
const conversations = require('./conversations');
const followupsMod  = require('./followups');
const { nextWindowMs, nextEmailWindowMs, estimateTimezone, scheduleJob, getAllJobs } = followupsMod;

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

function hasPendingJob(contactId) {
  return getAllJobs('pending').some(j => j.contactId === contactId);
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

async function claudeAnalyseConversation(ghlMessages, contactId) {
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

Our 6-step SMS sales flow:
- Step 1: Introduction / initial hook (who we are, curious about their practice)
- Step 2: Benefits angle (insurance resets, percentage not captured)
- Step 3: Dormant patients angle (patients not seen in 2+ years)
- Step 4: Practice research reveal + booking ask (data reveal, gap stack, pitch 10-min Zoom)
- Step 5: Founder intro / scheduling (Sid pitch, time slot ask)
- Step 6: Booked (confirmed Zoom)

Analyze the conversation and return a JSON object with exactly these fields:
{
  "currentStep": <number 0-6, the step they were on when conversation stalled>,
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
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const res = await getAI().messages.create({
      model,
      max_tokens: 300,
      messages:   [{ role: 'user', content: prompt }]
    });

    if (contactId) {
      const spend = require('./spend');
      spend.track(contactId, model, res.usage);
    }

    let raw = (res.content[0]?.text || '').trim();

    // Strip markdown code fences if Claude wrapped the JSON (e.g. ```json ... ```)
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    // If Claude still prepended prose, extract the first {...} block
    const braceStart = raw.indexOf('{');
    const braceEnd   = raw.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      raw = raw.slice(braceStart, braceEnd + 1);
    }

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
async function runEnrollment({ tag = '', dryRun = true, delayMs = 2000, signal } = {}) {
  const missingEnv = [];
  if (!process.env.GHL_API_KEY)     missingEnv.push('GHL_API_KEY');
  if (!process.env.GHL_LOCATION_ID) missingEnv.push('GHL_LOCATION_ID');
  if (missingEnv.length) {
    throw new Error(`Missing required environment variable(s): ${missingEnv.join(', ')}`);
  }

  const { contacts: ghlContacts, totalScanned } = await ghl.fetchContactsByTag(tag, signal);

  const stats = { total: ghlContacts.length, scanned: totalScanned, enrolled: 0, skipped: 0, errors: 0 };
  const rows  = [];

  const DAY = 24 * 60 * 60 * 1000;
  const POSITION_DELAY = { 2: 0, 3: 2, 4: 4, 5: 7 };

  // Process one contact — returns a row object.
  async function processContact(ghlContact) {
    const contactId = ghlContact.id;
    const firstName = ghlContact.firstName || ghlContact.name || '—';
    const phone     = ghlContact.phone     || '—';
    const city      = ghlContact.city      || ghlContact.address?.city || '';
    const email     = ghlContact.email     || '';
    const tags      = (ghlContact.tags || []).map(t =>
      (typeof t === 'string' ? t : (t.name || '')).toLowerCase()
    );

    const row = { contactId, firstName, phone, city, email, tags,
                  action: '', reason: '', position: null, step: null };

    if (tags.some(t => t === 'disable ai')) {
      return { ...row, action: 'SKIP', reason: 'Has "Disable AI" tag' };
    }
    const localContact = conversations.get(contactId);
    if (localContact?.booked) {
      return { ...row, action: 'SKIP', reason: 'Already booked' };
    }
    if (hasPendingJob(contactId)) {
      return { ...row, action: 'SKIP', reason: 'Already has pending follow-up job' };
    }

    const convId      = await ghl.getOrCreateConversation(contactId);
    const ghlMessages = convId ? await ghl.fetchMessages(convId) : [];
    const realMessages = (ghlMessages || []).filter(isRealMessage);
    const hasAnyInbound = realMessages.some(m => isInbound(m));

    let analysis;
    // Dry-run: use fast heuristics only — Claude analysis only runs on real enrollment.
    if (!dryRun && hasAnyInbound) {
      const claudeResult = await claudeAnalyseConversation(ghlMessages, contactId);
      if (claudeResult) {
        analysis = {
          ...heuristicAnalysis(ghlMessages),
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
    row._enroll  = dryRun ? null : { analysis, tz, sendAt, convId, ghlMessages };
    return row;
  }

  // Run contacts in parallel batches of 5 — fast for dry runs, safe for real runs.
  const BATCH = dryRun ? 5 : 1;
  for (let i = 0; i < ghlContacts.length; i += BATCH) {
    const batch = ghlContacts.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(c => processContact(c)));
    for (const r of results) {
      const row = r.status === 'fulfilled'
        ? r.value
        : { action: 'ERROR', reason: r.reason?.message || 'Unknown error',
            firstName: '—', phone: '—', city: '', position: null, step: null };

      if (row.action === 'SKIP') stats.skipped++;
      else if (row.action === 'ERROR') stats.errors++;
      else {
        stats.enrolled++;
        // Write-through only on real enrollment
        if (!dryRun && row._enroll) {
          const { analysis, tz, sendAt, convId, ghlMessages } = row._enroll;
          const { contactId, firstName, city, phone, email, tags } = row;
          conversations.ensureContact(contactId, { firstName, city, phone, email, tags });
          const fresh = conversations.get(contactId);
          if (!fresh?.exchanges?.length && ghlMessages.length > 0) {
            for (const ex of formatExchanges(ghlMessages, convId)) {
              conversations.addExchange(contactId, ex);
            }
          }
          conversations.update(contactId, { currentStep: analysis.currentStep, email, tags });
          scheduleJob({ contactId, type: 'hook', position: analysis.enrollPosition, sendAt,
            context: { lastOutboundBody: '', lastOutboundStep: analysis.currentStep,
                       timezone: tz, enrolledFromScript: true } });
          if (email && !tags.includes('disable ai')) {
            const emailSendAt = nextEmailWindowMs(sendAt, tz);
            const allJobs = getAllJobs('pending');
            if (!allJobs.some(j => j.contactId === contactId && j.type.startsWith('email-'))) {
              scheduleJob({ contactId, type: 'email-hook', position: 2, sendAt: emailSendAt,
                context: { timezone: tz, enrolledFromScript: true } });
            }
          }
          await sleep(delayMs);
        }
      }
      const { _enroll: _, ...cleanRow } = row;
      rows.push(cleanRow);
    }
  }

  return { stats, rows };
}

module.exports = { runEnrollment };
