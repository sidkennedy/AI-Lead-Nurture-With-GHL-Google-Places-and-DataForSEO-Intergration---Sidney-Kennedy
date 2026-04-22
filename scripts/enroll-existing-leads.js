#!/usr/bin/env node
/**
 * enroll-existing-leads.js
 *
 * One-time script to enroll existing GHL contacts (tagged "amplify") into
 * the follow-up sequence based on their conversation history.
 *
 * Usage:
 *   node scripts/enroll-existing-leads.js              ← dry-run (safe, no writes)
 *   node scripts/enroll-existing-leads.js --execute    ← actually enrolls contacts
 *   node scripts/enroll-existing-leads.js --tag "amplify" --execute --delay 3000
 *
 * Flags:
 *   --tag <name>      GHL tag to filter by (default: "amplify")
 *   --execute         Write to conversations.json + followups.json and schedule jobs
 *   --delay <ms>      Pause between contacts in execute mode (default: 2000ms)
 */

'use strict';

const path = require('path');

// ─── Load env (Replit provides these automatically via process.env) ────────────
// If running locally, set GHL_API_KEY, GHL_LOCATION_ID, ANTHROPIC_API_KEY
// in your shell before running this script.

// ─── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');
const TAG = (() => {
  const i = args.indexOf('--tag');
  return i !== -1 && args[i + 1] ? args[i + 1] : 'amplify';
})();
const DELAY_MS = (() => {
  const i = args.indexOf('--delay');
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : 2000;
})();

// ─── Load project modules (path relative to project root) ─────────────────────
const ROOT = path.join(__dirname, '..');
const ghl = require(path.join(ROOT, 'ghl'));
const conversations = require(path.join(ROOT, 'conversations'));
const { nextWindowMs, estimateTimezone, getAllJobs } = require(path.join(ROOT, 'followups'));

const fs = require('fs');
const FOLLOWUPS_FILE = path.join(ROOT, 'data', 'followups.json');

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
  const dir = path.join(ROOT, 'data');
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
    id: makeJobId(),
    contactId,
    type,
    position,
    sendAt,
    status: 'pending',
    context: context || {},
    createdAt: Date.now(),
    sentAt: null,
    error: null
  });
  saveFollowupJobs(jobs);
}

// ─── Conversation Analysis ─────────────────────────────────────────────────────

/**
 * Determine message direction from raw GHL message object.
 */
function isInbound(m) {
  return m.direction === 'inbound' || m.direction === 2 ||
         m.messageType === 'inbound' || m.type === 2;
}

/**
 * Parse a GHL date string into a unix timestamp (ms).
 * Falls back to 0 if unparseable.
 */
function parseDate(val) {
  if (!val) return 0;
  const t = new Date(val).getTime();
  return isNaN(t) ? 0 : t;
}

/**
 * Strip GHL system/automation messages (same filter as server.js).
 */
function isRealMessage(m) {
  const text = (m.body || m.message || '').trim();
  if (!text) return false;
  if (/CRM ID:/i.test(text)) return false;
  if (/opportunity created/i.test(text)) return false;
  if (/reply STOP to unsubscribe/i.test(text)) return false;
  return true;
}

/**
 * Analyse a contact's GHL message history and return enrollment decision.
 *
 * Returns:
 *   {
 *     outboundCount, inboundCount,
 *     hasReplied,       — prospect replied to at least one of our messages
 *     detectedStep,     — best guess at conversation step (0 if unknown/different angle)
 *     enrollPosition,   — which followup position to schedule (2–5)
 *     enrollType,       — 'hook' or 'nurture'
 *     neverContacted,   — we never sent any message
 *     usedCurrentScript — conversation matches current 5-step sales flow
 *   }
 */
function analyseConversation(ghlMessages) {
  const real = (ghlMessages || []).filter(isRealMessage);
  const outbounds = real.filter(m => !isInbound(m));
  const inbounds  = real.filter(m =>  isInbound(m));

  const outboundCount = outbounds.length;
  const inboundCount  = inbounds.length;

  // GHL returns newest-first — [0] is the most recent
  const lastOutTime = outboundCount > 0 ? parseDate(outbounds[0].dateAdded || outbounds[0].createdAt) : 0;
  const lastInTime  = inboundCount  > 0 ? parseDate(inbounds[0].dateAdded  || inbounds[0].createdAt)  : 0;

  const hasReplied = inboundCount > 0;
  const lastReplyAfterUs = hasReplied && lastInTime > lastOutTime;

  // Detect which sales script was used
  const allText = real.map(m => (m.body || m.message || '').toLowerCase()).join(' ');
  const usedCurrentScript =
    allText.includes('percentage actually went through') ||
    allText.includes('insurance benefits reset') ||
    allText.includes('benefits have reset') ||
    allText.includes("haven't seen in 2+");

  // Detect conversation step from outbound message content
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

  // If old script angle, treat as early stage so hooks re-engage naturally
  if (!usedCurrentScript && outboundCount > 0) {
    detectedStep = 0;
  }

  // Determine hook position to enroll at
  let enrollPosition;
  let enrollType = 'hook';

  if (outboundCount === 0) {
    // Never contacted — start at the very beginning of follow-up sequence
    enrollPosition = 2;
  } else if (!hasReplied) {
    // We sent messages but they never replied
    if (outboundCount <= 2) enrollPosition = 2;
    else if (outboundCount <= 4) enrollPosition = 3;
    else enrollPosition = 4;
  } else if (!lastReplyAfterUs) {
    // They replied but we had the last word — they went quiet on us
    enrollPosition = 3;
  } else {
    // They replied and their last message is more recent (we haven't responded)
    // They're still warm but may need a nudge
    enrollPosition = 2;
  }

  return {
    outboundCount,
    inboundCount,
    hasReplied,
    detectedStep,
    enrollPosition,
    enrollType,
    neverContacted: outboundCount === 0,
    usedCurrentScript
  };
}

// ─── Format exchange for import ───────────────────────────────────────────────

function formatExchanges(ghlMessages, convId) {
  const real = (ghlMessages || []).filter(isRealMessage);
  // GHL is newest-first — reverse to chronological
  return [...real].reverse().map(m => ({
    direction: isInbound(m) ? 'inbound' : 'outbound',
    body: (m.body || m.message || '').trim(),
    step: null,
    conversationId: convId || null,
    timestamp: parseDate(m.dateAdded || m.createdAt) || Date.now()
  }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  Amplify Lead Enrollment Script`);
  console.log(`  Mode:  ${DRY_RUN ? '🔍 DRY RUN (no writes)' : '🚀 EXECUTE'}`);
  console.log(`  Tag:   "${TAG}"`);
  console.log(`  Delay: ${DELAY_MS}ms between contacts`);
  console.log('══════════════════════════════════════════════════════\n');

  // 1. Fetch all contacts with the tag
  console.log(`Fetching contacts tagged "${TAG}" from GHL...`);
  const ghlContacts = await ghl.fetchContactsByTag(TAG);

  if (ghlContacts.length === 0) {
    console.log('\nNo contacts found with that tag. Exiting.\n');
    return;
  }

  console.log(`Found ${ghlContacts.length} contact(s). Analysing...\n`);

  // 2. Process each contact
  const stats = { total: ghlContacts.length, enrolled: 0, skipped: 0, errors: 0 };
  const rows = [];

  for (const ghlContact of ghlContacts) {
    const contactId = ghlContact.id;
    const firstName = ghlContact.firstName || ghlContact.name || '—';
    const phone     = ghlContact.phone || '—';
    const city      = ghlContact.city || ghlContact.address?.city || '';
    const tags      = (ghlContact.tags || []).map(t => t.toLowerCase());

    let row = { contactId, firstName, phone, city, action: '', reason: '', position: null, step: null };

    try {
      // ── Safety: Disable AI tag
      if (tags.includes('disable ai')) {
        row.action = 'SKIP';
        row.reason = 'Has "Disable AI" tag';
        stats.skipped++;
        rows.push(row);
        continue;
      }

      // ── Safety: Already booked in local record
      const localContact = conversations.get(contactId);
      if (localContact?.booked) {
        row.action = 'SKIP';
        row.reason = 'Already booked';
        stats.skipped++;
        rows.push(row);
        continue;
      }

      // ── Safety: Already has a pending follow-up job
      if (hasPendingJob(contactId)) {
        row.action = 'SKIP';
        row.reason = 'Already has pending follow-up job';
        stats.skipped++;
        rows.push(row);
        continue;
      }

      // ── Fetch conversation history
      const convId = await ghl.getOrCreateConversation(contactId);
      const ghlMessages = convId ? await ghl.fetchMessages(convId) : [];

      // ── Analyse state
      const analysis = analyseConversation(ghlMessages);
      const tz = estimateTimezone(city);

      // ── Determine send time (next available window)
      const DAY = 24 * 60 * 60 * 1000;
      let sendAt;
      if (analysis.enrollPosition === 2) {
        sendAt = nextWindowMs(Date.now(), tz);
      } else if (analysis.enrollPosition === 3) {
        sendAt = nextWindowMs(Date.now() + 1 * DAY, tz);
      } else {
        sendAt = nextWindowMs(Date.now() + 2 * DAY, tz);
      }

      row.position = analysis.enrollPosition;
      row.step     = analysis.detectedStep;
      row.action   = 'ENROLL';
      row.reason   = analysis.neverContacted
        ? 'Never contacted — starting fresh'
        : analysis.hasReplied
          ? `Engaged (${analysis.inboundCount} replies, step ~${analysis.detectedStep})`
          : `No reply to ${analysis.outboundCount} message(s)`;

      if (!DRY_RUN) {
        // ── Create/update local contact record
        conversations.ensureContact(contactId, { firstName, city, phone });

        // ── Import GHL exchanges if local record has none
        const fresh = conversations.get(contactId);
        if (!fresh?.exchanges?.length && ghlMessages.length > 0) {
          const exchanges = formatExchanges(ghlMessages, convId);
          for (const ex of exchanges) {
            conversations.addExchange(contactId, ex);
          }
        }

        // ── Update step
        if (analysis.detectedStep > 0) {
          conversations.update(contactId, { currentStep: analysis.detectedStep });
        }

        // ── Schedule follow-up job
        scheduleJob({
          contactId,
          type: analysis.enrollType,
          position: analysis.enrollPosition,
          sendAt,
          context: {
            lastOutboundBody: '',
            lastOutboundStep: analysis.detectedStep,
            timezone: tz,
            enrolledFromScript: true
          }
        });

        await sleep(DELAY_MS);
      }

      stats.enrolled++;

    } catch (err) {
      row.action = 'ERROR';
      row.reason = err.message;
      stats.errors++;
    }

    rows.push(row);
  }

  // 3. Print table
  console.log('\n' + '─'.repeat(100));
  console.log(
    'Name'.padEnd(20) +
    'Phone'.padEnd(18) +
    'City'.padEnd(18) +
    'Action'.padEnd(10) +
    'Pos'.padEnd(5) +
    'Step'.padEnd(6) +
    'Reason'
  );
  console.log('─'.repeat(100));

  for (const r of rows) {
    const symbol = r.action === 'ENROLL' ? '✓' : r.action === 'SKIP' ? '–' : '✗';
    console.log(
      `${symbol} ${r.firstName}`.padEnd(20) +
      r.phone.padEnd(18) +
      (r.city || '—').padEnd(18) +
      r.action.padEnd(10) +
      (r.position != null ? String(r.position) : '—').padEnd(5) +
      (r.step != null ? String(r.step) : '—').padEnd(6) +
      r.reason
    );
  }

  console.log('─'.repeat(100));
  console.log(`\nSummary:`);
  console.log(`  Total found:  ${stats.total}`);
  console.log(`  Enrolled:     ${stats.enrolled}${DRY_RUN ? ' (dry run — not written)' : ''}`);
  console.log(`  Skipped:      ${stats.skipped}`);
  console.log(`  Errors:       ${stats.errors}`);

  if (DRY_RUN && stats.enrolled > 0) {
    console.log('\n  ⚡ Run with --execute to actually enroll these contacts.');
  }
  console.log();
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
