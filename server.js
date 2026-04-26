try {
  const _fs = require('fs'), _p = require('path');
  const _env = _fs.readFileSync(_p.join(__dirname, '.env'), 'utf8');
  for (const line of _env.split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m && process.env[m[1].trim()] === undefined) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

// ─── Production DB Override (Dev Mode Only) ───────────────────────────────────
// PROD_DATABASE_URL is the Neon database — the real data store for BOTH the
// local dev server and the deployed production server. The Replit-managed
// DATABASE_URL points to an empty Replit-provisioned PostgreSQL that is not
// used by this app. Whenever PROD_DATABASE_URL is set (which it always is,
// in both environments), we route ALL database connections to it.
// Must run BEFORE any module that creates a Pool from process.env.DATABASE_URL.
if (process.env.PROD_DATABASE_URL && process.env.PROD_DATABASE_URL !== process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
  if (process.env.DEV_MODE === 'true') {
    console.log('[DB] DEV_MODE — DATABASE_URL routed to PROD_DATABASE_URL (local server uses the live production database)');
  } else {
    console.log('[DB] DATABASE_URL routed to PROD_DATABASE_URL (production server uses Neon database)');
  }
}

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const sessions = require('./sessions');
const conversations = require('./conversations');
const ghl = require('./ghl');
const { runResearch } = require('./research');
const { startScan } = require('./scanner');
const brain = require('./brain');
const followups = require('./followups');
const prompts = require('./prompts');
const { runEnrollment } = require('./enrollment');
const spend = require('./spend');
const optouts = require('./optouts');
const outboundLock = require('./outbound-lock');

// ─── Dev Mode ─────────────────────────────────────────────────────────────────
// Set DEV_MODE=true in your local .env to disable the scheduler and GHL sends.
// Production deployments should never set this variable.
const { DEV_MODE } = require('./devmode');
if (DEV_MODE) {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  DEV MODE — scheduler + GHL sends are disabled   ║');
  console.log('║  Safe to test UI changes against production data  ║');
  console.log('╚══════════════════════════════════════════════════╝');
} else {
  console.log('[Mode] Production — all systems active');
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Shared DB pool — used for prompt persistence (survives redeployments)
const _promptsPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Simple In-Memory Job Queue ───────────────────────────────────────────────
// Ensures one webhook job processes at a time; prevents race conditions on
// concurrent webhooks for the same contact.

const jobQueue = [];
let processing = false;

// ─── AI-Generation Auto-Trigger Tracker ───────────────────────────────────────
// When [PRACTICE_DETECTED] fires, the "Pulling up your listing" bridge goes out
// and research kicks off. After the prospect confirms the address (or any path
// where no confirmation prompt was sent), we poll for research completion — or
// hit a 90 s timeout — and then trigger Claude to generate the next scripted
// step from the variant prompt. After that AI reply, a separate watcher fires
// the scan-visibility follow-up once the map scan completes (only if the
// prospect hasn't already replied).
//
// Conversation order (post-refactor):
//   - Discovery   AI-generated steps (variant-specific opening + qualification)
//   - Bridge      "Pulling up your Google Maps listing now." + [PRACTICE_DETECTED:…]
//   - System      "Found X at Y — is that the right one?" (Google Places lookup)
//   - Prospect    "yes" / "yep" (confirms the listing)
//   - AI          next scripted step from the variant prompt
//                  • Variant B → hearing-aid percentage question (Step 5)
//                  • Variant A/C → data reveal / booking step
//   - Watcher     visibility follow-up if the scan finishes before the prospect
//                 replies to the AI step (early-aborts past the data reveal)
const pendingAiTrigger = new Map(); // contactId → setInterval handle (research poller)
const pendingScanWatch = new Map(); // contactId → setInterval handle (scan watcher)

const AI_TRIGGER_POLL_MS    = 2 * 1000;
const AI_TRIGGER_TIMEOUT_MS = 90 * 1000;
const SCAN_POLL_MS          = 2 * 1000;
const SCAN_TIMEOUT_MS       = 90 * 1000;

function scheduleAiResponseAfterResearch(contactId, resolvedConvId, opts = {}) {
  const skipReplyGuard = opts.skipReplyGuard === true;
  clearPendingAiTrigger(contactId);
  const started = Date.now();

  const handle = setInterval(async () => {
    const contact = conversations.get(contactId);
    if (!contact || contact.booked) {
      clearPendingAiTrigger(contactId);
      return;
    }

    const session = sessions.get(contactId);
    const researchDone = session?.researchStatus === 'complete' || session?.researchStatus === 'failed';
    const timedOut     = Date.now() - started > AI_TRIGGER_TIMEOUT_MS;

    if (!researchDone && !timedOut) return; // still waiting

    clearPendingAiTrigger(contactId);

    // Cancel if prospect replied after our last outbound — skip when their
    // confirmation YES was the last inbound (skipReplyGuard).
    if (!skipReplyGuard) {
      const exch    = contact.exchanges || [];
      const lastOut = [...exch].reverse().find(e => e.direction === 'outbound');
      const lastIn  = [...exch].reverse().find(e => e.direction === 'inbound');
      if (lastIn && lastOut && lastIn.timestamp > lastOut.timestamp) {
        console.log(`[AiTrigger] ${contactId} already replied — skipping auto-trigger`);
        return;
      }
    }

    if (timedOut && !researchDone) {
      console.log(`[AiTrigger] Research timeout for ${contactId} — generating reply without data`);
    }

    try {
      await generateAndSendAiReply(contactId, resolvedConvId);
      console.log(`[AiTrigger] AI reply triggered for ${contactId} (research ${researchDone ? 'complete' : 'timed out'})`);

      // Watch for scan completion → send visibility follow-up. The watcher
      // early-aborts once the contact has moved past the data-reveal step.
      watchForScanAndSendVisibility(contactId, resolvedConvId);
    } catch (err) {
      console.error(`[AiTrigger] Failed to generate AI reply for ${contactId}:`, err.message);
    }
  }, AI_TRIGGER_POLL_MS);

  pendingAiTrigger.set(contactId, handle);
  console.log(`[AiTrigger] Watching for research completion for ${contactId}`);
}

function clearPendingAiTrigger(contactId) {
  if (pendingAiTrigger.has(contactId)) {
    clearInterval(pendingAiTrigger.get(contactId));
    pendingAiTrigger.delete(contactId);
    console.log(`[AiTrigger] Cancelled pending AI trigger for ${contactId}`);
  }
}

// ─── Scan-Visibility Follow-Up ─────────────────────────────────────────────────
// After Step 3 is sent, poll until the map scan finishes. When it does, send a
// separate (non-numbered) message surfacing visibility gaps and real competitor
// names — but only if the prospect hasn't already replied to Step 3.

function watchForScanAndSendVisibility(contactId, resolvedConvId) {
  if (pendingScanWatch.has(contactId)) {
    clearInterval(pendingScanWatch.get(contactId));
    pendingScanWatch.delete(contactId);
  }

  const started = Date.now();

  const handle = setInterval(async () => {
    const contact = conversations.get(contactId);

    // Stop if booked or the conversation has advanced past the variant's
    // post-confirmation question step (variant B's percentage Q lives at step 5;
    // variant A/C jump straight to the data reveal at step 7). Past step 5 the
    // visibility info has already been folded into the data reveal — no need
    // to send a separate visibility nudge.
    if (!contact || contact.booked || (contact.currentStep !== undefined && contact.currentStep > 5)) {
      clearInterval(handle);
      pendingScanWatch.delete(contactId);
      return;
    }

    if (Date.now() - started > SCAN_TIMEOUT_MS) {
      clearInterval(handle);
      pendingScanWatch.delete(contactId);
      console.log(`[ScanWatch] Scan timeout for ${contactId} — skipping visibility message`);
      return;
    }

    const session = sessions.get(contactId);
    if (session?.scanStatus !== 'complete') return; // still waiting

    clearInterval(handle);
    pendingScanWatch.delete(contactId);

    const sr = session.scanResults;
    if (!sr) return;

    // Also abort if the prospect has replied since the watcher started — at that
    // point Claude is about to respond with the variant's next step, which will
    // surface the scan data inline (variant B step 6 / variant A step 7), so
    // the standalone visibility nudge would be redundant.
    const exch   = contact.exchanges || [];
    const lastIn = [...exch].reverse().find(e => e.direction === 'inbound');
    if (lastIn && lastIn.timestamp >= started) {
      console.log(`[ScanWatch] ${contactId} replied while scan was running — skipping visibility nudge`);
      return;
    }

    await sendScanVisibilityMessage(contactId, resolvedConvId, sr);
  }, SCAN_POLL_MS);

  pendingScanWatch.set(contactId, handle);
  console.log(`[ScanWatch] Watching for scan completion for ${contactId}`);
}

function clearScanWatch(contactId) {
  if (pendingScanWatch.has(contactId)) {
    clearInterval(pendingScanWatch.get(contactId));
    pendingScanWatch.delete(contactId);
    console.log(`[ScanWatch] Cancelled scan watcher for ${contactId}`);
  }
}

async function sendScanVisibilityMessage(contactId, resolvedConvId, sr) {
  const contact = conversations.get(contactId);
  if (!contact || contact.booked || contact.currentStep > 5) return;

  const competitor   = sr?.topCompetitor?.name;
  const visibleTop3  = sr?.visibleTop3  ?? 0;
  const totalPoints  = sr?.totalPoints  ?? 25;

  let msg;
  if (competitor && visibleTop3 < Math.ceil(totalPoints * 0.6)) {
    msg = `One more thing — just ran your visibility scan. You're showing up right around your building, but a few miles out ${competitor} is there and you're not. People searching from those areas are calling them, not you.`;
  } else if (competitor) {
    msg = `One more thing — just ran your visibility scan. You're showing up in most of your area, but ${competitor} is still winning the searches further from your building.`;
  } else {
    msg = `One more thing — just ran your visibility scan. There are gaps in your local search coverage — people looking for audiologists a few miles out aren't finding you.`;
  }

  // Race guard: same SEND→PERSIST window as every other outbound flow.
  const _lock = outboundLock.acquire(contactId);
  try {
    await ghl.sendMessage(contactId, msg);
    conversations.addExchange(contactId, {
      direction: 'outbound',
      body: msg,
      step: 4,
      conversationId: resolvedConvId || null,
      variant: conversations.get(contactId)?.variant || null
    });
    brain.recordOutbound(contactId, msg, 4, { variant: conversations.get(contactId)?.variant || null });
    console.log(`[ScanWatch] Visibility follow-up sent to ${contactId}`);
  } catch (err) {
    console.error(`[ScanWatch] Failed to send visibility message for ${contactId}:`, err.message);
  } finally {
    _lock.release();
  }
}

function enqueueJob(job) {
  jobQueue.push(job);
  if (!processing) drainQueue();
}

async function drainQueue() {
  if (processing || jobQueue.length === 0) return;
  processing = true;
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    try {
      await handleInbound(job);
    } catch (err) {
      console.error('[Queue] Job error:', err.message);
    }
  }
  processing = false;
}

// ─── GHL Webhook Auth ─────────────────────────────────────────────────────────

// `parseLeadForm` lives in conversations.js so enrollment.js + the brain can
// share the same parser. It looks for any `ampifyform:<slug>` GHL tag and
// returns the slug (e.g. 'high-volume', 'high-intent', 'high-intent-2fa').
// Falls back to 'unknown' when no `ampifyform:*` tag is present. Adding a new
// form in GHL automatically creates a new analytics bucket — no code change.
const { parseLeadForm } = conversations;

function verifyGhlWebhook(req, res) {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) {
    // No secret configured — allow all requests through (open mode)
    // Set GHL_WEBHOOK_SECRET to enable signature verification
    return true;
  }
  // GHL can be configured to send the secret in several headers; support all common forms
  const provided =
    req.headers['x-ghl-signature'] ||
    req.headers['x-api-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    '';
  if (provided === secret) return true;
  console.warn('[Webhook] Auth failed — received key does not match GHL_WEBHOOK_SECRET');
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

// ─── GHL Inbound Webhook ──────────────────────────────────────────────────────

app.post('/webhooks/ghl/inbound', async (req, res) => {
  // Verify the request is from GHL (fail-closed — 401/503 sent by verifyGhlWebhook)
  if (!verifyGhlWebhook(req, res)) return;

  const payload = req.body;

  // ── Direction / event-type guard ──────────────────────────────────────────────
  // Only process true inbound messages from prospects.
  // GHL may also fire webhooks for outbound messages or other events; skip those
  // to prevent loops and double-processing.
  const direction =
    payload.direction ||
    payload.messageDirection ||
    payload.type; // some versions send type: 1 (outbound) / 2 (inbound)

  const isOutbound =
    direction === 'outbound' ||
    direction === 'sent' ||
    direction === 1 ||
    direction === '1';

  if (isOutbound) {
    console.log('[Webhook] Skipping outbound message to prevent loop');
    return res.json({ received: true, skipped: 'outbound' });
  }

  // Acknowledge immediately — GHL expects a fast 200
  res.json({ received: true });

  // ── Parse payload (multiple GHL webhook shapes) ───────────────────────────────
  const contactId =
    payload.contactId ||
    payload.contact_id ||
    payload.contact?.id;

  const conversationId =
    payload.conversationId ||
    payload.conversation_id ||
    payload.conversation?.id ||
    null;

  const messageBody = (
    payload.body ||
    (typeof payload.message === 'string' ? payload.message : payload.message?.body) ||
    payload.messageBody ||
    payload.text ||
    ''
  ).trim();

  const firstName =
    payload.contact?.firstName ||
    payload.firstName ||
    payload.first_name ||
    '';

  const city =
    payload.contact?.city ||
    payload.city ||
    '';

  const phone =
    payload.contact?.phone ||
    payload.phone ||
    '';

  if (!contactId || !messageBody) {
    console.log('[Webhook] Skipping — missing contactId or body');
    return;
  }

  // ── Opt-out blocklist check ───────────────────────────────────────────────
  if (await optouts.isOptedOut(contactId)) {
    console.log(`[Webhook] Contact ${contactId} is opted out — silently ignoring inbound`);
    return;
  }

  // ── Opt-out keyword detection ─────────────────────────────────────────────
  if (optouts.isOptOutKeyword(messageBody)) {
    console.log(`[Webhook] Contact ${contactId} sent opt-out keyword "${messageBody}" — cancelling jobs and confirming`);
    followups.cancelContactJobs(contactId);
    followups.cancelEmailJobs(contactId);
    await optouts.add(contactId);
    ghl.sendMessage(contactId, "You've been unsubscribed. You won't receive any more messages from us.").catch(err => {
      console.error(`[Optout] Failed to send confirmation to ${contactId}:`, err.message);
    });
    return;
  }

  console.log(`[Webhook] Queuing job for contact ${contactId}: "${messageBody.slice(0, 60)}"`);

  // Cancel follow-up jobs immediately at intake — before enqueue — so a queued
  // AI handler or a due scheduler job cannot fire after this inbound arrives.
  followups.cancelContactJobs(contactId);

  // Cancel any pending AI auto-trigger (they replied, so flow resumes normally)
  clearPendingAiTrigger(contactId);
  // Cancel scan-visibility watcher if the prospect replied to the data-reveal step
  clearScanWatch(contactId);

  enqueueJob({ contactId, conversationId, messageBody, firstName, city, phone });
});

// ─── AI Opener (sent immediately on enrollment) ───────────────────────────────
// Replaces the legacy GHL static intro + 5-min static "Hey, you there?" hook.
// The AI generates the very first SMS using the contact's assigned variant
// prompt so each variant can A/B-test its own opener wording.
//
// Recorded as `followup-hook-pos1` (the Hook 1 marker — used by the enrolled
// webhook to recognise that an opener has already been sent for the contact).
// Then schedules the 5-min silence check (which fires "Hey <name>, you there?"
// if the prospect goes silent) and queues Hook 2 via scheduleNext so the
// follow-up cadence continues.

// In-progress guard — protects against duplicate enrollment webhooks racing
// before the first opener's `followup-hook-pos1` exchange has been persisted.
// Persisted dedup (the followup-hook-pos1 check) covers the long-tail case;
// this Set covers the small window between Claude call and exchange write.
const _openerInProgress = new Set();

async function generateAndSendOpener(contactId) {
  if (_openerInProgress.has(contactId)) {
    console.log(`[Opener] Skipping ${contactId} — opener generation already in progress`);
    return;
  }
  _openerInProgress.add(contactId);
  // Acquire the outbound lock so any inbound webhook for this contact arriving
  // mid-flight waits for the SEND→PERSIST window to fully close before reading
  // state. Without this, a fast prospect can reply between ghl.sendMessage and
  // conversations.addExchange, causing the inbound handler to see "no opener
  // sent yet" and re-generate Step 1.
  const _lock = outboundLock.acquire(contactId);
  try {
    const contact = conversations.get(contactId);
    if (!contact) {
      console.log(`[Opener] Skipping — contact ${contactId} not found`);
      return;
    }
    if (contact.booked) {
      console.log(`[Opener] Skipping ${contactId} — already booked`);
      return;
    }
    const tags = (contact.tags || []).map(t =>
      (typeof t === 'string' ? t : (t.name || '')).toLowerCase()
    );
    if (tags.includes('disable ai')) {
      console.log(`[Opener] Skipping ${contactId} — Disable AI tag`);
      return;
    }

    // Dedup: if the opener has already been sent for this contact, do nothing.
    const exchanges = contact.exchanges || [];
    if (exchanges.some(e => e.type === 'followup-hook-pos1')) {
      console.log(`[Opener] Skipping ${contactId} — opener already sent`);
      return;
    }

    // Build system prompt — same shape as handleInbound but with no live
    // research/scan data yet (none exists at enrollment time) and CURRENT STEP=0.
    const variant = contact.variant || null;
    const variantPromptKey = variant ? `conversationPrompt.${variant}` : 'conversationPrompt';
    let systemContent = prompts.get(variantPromptKey) || prompts.get('conversationPrompt');
    if (contact.firstName) systemContent += `\n\nPROSPECT FIRST NAME: ${contact.firstName}`;
    if (contact.city)      systemContent += `\n\nPROSPECT CITY: ${contact.city}`;
    systemContent += `\n\nCURRENT STEP: 0 (continue from here)`;
    const stage = brain.classifyStage(0);
    const winningSnippet = brain.buildWinningPatternsPrompt(stage, 'sms_scripted');
    if (winningSnippet) systemContent += winningSnippet;

    // Single trigger message — never persisted. The AI sees this only at
    // generation time so Anthropic's user/assistant ordering is satisfied.
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      system: systemContent,
      messages: [{ role: 'user', content: 'Begin the conversation now.' }]
    });
    spend.track(contactId, model, response.usage);

    let openerText = response.content[0]?.text?.trim() || '';
    if (!openerText) {
      console.error(`[Opener] Empty AI response for ${contactId} — skipping send`);
      return;
    }

    // Strip any hidden markers before sending — the prospect must never see them.
    const stepMatch = openerText.match(/\[STEP:(\d+)\]/i);
    const detectedStep = stepMatch ? parseInt(stepMatch[1], 10) : null;
    openerText = openerText
      .replace(/\[STEP:\d+\]\s*/gi, '')
      .replace(/\[PRACTICE_DETECTED:[^\]]+\]\s*/gi, '')
      .replace(/\[BOOKED\]\s*/gi, '')
      .trim();
    if (!openerText) {
      console.error(`[Opener] Stripped to empty for ${contactId} — skipping send`);
      return;
    }

    // Send via GHL — explicitly gated on DEV_MODE so the opener is generated
    // and logged in dev but never hits the GHL API. (ghl.sendMessage also
    // gates DEV_MODE internally; this outer gate matches the explicit pattern
    // used elsewhere in the codebase and makes the dev-vs-prod path obvious.)
    let sendResult;
    if (DEV_MODE) {
      console.log(`[Opener][DEV MODE] Generated opener for ${contactId} (variant ${variant || 'none'}), not sending: "${openerText.slice(0, 120)}"`);
      sendResult = { id: 'dev-mode-stub' };
    } else {
      sendResult = await ghl.sendMessage(contactId, openerText);
      if (!sendResult) {
        console.error(`[Opener] GHL send returned null for ${contactId} — not persisting`);
        return;
      }
    }

    // Persist as Hook 1 so the silence-check dedup correctly suppresses
    // the legacy "Hey, you there?" static fallback.
    conversations.addExchange(contactId, {
      direction: 'outbound',
      body: openerText,
      step: detectedStep ?? 0,
      conversationId: null,
      type: 'followup-hook-pos1',
      variant
    });
    if (detectedStep !== null) {
      conversations.update(contactId, { currentStep: detectedStep });
    }
    brain.recordOutbound(contactId, openerText, detectedStep ?? 0,
      { message_type: 'followup-sms', messageClass: 'hook-1', position: 1, variant });

    // Schedule the 5-min "Hey <name>, you there?" silence check (fires only
    // if the prospect doesn't reply), then queue Hook 2 so the cadence
    // continues if they stay silent.
    const tz = followups.estimateTimezone(contact.city || '');
    followups.scheduleSilenceCheck(contactId, detectedStep ?? 0, openerText);
    followups.scheduleNext(contactId, 1, detectedStep ?? 0, openerText, tz);

    console.log(`[Opener] AI opener sent to ${contactId} (variant ${variant || 'none'}): "${openerText.slice(0, 80)}"`);
  } catch (err) {
    console.error(`[Opener] Failed for ${contactId}:`, err.message);
  } finally {
    _openerInProgress.delete(contactId);
    _lock.release();
  }
}

// ─── GHL Enrolled Webhook ─────────────────────────────────────────────────────
// Fires the moment a new lead is enrolled in GHL. We create the local contact
// record, assign an A/B/C variant, and immediately fire-and-forget the
// AI-generated opener (which acts as Hook 1 of the follow-up sequence).

app.post('/webhooks/ghl/enrolled', async (req, res) => {
  // Use the same auth logic as /inbound: open mode when GHL_WEBHOOK_SECRET is not set,
  // strict match when it is. ADMIN_KEY is not used here — that's for the admin UI only.
  if (!verifyGhlWebhook(req, res)) return;

  res.json({ received: true });

  const payload = req.body;

  const contactId =
    payload.contactId ||
    payload.contact_id ||
    payload.contact?.id;

  const firstName =
    payload.contact?.firstName ||
    payload.firstName ||
    payload.first_name ||
    '';

  const city =
    payload.contact?.city ||
    payload.city ||
    '';

  const phone =
    payload.contact?.phone ||
    payload.phone ||
    '';

  const email =
    payload.contact?.email ||
    payload.email ||
    '';

  // GHL sometimes sends tags as an array, sometimes as a comma-separated
  // string, sometimes omits the field entirely. Normalise to a string[].
  const rawTags = payload.contact?.tags ?? payload.tags ?? [];
  const tagList = Array.isArray(rawTags)
    ? rawTags
    : (typeof rawTags === 'string'
        ? rawTags.split(',').map(s => s.trim()).filter(Boolean)
        : []);
  const tags = tagList.map(t =>
    (typeof t === 'string' ? t : (t.name || '')).toLowerCase()
  );

  if (!contactId) {
    console.log('[Enrolled] Skipping — missing contactId');
    return;
  }

  console.log(`[Enrolled] Received for contact ${contactId} (${firstName || '—'})`);

  // Guard: Disable AI tag → skip entirely
  if (tags.includes('disable ai')) {
    console.log(`[Enrolled] Skipping ${contactId} — has Disable AI tag`);
    return;
  }

  // Guard: already booked locally
  const existing = conversations.get(contactId);
  if (existing?.booked) {
    console.log(`[Enrolled] Skipping ${contactId} — already booked`);
    return;
  }

  // Guard: dedup — skip if either a pending silence-check job already exists
  // OR an opener (followup-hook-pos1) has already been recorded as outbound.
  // Both indicate the contact has already been enrolled in the AI flow.
  const jobs = followups.getAllJobs('pending');
  const hasSilenceCheck = jobs.some(
    j => j.contactId === contactId && j.type === 'silence-check'
  );
  const priorExchanges = existing?.exchanges || [];
  const hasOpener = priorExchanges.some(e => e.type === 'followup-hook-pos1');
  if (hasSilenceCheck || hasOpener) {
    console.log(`[Enrolled] Skipping ${contactId} — ${hasOpener ? 'opener already sent' : 'silence check already pending'}`);
    return;
  }

  // Create/update local contact record. Lead form is derived from the
  // `ampifyform:<slug>` GHL tag (see parseLeadForm) — defaults to 'unknown'.
  const leadForm = parseLeadForm(tags);
  conversations.ensureContact(contactId, { firstName, city, phone, email, tags, leadForm });
  conversations.update(contactId, { email, tags, leadForm });

  // Assign A/B/C variant if this is a new contact (only set once, never overwrite)
  const freshEnrolled = conversations.get(contactId);
  if (!freshEnrolled?.variant) {
    const assignedVariant = prompts.pickVariant(conversations.getAll());
    if (assignedVariant) {
      conversations.update(contactId, { variant: assignedVariant });
      console.log(`[Enrolled] Assigned variant ${assignedVariant} to ${contactId}`);
    }
  }

  const tz = followups.estimateTimezone(city);

  // Fire-and-forget the AI opener. The helper handles its own try/catch and
  // schedules the silence-check + Hook 2 internally, so the webhook response
  // is unaffected by Claude latency or failures.
  generateAndSendOpener(contactId).catch(err => {
    console.error(`[Enrolled] Opener task crashed for ${contactId}:`, err.message);
  });

  // Schedule Email #1 at next email window starting from 5min from now
  // (so the opener has time to land before the email window is checked)
  if (email) {
    const emailSendAt = followups.nextEmailWindowMs(Date.now() + 5 * 60 * 1000, tz);
    const allJobs = followups.getAllJobs();
    const hasEmail1 = allJobs.some(
      j => j.contactId === contactId && j.type === 'email-hook' &&
           j.position === 1 && (j.status === 'pending' || j.status === 'sent')
    );
    if (!hasEmail1) {
      followups.scheduleJob({
        contactId,
        type:     'email-hook',
        position: 1,
        sendAt:   emailSendAt,
        context:  { timezone: tz }
      });
      console.log(`[Enrolled] Email #1 scheduled for ${contactId} at ${new Date(emailSendAt).toISOString()}`);
    }
  }

  console.log(`[Enrolled] Contact ${contactId} enrolled — opener queued${email ? ' + email scheduled' : ''}`);
});

// ─── GHL Appointment Webhook ──────────────────────────────────────────────────
// Fires when a calendar appointment is created in GHL.
// This is the canonical "booked" signal — the contact is now counted in stats.
// Configure this in GHL: Automation → Webhooks → AppointmentCreated → POST to
// /webhooks/ghl/appointment

app.post('/webhooks/ghl/appointment', async (req, res) => {
  if (!verifyGhlWebhook(req, res)) return;
  res.json({ received: true });

  const payload = req.body;
  const contactId = payload.contactId || payload.contact_id;
  if (!contactId) {
    console.log('[Appointment] No contactId in payload — ignoring');
    return;
  }

  const contact = conversations.get(contactId);
  if (!contact) {
    console.log(`[Appointment] Contact ${contactId} not in our system — ignoring`);
    return;
  }

  // Only record the first appointment — follow-ups don't change the booked status
  if (contact.booked) {
    console.log(`[Appointment] Contact ${contactId} (${contact.firstName}) already booked — ignoring follow-up appointment`);
    return;
  }

  conversations.update(contactId, { booked: true });
  brain.recordBooking(contactId);
  console.log(`[Appointment] Contact ${contactId} (${contact.firstName}) has a confirmed GHL appointment — marked booked`);
});

// ─── GHL Contact-Updated Webhook ──────────────────────────────────────────────
// Fires when GHL updates a contact (e.g. a tag is added). When the "Disable AI"
// tag is detected, all pending email jobs are cancelled immediately so no further
// emails go out — even if jobs were already queued. The local contact record is
// also updated with the latest tags.

app.post('/webhooks/ghl/contact-updated', async (req, res) => {
  // Use the same auth logic as /inbound: open mode when GHL_WEBHOOK_SECRET is not set,
  // strict match when it is. ADMIN_KEY is not used here — that's for the admin UI only.
  if (!verifyGhlWebhook(req, res)) return;

  res.json({ received: true });

  const payload = req.body;

  const contactId =
    payload.contactId ||
    payload.contact_id ||
    payload.contact?.id;

  if (!contactId) {
    console.log('[ContactUpdated] Skipping — missing contactId');
    return;
  }

  // Only parse tags if the payload actually contains a tags field.
  // If tags are absent (e.g. a non-tag update), hasTags stays false and we
  // skip overwriting the local record — preventing accidental tag erasure.
  // Accept the same shapes the enrolled webhook does: array, comma-separated
  // string, or absent. Treat empty-string as "absent" (no tag info provided).
  const rawTagsSource = payload.contact?.tags ?? payload.tags;
  const hasTags = Array.isArray(rawTagsSource)
    || (typeof rawTagsSource === 'string' && rawTagsSource.trim().length > 0);
  let tagList = [];
  if (Array.isArray(rawTagsSource)) {
    tagList = rawTagsSource;
  } else if (typeof rawTagsSource === 'string') {
    tagList = rawTagsSource.split(',').map(s => s.trim()).filter(Boolean);
  }
  const tags = tagList.map(t =>
    (typeof t === 'string' ? t : (t?.name || '')).toLowerCase()
  );

  console.log(`[ContactUpdated] Received for contact ${contactId} — tags present: ${hasTags}${hasTags ? `, [${tags.join(', ')}]` : ''}`);

  // Update local contact record with the latest tags only when the payload
  // explicitly included a tags array (avoid clearing tags on unrelated updates).
  // Re-derive leadForm from the new tag set so a later GHL tag edit (e.g. moving
  // a contact from `ampifyform:high-volume` to `ampifyform:high-intent`) is
  // reflected in analytics. Existing outbound-message snapshots are untouched
  // so historical reply rates remain accurate.
  if (hasTags) {
    const existing = conversations.get(contactId);
    if (existing) {
      const leadForm = parseLeadForm(tags);
      conversations.update(contactId, { tags, leadForm });
      console.log(`[ContactUpdated] Updated tags on local record for ${contactId} (leadForm=${leadForm})`);
    }
  }

  // If "Disable AI" tag is present, cancel all pending jobs (email + SMS) immediately
  if (tags.includes('disable ai')) {
    const cancelledSms = followups.cancelContactJobs(contactId);
    const cancelledEmail = followups.cancelEmailJobs(contactId);
    console.log(`[ContactUpdated] Disable AI tag detected for ${contactId} — cancelled ${cancelledSms} SMS job(s) and ${cancelledEmail} email job(s)`);
  }
});

// ─── State Recovery from GHL History ─────────────────────────────────────────
// Called when local state may be incomplete (e.g. server restart). Scans the
// raw GHL message history and patches any missing flags back into the contact.

function recoverStateFromHistory(contactId, fresh, rawGhlMessages) {
  if (!rawGhlMessages || rawGhlMessages.length === 0) return;

  // GHL messages come newest-first — find the most recent outbound we sent
  const lastOutbound = rawGhlMessages.find(m => {
    const isInbound = m.direction === 'inbound' || m.direction === 2 ||
                      m.messageType === 'inbound' || m.type === 2;
    return !isInbound;
  });
  if (!lastOutbound) return;

  const body = (lastOutbound.body || lastOutbound.message || '').trim();
  const bodyLower = body.toLowerCase();
  const updates = {};

  // Recover awaitingRetryName: we asked them to re-provide name + street
  if (!fresh?.awaitingRetryName && !fresh?.confirmationPending) {
    if (bodyLower.includes("what's the exact name") && bodyLower.includes("google maps")) {
      updates.awaitingRetryName = true;
      console.log(`[StateRecovery] Restored awaitingRetryName for ${contactId}`);
    }
  }

  // Recover confirmationPending: we sent an address confirmation question
  if (!fresh?.confirmationPending && !fresh?.awaitingRetryName && !updates.awaitingRetryName) {
    if (bodyLower.includes('is that the right one') || bodyLower.includes('reply yes or no')) {
      const nameMatch = body.match(/^Found (.+?) at (.+?) —/i);
      const name = nameMatch ? nameMatch[1] : (fresh?.practiceName || '');
      const address = nameMatch ? nameMatch[2] : '';
      const city = fresh?.practiceCity || fresh?.city || '';
      updates.confirmationPending = { placeId: null, name, address, city, recovered: true };
      console.log(`[StateRecovery] Restored confirmationPending for ${contactId}: "${name}"`);
    }
  }

  // Recover currentStep from known scripted text patterns
  if (!fresh?.currentStep || fresh.currentStep === 0) {
    if (bodyLower.includes('i pulled up') && bodyLower.includes('while we were talking')) {
      updates.currentStep = 4;
    } else if (bodyLower.includes('sid, our founder')) {
      updates.currentStep = 5;
    } else if (bodyLower.includes('locked in') && bodyLower.includes('calendar invite')) {
      updates.currentStep = 6;
    }
    if (updates.currentStep) {
      console.log(`[StateRecovery] Restored currentStep ${updates.currentStep} for ${contactId}`);
    }
  }

  if (Object.keys(updates).length > 0) {
    conversations.update(contactId, updates);
  }
}

// ─── Webhook Handler ──────────────────────────────────────────────────────────

async function handleInbound({ contactId, conversationId, messageBody, firstName, city, phone }) {
  // ── 0. Wait for any in-flight outbound for this contact to fully settle ──────
  // The opener / AI reply / confirmation / follow-up flows all do SEND→PERSIST.
  // If a prospect replies inside that window (under ~5s), the inbound webhook
  // can race ahead of the persist call and read stale state — leading to
  // duplicate sends. Awaiting the outbound lock guarantees we see the world
  // exactly as it exists post-persist.
  await outboundLock.waitForSettle(contactId);

  // ── 1. Fetch authoritative contact info from GHL ─────────────────────────────
  const ghlContact = await ghl.fetchContact(contactId);

  const resolvedFirstName = ghlContact?.firstName || firstName || '';
  const resolvedCity = ghlContact?.city || ghlContact?.address?.city || city || '';
  const resolvedPhone = ghlContact?.phone || phone || '';

  // ── 1.5. Honour "Disable AI" tag — hard stop, no messages sent ───────────────
  const contactTags = (ghlContact?.tags || []).map(t => t.toLowerCase());
  if (contactTags.includes('disable ai')) {
    console.log(`[Webhook] Contact ${contactId} has "Disable AI" tag — skipping all AI actions`);
    return;
  }

  // ── 2. Load / create local contact record ────────────────────────────────────
  conversations.ensureContact(contactId, {
    firstName: resolvedFirstName,
    city: resolvedCity,
    phone: resolvedPhone
  });

  // Sync any updated contact info
  const infoUpdates = {};
  if (resolvedFirstName) infoUpdates.firstName = resolvedFirstName;
  if (resolvedCity) infoUpdates.city = resolvedCity;
  if (resolvedPhone) infoUpdates.phone = resolvedPhone;
  if (Object.keys(infoUpdates).length) conversations.update(contactId, infoUpdates);

  // ── 3. Record this inbound message ───────────────────────────────────────────
  conversations.addExchange(contactId, {
    direction: 'inbound',
    body: messageBody,
    step: conversations.get(contactId)?.currentStep || 0,
    conversationId
  });

  // Cancel any pending follow-up jobs before processing the reply (they replied — no hooks needed)
  followups.cancelContactJobs(contactId);

  // Store inbound in brain (for stats and contact history) then mark previous outbound replied
  const stepAtInbound = conversations.get(contactId)?.currentStep ?? null;
  brain.recordInbound(contactId, messageBody, stepAtInbound);
  brain.recordReply(contactId);

  // Reload fresh state after recording
  let fresh = conversations.get(contactId);

  if (fresh?.booked) {
    console.log(`[Webhook] Contact ${contactId} already booked — skipping`);
    return;
  }

  // ── 3.5. API spend limit check ───────────────────────────────────────────────
  if (spend.isAtLimit(contactId)) {
    console.warn(`[Webhook] Contact ${contactId} has hit API spend limit — not generating reply`);
    return;
  }

  // ── 4. Resolve conversationId and fetch full GHL history ──────────────────────
  // We fetch GHL messages BEFORE the state check so we can recover lost
  // mid-conversation flags (confirmationPending / awaitingRetryName) in case
  // the in-memory state was wiped (server restart, fresh contact, etc.).
  let resolvedConvId = conversationId;
  if (!resolvedConvId && contactId) {
    try {
      resolvedConvId = await ghl.getOrCreateConversation(contactId);
      console.log(`[Webhook] Resolved conversationId ${resolvedConvId} for contact ${contactId}`);
    } catch (err) {
      console.warn('[Webhook] Could not resolve conversationId:', err.message);
    }
  }

  let rawGhlMessages = [];
  if (resolvedConvId) {
    rawGhlMessages = await ghl.fetchMessages(resolvedConvId);
  }

  // ── 4.4. Recover lost state from GHL message history ──────────────────────────
  // If the local in-memory state is missing the Maps-flow flags but the most
  // recent outbound message shows we're mid-flow, restore the flags so the
  // deterministic handler below picks them up instead of falling through to
  // Claude (which would otherwise improvise a new question).
  if (rawGhlMessages.length > 0) {
    recoverStateFromHistory(contactId, fresh, rawGhlMessages);
    fresh = conversations.get(contactId);
  }

  // ── 4.5. Handle address confirmation or name-retry states (no Claude call) ────
  if (fresh?.confirmationPending) {
    return await handleConfirmationReply(contactId, messageBody, fresh, resolvedConvId);
  }
  if (fresh?.awaitingRetryName) {
    return await handleRetryName(contactId, messageBody, fresh, resolvedConvId);
  }

  // ── 4.6. Hand off to the AI generation pipeline ───────────────────────────────
  await generateAndSendAiReply(contactId, resolvedConvId, {
    fresh,
    rawGhlMessages,
    resolvedFirstName,
    resolvedCity
  });
}

// Signature of the "Not interested" rejection-handler outbound. Used by the
// [BOOKED] hallucination guard below to recognize a prior decline even if
// Claude forgot to emit the [DECLINED] marker on that turn.
const _REJECTION_SIGNATURE = /text me if anything changes/i;

function _wasLastOutboundRejection(fresh) {
  const exchanges = fresh?.exchanges || [];
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const ex = exchanges[i];
    if (ex.direction === 'outbound') {
      return _REJECTION_SIGNATURE.test(ex.body || '');
    }
  }
  return false;
}

// ─── AI Generation Pipeline ───────────────────────────────────────────────────
// Builds the message history + variant-specific system prompt, calls Claude,
// processes hidden markers ([STEP:N], [PRACTICE_DETECTED:…], [BOOKED],
// [DECLINED]), sends the reply via GHL, and persists the exchange. Called from:
//   • handleInbound — every inbound webhook that isn't intercepted by the
//                     confirmation / retry-name short-circuits
//   • scheduleAiResponseAfterResearch — to generate the next scripted step
//                     once research/scan completes (post-bridge / post-YES)
async function generateAndSendAiReply(contactId, resolvedConvId, opts = {}) {
  // Acquire the outbound lock so any concurrent inbound webhook for this
  // contact (or another reply path like scheduleAiResponseAfterResearch)
  // waits for SEND→PERSIST to fully close before reading state.
  const _lock = outboundLock.acquire(contactId);
  try {
  let fresh = opts.fresh || conversations.get(contactId);
  if (!fresh) {
    console.log(`[AiGen] No contact record for ${contactId} — skipping`);
    return;
  }
  if (fresh.booked) {
    console.log(`[AiGen] Contact ${contactId} already booked — skipping AI generation`);
    return;
  }

  // Honour API spend limit (also checked at the top of handleInbound; this
  // covers post-research auto-triggers that bypass that path).
  if (spend.isAtLimit(contactId)) {
    console.warn(`[AiGen] Contact ${contactId} hit API spend limit — not generating reply`);
    return;
  }

  const resolvedFirstName = opts.resolvedFirstName ?? fresh.firstName ?? '';
  const resolvedCity = opts.resolvedCity ?? fresh.city ?? '';

  // Fetch GHL message history if the caller didn't already supply it.
  let rawGhlMessages = opts.rawGhlMessages;
  if (!rawGhlMessages) {
    if (resolvedConvId) {
      try {
        rawGhlMessages = await ghl.fetchMessages(resolvedConvId);
      } catch (err) {
        console.warn(`[AiGen] Could not fetch GHL messages for ${contactId}:`, err.message);
        rawGhlMessages = [];
      }
    } else {
      rawGhlMessages = [];
    }
  }

  // Build message history from GHL + local
  let messages = [];
  if (rawGhlMessages.length > 0) {
    messages = buildMessagesFromGhl(rawGhlMessages);
  }
  if (messages.length === 0) {
    messages = buildMessagesFromLocal(fresh?.exchanges || []);
  }
  if (messages.length === 0) {
    console.log(`[AiGen] No message history for ${contactId}`);
    return;
  }

  // Build system prompt with live data + winning patterns. Pick variant-specific
  // prompt (A/B/C); fall back to the base prompt if no variant is assigned.
  const contactVariant = fresh?.variant || null;
  const variantPromptKey = contactVariant ? `conversationPrompt.${contactVariant}` : 'conversationPrompt';
  let systemContent = prompts.get(variantPromptKey) || prompts.get('conversationPrompt');

  if (resolvedFirstName || fresh?.firstName) {
    systemContent += `\n\nPROSPECT FIRST NAME: ${resolvedFirstName || fresh?.firstName}`;
  }

  if (resolvedCity || fresh?.city) {
    systemContent += `\n\nPROSPECT CITY: ${resolvedCity || fresh?.city}`;
  }

  if (fresh?.currentStep !== undefined) {
    systemContent += `\n\nCURRENT STEP: ${fresh.currentStep} (continue from here)`;
  }

  // Inject winning patterns for the current conversation stage (learning brain)
  const currentStage = brain.classifyStage(fresh?.currentStep ?? null);
  const winningPromptSnippet = brain.buildWinningPatternsPrompt(currentStage, 'sms_scripted');
  if (winningPromptSnippet) systemContent += winningPromptSnippet;

  if (fresh?.researchData) {
    const rd = fresh.researchData;
    systemContent += `\n\nLIVE RESEARCH DATA:\n${JSON.stringify({
      practiceName: fresh.practiceName,
      reviews: rd.reviews,
      rating: rd.rating,
      competitors: rd.competitors?.slice(0, 3),
      competitorSummary: rd.competitorSummary,
      prospectRank: rd.prospectRank
    }, null, 2)}`;
  }

  if (fresh?.scanResults) {
    const sr = fresh.scanResults;
    systemContent += `\n\nSCAN RESULTS:\n${JSON.stringify({
      visibleTop3: sr.visibleTop3,
      invisible: sr.invisible,
      totalPoints: sr.totalPoints,
      topCompetitor: sr.topCompetitor,
      averageRankWhereVisible: sr.averageRankWhereVisible
    }, null, 2)}`;
  }

  // Call Claude
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: systemContent,
    messages
  });

  spend.track(contactId, model, response.usage);

  let reply = response.content[0]?.text?.trim() || '';

  // ── Extract hidden markers ──

  // [STEP:N] — track current step
  const stepMatch = reply.match(/\[STEP:(\d+)\]/i);
  const detectedStep = stepMatch ? parseInt(stepMatch[1], 10) : null;
  reply = reply.replace(/\[STEP:\d+\]\s*/gi, '').trim();

  // [PRACTICE_DETECTED:name|street|city] — fast lookup → address confirmation → research
  const practiceMatch = reply.match(/\[PRACTICE_DETECTED:([^\]]+)\]/i);
  let confirmationMsg = null;
  if (practiceMatch) {
    const parts = practiceMatch[1].split('|').map(s => s.trim());
    const practiceName = parts[0] || '';
    const practiceStreet = parts[1] || '';
    const practiceCity = parts[2] || resolvedCity || fresh?.city || '';

    reply = reply.replace(/\[PRACTICE_DETECTED:[^\]]+\]\s*/i, '').trim();
    conversations.update(contactId, { practiceName, practiceStreet, practiceCity });
    console.log(`[AiGen] Practice detected: "${practiceName}" on "${practiceStreet}" in "${practiceCity}"`);

    const apiKey = process.env.GOOGLE_PLACES_KEY;
    if (apiKey && practiceName) {
      try {
        const searchQuery = [practiceName, practiceStreet, practiceCity].filter(Boolean).join(' ');
        const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&key=${apiKey}`;
        const placesRes = await fetch(placesUrl);
        const placesData = await placesRes.json();
        const topResult = (placesData.results || [])[0];

        if (topResult) {
          const confirmName = topResult.name || practiceName;
          const confirmAddress = topResult.formatted_address || topResult.vicinity || '';
          conversations.update(contactId, {
            confirmationPending: { placeId: topResult.place_id, name: confirmName, address: confirmAddress, city: practiceCity }
          });
          confirmationMsg = `Found ${confirmName} at ${confirmAddress} — is that the right one?`;
          console.log(`[AiGen] Address confirmation queued for ${contactId}: ${confirmName}`);
        } else {
          console.log(`[AiGen] No listing found for "${searchQuery}" — skipping confirmation`);
          startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
          scheduleAiResponseAfterResearch(contactId, resolvedConvId);
        }
      } catch (err) {
        console.error('[AiGen] Fast lookup error:', err.message);
        startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
        scheduleAiResponseAfterResearch(contactId, resolvedConvId);
      }
    } else {
      startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
      scheduleAiResponseAfterResearch(contactId, resolvedConvId);
    }
  }

  // [DECLINED] — the AI fired the rejection handler ("No worries [name] — text
  // me if anything changes."). Pause the AI like [BOOKED] does, but tag the
  // pause as 'declined' so the contact does NOT appear in Pending Booking
  // Confirmations and we can detect future [BOOKED] hallucinations on the
  // same contact. The reply text itself still goes out (only the marker is
  // stripped) — UNLESS the same turn also contains [BOOKED], which is a
  // contradictory mixed-marker hallucination handled below.
  // Marker detection is case-insensitive to absorb any casing drift from
  // Claude (e.g. [Booked], [declined]).
  const hasDeclinedMarker = /\[DECLINED\]/i.test(reply);
  const hasBookedMarker   = /\[BOOKED\]/i.test(reply);
  if (hasDeclinedMarker) {
    reply = reply.replace(/\[DECLINED\]\s*/gi, '').trim();
    conversations.update(contactId, { booked: true, pausedReason: 'declined' });
    console.log(`[AiGen] Contact ${contactId} declined — AI paused (paused_reason=declined)`);
  }

  // [BOOKED] — the AI thinks the prospect agreed to a time. This ONLY pauses
  // the AI (so it stops responding and follow-ups stop firing). It does NOT
  // count as a real booking on the dashboard — that requires a confirmed
  // GHL calendar appointment (see /webhooks/ghl/appointment), which calls
  // brain.recordBooking() to mark the booking in the stats. This split lets
  // the dashboard's booking-rate stat reflect only confirmed calendar
  // bookings, not the AI's optimistic interpretation of the conversation.
  //
  // Hallucination guard fires (and the entire reply is discarded) when ANY of:
  //   • The contact is already paused as declined (prior turn).
  //   • The most recent outbound was the rejection handler (legacy contacts
  //     declined before [DECLINED] existed in the prompts).
  //   • This same turn ALSO emitted [DECLINED] — contradictory mixed-marker
  //     output. Saying "No worries — text me if anything changes." AND
  //     "Locked in. Calendar invite incoming." in the same SMS would whiplash
  //     the prospect; safer to send nothing and keep them paused as declined.
  if (hasBookedMarker) {
    reply = reply.replace(/\[BOOKED\]\s*/gi, '').trim();
    const isHallucination = fresh.pausedReason === 'declined'
                         || _wasLastOutboundRejection(fresh)
                         || hasDeclinedMarker;
    if (isHallucination) {
      console.warn(`[AiGen] [BOOKED] hallucination suppressed for ${contactId} (declined-context). Reply discarded: "${reply.slice(0, 80)}"`);
      conversations.update(contactId, { booked: true, pausedReason: 'declined' });
      reply = '';
    } else {
      conversations.update(contactId, { booked: true, pausedReason: 'verbal-commit' });
      console.log(`[AiGen] Contact ${contactId} agreed to book — AI paused (paused_reason=verbal-commit), awaiting GHL appointment confirmation`);
    }
  }

  // Update step
  if (detectedStep !== null) {
    conversations.update(contactId, { currentStep: detectedStep });
  }

  // Persisted step: prefer Claude's marker, fall back to the contact's last
  // known step so brain/followups never receive null when we have prior state.
  const persistStep = detectedStep ?? fresh?.currentStep ?? null;

  // Send reply via GHL and persist
  if (reply) {
    await ghl.sendMessage(contactId, reply);
    conversations.addExchange(contactId, {
      direction: 'outbound',
      body: reply,
      step: persistStep,
      conversationId: resolvedConvId || null,
      variant: contactVariant
    });
    brain.recordOutbound(contactId, reply, persistStep, { variant: contactVariant });
    followups.scheduleSilenceCheck(contactId, persistStep, reply);
    console.log(`[AiGen] Sent to ${contactId} (step ${persistStep}, variant ${contactVariant || 'none'}): "${reply.slice(0, 80)}"`);
  }

  // Send address confirmation (if queued from PRACTICE_DETECTED)
  if (confirmationMsg) {
    try {
      await ghl.sendMessage(contactId, confirmationMsg);
      conversations.addExchange(contactId, {
        direction: 'outbound',
        body: confirmationMsg,
        step: persistStep,
        conversationId: resolvedConvId || null,
        variant: contactVariant
      });
      brain.recordOutbound(contactId, confirmationMsg, persistStep, { variant: contactVariant });
      followups.scheduleSilenceCheck(contactId, persistStep, confirmationMsg);
      console.log(`[AiGen] Sent address confirmation to ${contactId}: "${confirmationMsg.slice(0, 80)}"`);
    } catch (err) {
      console.error('[AiGen] Failed to send confirmation — falling back to AI auto-trigger:', err.message);
      const ct = conversations.get(contactId);
      if (ct?.confirmationPending) {
        conversations.update(contactId, { confirmationPending: null });
        startResearchAndScan(contactId, ct.practiceName, ct.practiceStreet || '', ct.practiceCity || ct.city || '', null);
        scheduleAiResponseAfterResearch(contactId, resolvedConvId);
      }
    }
  }
  } finally {
    _lock.release();
  }
}

// ─── Address Confirmation Helpers ─────────────────────────────────────────────

function startResearchAndScan(contactId, practiceName, practiceStreet, city, confirmedPlaceId) {
  const sessionObj = { sessionId: contactId };
  sessions.set(contactId, {
    sessionId: contactId,
    practiceName,
    practiceStreet: practiceStreet || '',
    city,
    researchStatus: 'idle',
    scanStatus: 'idle',
    researchData: null,
    scanResults: null,
    createdAt: Date.now()
  });
  runResearch(sessionObj, practiceName, practiceStreet || '', city, confirmedPlaceId).then(() => {
    const s = sessions.get(contactId);
    if (s?.researchData) {
      conversations.update(contactId, { researchData: s.researchData });
      console.log(`[Webhook] Research stored for ${contactId}`);
    }
  }).catch(() => {});
  startScan(sessionObj, practiceName, city, config.scanKeyword).then(() => {
    const s = sessions.get(contactId);
    if (s?.scanResults) {
      conversations.update(contactId, { scanResults: s.scanResults });
      console.log(`[Webhook] Scan stored for ${contactId}`);
    }
  }).catch(() => {});
}

async function handleConfirmationReply(contactId, messageBody, contact, resolvedConvId) {
  const _lock = outboundLock.acquire(contactId);
  try {
  const pending = contact.confirmationPending;
  const msg = messageBody.toLowerCase().trim();

  const isNo = /^(no|nope|not (quite|right|that one|it)|wrong|different|nah|incorrect)\b/.test(msg) || msg === 'n';

  if (isNo) {
    conversations.update(contactId, { confirmationPending: null, awaitingRetryName: true });
    const clarification = "No problem — what's the exact name as it appears on Google Maps, and what street is it on?";
    await ghl.sendMessage(contactId, clarification);
    conversations.addExchange(contactId, { direction: 'outbound', body: clarification, step: 4, conversationId: resolvedConvId || null, variant: contact.variant || null });
    brain.recordOutbound(contactId, clarification, 4, { variant: contact.variant || null });
    followups.scheduleSilenceCheck(contactId, 4, clarification);
    console.log(`[Webhook] Confirmation denied for ${contactId} — asking for correction`);
    return;
  }

  // Require explicit affirmative — ambiguous replies re-prompt so Step 3 stays held
  const isYes = /^(yes|yea|yeah|yep|yup|ya|ye|correct|right|that('s| is)( it| right| the one| us| ours| mine)?|thats (it|right|correct|us|ours)|sure|exactly|affirmative|absolutely|definitely|for sure|sounds (right|good|correct)|looks (right|good|correct)|ok(ay)?|y|100)\b/.test(msg);
  if (!isYes) {
    const reprompt = "Just want to make sure — is that your practice listing? Reply yes or no.";
    await ghl.sendMessage(contactId, reprompt);
    conversations.addExchange(contactId, { direction: 'outbound', body: reprompt, step: 4, conversationId: resolvedConvId || null, variant: contact.variant || null });
    brain.recordOutbound(contactId, reprompt, 4, { variant: contact.variant || null });
    followups.scheduleSilenceCheck(contactId, 4, reprompt);
    return;
  }

  conversations.update(contactId, { confirmationPending: null });
  console.log(`[Webhook] Practice confirmed for ${contactId}: ${pending.name}`);
  startResearchAndScan(contactId, pending.name, contact.practiceStreet || '', pending.city, pending.placeId);
  scheduleAiResponseAfterResearch(contactId, resolvedConvId, { skipReplyGuard: true });
  } finally {
    _lock.release();
  }
}

async function handleRetryName(contactId, messageBody, contact, resolvedConvId) {
  const _lock = outboundLock.acquire(contactId);
  try {
  const city = contact.practiceCity || contact.city || '';
  // Use the full reply as the search query — prospect may give "Name on Street" or just a name
  const retryInput = messageBody.trim();
  conversations.update(contactId, { awaitingRetryName: false, practiceName: retryInput });

  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (apiKey) {
    try {
      // Include city; let Google Places parse out name vs street from the natural reply
      const searchQuery = [retryInput, city].filter(Boolean).join(' ');
      const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&key=${apiKey}`;
      const placesRes = await fetch(placesUrl);
      const placesData = await placesRes.json();
      const topResult = (placesData.results || [])[0];

      if (topResult) {
        const confirmName = topResult.name || retryInput;
        const confirmAddress = topResult.formatted_address || '';
        conversations.update(contactId, {
          confirmationPending: { placeId: topResult.place_id, name: confirmName, address: confirmAddress, city }
        });
        const confirmMsg = `Found ${confirmName} at ${confirmAddress} — is that the right one?`;
        await ghl.sendMessage(contactId, confirmMsg);
        conversations.addExchange(contactId, { direction: 'outbound', body: confirmMsg, step: 4, conversationId: resolvedConvId || null, variant: contact.variant || null });
        brain.recordOutbound(contactId, confirmMsg, 4, { variant: contact.variant || null });
        followups.scheduleSilenceCheck(contactId, 4, confirmMsg);
        console.log(`[Webhook] Retry confirmation sent to ${contactId}: ${confirmName}`);
        return;
      }
    } catch (err) {
      console.error('[Webhook] Retry lookup error:', err.message);
    }
  }

  // No result or no API key — proceed without confirmation; let Claude take
  // the next turn once research completes.
  startResearchAndScan(contactId, retryInput, '', city, null);
  scheduleAiResponseAfterResearch(contactId, resolvedConvId, { skipReplyGuard: true });
  } finally {
    _lock.release();
  }
}

// ─── Message History Builders ─────────────────────────────────────────────────

function buildMessagesFromGhl(ghlMessages) {
  if (!ghlMessages || !Array.isArray(ghlMessages) || ghlMessages.length === 0) return [];

  // GHL returns messages newest-first — reverse to chronological order for Claude
  const chronological = [...ghlMessages].reverse();

  const mapped = chronological
    .filter(m => m.body || m.message)
    .filter(m => {
      // Drop outbound messages that GHL/Twilio failed to deliver — Claude should
      // not treat them as received by the prospect.
      const outbound = m.direction === 'outbound' || m.direction === 1 ||
                       m.messageType === 'outbound' || m.type === 1;
      if (outbound && m.status === 'failed') return false;
      // Strip automated GHL system messages (CRM notifications, workflow triggers, etc.)
      const text = (m.body || m.message || '').trim();
      if (/CRM ID:/i.test(text)) return false;
      if (/opportunity created/i.test(text)) return false;
      if (/reply STOP to unsubscribe/i.test(text)) return false;
      return true;
    })
    .map(m => {
      // GHL direction: 1 = outbound (AI), 2 = inbound (prospect)
      const isInbound =
        m.direction === 'inbound' ||
        m.direction === 2 ||
        m.messageType === 'inbound' ||
        m.type === 2;
      return {
        role: isInbound ? 'user' : 'assistant',
        content: (m.body || m.message || '').trim()
      };
    })
    .filter(m => m.content.length > 0);

  return mergeAndNormalise(mapped);
}

function buildMessagesFromLocal(exchanges) {
  const mapped = exchanges.map(ex => ({
    role: ex.direction === 'inbound' ? 'user' : 'assistant',
    content: ex.body
  }));
  return mergeAndNormalise(mapped);
}

function mergeAndNormalise(messages) {
  // Merge consecutive same-role messages
  const merged = [];
  for (const m of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === m.role) {
      merged[merged.length - 1].content += ' ' + m.content;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  // Claude requires messages to start with 'user'
  while (merged.length > 0 && merged[0].role !== 'user') merged.shift();
  // Claude must respond to a user turn — strip any trailing assistant messages
  // (e.g. GHL automation messages that appear after the prospect's last reply)
  while (merged.length > 0 && merged[merged.length - 1].role !== 'user') merged.pop();
  return merged;
}

// ─── GMB Listing Search ───────────────────────────────────────────────────────

app.post('/api/places/search', async (req, res) => {
  const { practiceName, city } = req.body;
  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey || !practiceName || !city) return res.json({ results: [] });

  try {
    const query = encodeURIComponent(`${practiceName} ${city}`);
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const results = (data.results || []).slice(0, 5).map(p => {
      const photoRef = p.photos?.[0]?.photo_reference || null;
      const photoUrl = photoRef
        ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${photoRef}&key=${apiKey}`
        : null;
      const skipTypes = new Set(['point_of_interest', 'establishment', 'health', 'doctor', 'store', 'food', 'lodging']);
      const category = (p.types || []).find(t => !skipTypes.has(t));
      return {
        placeId: p.place_id,
        name: p.name,
        address: p.formatted_address || '',
        rating: p.rating || null,
        userRatingsTotal: p.user_ratings_total || 0,
        photoUrl,
        category: category ? category.replace(/_/g, ' ') : null
      };
    });
    res.json({ results });
  } catch (err) {
    console.error('[Places Search] Error:', err.message);
    res.json({ results: [] });
  }
});

// ─── GMB Message Generator ────────────────────────────────────────────────────

app.post('/api/generate', async (req, res) => {
  const { practiceName, city, confirmedPlaceId } = req.body;
  if (!practiceName || !city) {
    return res.status(400).json({ error: 'practiceName and city are required' });
  }

  const sessionId = uuidv4();
  const session = {
    sessionId,
    practiceName,
    city,
    confirmedPlaceId: confirmedPlaceId || null,
    researchStatus: 'idle',
    scanStatus: 'idle',
    researchData: null,
    scanResults: null,
    createdAt: Date.now()
  };
  sessions.set(sessionId, session);

  runResearch(session, practiceName, '', city, confirmedPlaceId || null).catch(() => {});
  startScan(session, practiceName, city, config.scanKeyword).catch(() => {});

  const TIMEOUT = 90000;
  const start = Date.now();

  await new Promise(resolve => {
    const check = setInterval(() => {
      const s = sessions.get(sessionId);
      const researchDone = s?.researchStatus === 'complete' || s?.researchStatus === 'failed';
      const scanDone = s?.scanStatus === 'complete' || s?.scanStatus === 'failed';
      if ((researchDone && scanDone) || Date.now() - start > TIMEOUT) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });

  const final = sessions.get(sessionId);
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  let userMessage = `Generate a message for this prospect's audiology practice.\n\nPractice name: ${practiceName}\nCity: ${city}`;

  if (final?.researchData) {
    const rd = final.researchData;
    userMessage += `\n\nGOOGLE MAPS PROFILE DATA:\n${JSON.stringify({
      reviews: rd.reviews,
      rating: rd.rating,
      photos: rd.photos,
      websiteListed: rd.websiteListed,
      hoursSet: rd.hoursSet,
      profileScore: rd.profileScore,
      competitors: rd.competitors,
      competitorSummary: rd.competitorSummary,
      prospectRank: rd.prospectRank
    }, null, 2)}`;
  }

  if (final?.scanResults) {
    const sr = final.scanResults;
    userMessage += `\n\nGOOGLE MAPS VISIBILITY SCAN:\n${JSON.stringify({
      visibleTop3: sr.visibleTop3,
      visibleTop10: sr.visibleTop10,
      invisible: sr.invisible,
      totalPoints: sr.totalPoints,
      percentInvisible: sr.percentInvisible,
      topCompetitor: sr.topCompetitor,
      averageRankWhereVisible: sr.averageRankWhereVisible
    }, null, 2)}`;
  }

  try {
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      system: prompts.get('systemPrompt'),
      messages: [{ role: 'user', content: userMessage }]
    });

    const message = response.content[0]?.text?.trim() || '';
    const scanUrl = `${appUrl}/scan/${sessionId}`;

    res.json({
      message,
      sessionId,
      scanUrl,
      hasResearch: !!(final?.researchData),
      hasScan: !!(final?.scanResults)
    });
  } catch (err) {
    console.error('[Generate] Claude error:', err.message);
    res.status(500).json({ error: 'Failed to generate message. Please try again.' });
  }
});

// ─── Scan Visualization ───────────────────────────────────────────────────────

app.get('/scan/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  const practiceName = session?.practiceName || 'Your Practice';
  const city = session?.city || '';
  const lat = session?.researchData?.lat || 37.7749;
  const lng = session?.researchData?.lng || -122.4194;
  const scanResults = session?.scanResults;
  res.send(buildScanPage(req.params.sessionId, practiceName, city, lat, lng, scanResults));
});

app.get('/api/scan/data/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const rd = session.researchData || {};
  const topComp = (rd.competitors || [])[0] || null;
  res.json({
    practiceName: session.practiceName,
    city: session.city,
    lat: rd.lat,
    lng: rd.lng,
    rating: rd.rating || 0,
    reviews: rd.reviews || 0,
    competitorSummary: rd.competitorSummary || '',
    topCompetitorResearch: topComp ? { name: topComp.name, rating: topComp.rating, reviews: topComp.reviews } : null,
    scanResults: session.scanResults,
    scanStatus: session.scanStatus
  });
});

// ─── Admin: Contact Monitoring ────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY) return res.status(503).send('ADMIN_KEY not configured');
  const key = req.query.key || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).send('Unauthorized');
  next();
}

app.get('/api/contacts', requireAdmin, (req, res) => {
  const all = conversations.getAll();
  const list = Object.values(all)
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    .map(c => ({
      contactId:            c.contactId,
      firstName:            c.firstName,
      city:                 c.city,
      practiceName:         c.practiceName,
      booked:               c.booked,
      currentStep:          c.currentStep,
      exchangeCount:        (c.exchanges || []).length,
      lastMessageAt:        c.lastMessageAt,
      createdAt:            c.createdAt,
      totalApiSpend:        c.totalApiSpend        || 0,
      apiSpendLimitReached: c.apiSpendLimitReached || false
    }));
  res.json(list);
});

app.get('/api/contacts/:contactId', requireAdmin, (req, res) => {
  const c = conversations.get(req.params.contactId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.post('/api/contacts/:contactId/reset-spend', requireAdmin, (req, res) => {
  const ok = spend.resetLimit(req.params.contactId);
  if (!ok) return res.status(404).json({ error: 'Contact not found' });
  res.json({ ok: true });
});

// ─── Admin: Learning Brain ────────────────────────────────────────────────────

app.get('/api/brain/stats', requireAdmin, async (req, res) => {
  const days = parseInt(req.query.days, 10) || null;
  const allContacts = conversations.getAll();

  let enrolledIds = null;
  let enrolledTotal;
  if (days) {
    const cutoff = Date.now() - days * 86400000;
    const filtered = Object.values(allContacts).filter(c => (c.createdAt || 0) >= cutoff);
    enrolledIds = new Set(filtered.map(c => c.contactId));
    enrolledTotal = enrolledIds.size;
  } else {
    enrolledTotal = Object.keys(allContacts).length;
  }

  const stats = brain.getStats(enrolledIds);

  // Fetch week-over-week snapshot delta (most recent vs ~7 days ago)
  let snapshotDelta = null;
  try {
    const snapResult = await _promptsPool.query(
      `SELECT * FROM funnel_snapshots ORDER BY taken_at DESC LIMIT 1`
    );
    const weekAgoResult = await _promptsPool.query(
      `SELECT * FROM funnel_snapshots WHERE taken_at <= NOW() - INTERVAL '6 days' ORDER BY taken_at DESC LIMIT 1`
    );
    if (snapResult.rows.length && weekAgoResult.rows.length) {
      const cur = snapResult.rows[0];
      const old = weekAgoResult.rows[0];
      snapshotDelta = {
        leads:       (cur.total_leads        - old.total_leads),
        repliedOnce: (parseFloat(cur.replied_once_pct)  - parseFloat(old.replied_once_pct)),
        replied4:    (parseFloat(cur.replied_4plus_pct) - parseFloat(old.replied_4plus_pct)),
        bookingRate: (parseFloat(cur.booking_rate_pct)  - parseFloat(old.booking_rate_pct)),
        comparedAt:  old.taken_at
      };
    }
  } catch (err) {
    // Silently skip only when the table does not exist yet (first boot before migration)
    if (!err.message.includes('funnel_snapshots')) {
      console.error('[Stats] Snapshot delta query error:', err.message);
    }
  }

  res.json({ ...stats, enrolledTotal, snapshotDelta });
});

app.post('/api/brain/analyze', requireAdmin, async (req, res) => {
  const patterns = brain.runAnalysis();
  if (Object.keys(patterns).length > 0) {
    brain.runLlmAnalysis(patterns).catch(err =>
      console.error('[Admin] LLM analysis error:', err.message)
    );
  }
  res.json({ ok: true, patterns });
});

// ─── Admin: Follow-Up Job Monitoring ─────────────────────────────────────────

app.get('/api/followups', requireAdmin, (req, res) => {
  const { status, contactId } = req.query;
  let jobs = followups.getAllJobs(status || null);
  if (contactId) jobs = jobs.filter(j => j.contactId === contactId);
  // Pending: sort soonest sendAt first. Others: most recent action first.
  if (!status || status === 'pending') {
    jobs = jobs.filter(j => j.status === 'pending').sort((a, b) => (a.sendAt || 0) - (b.sendAt || 0));
  } else {
    jobs = jobs.sort((a, b) => (b.sentAt || b.createdAt || 0) - (a.sentAt || a.createdAt || 0));
  }
  res.json(jobs.slice(0, 300));
});

app.get('/api/followups/:contactId', requireAdmin, (req, res) => {
  const jobs = followups.getContactJobs(req.params.contactId);
  res.json(jobs.sort((a, b) => b.createdAt - a.createdAt));
});

// ─── Admin: Rebuild Follow-Up Queue ──────────────────────────────────────────
// One-shot recovery endpoint for contacts whose follow-up jobs were lost
// (e.g. after a deployment that wiped the in-memory/flat-file queue).
// Only schedules jobs for contacts that genuinely need them; safe to call
// multiple times — the dedup guard in /enrolled already prevents duplicates.

app.post('/api/admin/rebuild-queue', requireAdmin, async (req, res) => {
  const allContacts  = conversations.getAll();
  const pendingJobs  = followups.getAllJobs('pending');

  // Separate sets for SMS and email so each track is deduped independently
  const pendingSmsSet   = new Set(pendingJobs.filter(j => !j.type.startsWith('email-')).map(j => j.contactId));
  const pendingEmailSet = new Set(pendingJobs.filter(j =>  j.type.startsWith('email-')).map(j => j.contactId));

  const results = { scheduledSms: [], scheduledEmail: [], skipped: [] };

  for (const contact of Object.values(allContacts)) {
    const { contactId, firstName, booked, exchanges = [] } = contact;

    if (booked) { results.skipped.push({ contactId, firstName, reason: 'booked' }); continue; }
    if (await optouts.isOptedOut(contactId)) { results.skipped.push({ contactId, firstName, reason: 'opted_out' }); continue; }

    const outbound = exchanges.filter(e => e.direction === 'outbound');
    const inbound  = exchanges.filter(e => e.direction === 'inbound');
    const tz       = followups.estimateTimezone(contact.city || '');
    const ctx      = { timezone: tz, firstName, city: contact.city || '', phone: contact.phone || '' };
    const DAY      = 24 * 60 * 60 * 1000;

    // ── SMS track ────────────────────────────────────────────────────────────
    if (outbound.length > 0 && !pendingSmsSet.has(contactId)) {
      if (inbound.length === 0) {
        // Never replied — hook 1 at next window
        const sendAt = followups.nextWindowMs(Date.now(), tz);
        followups.scheduleJob({ contactId, type: 'hook', position: 1, sendAt, context: ctx });
        results.scheduledSms.push({ contactId, firstName, sendAt: new Date(sendAt).toISOString() });
      } else {
        // Has replied — nurture in 3 days
        const sendAt = followups.nextWindowMs(Date.now() + 3 * DAY, tz);
        followups.scheduleJob({ contactId, type: 'nurture', position: 2, sendAt, context: ctx });
        results.scheduledSms.push({ contactId, firstName, sendAt: new Date(sendAt).toISOString() });
      }
      pendingSmsSet.add(contactId);
    }

    // ── Email track ──────────────────────────────────────────────────────────
    if (contact.email && outbound.length > 0 && !pendingEmailSet.has(contactId)) {
      const sendAt = followups.nextEmailWindowMs(Date.now() + 5 * 60 * 1000, tz);
      followups.scheduleJob({
        contactId, type: 'email-hook', position: 1, sendAt,
        context: { ...ctx, email: contact.email }
      });
      results.scheduledEmail.push({ contactId, firstName, email: contact.email, sendAt: new Date(sendAt).toISOString() });
      pendingEmailSet.add(contactId);
    }
  }

  const total = results.scheduledSms.length + results.scheduledEmail.length;
  console.log(`[RebuildQueue] SMS: ${results.scheduledSms.length}, Email: ${results.scheduledEmail.length}, Skipped: ${results.skipped.length}`);
  res.json({
    scheduledSms:   results.scheduledSms.length,
    scheduledEmail: results.scheduledEmail.length,
    total,
    skipped: results.skipped.length,
    detail: results
  });
});

// ─── Admin: Emergency Controls ────────────────────────────────────────────────

app.post('/api/admin/pause', requireAdmin, (req, res) => {
  followups.pauseScheduler();
  res.json({ ok: true, paused: true });
});

app.post('/api/admin/resume', requireAdmin, (req, res) => {
  followups.resumeScheduler();
  res.json({ ok: true, paused: false });
});

app.get('/api/admin/paused', requireAdmin, (req, res) => {
  res.json({ paused: followups.isPaused() });
});

app.post('/api/admin/cancel-sms-jobs', requireAdmin, (req, res) => {
  const cancelled = followups.cancelAllPendingSmsJobs();
  res.json({ ok: true, cancelled });
});

// ─── Admin: Enrollment Sync — fetch from GHL by tag, enroll missing contacts ──
app.post('/api/admin/enrollment-sync', requireAdmin, async (req, res) => {
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'tag is required' });

  let ghlContacts;
  try {
    const result = await ghl.fetchContactsByTag(tag);
    ghlContacts = result.contacts || [];
  } catch (err) {
    return res.status(500).json({ error: 'GHL fetch failed: ' + err.message });
  }

  if (ghlContacts.length === 0) {
    return res.json({ ok: true, enrolled: [], skipped: [], message: `No contacts found in GHL with tag "${tag}".` });
  }

  const enrolled = [];
  const skipped  = [];

  for (const c of ghlContacts) {
    const contactId = c.id || c.contactId;
    if (!contactId) continue;

    const firstName = c.firstName || c.first_name || '';
    const city      = c.city || c.address?.city || '';
    const phone     = c.phone || '';
    const email     = c.email || '';
    const tags      = (c.tags || []).map(t => (typeof t === 'string' ? t : t.name || '').toLowerCase());

    // Skip: Disable AI tag
    if (tags.includes('disable ai')) { skipped.push({ firstName, reason: 'disable ai tag' }); continue; }

    // Skip: already in our system — don't touch their schedule at all
    const existing = conversations.get(contactId);
    if (existing) { skipped.push({ firstName, reason: 'already in system' }); continue; }

    // Enroll
    const leadForm = parseLeadForm(tags);
    conversations.ensureContact(contactId, { firstName, city, phone, email, tags, leadForm });
    conversations.update(contactId, { email, tags, leadForm });

    const fresh = conversations.get(contactId);
    if (!fresh?.variant) {
      const assignedVariant = prompts.pickVariant(conversations.getAll());
      if (assignedVariant) conversations.update(contactId, { variant: assignedVariant });
    }

    // Fire the AI opener — same flow as the GHL enrolled webhook. The helper
    // gates DEV_MODE inside ghl.sendMessage and dedupes via the
    // `followup-hook-pos1` exchange marker, so a second sync run is safe.
    generateAndSendOpener(contactId).catch(err => {
      console.error(`[Admin] Opener task crashed for ${contactId}:`, err.message);
    });
    console.log(`[Admin] Enrollment sync: enrolled ${contactId} (${firstName}) — opener queued`);
    enrolled.push({ firstName, contactId });
  }

  res.json({ ok: true, enrolled, skipped,
    message: `Sync complete — ${enrolled.length} enrolled, ${skipped.length} skipped.` });
});

// ─── Admin: Manual enroll a single contact by GHL ID ─────────────────────────
app.post('/api/admin/manual-enroll', requireAdmin, async (req, res) => {
  const { contactId } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });

  const ghlContact = await ghl.fetchContact(contactId);
  if (!ghlContact) return res.status(404).json({ error: 'Contact not found in GHL. Check the ID and try again.' });

  const firstName = ghlContact.firstName || ghlContact.first_name || '';
  const city      = ghlContact.city || ghlContact.address?.city || '';
  const phone     = ghlContact.phone || '';
  const email     = ghlContact.email || '';
  const tags      = (ghlContact.tags || []).map(t => (typeof t === 'string' ? t : t.name || '').toLowerCase());

  if (tags.includes('disable ai')) return res.status(400).json({ error: 'Contact has "Disable AI" tag — skipping.' });

  const existing = conversations.get(contactId);
  if (existing?.booked) return res.status(400).json({ error: 'Contact is already marked as booked.' });

  const leadForm = parseLeadForm(tags);
  conversations.ensureContact(contactId, { firstName, city, phone, email, tags, leadForm });
  conversations.update(contactId, { email, tags, leadForm });

  const fresh = conversations.get(contactId);
  if (!fresh?.variant) {
    const assignedVariant = prompts.pickVariant(conversations.getAll());
    if (assignedVariant) conversations.update(contactId, { variant: assignedVariant });
  }

  const tz = followups.estimateTimezone(city);
  // Fire the AI opener (same flow as the GHL enrolled webhook).
  generateAndSendOpener(contactId).catch(err => {
    console.error(`[Admin] Manual-enroll opener task crashed for ${contactId}:`, err.message);
  });

  if (email) {
    const emailSendAt = followups.nextEmailWindowMs(Date.now() + 5 * 60 * 1000, tz);
    const hasEmail1 = followups.getAllJobs().some(
      j => j.contactId === contactId && j.type === 'email-hook' && j.position === 1 &&
           (j.status === 'pending' || j.status === 'sent')
    );
    if (!hasEmail1) followups.scheduleJob({ contactId, type: 'email-hook', position: 1, sendAt: emailSendAt, context: { timezone: tz } });
  }

  console.log(`[Admin] Manual enroll complete for ${contactId} (${firstName})`);
  res.json({ ok: true, firstName, variant: conversations.get(contactId)?.variant || null,
    message: `${firstName || contactId} enrolled — opener will send shortly.` });
});

// ─── Admin: Replay a missed inbound message ───────────────────────────────────
app.post('/api/admin/replay-inbound', requireAdmin, async (req, res) => {
  const { contactId, messageBody } = req.body || {};
  if (!contactId || !messageBody) {
    return res.status(400).json({ error: 'contactId and messageBody are required' });
  }
  res.json({ ok: true, message: 'Replay triggered — AI is generating a response now.' });
  try {
    await handleInbound({ contactId, conversationId: null, messageBody, firstName: '', city: '', phone: '' });
    console.log(`[Admin] Replay-inbound complete for ${contactId}`);
  } catch (err) {
    console.error(`[Admin] Replay-inbound error for ${contactId}:`, err.message);
  }
});

// ─── Admin: Contacts awaiting booking confirmation ────────────────────────────
// Returns contacts the AI paused ([BOOKED] marker) but that have NOT yet been
// confirmed as a real booking (no brain_messages.booked record). These are the
// prospects who verbally agreed in chat but may not have hit the calendar yet.
// Excludes contacts whose pause was triggered by the [DECLINED] rejection
// handler (paused_reason='declined') — those prospects said no, not yes.
// Legacy rows with paused_reason=NULL are still surfaced (treated as
// verbal-commit) so existing pre-feature contacts remain reviewable.
app.get('/api/admin/awaiting-confirmation', requireAdmin, (req, res) => {
  const bookedSet = brain.getBookedContactIds();
  const all = conversations.getAll();
  const awaiting = Object.values(all)
    .filter(c => c.booked && !bookedSet.has(c.contactId) && c.pausedReason !== 'declined')
    .map(c => ({ contactId: c.contactId, firstName: c.firstName || '—', city: c.city || '' }));
  res.json({ ok: true, awaiting });
});

// ─── Admin: Manually confirm a booking ───────────────────────────────────────
// Marks a contact as a REAL booking in the brain stats (counts on dashboard).
// Only valid if the contact is already in the AI-paused state (contacts.booked).
app.post('/api/admin/confirm-booking', requireAdmin, async (req, res) => {
  const { contactId } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  const contact = conversations.get(contactId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!contact.booked) return res.status(400).json({ error: 'Contact is not in a booked/paused state' });
  const alreadyConfirmed = brain.getBookedContactIds().has(contactId);
  if (alreadyConfirmed) return res.json({ ok: true, alreadyConfirmed: true, firstName: contact.firstName });
  await brain.recordBooking(contactId);
  // Promote pause reason to verbal-commit so the row is recorded as a real
  // booking (and won't drift back into the panel after a future dismiss flow).
  conversations.update(contactId, { pausedReason: 'verbal-commit' });
  console.log(`[ConfirmBooking] Admin confirmed booking for ${contact.firstName} (${contactId})`);
  res.json({ ok: true, firstName: contact.firstName });
});

// ─── Admin: Dismiss a Pending Booking Confirmation ───────────────────────────
// Used when the AI mistakenly fired [BOOKED] on a prospect who actually
// declined — flips paused_reason='declined' so the contact disappears from
// the Pending Booking Confirmations panel. The AI stays paused (booked=true
// is preserved), so no further messages will be sent to this contact.
app.post('/api/admin/dismiss-booking', requireAdmin, (req, res) => {
  const { contactId } = req.body || {};
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });
  const contact = conversations.get(contactId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!contact.booked) return res.status(400).json({ error: 'Contact is not in a paused state' });
  conversations.update(contactId, { pausedReason: 'declined' });
  console.log(`[DismissBooking] Admin dismissed false-positive booking for ${contact.firstName} (${contactId}) — paused_reason=declined`);
  res.json({ ok: true, firstName: contact.firstName });
});

app.post('/api/admin/backfill-bookings', requireAdmin, async (req, res) => {
  const CALENDAR_IDS = [
    'TEJPVxOMR0rrTwxgavfc','lLa9R176JhNHeXrmyhc4','xadAGwKudYEsVjbEYR0n',
    'MyGuztNviyIdbDNs1Ob3','ZvP8hfJ2Xr5Srit8aLA7','bZbSTcLeFll9JYTrjYnN',
    '81R5ud9u96dv67Ni56yS','sseQg8YjNlyg5T66AjOV'
  ];
  const ghlHeaders = {
    'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
    'Version': '2021-04-15'
  };

  const bookedContactIds = new Set();
  for (const calId of CALENDAR_IDS) {
    try {
      const r = await fetch(
        `https://services.leadconnectorhq.com/calendars/events?calendarId=${calId}&locationId=${process.env.GHL_LOCATION_ID}&startTime=1704067200000&endTime=1798761600000`,
        { headers: ghlHeaders }
      );
      if (!r.ok) continue;
      const data = await r.json();
      for (const ev of data.events || []) {
        if (ev.contactId && ev.appointmentStatus !== 'cancelled') {
          bookedContactIds.add(ev.contactId);
        }
      }
    } catch (_) {}
  }

  const results = { booked: [], alreadyBooked: [], notInSystem: [] };
  for (const contactId of bookedContactIds) {
    const contact = conversations.get(contactId);
    if (!contact) { results.notInSystem.push(contactId); continue; }
    if (contact.booked) { results.alreadyBooked.push({ contactId, firstName: contact.firstName }); continue; }
    conversations.update(contactId, { booked: true });
    brain.recordBooking(contactId);
    results.booked.push({ contactId, firstName: contact.firstName });
    console.log(`[BackfillBookings] Marked ${contact.firstName} (${contactId}) as booked`);
  }

  res.json({ ok: true, ...results });
});

// ─── Admin: Opt-Out Blocklist ──────────────────────────────────────────────────

app.get('/api/optouts', requireAdmin, async (req, res) => {
  res.json(await optouts.getAll());
});

// ─── Admin: Dashboard ─────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).send('ADMIN_KEY not configured');
  const key = req.query.key || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_KEY to the URL.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildAdminDashboardPage(key));
});

// ─── Admin: Prompt Editor ─────────────────────────────────────────────────────

app.get('/admin/prompts', (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).send('ADMIN_KEY not configured');
  const key = req.query.key || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_KEY to the URL.');
  }
  const all = prompts.listAll();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.send(buildPromptEditorPage(key, all));
});

app.post('/admin/prompts/:name/reset', requireAdmin, (req, res) => {
  const { name } = req.params;
  try {
    prompts.reset(name);
    res.json({ ok: true, name, text: prompts.getDefault(name) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/admin/prompts/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  const { text } = req.body;
  console.log(`[Prompts] Save request — name=${name}, textLength=${typeof text === 'string' ? text.length : 'missing'}`);
  if (typeof text !== 'string') return res.status(400).json({ error: 'text field required' });
  try {
    prompts.set(name, text);
    // Also persist to DB so the save survives redeployments
    prompts.syncToDb(_promptsPool, name, text).catch(err =>
      console.error(`[Prompts] DB write failed for ${name}:`, err.message)
    );
    console.log(`[Prompts] Saved ${name} (${text.length} chars)`);
    res.json({ ok: true, name, length: text.length });
  } catch (err) {
    console.error(`[Prompts] Save failed for ${name}:`, err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── Admin: Variant Backfill ──────────────────────────────────────────────────

app.post('/api/admin/backfill-variants', requireAdmin, (req, res) => {
  const all = conversations.getAll();
  const unassigned = Object.entries(all).filter(([, c]) => !c.variant);
  if (unassigned.length === 0) return res.json({ ok: true, assigned: 0, message: 'All contacts already have variants' });

  const variants = ['A', 'B', 'C', 'D'];
  // Count current assignments to continue the round-robin fairly
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const c of Object.values(all)) {
    if (c.variant && counts[c.variant] !== undefined) counts[c.variant]++;
  }

  let assigned = 0;
  for (const [contactId] of unassigned) {
    // Always pick the variant with the fewest contacts
    const next = variants.slice().sort((a, b) => counts[a] - counts[b])[0];
    conversations.update(contactId, { variant: next });
    counts[next]++;
    assigned++;
  }

  console.log(`[Variants] Backfilled ${assigned} contacts. Distribution: A=${counts.A} B=${counts.B} C=${counts.C} D=${counts.D}`);
  res.json({ ok: true, assigned, distribution: counts });
});

// ─── Admin: Variant Reset (one-time clean slate) ─────────────────────────────

app.post('/api/admin/reset-variants', requireAdmin, async (req, res) => {
  try {
    // 1. Clear in-memory cache
    const all = conversations.getAll();
    let memCleared = 0;
    for (const [contactId, c] of Object.entries(all)) {
      if (c.variant) {
        conversations.update(contactId, { variant: null });
        memCleared++;
      }
    }

    // 2. Clear variant on contacts in DB
    const cResult = await _promptsPool.query('UPDATE contacts SET variant = NULL');
    const bResult = await _promptsPool.query('UPDATE brain_messages SET variant = NULL');

    // 3. Clear variantStats from winning_patterns
    const wpRow = await _promptsPool.query("SELECT data FROM winning_patterns WHERE key = 'main'");
    if (wpRow.rows.length > 0) {
      let patterns = JSON.parse(wpRow.rows[0].data);
      if (patterns.variantStats) {
        delete patterns.variantStats;
        await _promptsPool.query(
          "UPDATE winning_patterns SET data = $1, updated_at = $2 WHERE key = 'main'",
          [JSON.stringify(patterns), Date.now()]
        );
      }
    }

    console.log(`[Variants] Reset complete. Contacts cleared: ${cResult.rowCount}, Brain messages cleared: ${bResult.rowCount}`);
    res.json({
      ok: true,
      contactsCleared: cResult.rowCount,
      brainMessagesCleared: bResult.rowCount,
      message: 'Variant assignments wiped. New contacts will be assigned variants from enrollment.'
    });
  } catch (err) {
    console.error('[Variants] Reset failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Variant Enable/Disable ────────────────────────────────────────────

app.post('/admin/variants/:variant/enabled', requireAdmin, (req, res) => {
  const { variant } = req.params;
  if (!['A', 'B', 'C', 'D'].includes(variant)) return res.status(400).json({ error: 'Invalid variant. Must be A, B, C, or D.' });
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled field must be a boolean.' });
  try {
    prompts.setVariantEnabled(variant, enabled);
    prompts.syncToDb(_promptsPool, `conversationPrompt.${variant}.enabled`, enabled ? 'true' : 'false')
      .catch(err => console.error(`[Variants] DB write failed for ${variant}.enabled:`, err.message));
    console.log(`[Variants] Variant ${variant} ${enabled ? 'enabled' : 'disabled'}`);
    res.json({ ok: true, variant, enabled });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/brain/variants', requireAdmin, (req, res) => {
  try {
    const enabledList = prompts.getEnabledVariants();
    const allContacts = conversations.getAll();

    // Optional Lead Form filter — when provided, only contacts whose
    // current `leadForm` matches are counted. Used by the Variant Performance
    // view to compare variants within a specific GHL lead form.
    const leadFormFilter = (req.query.leadForm || '').toString().trim().toLowerCase() || null;

    const counts = { A: { assigned: 0, repliedOnce: 0, replied4: 0, booked: 0 },
                     B: { assigned: 0, repliedOnce: 0, replied4: 0, booked: 0 },
                     C: { assigned: 0, repliedOnce: 0, replied4: 0, booked: 0 },
                     D: { assigned: 0, repliedOnce: 0, replied4: 0, booked: 0 } };

    // Track which lead forms are present in the data so the dashboard can
    // render filter chips dynamically (no hard-coded form list).
    const leadFormSet = new Set();

    // Real-bookings source-of-truth — only contacts confirmed by the GHL
    // appointment webhook (or the manual admin backfill) appear here. The
    // AI's [BOOKED] marker pauses the AI but does NOT count for stats.
    const bookedSet = brain.getBookedContactIds();

    for (const c of Object.values(allContacts)) {
      const cForm = c.leadForm || 'unknown';
      leadFormSet.add(cForm);
      if (leadFormFilter && cForm !== leadFormFilter) continue;
      if (!c.variant || !counts[c.variant]) continue;
      const vc = counts[c.variant];
      vc.assigned++;
      const inbound = (c.exchanges || []).filter(e => e.direction === 'inbound').length;
      if (inbound >= 1) vc.repliedOnce++;
      if (inbound >= 4) vc.replied4++;
      if (bookedSet.has(c.contactId)) vc.booked++;
    }

    const pct = (n, d) => d > 0 ? Math.round((n / d) * 100) : null;

    const variants = ['A', 'B', 'C', 'D'].map(v => {
      const vc = counts[v];
      return {
        variant:          v,
        enabled:          enabledList.includes(v),
        contactsAssigned: vc.assigned,
        repliedOncePct:   pct(vc.repliedOnce, vc.assigned),
        replied4Pct:      pct(vc.replied4,    vc.assigned),
        bookingRatePct:   pct(vc.booked,      vc.assigned)
      };
    });

    res.json({
      ok: true,
      variants,
      leadForms:        Array.from(leadFormSet).sort(),
      leadFormFilter
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Conversation Tester (Playground) ──────────────────────────────────
// In-memory chat sandbox. Lets you talk to the AI as a fake prospect using any
// variant prompt (A/B/C). Reuses the SAME prompt-building + Claude pipeline
// production uses, but writes NOTHING to the DB, GHL, brain stats, or scheduler.
// Sessions live in memory only and are cleared on server restart.

const _playgroundSessions = new Map(); // sessionId → { variant, firstName, city, currentStep, messages: [{role,content}], createdAt }
const _PLAYGROUND_MAX_SESSIONS = 50;
const _PLAYGROUND_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function _evictPlaygroundSession(id) {
  const s = _playgroundSessions.get(id);
  if (s?.realScanKey) {
    try { sessions.del(s.realScanKey); } catch {}
  }
  _playgroundSessions.delete(id);
}

function _gcPlaygroundSessions() {
  const cutoff = Date.now() - _PLAYGROUND_SESSION_TTL_MS;
  for (const [id, s] of _playgroundSessions) {
    if ((s.lastActivityAt || s.createdAt) < cutoff) _evictPlaygroundSession(id);
  }
  // Also cap total sessions
  if (_playgroundSessions.size > _PLAYGROUND_MAX_SESSIONS) {
    const sorted = [..._playgroundSessions.entries()].sort((a, b) => (a[1].lastActivityAt || a[1].createdAt) - (b[1].lastActivityAt || b[1].createdAt));
    const toRemove = sorted.slice(0, _playgroundSessions.size - _PLAYGROUND_MAX_SESSIONS);
    for (const [id] of toRemove) _evictPlaygroundSession(id);
  }
}

app.get('/admin/playground', (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).send('ADMIN_KEY not configured');
  const key = req.query.key || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_KEY to the URL.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.send(buildPlaygroundPage(key));
});

app.post('/admin/playground/reset', requireAdmin, (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  _evictPlaygroundSession(sessionId);
  res.json({ ok: true });
});

// ── Playground helpers (shared by /message and /start) ─────────────────────
function _buildPlaygroundSystemPrompt(session) {
  let systemContent;
  if (session.variant === 'CUSTOM') {
    systemContent = String(session.customPrompt || '').trim();
  } else {
    const variantPromptKey = `conversationPrompt.${session.variant}`;
    systemContent = prompts.get(variantPromptKey) || prompts.get('conversationPrompt');
  }
  if (session.firstName) systemContent += `\n\nPROSPECT FIRST NAME: ${session.firstName}`;
  if (session.city)      systemContent += `\n\nPROSPECT CITY: ${session.city}`;
  systemContent += `\n\nCURRENT STEP: ${session.currentStep} (continue from here)`;

  const stage = brain.classifyStage(session.currentStep);
  const winningSnippet = brain.buildWinningPatternsPrompt(stage, 'sms_scripted');
  if (winningSnippet) systemContent += winningSnippet;

  // Mirror production: once the practice has been confirmed, attach synthetic
  // research + scan data so the AI can produce an authentic data-reveal turn.
  // Real production data comes from Google Places + an internal scan; the
  // playground uses plausible stub values so testers can exercise the flow
  // end-to-end without burning real API quota.
  if (session.researchData) {
    systemContent += `\n\nLIVE RESEARCH DATA:\n${JSON.stringify(session.researchData, null, 2)}`;
  }
  if (session.scanResults) {
    systemContent += `\n\nSCAN RESULTS:\n${JSON.stringify(session.scanResults, null, 2)}`;
  }
  return systemContent;
}

// Mirror production's PRACTICE_DETECTED handler for the playground. Returns
// either:
//   { confirmationMsg }                   → emit confirmation, await yes/no
//   { skipConfirmation: true }            → no name/key/result; behave like
//                                           live flow which skips the
//                                           confirmation step and proceeds
// Either way, sets practiceName/confirmationPending on the session so the
// next reply can be routed correctly.
async function _playgroundLookupPractice(rawValue, session) {
  const parts = String(rawValue || '').split('|').map(s => s.trim());
  const practiceName = parts[0] || '';
  const practiceStreet = parts[1] || '';
  const practiceCity = parts[2] || session.city || '';

  // Defensive: a marker with no usable name should not produce a
  // malformed "Found  at ..." bubble. Mirror live flow's "no result"
  // branch and skip confirmation entirely.
  if (!practiceName) return { skipConfirmation: true };

  const apiKey = process.env.GOOGLE_PLACES_KEY;
  let confirmName = practiceName;
  let confirmAddress = '';
  let placesHit = false;

  let confirmPlaceId = null;
  if (apiKey) {
    try {
      const searchQuery = [practiceName, practiceStreet, practiceCity].filter(Boolean).join(' ');
      const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&key=${apiKey}`;
      const placesRes = await fetch(placesUrl);
      const placesData = await placesRes.json();
      const topResult = (placesData.results || [])[0];
      if (topResult) {
        confirmName = topResult.name || practiceName;
        confirmAddress = topResult.formatted_address || topResult.vicinity || '';
        confirmPlaceId = topResult.place_id || null;
        placesHit = true;
      }
    } catch (err) {
      console.error('[Playground] Places lookup error:', err.message);
    }
  }

  session.practiceName = confirmName;

  // Live behavior: when the lookup misses (no key or no result), the
  // server skips the confirmation step and lets the Step-N data reveal
  // proceed. Mirror that here so the playground doesn't sit waiting on
  // a yes/no that production would never demand.
  if (!placesHit) return { skipConfirmation: true };

  session.confirmationPending = { name: confirmName, address: confirmAddress, city: practiceCity, placeId: confirmPlaceId };
  const confirmationMsg = confirmAddress
    ? `Found ${confirmName} at ${confirmAddress} — is that the right one?`
    : `Found ${confirmName} — is that the right one?`;
  return { confirmationMsg };
}

// Match the regexes used by handleConfirmationReply so the playground's
// state machine recognises the same affirmative/negative/ambiguous reply
// shapes that production does.
function _playgroundIsAffirmative(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return /^(yes|yea|yeah|yep|yup|ya|ye|correct|right|that('s| is)( it| right| the one| us| ours| mine)?|thats (it|right|correct|us|ours)|sure|exactly|affirmative|absolutely|definitely|for sure|sounds (right|good|correct)|looks (right|good|correct)|ok(ay)?|y|100)\b/.test(t);
}
function _playgroundIsNegative(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return /^(no|nope|not (quite|right|that one|it)|wrong|different|nah|incorrect)\b/.test(t) || t === 'n';
}

function _playgroundSeedScanData(session) {
  const name = session.practiceName || 'Your Practice';
  const city = session.confirmationPending?.city || session.city || 'your area';
  const competitorName = `${city.split(',')[0]} Hearing Center`;
  session.researchData = {
    practiceName: name,
    reviews: 27,
    rating: 4.6,
    competitors: [competitorName, 'Premier Audiology', 'Beltone'],
    competitorSummary: `${competitorName} has 4× your review count and ranks #1 in 14/15 nearby searches.`,
    prospectRank: 5
  };
  session.scanResults = {
    visibleTop3: 3,
    invisible: 12,
    totalPoints: 15,
    topCompetitor: competitorName,
    averageRankWhereVisible: 7
  };
}

// Fires the real research + scan pipeline for a playground session, mirroring
// what production's startResearchAndScan does for a live contact. Namespaces
// the underlying sessions-module key with a `pg_` prefix so tester traffic
// can never collide with real GHL contact ids. Idempotent: a session that
// already has a scan in flight or completed data short-circuits.
function _playgroundFireRealScan(session) {
  if (session.scanInFlight) return;
  if (session.researchData && session.scanResults) return;

  const playgroundKey = session.realScanKey
    || `pg_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
  session.realScanKey = playgroundKey;

  const practiceName = session.practiceName || 'Unknown';
  const practiceCity = session.confirmationPending?.city || session.city || '';
  const placeId = session.confirmationPending?.placeId || null;

  console.log(`[Playground] Starting real scan for "${practiceName}" in ${practiceCity || 'unknown city'} (key=${playgroundKey}, placeId=${placeId || 'none'})`);

  sessions.set(playgroundKey, {
    sessionId: playgroundKey,
    practiceName,
    practiceStreet: '',
    city: practiceCity,
    researchStatus: 'idle',
    scanStatus: 'idle',
    researchData: null,
    scanResults: null,
    createdAt: Date.now()
  });

  const sessionObj = { sessionId: playgroundKey };

  // Track real-pipeline outcomes separately from session.researchData /
  // scanResults so that a later seed fallback (on timeout) can never
  // retroactively flip scanStatus to 'complete'.
  session.realResearchOk = false;
  session.realScanOk = false;

  const researchPromise = runResearch(sessionObj, practiceName, '', practiceCity, placeId)
    .then(() => {
      const s = sessions.get(playgroundKey);
      if (s?.researchData) {
        session.researchData = s.researchData;
        session.realResearchOk = true;
        console.log(`[Playground] Research complete for ${practiceName}: reviews=${s.researchData.reviews} rating=${s.researchData.rating} competitors=${(s.researchData.competitors || []).length}`);
      } else {
        console.warn(`[Playground] Research returned no data for ${practiceName}`);
      }
    })
    .catch(err => console.error('[Playground] Research error:', err.message));

  const scanPromise = startScan(sessionObj, practiceName, practiceCity, config.scanKeyword)
    .then(() => {
      const s = sessions.get(playgroundKey);
      if (s?.scanResults) {
        session.scanResults = s.scanResults;
        session.realScanOk = true;
        const top = s.scanResults.topCompetitor;
        const topName = top && typeof top === 'object' ? top.name : top;
        console.log(`[Playground] Scan complete for ${practiceName}: visibleTop3=${s.scanResults.visibleTop3} invisible=${s.scanResults.invisible}/${s.scanResults.totalPoints} top=${topName || 'n/a'}`);
      } else {
        console.warn(`[Playground] Scan returned no results for ${practiceName}`);
      }
    })
    .catch(err => console.error('[Playground] Scan error:', err.message));

  session.scanStatus = 'running';
  const inFlight = Promise.all([researchPromise, scanPromise]).finally(() => {
    // Only update status from this finally if the await side hasn't already
    // detached us on timeout. Use a sentinel on the promise to know "is this
    // still the current in-flight scan?" — if the await reassigned
    // scanInFlight to null, leave its terminal status alone.
    if (session.scanInFlight === inFlight) {
      session.scanInFlight = null;
      session.scanStatus = (session.realResearchOk && session.realScanOk) ? 'complete' : 'failed';
    }
    // Free the temporary sessions-module entry — tester scans don't need to
    // outlive the request that fired them. The data we care about is already
    // copied onto the playground session above.
    try { sessions.del(playgroundKey); } catch {}
  });
  session.scanInFlight = inFlight;
}

// Awaits an in-flight playground scan with a hard timeout so a slow Google
// Places call can never indefinitely block a Claude turn. On timeout or scan
// failure, falls back to seed data so the conversation can still continue —
// matches the live system's "no data → scripted language only" behavior.
async function _playgroundAwaitScanIfRunning(session, timeoutMs = 30000) {
  // Already have data of any kind — nothing to wait on.
  if (session.researchData && session.scanResults) return;
  // STUB mode: do NOT pre-seed. Stub seeding happens on the same paths the
  // production flow uses — affirmative confirmation (line ~2430) and the
  // retry-name lookup-miss fallback (line ~2485). The only case where we
  // need to seed here is if a real scan was in flight and the user flipped
  // the Stub toggle mid-flow — then we drop the in-flight promise and seed
  // so the conversation can continue. Otherwise just return and let the
  // confirmation-path seeding handle it.
  if (session.useRealScan === false) {
    if (session.scanInFlight) {
      _playgroundSeedScanData(session);
      if (session.scanStatus !== 'failed') session.scanStatus = null;
      session.scanInFlight = null;
    }
    return;
  }
  if (!session.scanInFlight) return;

  const TIMEOUT = Symbol('scan-timeout');
  const result = await Promise.race([
    session.scanInFlight.then(() => null),
    new Promise(resolve => setTimeout(() => resolve(TIMEOUT), timeoutMs))
  ]);
  if (result === TIMEOUT) {
    console.warn(`[Playground] Scan await timed out after ${timeoutMs}ms — detaching and falling back to seed`);
    // Detach so subsequent turns don't re-await this still-pending promise.
    // The background promise will keep running but its .finally will see the
    // ownership change and skip overwriting the failed status.
    session.scanInFlight = null;
    session.scanStatus = 'failed';
  }
  if (!session.researchData || !session.scanResults) {
    console.log('[Playground] Real scan produced no data — using seed fallback so conversation can continue');
    _playgroundSeedScanData(session);
    session.scanStatus = 'failed';
  }
}

function _extractPlaygroundMarkers(text, session) {
  const markers = [];
  let display = text;
  const stepMatch = display.match(/\[STEP:(\d+)\]/i);
  if (stepMatch) {
    const detectedStep = parseInt(stepMatch[1], 10);
    session.currentStep = detectedStep;
    markers.push({ type: 'STEP', value: detectedStep });
    display = display.replace(/\[STEP:\d+\]\s*/gi, '').trim();
  }
  const practiceMatch = display.match(/\[PRACTICE_DETECTED:([^\]]+)\]/i);
  if (practiceMatch) {
    markers.push({ type: 'PRACTICE_DETECTED', value: practiceMatch[1] });
    display = display.replace(/\[PRACTICE_DETECTED:[^\]]+\]\s*/i, '').trim();
  }
  if (display.includes('[BOOKED]')) {
    markers.push({ type: 'BOOKED', value: true });
    display = display.replace(/\[BOOKED\]\s*/gi, '').trim();
  }
  if (display.includes('[DECLINED]')) {
    markers.push({ type: 'DECLINED', value: true });
    display = display.replace(/\[DECLINED\]\s*/gi, '').trim();
  }
  return { display, markers };
}

const _PLAYGROUND_CUSTOM_PROMPT_MAX = 50_000;
function _normalizePlaygroundVariant(variant, customPrompt) {
  const v = (variant || 'A').toUpperCase();
  const trimmedCustom = String(customPrompt || '').trim();

  // Per the task contract: when customPrompt is present and non-empty, use it
  // as the system prompt regardless of the variant field. variant === 'CUSTOM'
  // requires a non-empty customPrompt; otherwise variant must be A/B/C.
  if (trimmedCustom) {
    if (trimmedCustom.length > _PLAYGROUND_CUSTOM_PROMPT_MAX) {
      return { error: `customPrompt is too long (max ${_PLAYGROUND_CUSTOM_PROMPT_MAX} chars)` };
    }
    return { variant: 'CUSTOM', customPrompt: trimmedCustom };
  }
  if (v === 'CUSTOM') return { error: 'customPrompt is required when variant is CUSTOM' };
  if (!['A', 'B', 'C', 'D'].includes(v)) return { error: 'variant must be A, B, C, D, or CUSTOM' };
  return { variant: v };
}

function _calcPlaygroundCost(usage) {
  try {
    const tokenCost = (usage?.input_tokens || 0) * 3 / 1_000_000
                   + (usage?.output_tokens || 0) * 15 / 1_000_000;
    return Math.round(tokenCost * 10000) / 10000;
  } catch { return null; }
}

app.post('/admin/playground/message', requireAdmin, async (req, res) => {
  try {
    _gcPlaygroundSessions();

    const { sessionId, message, variant, customPrompt, firstName, city, useRealScan } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });

    // For existing sessions, only validate/apply variant fields if the caller
    // actually sent them. This preserves the prior session.variant when a
    // non-UI caller omits both fields (the in-page client always sends both,
    // so this is purely defensive).
    const variantFieldsSent = variant !== undefined || customPrompt !== undefined;
    let norm = null;
    let session = _playgroundSessions.get(sessionId);

    if (!session || variantFieldsSent) {
      norm = _normalizePlaygroundVariant(variant, customPrompt);
      if (norm.error) return res.status(400).json({ error: norm.error });
    }

    if (!session) {
      session = {
        variant: norm.variant,
        customPrompt: norm.customPrompt || '',
        firstName: (firstName || 'Test').trim() || 'Test',
        city: (city || '').trim(),
        useRealScan: useRealScan !== false, // default true
        currentStep: 0,
        messages: [],
        createdAt: Date.now()
      };
      _playgroundSessions.set(sessionId, session);
      // Enforce strict cap after insert so we never exceed the maximum
      _gcPlaygroundSessions();
    } else {
      // Allow swapping variant or contact info mid-session. When variant
      // fields were sent, honor the normalized result (so a request supplying
      // only `customPrompt` correctly flips into CUSTOM mode).
      if (variantFieldsSent) {
        session.variant = norm.variant;
        if (norm.variant === 'CUSTOM') session.customPrompt = norm.customPrompt;
      }
      if (firstName !== undefined) session.firstName = (firstName || 'Test').trim() || 'Test';
      if (city !== undefined) session.city = (city || '').trim();
      if (useRealScan !== undefined) session.useRealScan = useRealScan !== false;
    }
    session.lastActivityAt = Date.now();

    // Append user message to history
    session.messages.push({ role: 'user', content: message });

    // ── Production-parity confirmation state machine ──
    // When confirmationPending or awaitingRetryName is set, intercept the
    // reply BEFORE calling Claude — exactly as live handleInbound routes
    // these to handleConfirmationReply / handleRetryName. This keeps
    // playground behavior deterministic and matches live SMS flow.
    if (session.confirmationPending) {
      if (_playgroundIsNegative(message)) {
        const denied = "No problem — what's the exact name as it appears on Google Maps, and what street is it on?";
        session.confirmationPending = null;
        session.awaitingRetryName = true;
        session.messages.push({ role: 'assistant', content: denied });
        return res.json({
          ok: true,
          reply: denied,
          raw: denied,
          markers: [],
          extraMessages: [],
          currentStep: session.currentStep,
          variant: session.variant,
          tokenUsage: { input: 0, output: 0 },
          elapsedMs: 0,
          estCost: 0,
          scanStatus: session.scanStatus || null,
          awaitingConfirmReply: false,
          systemPromptPreview: '(intercepted: confirmation denied)'
        });
      }
      if (_playgroundIsAffirmative(message)) {
        if (session.useRealScan) {
          // Kick off the real research + scan pipeline in the background.
          // This turn's Claude reply is the Step 4 question (which doesn't
          // need scan data), so we deliberately do NOT await — that keeps
          // the Send button responsive instead of blocking 10–20s here.
          // The scan runs while the user is typing their answer to Step 4;
          // by the next /message turn it's almost always already complete,
          // and that turn awaits below before generating the data reveal.
          _playgroundFireRealScan(session);
          session.scanKickedOffThisTurn = true;
        } else {
          _playgroundSeedScanData(session);
        }
        session.confirmationPending = null;
        // Fall through to normal Claude call so it produces the data reveal.
      } else {
        const reprompt = "Just want to make sure — is that your practice listing? Reply yes or no.";
        session.messages.push({ role: 'assistant', content: reprompt });
        return res.json({
          ok: true,
          reply: reprompt,
          raw: reprompt,
          markers: [],
          extraMessages: [],
          currentStep: session.currentStep,
          variant: session.variant,
          tokenUsage: { input: 0, output: 0 },
          elapsedMs: 0,
          estCost: 0,
          scanStatus: session.scanStatus || null,
          // Still waiting on a yes/no — keep the scan indicator armed.
          awaitingConfirmReply: true,
          systemPromptPreview: '(intercepted: confirmation re-prompt)'
        });
      }
    } else if (session.awaitingRetryName) {
      // Mirror handleRetryName: treat the reply as the corrected practice
      // name and re-run the lookup.
      session.awaitingRetryName = false;
      const retryMarker = `${message.trim()}||${session.city || ''}`;
      const retry = await _playgroundLookupPractice(retryMarker, session);
      if (retry.confirmationMsg) {
        session.messages.push({ role: 'assistant', content: retry.confirmationMsg });
        return res.json({
          ok: true,
          reply: retry.confirmationMsg,
          raw: retry.confirmationMsg,
          markers: [],
          extraMessages: [],
          currentStep: session.currentStep,
          variant: session.variant,
          tokenUsage: { input: 0, output: 0 },
          elapsedMs: 0,
          estCost: 0,
          scanStatus: session.scanStatus || null,
          // Re-armed: a fresh confirmation just landed, the next user reply
          // will trigger the real scan (when the toggle is on).
          awaitingConfirmReply: true,
          systemPromptPreview: '(intercepted: retry confirmation)'
        });
      }
      // Lookup missed on the retry — production flow drops the
      // confirmation step entirely, so seed scan data and let Claude
      // continue. We deliberately do NOT fire a real scan here because
      // there's no affirmative-confirmation signal that the operator
      // actually wants Maps data for this practice.
      _playgroundSeedScanData(session);
    }

    // Block the Claude call until any in-flight real scan finishes — but
    // ONLY on follow-up turns. The turn that fired the scan (the
    // affirmative-confirm "yes" reply) generates the Step 4 question,
    // which doesn't need scan data; awaiting there would lock the Send
    // button for 10–20s. By the next turn the scan is almost always done,
    // and that's the turn whose data reveal needs the real numbers.
    if (session.scanKickedOffThisTurn) {
      session.scanKickedOffThisTurn = false;
    } else {
      await _playgroundAwaitScanIfRunning(session);
    }

    // ── Build system prompt — mirrors the live handleInbound pipeline ──
    const systemContent = _buildPlaygroundSystemPrompt(session);

    // Anthropic requires the first message to be role:user. After /start,
    // session.messages begins with the assistant opener — prepend a synthetic
    // trigger user-message for the API call only (not stored in history).
    const apiMessages = session.messages[0]?.role === 'assistant'
      ? [{ role: 'user', content: 'Begin the conversation.' }, ...session.messages]
      : session.messages;

    // ── Call Claude ──
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const t0 = Date.now();
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      system: systemContent,
      messages: apiMessages
    });
    const elapsedMs = Date.now() - t0;

    const raw = response.content[0]?.text?.trim() || '';
    const { display, markers } = _extractPlaygroundMarkers(raw, session);

    // Append assistant message to history (use display version so future turns
    // don't re-include markers — same as production behavior, which strips them
    // before storing in conversations.addExchange)
    session.messages.push({ role: 'assistant', content: display });

    // Production-parity simulation: if the AI emitted [PRACTICE_DETECTED],
    // the live webhook follows up with a Google Places address-confirmation
    // message before continuing. Do the same here so the playground doesn't
    // appear to "freeze" after the bridge ("Pulling up your listing now.").
    let extraMessages = [];
    const detectedMarker = markers.find(m => m.type === 'PRACTICE_DETECTED');
    if (detectedMarker) {
      try {
        const lookup = await _playgroundLookupPractice(detectedMarker.value, session);
        if (lookup.confirmationMsg) {
          // Anthropic disallows consecutive same-role messages, so merge
          // the synthetic confirmation into the prior assistant turn for
          // conversation history. The UI still renders it as a separate
          // bubble via extraMessages so it visually matches live SMS.
          const last = session.messages[session.messages.length - 1];
          if (last && last.role === 'assistant') {
            last.content = `${last.content}\n\n${lookup.confirmationMsg}`.trim();
          } else {
            session.messages.push({ role: 'assistant', content: lookup.confirmationMsg });
          }
          extraMessages.push({
            reply: lookup.confirmationMsg,
            source: 'system_confirmation',
            meta: 'system · address confirmation'
          });
        } else if (lookup.skipConfirmation) {
          // No key, no result, or empty marker — match live flow which
          // skips the confirmation step. Without an affirmative-confirm
          // signal we have no go-ahead to burn real Google Places API
          // credits, so always seed here regardless of the toggle. Real
          // scans only ever fire after the operator says yes.
          _playgroundSeedScanData(session);
        }
      } catch (err) {
        console.error('[Playground] Confirmation simulation error:', err.message);
      }
    }

    const awaitingConfirmReply = extraMessages.some(m => m.source === 'system_confirmation');

    res.json({
      ok: true,
      reply: display,
      raw,
      markers,
      extraMessages,
      currentStep: session.currentStep,
      variant: session.variant,
      tokenUsage: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0
      },
      elapsedMs,
      estCost: _calcPlaygroundCost(response.usage),
      scanStatus: session.scanStatus || null,
      awaitingConfirmReply,
      systemPromptPreview: systemContent.slice(0, 500) + (systemContent.length > 500 ? '…' : '')
    });
  } catch (err) {
    console.error('[Playground] Error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// Generates the AI's opening message — simulates what the live system will
// do on lead enrollment once the AI-first-enrollment flow ships. Resets the
// session, calls Claude with a single trigger user-message, and seeds the
// session with the resulting opener as the assistant's first turn.
app.post('/admin/playground/start', requireAdmin, async (req, res) => {
  try {
    _gcPlaygroundSessions();

    const { sessionId, variant, customPrompt, firstName, city, useRealScan } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const norm = _normalizePlaygroundVariant(variant, customPrompt);
    if (norm.error) return res.status(400).json({ error: norm.error });

    // Always reset the session — Start represents a brand-new conversation.
    // Evict any prior session under this id (and its real-scan side-data)
    // so a fresh Start never inherits stale researchData / scanResults.
    _evictPlaygroundSession(sessionId);
    const session = {
      variant: norm.variant,
      customPrompt: norm.customPrompt || '',
      firstName: (firstName || 'Test').trim() || 'Test',
      city: (city || '').trim(),
      useRealScan: useRealScan !== false, // default true
      currentStep: 0,
      messages: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now()
    };
    _playgroundSessions.set(sessionId, session);
    _gcPlaygroundSessions();

    const systemContent = _buildPlaygroundSystemPrompt(session);

    // Single trigger message — Anthropic API requires a non-empty messages
    // array, so we send a minimal "begin" instruction for this call only. We
    // do NOT persist this trigger in session.messages so the rest of the
    // conversation reflects what the prospect actually sees: assistant opener,
    // then user replies. The /message endpoint detects the assistant-first
    // case and prepends a synthetic trigger for subsequent API calls.
    const triggerMessage = 'Begin the conversation now. Generate only the opening SMS message you would send to start the conversation.';
    const triggerMessages = [{ role: 'user', content: triggerMessage }];

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const t0 = Date.now();
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      system: systemContent,
      messages: triggerMessages
    });
    const elapsedMs = Date.now() - t0;

    const raw = response.content[0]?.text?.trim() || '';
    const { display, markers } = _extractPlaygroundMarkers(raw, session);

    // Seed only the assistant opener — the trigger user-message stays out of
    // history so the conversation accurately reflects what the prospect sees.
    session.messages.push({ role: 'assistant', content: display });

    res.json({
      ok: true,
      reply: display,
      raw,
      markers,
      currentStep: session.currentStep,
      variant: session.variant,
      tokenUsage: {
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0
      },
      elapsedMs,
      estCost: _calcPlaygroundCost(response.usage),
      systemPromptPreview: systemContent.slice(0, 500) + (systemContent.length > 500 ? '…' : '')
    });
  } catch (err) {
    console.error('[Playground] Start error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// ─── Admin: Lead Enrollment ───────────────────────────────────────────────────

app.get('/admin/enroll', (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).send('ADMIN_KEY not configured');
  const key = req.query.key || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).send('Unauthorized. Add ?key=YOUR_ADMIN_KEY to the URL.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.send(buildEnrollPage(key));
});

// ─── Enrollment Background Jobs ───────────────────────────────────────────────
// Runs in-process so proxy timeouts don't matter. Jobs expire after 10 minutes.
const _enrollJobs = new Map(); // jobId → { status, result, error, expiresAt }

function _makeJobId() {
  return `ej-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function _gcJobs() {
  const now = Date.now();
  for (const [id, job] of _enrollJobs) if (job.expiresAt < now) _enrollJobs.delete(id);
}

app.post('/api/enroll/run', requireAdmin, (req, res) => {
  const tag    = typeof req.body.tag === 'string' && req.body.tag.trim() ? req.body.tag.trim() : '';
  if (!tag) return res.status(400).json({ ok: false, error: 'Tag is required.' });
  const dryRun = req.body.dryRun !== false && req.body.dryRun !== 'false';

  _gcJobs();
  const jobId = _makeJobId();
  _enrollJobs.set(jobId, { status: 'running', result: null, error: null, expiresAt: Date.now() + 10 * 60 * 1000 });

  // Fire-and-forget — runs after response is sent so proxy can't time it out.
  setImmediate(async () => {
    try {
      const result = await runEnrollment({ tag, dryRun, delayMs: 1500 });
      _enrollJobs.set(jobId, { status: 'done', result, error: null, expiresAt: Date.now() + 10 * 60 * 1000 });
    } catch (err) {
      _enrollJobs.set(jobId, { status: 'error', result: null, error: err.message, expiresAt: Date.now() + 10 * 60 * 1000 });
    }
  });

  res.json({ ok: true, jobId, status: 'running' });
});

app.get('/api/enroll/status/:jobId', requireAdmin, (req, res) => {
  const job = _enrollJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found or expired.' });
  if (job.status === 'running') return res.json({ ok: true, status: 'running' });
  if (job.status === 'error')   return res.json({ ok: false, status: 'error', error: job.error });
  res.json({ ok: true, status: 'done', ...job.result });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
// ─── Startup State Bootstrap ──────────────────────────────────────────────────
// On every restart, reload state for all active (non-booked, last 30 days)
// contacts by reading their GHL conversation history. Runs in the background
// so it never delays server startup or incoming messages.

async function bootstrapStateFromGHL() {
  const all = conversations.getAll();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const active = Object.values(all).filter(c => {
    if (c.booked) return false;
    const last = c.lastMessageAt || c.createdAt || 0;
    return last > thirtyDaysAgo;
  });

  if (active.length === 0) {
    console.log('[Bootstrap] No active contacts to restore');
    return;
  }

  console.log(`[Bootstrap] Restoring state for ${active.length} active contact(s)...`);

  const results = await Promise.allSettled(active.map(async (contact) => {
    const convId = (contact.exchanges || []).map(e => e.conversationId).find(id => !!id);
    if (!convId) return;
    const msgs = await ghl.fetchMessages(convId);
    recoverStateFromHistory(contact.contactId, contact, msgs);
  }));

  const ok = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[Bootstrap] Done — ${ok}/${active.length} contact(s) restored`);
}

// ─── Funnel Snapshot ──────────────────────────────────────────────────────────
// Captures the current 4 funnel metrics and writes one row to funnel_snapshots.
// Called once on startup (so there is always at least one data point) and then
// every 24 hours.  The /api/brain/stats handler reads the most recent row plus
// a row from ≥6 days ago to compute week-over-week deltas.

async function takeFunnelSnapshot() {
  try {
    const allContacts = conversations.getAll();
    const total = Object.keys(allContacts).length;
    if (total === 0) {
      console.log('[Snapshot] No contacts yet — skipping snapshot');
      return;
    }

    // Guard against duplicate rows when the server restarts multiple times
    // in a short window — only record one snapshot per 12-hour period.
    const recentCheck = await _promptsPool.query(
      `SELECT id FROM funnel_snapshots WHERE taken_at > NOW() - INTERVAL '12 hours' LIMIT 1`
    );
    if (recentCheck.rows.length > 0) {
      console.log('[Snapshot] Recent snapshot exists (<12h ago) — skipping duplicate');
      return;
    }

    const stats = brain.getStats(null);
    const t = stats.totals || {};
    const pct = (n) => total > 0 ? Math.round(((n || 0) / total) * 100) : 0;
    const repliedOncePct  = pct(t.contactsRepliedOnce);
    const replied4plusPct = pct(t.contactsReplied4Plus);
    const bookingRatePct  = pct(t.booked);

    await _promptsPool.query(
      `INSERT INTO funnel_snapshots (taken_at, total_leads, replied_once_pct, replied_4plus_pct, booking_rate_pct)
       VALUES (NOW(), $1, $2, $3, $4)`,
      [total, repliedOncePct, replied4plusPct, bookingRatePct]
    );
    console.log(`[Snapshot] Recorded — leads:${total} repliedOnce:${repliedOncePct}% replied4+:${replied4plusPct}% booked:${bookingRatePct}%`);
  } catch (err) {
    console.error('[Snapshot] Failed to record funnel snapshot:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`Powered Up AI — GMB Message Generator running on port ${PORT}`);

  // ── DB migrations (safe, idempotent) ──────────────────────────────────────
  _promptsPool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS variant varchar(1)`)
    .then(() => console.log('[DB] contacts.variant column ensured'))
    .catch(err => console.error('[DB] contacts.variant migration error:', err.message));

  // ── Funnel snapshot table ──────────────────────────────────────────────────
  _promptsPool.query(`
    CREATE TABLE IF NOT EXISTS funnel_snapshots (
      id SERIAL PRIMARY KEY,
      taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_leads INT NOT NULL,
      replied_once_pct NUMERIC(6,2) NOT NULL,
      replied_4plus_pct NUMERIC(6,2) NOT NULL,
      booking_rate_pct NUMERIC(6,2) NOT NULL
    )
  `)
    .then(() => {
      console.log('[DB] funnel_snapshots table ensured');
      // Take an initial snapshot on startup then every 24 hours
      takeFunnelSnapshot();
      setInterval(takeFunnelSnapshot, 24 * 60 * 60 * 1000);
    })
    .catch(err => console.error('[DB] funnel_snapshots migration error:', err.message));

  prompts.seed();
  // Sync prompts from DB into local file on every startup — this ensures
  // UI-saved prompts survive redeployments (DB is the durable source of truth)
  prompts.syncFromDb(_promptsPool).then(async () => {
    // Seed any variant prompt keys that aren't in the DB yet (ensures DB is
    // always the full source of truth from day one, no lazy-init surprises).
    const variantKeys = [
      'conversationPrompt.A', 'conversationPrompt.B', 'conversationPrompt.C', 'conversationPrompt.D',
      'conversationPrompt.A.enabled', 'conversationPrompt.B.enabled', 'conversationPrompt.C.enabled', 'conversationPrompt.D.enabled'
    ];
    for (const key of variantKeys) {
      const val = prompts.get(key);
      if (val) {
        await _promptsPool.query(
          'INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
          [key, val, Date.now()]
        ).catch(err => console.error(`[Prompts] Variant seed error for ${key}:`, err.message));
      }
    }
    console.log('[Prompts] Variant prompt keys seeded to DB');
  }).catch(err => console.error('[Prompts] Startup DB sync error:', err.message));
  brain.startScheduledAnalysis();
  if (DEV_MODE) {
    console.log('[Followups] DEV MODE — scheduler not started (no jobs will fire locally)');
  } else {
    followups.startScheduler();
  }
  Promise.all([bootstrapStateFromGHL(), conversations.whenReady()])
    .then(() => {
      console.log('[Bootstrap] GHL state and conversations ready.');
    })
    .catch(err => console.error('[Bootstrap] Error:', err.message));
});

// ─── Scan Page Builder ────────────────────────────────────────────────────────

function buildScanPage(sessionId, practiceName, city, lat, lng, scanResults) {
  const sr = scanResults || {};
  const gridJson = JSON.stringify(sr.gridResults || []);
  const statsJson = JSON.stringify({
    visibleTop3: sr.visibleTop3 || 0,
    visibleTop10: sr.visibleTop10 || 0,
    invisible: sr.invisible || 0,
    totalPoints: sr.totalPoints || 25,
    percentInvisible: sr.percentInvisible || 0,
    topCompetitor: sr.topCompetitor || null,
    averageRankWhereVisible: sr.averageRankWhereVisible || null
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${practiceName} — Google Maps Visibility</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh}
.header{padding:20px 16px 12px;text-align:center}
.header h1{font-size:20px;font-weight:700;color:#fff;line-height:1.3}
.header p{font-size:13px;color:#888;margin-top:6px}
#map{width:100%;height:380px;background:#222}
.stats{padding:16px}
.stat-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #2a2a2a;font-size:14px}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot-green{background:#22c55e}.dot-yellow{background:#f59e0b}.dot-red{background:#ef4444}
.stat-label{flex:1;color:#ccc}
.stat-value{font-weight:600;color:#fff}
.footer{text-align:center;padding:20px;font-size:11px;color:#555}
.loading-msg{text-align:center;padding:40px 20px;color:#888;font-size:14px}
</style>
</head>
<body>
<div class="header">
  <h1>${practiceName} — Google Maps Visibility</h1>
  <p>Keyword: ${config.scanKeyword} near me &bull; ${city} &bull; ${config.scanRadius}-mile radius</p>
</div>
<div id="map"></div>
<div id="stats-container">
  ${!scanResults ? '<div class="loading-msg">Scan in progress — check back in a moment.</div>' : ''}
</div>
<div class="footer">Powered by Powered Up AI</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const grid=${gridJson},stats=${statsJson},centerLat=${lat},centerLng=${lng};
const map=L.map('map').setView([centerLat,centerLng],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:18}).addTo(map);
function rankColor(r){if(!r||r>20)return{bg:'#ef4444',text:'#fff'};if(r<=3)return{bg:'#22c55e',text:'#fff'};return{bg:'#f59e0b',text:'#111'}}
grid.forEach(point=>{
  const{bg,text}=rankColor(point.rank),label=point.rank?String(point.rank):'—';
  const icon=L.divIcon({className:'',html:\`<div style="width:30px;height:30px;border-radius:50%;background:\${bg};color:\${text};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid rgba(255,255,255,0.3)">\${label}</div>\`,iconSize:[30,30],iconAnchor:[15,15]});
  const topBiz=(point.topBusinesses||[]).map(b=>\`<div style="padding:3px 0;font-size:13px;">#\${b.rank} \${b.name}</div>\`).join('');
  L.marker([point.lat,point.lng],{icon}).addTo(map).bindPopup(\`<div style="min-width:160px">\${topBiz||'No data'}</div>\`);
});
if(stats.totalPoints>0){
  const container=document.getElementById('stats-container'),comp=stats.topCompetitor;
  container.innerHTML=\`<div class="stats">
    <div class="stat-row"><span class="dot dot-green"></span><span class="stat-label">Visible (top 3)</span><span class="stat-value">\${stats.visibleTop3}/\${stats.totalPoints} locations</span></div>
    <div class="stat-row"><span class="dot dot-yellow"></span><span class="stat-label">Partially visible (4–10)</span><span class="stat-value">\${stats.visibleTop10-stats.visibleTop3}/\${stats.totalPoints}</span></div>
    <div class="stat-row"><span class="dot dot-red"></span><span class="stat-label">Invisible</span><span class="stat-value">\${stats.invisible}/\${stats.totalPoints}</span></div>
    \${comp?\`<div class="stat-row"><span class="dot" style="background:#888"></span><span class="stat-label">Top competitor: \${comp.name}</span><span class="stat-value">visible in \${comp.visibleIn}/\${stats.totalPoints} locations</span></div>\`:''}
    \${stats.averageRankWhereVisible?\`<div class="stat-row"><span class="dot" style="background:#888"></span><span class="stat-label">Avg rank where visible</span><span class="stat-value">#\${stats.averageRankWhereVisible}</span></div>\`:''}
  </div>\`;
}
</script>
</body>
</html>`;
}

// ─── Admin Dashboard Page ─────────────────────────────────────────────────────

function buildAdminDashboardPage(adminKey) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Dashboard — Powered Up AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:
  radial-gradient(circle at 8% 82%, rgba(45,212,191,.12) 0, rgba(45,212,191,0) 26%),
  radial-gradient(circle at 92% 12%, rgba(56,189,248,.12) 0, rgba(56,189,248,0) 24%),
  linear-gradient(180deg,#fbfbfb 0%,#f7fbfb 48%,#ffffff 100%);
  color:#0f172a;font-family:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:32px 16px 80px;-webkit-font-smoothing:antialiased}
a{color:#0ea56f;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}

/* ── Header ── */
.header{max-width:1100px;margin:0 auto 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.header-left .logo{font-size:11px;font-weight:700;letter-spacing:.32em;color:#9ca3af;text-transform:uppercase;margin-bottom:6px}
.header-left h1{font-size:28px;font-weight:900;color:#0f172a;letter-spacing:-.02em;line-height:1.1}
.header-right{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;padding:9px 16px;border-radius:999px;border:1px solid rgba(203,213,225,.9);background:#fff;color:#334155;cursor:pointer;text-decoration:none;transition:all .15s;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.btn:hover{border-color:#94a3b8;color:#0f172a;text-decoration:none;box-shadow:0 4px 10px rgba(15,23,42,.06)}
.btn-primary{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);border-color:rgba(16,185,129,.45);color:#fff;box-shadow:0 8px 18px rgba(16,185,129,.22),inset 0 1px 0 rgba(255,255,255,.28)}
.btn-primary:hover{filter:saturate(1.05) brightness(1.02);color:#fff}

/* ── Refresh bar ── */
.refresh-bar{max-width:1100px;margin:-12px auto 22px;font-size:11px;color:#94a3b8;text-align:right;font-weight:600;letter-spacing:.04em}

/* ── Stats strip ── */
.stats-strip{max-width:1100px;margin:0 auto 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat-card{background:rgba(255,255,255,.86);backdrop-filter:blur(12px);border:1px solid rgba(203,213,225,.7);border-radius:18px;padding:18px 14px;text-align:center;box-shadow:0 12px 28px rgba(15,23,42,.05)}
.funnel-header{max-width:1100px;margin:6px auto 10px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.funnel-header .funnel-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.12em;font-weight:800}
.filter-pills{display:flex;gap:6px}
.filter-pill{background:#fff;border:1px solid rgba(203,213,225,.9);color:#64748b;border-radius:999px;padding:5px 14px;font-size:11px;font-weight:700;cursor:pointer;transition:all .15s;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.filter-pill:hover{border-color:#94a3b8;color:#0f172a}
.filter-pill.active{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);border-color:transparent;color:#fff;box-shadow:0 6px 14px rgba(16,185,129,.22)}
.stat-card .val{font-size:30px;font-weight:900;color:#0f172a;line-height:1.05;letter-spacing:-.02em}
.stat-card .lbl{font-size:11px;color:#64748b;margin-top:6px;text-transform:uppercase;letter-spacing:.1em;font-weight:700}
.stat-card .sub{font-size:11px;color:#94a3b8;margin-top:3px;font-weight:500}
.stat-card .delta{font-size:11px;margin-top:5px;font-weight:700;letter-spacing:.02em}
.stat-card .delta.up{color:#10b981}
.stat-card .delta.down{color:#ef4444}
.stat-card .delta.flat{color:#94a3b8}
.stat-highlight .val{color:#0ea56f}

/* ── Panel ── */
.panel{background:rgba(255,255,255,.86);backdrop-filter:blur(12px);border:1px solid rgba(203,213,225,.7);border-radius:22px;padding:26px;width:100%;max-width:1100px;margin:0 auto 22px;box-shadow:0 18px 42px rgba(15,23,42,.06)}
.panel-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px;gap:12px;flex-wrap:wrap}
.panel-title{font-size:17px;font-weight:800;color:#0f172a;letter-spacing:-.01em}
.panel-desc{font-size:13px;color:#64748b;margin-bottom:18px;line-height:1.6}
.tab-row{display:flex;gap:6px;margin-bottom:18px;flex-wrap:wrap}
.tab{font-size:12px;font-weight:700;padding:6px 14px;border-radius:999px;border:1px solid rgba(203,213,225,.9);background:#fff;color:#64748b;cursor:pointer;transition:all .15s}
.tab.active{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);border-color:transparent;color:#fff;box-shadow:0 6px 14px rgba(16,185,129,.22)}
.tab:hover:not(.active){border-color:#94a3b8;color:#0f172a}

/* ── Table ── */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#94a3b8;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.08em;padding:0 12px 10px;border-bottom:1px solid rgba(203,213,225,.6);white-space:nowrap}
td{padding:12px 12px;border-bottom:1px solid rgba(226,232,240,.6);color:#475569;vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(236,253,245,.45)}
.name-cell{font-weight:600;color:#0f172a}
.city-cell{font-size:11px;color:#94a3b8;margin-top:2px;font-weight:500}
.time-cell{font-weight:700;color:#0f172a}
.time-sub{font-size:11px;color:#94a3b8;margin-top:2px;font-weight:500}

/* ── Badges ── */
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap}
.b-sms{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe}
.b-email{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0}
.b-pending{background:#fffbeb;color:#b45309;border:1px solid #fde68a}
.b-sent{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0}
.b-skipped{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}
.b-cancelled{background:#f8fafc;color:#94a3b8;border:1px solid #e2e8f0}
.b-booked{background:#ecfdf5;color:#047857;border:1px solid #6ee7b7}
.b-active{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe}

/* ── Stage label ── */
.stage-label{font-weight:700;color:#0f172a;display:block}
.stage-sub{font-size:11px;color:#94a3b8;margin-top:2px;display:block;font-weight:500}

/* ── Summary row above table ── */
.queue-summary{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:16px}
.qs-item{font-size:13px;color:#64748b;font-weight:500}
.qs-item strong{color:#0f172a;font-weight:800}
.qs-item.urgent strong{color:#d97706}

/* ── Legend ── */
.legend{background:rgba(248,250,252,.72);border:1px solid rgba(203,213,225,.7);border-radius:14px;padding:16px 18px;margin-bottom:18px}
.legend-title{font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px}
.legend-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.legend-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#64748b;line-height:1.5}
.legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:5px}
.ld-1{background:#6366f1}.ld-2{background:#f59e0b}.ld-3{background:#10b981}.ld-4{background:#0ea5e9}

/* ── Performance table ── */
.perf-table td:first-child{color:#475569;font-weight:600}
.rate-good{color:#10b981;font-weight:800}
.rate-mid{color:#d97706;font-weight:800}
.rate-low{color:#94a3b8;font-weight:800}

/* ── Misc ── */
.empty{color:#94a3b8;font-size:13px;padding:24px 0;text-align:center}
.loading{color:#94a3b8;text-align:center;padding:24px;font-size:13px;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:.45}50%{opacity:1}}
.dot-live{display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;margin-right:6px;animation:livepulse 2s infinite}
@keyframes livepulse{0%,100%{opacity:1}50%{opacity:.4}}

/* ── Table scroll wrapper ── */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}

/* ── Action buttons / inputs (used inline in panels) ── */
.action-btn{display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;padding:9px 16px;border-radius:12px;border:1px solid rgba(203,213,225,.9);background:#fff;color:#334155;cursor:pointer;transition:all .15s;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.action-btn:hover{border-color:#94a3b8;color:#0f172a;box-shadow:0 4px 10px rgba(15,23,42,.06)}
.action-btn-primary{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);border-color:transparent;color:#fff;box-shadow:0 8px 18px rgba(16,185,129,.22)}
.action-btn-primary:hover{filter:saturate(1.05) brightness(1.02);color:#fff}
.action-btn-warn{background:#fff5f5;border-color:#fecaca;color:#dc2626}
.action-btn-warn:hover{background:#fee2e2;border-color:#fca5a5;color:#b91c1c}
.action-btn-info{background:#eff6ff;border-color:#bfdbfe;color:#2563eb}
.action-btn-info:hover{background:#dbeafe;border-color:#93c5fd;color:#1d4ed8}
.field-input{background:#fff;border:1px solid rgba(203,213,225,.9);color:#0f172a;padding:10px 14px;border-radius:12px;font-size:13px;outline:none;font-family:inherit;box-shadow:0 1px 0 rgba(255,255,255,.8) inset;transition:border-color .15s,box-shadow .15s}
.field-input:focus{border-color:#2dd4bf;box-shadow:0 0 0 4px rgba(45,212,191,.12)}
.subpanel-title{font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px}
.subpanel-desc{font-size:13px;color:#64748b;margin-bottom:14px;line-height:1.6}
.subpanel-divider{margin-top:22px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px}

/* ── Mobile ── */
@media(max-width:640px){
  body{padding:12px 10px 60px}
  .header{margin-bottom:14px;gap:8px}
  .header-left h1{font-size:16px}
  .header-right{width:100%}
  .header-right .btn{flex:1;text-align:center;font-size:11px;padding:7px 8px}
  .refresh-bar{font-size:10px;margin-bottom:12px}
  .stats-strip{grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px}
  .stat-card{padding:10px 6px;border-radius:10px}
  .stat-card .val{font-size:20px}
  .stat-card .lbl{font-size:10px}
  .stat-card .sub{display:none}
  .panel{padding:14px 12px;border-radius:12px;margin-bottom:14px}
  .panel-desc{font-size:11px;margin-bottom:12px}
  .legend{display:none}
  .tab-row{gap:4px;margin-bottom:12px}
  .tab{font-size:11px;padding:4px 10px}
  table{font-size:12px}
  th{font-size:10px;padding:0 8px 8px;letter-spacing:0}
  td{padding:8px 8px}
  .badge{font-size:10px;padding:2px 7px}
  .queue-summary{gap:12px}
  .qs-item{font-size:12px}
}
</style>
</head>
<body>

${DEV_MODE ? `<div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(180deg,#fff7ed,#ffedd5);color:#9a3412;font-size:13px;font-weight:700;text-align:center;padding:9px 16px;letter-spacing:.04em;border-bottom:1px solid #fdba74;box-shadow:0 2px 12px rgba(154,52,18,.08)">
  ⚠ DEV MODE — Scheduler &amp; GHL sends are disabled. No real messages will go out.
</div>
<div style="height:39px"></div>` : ''}

<div class="header">
  <div class="header-left">
    <div class="logo">Powered Up AI</div>
    <h1>Admin Dashboard</h1>
  </div>
  <div class="header-right">
    <a class="btn" href="/admin/playground?key=${adminKey}">Conversation Tester &rarr;</a>
    <a class="btn" href="/admin/prompts?key=${adminKey}">Prompt Editor &rarr;</a>
    <a class="btn btn-primary" href="/admin/enroll?key=${adminKey}">Lead Enrollment &rarr;</a>
  </div>
</div>

<div class="refresh-bar"><span class="dot-live"></span>Auto-refreshes every 30s &nbsp;&bull;&nbsp; next refresh in <span id="countdown">30</span>s</div>

<!-- ── Funnel Header ── -->
<div class="funnel-header">
  <span class="funnel-label">Funnel</span>
  <div class="filter-pills">
    <button class="filter-pill active" onclick="setDaysFilter(null,this)">All time</button>
    <button class="filter-pill" onclick="setDaysFilter(30,this)">30d</button>
    <button class="filter-pill" onclick="setDaysFilter(7,this)">7d</button>
    <button class="filter-pill" onclick="setDaysFilter(3,this)">3d</button>
  </div>
</div>

<!-- ── Funnel Strip ── -->
<div class="stats-strip" id="stats-strip">
  <div class="stat-card"><div class="val" id="s-leads">—</div><div class="lbl">Total Leads</div><div class="sub">enrolled contacts</div><div class="delta flat" id="d-leads"></div></div>
  <div class="stat-card"><div class="val" id="s-replied-once">—</div><div class="lbl">Replied Once</div><div class="sub">% of total leads</div><div class="delta flat" id="d-replied-once"></div></div>
  <div class="stat-card"><div class="val" id="s-replied-4">—</div><div class="lbl">4+ Replies</div><div class="sub">% of total leads</div><div class="delta flat" id="d-replied-4"></div></div>
  <div class="stat-card stat-highlight"><div class="val" id="s-booked-rate">—</div><div class="lbl">Booking Rate</div><div class="sub">% of total leads</div><div class="delta flat" id="d-booked-rate"></div></div>
</div>

<!-- ── Queue Ops Strip ── -->
<div class="stats-strip" id="ops-strip" style="grid-template-columns:repeat(3,1fr);margin-top:-6px;margin-bottom:18px">
  <div class="stat-card" style="padding:8px 10px"><div class="val" id="s-queued" style="font-size:18px">—</div><div class="lbl">In Queue</div></div>
  <div class="stat-card" style="padding:8px 10px"><div class="val" id="s-today" style="font-size:18px;color:#f59e0b">—</div><div class="lbl">Sending Today</div></div>
  <div class="stat-card" style="padding:8px 10px"><div class="val" id="s-sent" style="font-size:18px">—</div><div class="lbl">Sent Total</div></div>
</div>

<!-- ── Performance Stats ── -->
<div class="panel">
  <div class="panel-header"><div class="panel-title">Performance</div></div>
  <p class="panel-desc">How the AI is performing across all enrolled contacts. The brain updates its analysis every 72 hours to improve future messages.</p>
  <div id="brain-content"><div class="loading">Loading&hellip;</div></div>
</div>

<!-- ── Follow-Up Queue ── -->
<div class="panel">
  <div class="panel-header">
    <div>
      <div class="panel-title">Follow-Up Queue</div>
    </div>
  </div>
  <p class="panel-desc">All scheduled outreach messages, sorted by who gets contacted next. These fire automatically during 7–8am or 4–8pm in the contact's timezone.</p>

  <div class="legend">
    <div class="legend-title">What the Sequence Positions Mean</div>
    <div class="legend-grid">
      <div class="legend-item"><div class="legend-dot ld-1"></div><span><strong style="color:#4f46e5">Pos 2–5 &nbsp;·&nbsp; Hooks</strong><br>4 follow-ups over the first week (day 0, 2, 4, 7). First contact after enrollment.</span></div>
      <div class="legend-item"><div class="legend-dot ld-2"></div><span><strong style="color:#b45309">Pos 6–21 &nbsp;·&nbsp; Bi-weekly</strong><br>Every 3–4 days for ~8 weeks. Nurture messages keeping the lead warm.</span></div>
      <div class="legend-item"><div class="legend-dot ld-3"></div><span><strong style="color:#047857">Pos 22+ &nbsp;·&nbsp; Monthly</strong><br>One message per month, indefinitely. Long-term follow-up for slow-moving leads.</span></div>
      <div class="legend-item"><div class="legend-dot ld-4"></div><span><strong style="color:#0369a1">Email hooks</strong><br>Parallel email track for contacts with a known email address.</span></div>
    </div>
  </div>

  <div class="tab-row">
    <button class="tab active" onclick="switchTab('pending',this)">Pending</button>
    <button class="tab" onclick="switchTab('sent',this)">Sent</button>
    <button class="tab" onclick="switchTab('skipped',this)">Skipped / Cancelled</button>
  </div>

  <div class="queue-summary" id="queue-summary"></div>
  <div id="followups-content"><div class="loading">Loading&hellip;</div></div>
  <div style="margin-top:14px;border-top:1px solid rgba(203,213,225,.6);padding-top:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <button id="pause-btn" class="action-btn action-btn-warn" onclick="togglePause()" disabled>… loading</button>
    <button class="action-btn action-btn-info" onclick="syncBookings(this)">↻ Sync Bookings from GHL</button>
    <span id="rebuild-status" style="font-size:12px;color:#94a3b8;font-weight:500"></span>
  </div>

  <div class="subpanel-divider">
    <div class="subpanel-title">Pending Booking Confirmations</div>
    <div class="subpanel-desc">Contacts where the AI stopped messaging because it detected a verbal commitment, but no GHL calendar appointment has been confirmed yet. If the prospect did book, click <strong style="color:#0f172a;font-weight:700">Confirm</strong> to record them in your booking stats. If they didn't actually book, you can ignore them — the AI is already paused.</div>
    <div id="awaiting-confirmation-list" style="margin-top:10px;font-size:13px;color:#94a3b8">Loading&hellip;</div>
  </div>

  <div class="subpanel-divider">
    <div class="subpanel-title">Enrollment Sync</div>
    <div class="subpanel-desc">Pulls everyone with a specific GHL tag and registers any who aren't in the system yet. Does <strong style="color:#0f172a;font-weight:700">not</strong> send any messages — GHL's automation handles the intro. When contacts reply, the AI takes over automatically. Enter the exact tag name from GHL.</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
      <input id="sync-tag-input" type="text" placeholder="GHL tag name (e.g. Powered Up AI)" class="field-input" style="width:280px">
      <button class="action-btn action-btn-primary" onclick="runEnrollmentSync()">Sync Now</button>
    </div>
    <div id="sync-status" style="font-size:13px;margin-top:10px;font-weight:600"></div>
    <div id="sync-results" style="font-size:12px;color:#64748b;margin-top:6px"></div>
  </div>

  <div class="subpanel-divider">
    <div class="subpanel-title">Missed Reply Trigger</div>
    <div class="subpanel-desc">If someone replied while the server was down and the AI never responded, search for them here and trigger the reply now.</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
      <div style="position:relative">
        <input id="replay-name-input" type="text" placeholder="Search contact name…" class="field-input" style="width:240px" oninput="replaySearchContacts(this.value)">
        <div id="replay-dropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:12px;box-shadow:0 12px 28px rgba(15,23,42,.12);z-index:100;max-height:200px;overflow-y:auto"></div>
      </div>
      <input id="replay-msg-input" type="text" placeholder="Their message (e.g. Go)" value="Go" class="field-input" style="width:180px">
      <button class="action-btn action-btn-primary" onclick="triggerReplayInbound()">Trigger AI Response</button>
    </div>
    <div id="replay-selected" style="font-size:12px;color:#64748b;margin-top:8px"></div>
    <div id="replay-status" style="font-size:13px;margin-top:8px;font-weight:600"></div>
  </div>
</div>

<!-- ── Spend Monitor ── -->
<div class="panel">
  <div class="panel-header"><div class="panel-title">API Spend Monitor</div></div>
  <p class="panel-desc">Claude API cost per contact. Each contact is capped at $1.00 — once hit, AI responses stop and all pending jobs are cancelled. Use the override button to resume a high-value prospect.</p>
  <div id="spend-content"><div class="loading">Loading&hellip;</div></div>
</div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
let currentTab = 'pending';
let allJobs = [];
let contactMap = {};
let currentDays = null;

function setDaysFilter(days, btn) {
  currentDays = days;
  document.querySelectorAll('.filter-pill').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  loadBrain();
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── Format scheduled time (future-aware) ── */
function fmtSendTime(ts) {
  if (!ts) return { main:'—', sub:'' };
  const d = new Date(ts);
  const now = new Date();
  const diffMs = ts - Date.now();
  const diffMins = Math.round(diffMs / 60000);
  const timeStr = d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  const dateStr = d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'});
  const todayStr = now.toDateString();
  const tomStr = new Date(now.getTime()+86400000).toDateString();
  let main, sub;
  if (d.toDateString() === todayStr) {
    main = 'Today at ' + timeStr;
    sub = diffMs > 0 ? 'in ' + (diffMins < 60 ? diffMins + 'm' : Math.round(diffMins/60) + 'h') : 'overdue';
  } else if (d.toDateString() === tomStr) {
    main = 'Tomorrow at ' + timeStr;
    sub = 'in ~' + Math.round(diffMins/60) + 'h';
  } else if (diffMs < 0) {
    const ago = Math.abs(diffMins);
    main = dateStr + ' ' + timeStr;
    sub = ago < 60 ? ago+'m ago' : ago < 1440 ? Math.round(ago/60)+'h ago' : Math.round(ago/1440)+'d ago';
  } else {
    const days = Math.round(diffMs/86400000);
    main = dateStr + ' at ' + timeStr;
    sub = 'in ' + days + ' day' + (days===1?'':'s');
  }
  return { main, sub };
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs/24) + 'd ago';
}

/* ── Position → human label ── */
function stageLabel(pos, type) {
  const isEmail = (type||'').startsWith('email-');
  const ch = isEmail ? 'Email' : 'SMS';
  if (pos == null) return { label: ch + ' message', sub: '' };
  pos = Number(pos);
  if (isEmail) {
    if (pos <= 5) return { label: ch + ' Hook ' + pos, sub: 'First-week email' };
    if (pos <= 21) return { label: ch + ' Nurture #' + (pos-5), sub: 'Bi-weekly email' };
    return { label: ch + ' Monthly #' + (pos-21), sub: 'Long-term nurture' };
  }
  if (pos <= 1) return { label: 'Initial message', sub: 'First contact' };
  if (pos <= 5) return { label: 'Hook ' + (pos-1) + ' of 4', sub: 'Week 1 follow-up' };
  if (pos <= 21) return { label: 'Bi-weekly #' + (pos-5), sub: 'Weeks 2–10' };
  return { label: 'Monthly #' + (pos-21), sub: 'Long-term nurture' };
}

function contactCell(contactId) {
  const c = contactMap[contactId];
  if (!c) return '<span style="color:#444;font-size:12px">' + escHtml(contactId.slice(0,12)) + '…</span>';
  const name = escHtml(c.firstName || '—');
  const loc = escHtml(c.practiceName || c.city || '');
  return \`<div class="name-cell">\${name}</div>\${loc ? '<div class="city-cell">'+loc+'</div>' : ''}\`;
}

function channelBadge(type) {
  if ((type||'').startsWith('email-')) return '<span class="badge b-email">Email</span>';
  return '<span class="badge b-sms">SMS</span>';
}

function statusBadge(s) {
  const map = { pending:'b-pending', sent:'b-sent', skipped:'b-skipped', cancelled:'b-cancelled' };
  const labels = { pending:'Pending', sent:'Sent', skipped:'Skipped', cancelled:'Cancelled' };
  return \`<span class="badge \${map[s]||'b-skipped'}">\${labels[s]||escHtml(s)}</span>\`;
}

/* ── Render queue table ── */
function renderQueue() {
  const el = document.getElementById('followups-content');
  const sumEl = document.getElementById('queue-summary');

  const filtered = allJobs.filter(j => {
    if (currentTab === 'pending') return j.status === 'pending';
    if (currentTab === 'sent') return j.status === 'sent';
    return j.status === 'skipped' || j.status === 'cancelled';
  });

  // Summary
  if (currentTab === 'pending') {
    const now = Date.now();
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    const today = filtered.filter(j => j.sendAt && j.sendAt <= todayEnd.getTime()).length;
    const overdue = filtered.filter(j => j.sendAt && j.sendAt < now).length;
    sumEl.innerHTML = \`
      <div class="qs-item"><strong>\${filtered.length}</strong> total pending</div>
      \${today > 0 ? '<div class="qs-item urgent"><strong>'+today+'</strong> sending today</div>' : ''}
      \${overdue > 0 ? '<div class="qs-item" style="color:#ef4444"><strong>'+overdue+'</strong> overdue</div>' : ''}
    \`;
  } else {
    sumEl.innerHTML = '';
  }

  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty">No ' + currentTab + ' messages.</div>';
    return;
  }

  if (currentTab === 'pending') {
    el.innerHTML = \`<div class="table-wrap"><table>
      <thead><tr>
        <th>Contact</th>
        <th>Channel</th>
        <th>Stage</th>
        <th>Sends At</th>
      </tr></thead>
      <tbody>\${filtered.map(j => {
        const { main, sub } = fmtSendTime(j.sendAt);
        const { label, sub: stageSub } = stageLabel(j.position, j.type);
        const isToday = main.startsWith('Today');
        const isOverdue = sub === 'overdue';
        return \`<tr>
          <td>\${contactCell(j.contactId)}</td>
          <td>\${channelBadge(j.type)}</td>
          <td><span class="stage-label">\${escHtml(label)}</span><span class="stage-sub">\${escHtml(stageSub)}</span></td>
          <td>
            <div class="time-cell" style="\${isOverdue?'color:#ef4444':isToday?'color:#f59e0b':''}">\${escHtml(main)}</div>
            <div class="time-sub">\${escHtml(sub)}</div>
          </td>
        </tr>\`;
      }).join('')}</tbody>
    </table></div>\`;
  } else {
    el.innerHTML = \`<div class="table-wrap"><table>
      <thead><tr>
        <th>Contact</th>
        <th>Channel</th>
        <th>Stage</th>
        <th>Status</th>
        <th>When</th>
      </tr></thead>
      <tbody>\${filtered.map(j => {
        const ts = j.sentAt || j.createdAt;
        const { label, sub: stageSub } = stageLabel(j.position, j.type);
        return \`<tr>
          <td>\${contactCell(j.contactId)}</td>
          <td>\${channelBadge(j.type)}</td>
          <td><span class="stage-label">\${escHtml(label)}</span><span class="stage-sub">\${escHtml(stageSub)}</span></td>
          <td>\${statusBadge(j.status)}</td>
          <td style="color:#555;font-size:12px">\${fmtRelative(ts)}</td>
        </tr>\`;
      }).join('')}</tbody>
    </table></div>\`;
  }
}

async function rebuildQueue() {
  const btn = event.target;
  const status = document.getElementById('rebuild-status');
  btn.disabled = true;
  status.textContent = 'Running…';
  try {
    const res = await fetch('/api/admin/rebuild-queue', { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    status.textContent = 'Done — ' + data.scheduledSms + ' SMS + ' + data.scheduledEmail + ' email job(s) scheduled, ' + data.skipped + ' skipped';
    if (data.total > 0) loadFollowups();
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

let _schedulerPaused = false;
function applyPauseButtonState(paused) {
  _schedulerPaused = !!paused;
  const btn = document.getElementById('pause-btn');
  if (!btn) return;
  btn.textContent = _schedulerPaused ? '▶ Resume Everything' : '⏸ Pause Everything';
  btn.style.background = _schedulerPaused ? '#1a3a1a' : '#3a1a1a';
  btn.style.color = _schedulerPaused ? '#4ade80' : '#f87171';
  btn.style.borderColor = _schedulerPaused ? '#2d5a2d' : '#5a2d2d';
}
async function refreshPauseState() {
  try {
    const res = await fetch('/api/admin/paused', { headers: { 'x-admin-key': ADMIN_KEY } });
    if (!res.ok) return;
    const data = await res.json();
    applyPauseButtonState(data.paused);
    const btn = document.getElementById('pause-btn');
    if (btn) btn.disabled = false;
  } catch (err) {
    /* ignore — button stays in its previous state */
  }
}
async function togglePause() {
  const btn = document.getElementById('pause-btn');
  const status = document.getElementById('rebuild-status');
  btn.disabled = true;
  try {
    const endpoint = _schedulerPaused ? '/api/admin/resume' : '/api/admin/pause';
    const res = await fetch(endpoint, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    applyPauseButtonState(data.paused);
    status.textContent = _schedulerPaused ? 'Scheduler paused — no texts will fire' : 'Scheduler resumed';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function cancelAllSms() {
  const status = document.getElementById('rebuild-status');
  if (!confirm('Cancel ALL pending SMS jobs? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/admin/cancel-sms-jobs', { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    status.textContent = data.cancelled + ' SMS job(s) cancelled';
    loadFollowups();
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
}

async function syncBookings(btn) {
  const status = document.getElementById('rebuild-status');
  btn.disabled = true;
  status.textContent = 'Checking GHL calendars…';
  try {
    const res = await fetch('/api/admin/backfill-bookings', { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    const n = data.booked?.length || 0;
    const already = data.alreadyBooked?.length || 0;
    status.textContent = n > 0
      ? n + ' contact(s) marked booked: ' + data.booked.map(c => c.firstName).join(', ')
      : already > 0
        ? 'All matched contacts already booked (' + already + ')'
        : 'No enrolled contacts found with GHL appointments';
    if (n > 0) { loadBrain(); loadAwaitingConfirmation(); }
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function loadAwaitingConfirmation() {
  const el = document.getElementById('awaiting-confirmation-list');
  try {
    const res = await fetch('/api/admin/awaiting-confirmation', { headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    const list = data.awaiting || [];
    if (list.length === 0) {
      el.innerHTML = '<span style="color:#64748b">None — all AI-paused contacts are confirmed or the AI hasn\'t detected any verbal commitments yet.</span>';
      return;
    }
    el.innerHTML = list.map(c => {
      const cid  = escHtml(c.contactId);
      const name = escHtml(c.firstName || '—');
      const loc  = escHtml(c.city || '');
      return \`<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(203,213,225,.2)">
        <div style="flex:1">
          <span style="font-weight:600;color:#e2e2e2">\${name}</span>
          \${loc ? \`<span style="color:#64748b;margin-left:6px">\${loc}</span>\` : ''}
        </div>
        <button onclick="confirmBooking('\${cid}',this)"
          style="font-size:11px;font-weight:600;padding:4px 12px;border-radius:6px;border:1px solid #16a34a;background:#052e16;color:#4ade80;cursor:pointer">
          Confirm Booking
        </button>
        <button onclick="dismissBooking('\${cid}',this)"
          title="Use this if the AI mistakenly thought they booked. Marks them as declined and they disappear from this list. The AI stays paused either way."
          style="font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;border:1px solid #475569;background:#1e293b;color:#94a3b8;cursor:pointer">
          Not a booking
        </button>
      </div>\`;
    }).join('');
  } catch (err) {
    el.innerHTML = '<span style="color:#ef4444">Failed to load: ' + escHtml(err.message) + '</span>';
  }
}

async function confirmBooking(contactId, btn) {
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/admin/confirm-booking', {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contactId })
    });
    const data = await res.json();
    if (!res.ok) { btn.textContent = data.error || 'Error'; btn.disabled = false; return; }
    btn.textContent = data.alreadyConfirmed ? 'Already confirmed' : 'Confirmed!';
    btn.style.borderColor = '#475569';
    btn.style.color = '#94a3b8';
    loadBrain();
    setTimeout(() => loadAwaitingConfirmation(), 800);
  } catch (err) {
    btn.textContent = 'Error';
    btn.disabled = false;
  }
}

async function dismissBooking(contactId, btn) {
  btn.disabled = true;
  btn.textContent = 'Dismissing…';
  try {
    const res = await fetch('/api/admin/dismiss-booking', {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contactId })
    });
    const data = await res.json();
    if (!res.ok) { btn.textContent = data.error || 'Error'; btn.disabled = false; return; }
    btn.textContent = 'Dismissed';
    setTimeout(() => loadAwaitingConfirmation(), 600);
  } catch (err) {
    btn.textContent = 'Error';
    btn.disabled = false;
  }
}

function switchTab(tab, btn) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderQueue();
}

// ── Enrollment Sync ──
async function runEnrollmentSync() {
  const tag = document.getElementById('sync-tag-input').value.trim();
  const statusEl = document.getElementById('sync-status');
  const resultsEl = document.getElementById('sync-results');
  if (!tag) { statusEl.style.color = '#f87171'; statusEl.textContent = 'Enter a GHL tag name first.'; return; }
  statusEl.style.color = '#888';
  statusEl.textContent = 'Searching GHL for contacts with tag "' + tag + '"…';
  resultsEl.textContent = '';
  try {
    const res = await fetch('/api/admin/enrollment-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ tag })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    statusEl.style.color = '#4ade80';
    statusEl.textContent = data.message;
    if (data.enrolled.length > 0) {
      resultsEl.textContent = 'Enrolled: ' + data.enrolled.map(c => c.firstName || c.contactId).join(', ');
    }
    if (data.enrolled.length > 0) { loadFollowups(); }
  } catch (err) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Error: ' + err.message;
  }
}

// ── Manual AI Trigger (replay missed inbound) ──
let _replayContactId = null;

function replaySearchContacts(query) {
  const dd = document.getElementById('replay-dropdown');
  const selEl = document.getElementById('replay-selected');
  _replayContactId = null;
  selEl.textContent = '';
  if (!query || query.length < 2) { dd.style.display = 'none'; return; }
  const q = query.toLowerCase();
  const matches = Object.values(contactMap)
    .filter(c => ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().includes(q))
    .slice(0, 8);
  if (matches.length === 0) { dd.style.display = 'none'; return; }
  dd.style.display = 'block';
  dd.innerHTML = matches.map(c => {
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactId;
    return \`<div onclick="replaySelectContact('\${c.contactId}','\${escHtml(name)}')"
      style="padding:10px 14px;font-size:13px;color:#334155;cursor:pointer;border-bottom:1px solid rgba(226,232,240,.6);font-weight:500"
      onmouseover="this.style.background='rgba(236,253,245,.6)'" onmouseout="this.style.background=''">\${escHtml(name)}</div>\`;
  }).join('');
}

function replaySelectContact(contactId, name) {
  _replayContactId = contactId;
  document.getElementById('replay-name-input').value = name;
  document.getElementById('replay-dropdown').style.display = 'none';
  document.getElementById('replay-selected').textContent = 'Selected: ' + name + ' (' + contactId + ')';
}

async function triggerReplayInbound() {
  const statusEl = document.getElementById('replay-status');
  const msgBody = document.getElementById('replay-msg-input').value.trim();
  if (!_replayContactId) { statusEl.style.color = '#f87171'; statusEl.textContent = 'Please search and select a contact first.'; return; }
  if (!msgBody) { statusEl.style.color = '#f87171'; statusEl.textContent = 'Please enter their message.'; return; }
  statusEl.style.color = '#888';
  statusEl.textContent = 'Triggering AI response…';
  try {
    const res = await fetch('/api/admin/replay-inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ contactId: _replayContactId, messageBody: msgBody })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    statusEl.style.color = '#4ade80';
    statusEl.textContent = 'Done — AI response sent. Check GHL to confirm.';
  } catch (err) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = 'Error: ' + err.message;
  }
}

/* ── Load follow-up queue + contacts ── */
async function loadFollowups() {
  try {
    const [jobsRes, contactsRes, sentRes] = await Promise.all([
      fetch('/api/followups?status=pending', { headers: { 'x-admin-key': ADMIN_KEY } }),
      fetch('/api/contacts', { headers: { 'x-admin-key': ADMIN_KEY } }),
      fetch('/api/followups?status=sent', { headers: { 'x-admin-key': ADMIN_KEY } })
    ]);
    if (!jobsRes.ok) throw new Error('Queue load failed');
    const pending = await jobsRes.json();
    const sent = sentRes.ok ? await sentRes.json() : [];
    allJobs = [...pending, ...sent,
      ...(await (await fetch('/api/followups?status=skipped', {headers:{'x-admin-key':ADMIN_KEY}})).json().catch(()=>[])),
      ...(await (await fetch('/api/followups?status=cancelled', {headers:{'x-admin-key':ADMIN_KEY}})).json().catch(()=>[]))
    ];
    if (contactsRes.ok) {
      const contacts = await contactsRes.json();
      contactMap = {};
      contacts.forEach(c => { contactMap[c.contactId] = c; });
    }
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    document.getElementById('s-queued').textContent = pending.length;
    document.getElementById('s-today').textContent  = pending.filter(j => j.sendAt && j.sendAt <= todayEnd.getTime()).length;
    document.getElementById('s-sent').textContent   = sent.length;
    renderQueue();
  } catch (err) {
    document.getElementById('followups-content').innerHTML = '<div class="empty">Failed to load queue: ' + escHtml(err.message) + '</div>';
  }
}

/* ── Load brain / performance ── */
async function loadBrain() {
  const el = document.getElementById('brain-content');
  try {
    const statsUrl = '/api/brain/stats' + (currentDays ? '?days=' + currentDays : '');
    const res = await fetch(statsUrl, { headers: { 'x-admin-key': ADMIN_KEY } });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const t = data.totals || {};
    const total = data.enrolledTotal || t.contacts || 0;
    const pct = (n) => total > 0 ? Math.round(((n || 0) / total) * 100) + '%' : '—';
    // Update funnel stat cards
    document.getElementById('s-leads').textContent        = total || '—';
    document.getElementById('s-replied-once').textContent = pct(t.contactsRepliedOnce);
    document.getElementById('s-replied-4').textContent    = pct(t.contactsReplied4Plus);
    document.getElementById('s-booked-rate').textContent  = pct(t.booked);

    // Week-over-week delta badges
    function applyDelta(elId, diff, isCount) {
      const el = document.getElementById(elId);
      if (!el) return;
      if (diff === null || diff === undefined || isNaN(diff)) { el.textContent = ''; return; }
      const sign = diff > 0 ? '+' : '';
      const label = isCount ? \`\${sign}\${diff} vs last wk\` : \`\${sign}\${Math.round(diff)}pp vs last wk\`;
      el.textContent = label;
      el.className = 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
    }
    // Only show deltas on the "all time" view — snapshot data is global so the
    // delta would be misleading when a date filter is active.
    const sd = (!currentDays && data.snapshotDelta) ? data.snapshotDelta : null;
    ['d-leads','d-replied-once','d-replied-4','d-booked-rate'].forEach(id => {
      const el = document.getElementById(id);
      if (el && !sd) { el.textContent = ''; el.className = 'delta flat'; }
    });
    if (sd) {
      applyDelta('d-leads',       sd.leads,       true);
      applyDelta('d-replied-once', sd.repliedOnce, false);
      applyDelta('d-replied-4',    sd.replied4,    false);
      applyDelta('d-booked-rate',  sd.bookingRate, false);
    }

    function rateClass(r) { return r >= 30 ? 'rate-good' : r >= 10 ? 'rate-mid' : 'rate-low'; }

    const stages = Object.entries(data.byStage || {}).filter(([stage]) => stage !== 'unknown');
    const stageHtml = stages.length > 0 ? \`
      <div class="table-wrap"><table class="perf-table" style="margin-top:20px">
        <thead><tr>
          <th>Stage</th><th>Sent</th><th>Replied</th><th>Reply Rate</th><th>Booked</th>
        </tr></thead>
        <tbody>\${stages.map(([stage, s]) => {
          const rate = s.sent > 0 ? Math.round((s.replied / s.sent) * 100) : 0;
          return \`<tr>
            <td>\${escHtml(stage)}</td><td>\${s.sent}</td><td>\${s.replied}</td>
            <td><span class="\${rateClass(rate)}">\${rate}%</span></td><td>\${s.booked}</td>
          </tr>\`;
        }).join('')}</tbody>
      </table></div>\` : '';

    // ── Lead Form Performance ────────────────────────────────────────────────
    // Each row is a Facebook lead form bucket (derived from the
    // \`ampifyform:<slug>\` GHL tag at enrollment / tag update). A new tag
    // automatically becomes a new row — no code change needed.
    const leadFormEntries = Object.entries(data.byLeadForm || {})
      .sort((a, b) => (b[1].leads || 0) - (a[1].leads || 0));
    const leadFormHtml = leadFormEntries.length > 0 ? \`
      <div style="margin-top:28px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">
        <div style="font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Lead Form Performance</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:12px;line-height:1.6">
          Compares how each Facebook lead form converts. Tag contacts in GHL with
          <code style="background:#f1f5f9;padding:1px 6px;border-radius:6px;font-size:11px">ampifyform:&lt;slug&gt;</code>
          (e.g. <code style="background:#f1f5f9;padding:1px 6px;border-radius:6px;font-size:11px">ampifyform:high-volume</code>,
          <code style="background:#f1f5f9;padding:1px 6px;border-radius:6px;font-size:11px">ampifyform:high-intent</code>,
          <code style="background:#f1f5f9;padding:1px 6px;border-radius:6px;font-size:11px">ampifyform:high-intent-2FA</code>) — new buckets appear here automatically.
        </div>
        <div class="table-wrap"><table class="perf-table">
          <thead><tr>
            <th>Lead Form</th><th>Leads</th><th>Sent</th><th>Replied</th><th>Reply Rate</th><th>Booked</th><th>Booking Rate</th>
          </tr></thead>
          <tbody>\${leadFormEntries.map(([form, s]) => {
            const rr = s.replyRate;
            const br = s.bookingRate;
            const rrCell = rr === null ? '<span style="color:#94a3b8">—</span>' : \`<span class="\${rateClass(rr)}">\${rr}%</span>\`;
            const brCell = br === null ? '<span style="color:#94a3b8">—</span>' : \`<span class="\${rateClass(br)}">\${br}%</span>\`;
            return \`<tr>
              <td style="font-weight:700;color:#0f172a">\${escHtml(form)}</td>
              <td>\${s.leads}</td>
              <td>\${s.sent}</td>
              <td>\${s.replied}</td>
              <td>\${rrCell}</td>
              <td>\${s.booked}</td>
              <td>\${brCell}</td>
            </tr>\`;
          }).join('')}</tbody>
        </table></div>
      </div>\` : '';

    // ── Variant Performance (with optional Lead Form filter) ────────────────
    // Active filter survives across the 30-second refresh cycle by being stored
    // on the panel container as a data attribute.
    const wrapEl = document.getElementById('brain-content');
    const activeForm = wrapEl?.dataset.leadFormFilter || '';
    let variantRows = '';
    try {
      const vUrl = '/api/brain/variants' + (activeForm ? ('?leadForm=' + encodeURIComponent(activeForm)) : '');
      const vRes = await fetch(vUrl, { headers: { 'x-admin-key': ADMIN_KEY } });
      if (vRes.ok) {
        const vData = await vRes.json();
        if (vData.variants) {
          function vPct(r) {
            if (r === null || r === undefined) return '<span style="color:#555">—</span>';
            const col = r >= 30 ? '#22c55e' : r >= 10 ? '#f59e0b' : '#6b7280';
            return \`<span style="font-weight:600;color:\${col}">\${r}%</span>\`;
          }
          const variantColors = { A: '#748ffc', B: '#f59e0b', C: '#34d399' };
          const formChips = ['', ...(vData.leadForms || [])].map(f => {
            const label = f === '' ? 'All forms' : f;
            const isActive = (f === '' && !activeForm) || (f !== '' && f === activeForm);
            const cls = isActive ? 'filter-pill active' : 'filter-pill';
            return \`<button class="\${cls}" onclick="setVariantLeadFormFilter(\${JSON.stringify(f)})">\${escHtml(label)}</button>\`;
          }).join('');
          variantRows = \`
            <div style="margin-top:28px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
                <div style="font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em">A/B/C/D Script Variant Performance</div>
                <div class="filter-pills">\${formChips}</div>
              </div>
              <div class="table-wrap"><table class="perf-table">
                <thead><tr>
                  <th>Variant</th><th>Enabled</th><th>Contacts</th><th>Replied Once</th><th>4+ Replies</th><th>Booking Rate</th>
                </tr></thead>
                <tbody>\${vData.variants.map(v => {
                  const col = variantColors[v.variant] || '#aaa';
                  return \`<tr>
                    <td><span style="font-weight:700;color:\${col}">Variant \${v.variant}</span></td>
                    <td><span style="\${v.enabled ? 'color:#22c55e' : 'color:#555'};font-weight:600">\${v.enabled ? 'Yes' : 'No'}</span></td>
                    <td>\${v.contactsAssigned}</td>
                    <td>\${vPct(v.repliedOncePct)}</td>
                    <td>\${vPct(v.replied4Pct)}</td>
                    <td>\${vPct(v.bookingRatePct)}</td>
                  </tr>\`;
                }).join('')}</tbody>
              </table></div>
              <div style="font-size:11px;color:#64748b;margin-top:10px">\${activeForm ? 'Showing variant performance for lead form <strong>' + escHtml(activeForm) + '</strong>. ' : 'All percentages are of total contacts assigned to each variant. '}Edit scripts at <a href="/admin/prompts?key=\${ADMIN_KEY}" style="color:#0ea56f">Prompt Editor</a>.</div>
            </div>\`;
        }
      }
    } catch (_) { /* variant stats are supplemental — ignore errors */ }

    el.innerHTML = \`
      \${stageHtml}
      \${leadFormHtml}
      \${variantRows}
    \`;
  } catch (err) {
    el.innerHTML = '<div class="empty">Failed to load: ' + escHtml(err.message) + '</div>';
  }
}

// Persist the chosen Lead Form filter on the brain-content container so it
// survives the 30-second auto-refresh. Calling loadBrain() repaints the panel
// using the new filter without disturbing other panels on the page.
function setVariantLeadFormFilter(form) {
  const wrap = document.getElementById('brain-content');
  if (!wrap) return;
  wrap.dataset.leadFormFilter = form || '';
  loadBrain();
}

async function loadSpend() {
  const el = document.getElementById('spend-content');
  try {
    const res = await fetch('/api/contacts', { headers: { 'x-admin-key': ADMIN_KEY } });
    if (!res.ok) throw new Error(res.statusText);
    const contacts = await res.json();
    const withSpend = contacts
      .filter(c => (c.totalApiSpend || 0) > 0 || c.apiSpendLimitReached)
      .sort((a, b) => (b.totalApiSpend || 0) - (a.totalApiSpend || 0));

    if (withSpend.length === 0) {
      el.innerHTML = '<div class="empty">No API spend recorded yet. Spend accumulates as AI generates messages for enrolled contacts.</div>';
      return;
    }

    const totalSpend = contacts.reduce((s, c) => s + (c.totalApiSpend || 0), 0);
    const atLimit = contacts.filter(c => c.apiSpendLimitReached).length;

    el.innerHTML = \`
      <div class="queue-summary" style="margin-bottom:16px">
        <div class="qs-item"><strong>\${withSpend.length}</strong> contacts with recorded spend</div>
        <div class="qs-item"><strong>$\${totalSpend.toFixed(4)}</strong> total across all contacts</div>
        \${atLimit > 0 ? '<div class="qs-item" style="color:#ef4444"><strong>'+atLimit+'</strong> at $1 limit</div>' : ''}
        <div class="qs-item" style="color:#444">Cap: $1.00 per contact</div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Contact</th>
          <th>Spend</th>
          <th>Status</th>
          <th>Action</th>
        </tr></thead>
        <tbody>\${withSpend.map(c => {
          const pct = Math.min(100, ((c.totalApiSpend || 0) / 1.00) * 100);
          const barColor = c.apiSpendLimitReached ? '#ef4444' : pct > 75 ? '#f59e0b' : '#818cf8';
          const name = escHtml(c.firstName || '—');
          const loc = escHtml(c.practiceName || c.city || '');
          const limitBadge = c.apiSpendLimitReached
            ? '<span class="badge" style="background:#2a0a0a;color:#ef4444;border:1px solid #7f1d1d">Limit Hit</span>'
            : '<span class="badge b-active">Active</span>';
          const resetBtn = c.apiSpendLimitReached
            ? \`<button onclick="resetSpend('\${escHtml(c.contactId)}')" style="font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;border:1px solid #4f46e5;background:#1e1b4b;color:#818cf8;cursor:pointer">Override &rarr;</button>\`
            : '—';
          return \`<tr>
            <td>
              <div class="name-cell">\${name}</div>
              \${loc ? '<div class="city-cell">'+loc+'</div>' : ''}
            </td>
            <td>
              <div style="font-weight:600;color:#e2e2e2">$\${(c.totalApiSpend||0).toFixed(4)}</div>
              <div style="margin-top:5px;height:4px;background:#1f1f1f;border-radius:2px;width:80px">
                <div style="height:4px;background:\${barColor};border-radius:2px;width:\${pct.toFixed(1)}%"></div>
              </div>
              <div style="font-size:10px;color:#444;margin-top:2px">\${pct.toFixed(0)}% of cap</div>
            </td>
            <td>\${limitBadge}</td>
            <td>\${resetBtn}</td>
          </tr>\`;
        }).join('')}</tbody>
      </table></div>
    \`;
  } catch (err) {
    el.innerHTML = '<div class="empty">Failed to load: ' + escHtml(err.message) + '</div>';
  }
}

async function resetSpend(contactId) {
  if (!confirm('Resume AI for this contact? Their spend counter will stay as-is but the block will be removed.')) return;
  try {
    const res = await fetch('/api/contacts/' + encodeURIComponent(contactId) + '/reset-spend', {
      method: 'POST', headers: { 'x-admin-key': ADMIN_KEY }
    });
    if (!res.ok) throw new Error(await res.text());
    await loadSpend();
  } catch (err) {
    alert('Reset failed: ' + err.message);
  }
}

function loadAll() { loadFollowups(); loadBrain(); loadSpend(); loadAwaitingConfirmation(); refreshPauseState(); }
loadAll();

let secondsLeft = 30;
setInterval(() => {
  secondsLeft--;
  document.getElementById('countdown').textContent = secondsLeft;
  if (secondsLeft <= 0) { secondsLeft = 30; loadAll(); }
}, 1000);
</script>
</body>
</html>`;
}

// ─── Admin Prompt Editor Page ─────────────────────────────────────────────────

function buildPromptEditorPage(adminKey, promptsList) {
  const promptsJson = JSON.stringify(promptsList.map(p => ({
    name: p.name,
    label: p.label,
    description: p.description,
    current: p.current,
    isModified: p.isModified,
    defaultValue: p.defaultValue,
    sectionLabel: p.sectionLabel || null
  })));

  // Build variant data: text + enabled flag for A/B/C
  const variantsJson = JSON.stringify(['A', 'B', 'C', 'D'].map(v => ({
    variant: v,
    text: prompts.get(`conversationPrompt.${v}`) || prompts.get('conversationPrompt'),
    enabled: prompts.get(`conversationPrompt.${v}.enabled`) === 'true'
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Prompt Editor — Powered Up AI</title>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:
  radial-gradient(circle at 8% 82%, rgba(45,212,191,.12) 0, rgba(45,212,191,0) 26%),
  radial-gradient(circle at 92% 12%, rgba(56,189,248,.12) 0, rgba(56,189,248,0) 24%),
  linear-gradient(180deg,#fbfbfb 0%,#f7fbfb 48%,#ffffff 100%);
  color:#0f172a;font-family:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:32px 16px 80px;-webkit-font-smoothing:antialiased}
.logo{font-size:12px;font-weight:600;letter-spacing:.32em;color:#9ca3af;text-transform:uppercase;text-align:center;margin-bottom:28px}
.back-link{display:block;max-width:820px;margin:0 auto 16px;color:#6b7280;font-size:13px;text-decoration:none;font-weight:600}
h1{font-size:clamp(36px,5.5vw,56px);font-weight:900;color:#0f172a;text-align:center;margin-bottom:14px;letter-spacing:-.04em;line-height:1}
.subtitle{font-size:16px;color:#475569;text-align:center;margin-bottom:14px;line-height:1.6;max-width:680px;margin-left:auto;margin-right:auto}
.build-pill{display:inline-block;margin-top:14px;padding:7px 16px;background:rgba(255,255,255,.88);border:1px solid rgba(148,163,184,.28);box-shadow:0 8px 22px rgba(15,23,42,.06);color:#334155;font-size:12px;font-weight:700;border-radius:999px;letter-spacing:.04em}
.prompt-card{background:rgba(255,255,255,.86);backdrop-filter:blur(12px);border:1px solid rgba(203,213,225,.7);border-radius:22px;padding:28px;width:100%;max-width:820px;margin:0 auto 22px;box-shadow:0 18px 42px rgba(15,23,42,.06)}
.prompt-card.modified{border-color:rgba(110,231,183,.7);box-shadow:0 18px 42px rgba(16,185,129,.10)}
.prompt-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.prompt-label{font-size:16px;font-weight:800;color:#0f172a;line-height:1.3;letter-spacing:-.01em}
.badge{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap;flex-shrink:0}
.badge-modified{background:#ecfdf5;color:#047857;border:1px solid #6ee7b7}
.badge-default{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}
.prompt-desc{font-size:13px;color:#64748b;margin-bottom:14px;line-height:1.6}
textarea{width:100%;background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:14px;color:#0f172a;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:12.5px;line-height:1.6;padding:14px 16px;resize:vertical;min-height:220px;outline:none;transition:border-color .15s,box-shadow .15s;box-shadow:0 1px 0 rgba(255,255,255,.8) inset}
textarea:focus{border-color:#2dd4bf;box-shadow:0 0 0 4px rgba(45,212,191,.12)}
.actions{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap}
.btn{padding:10px 20px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:all .15s;font-family:inherit}
.btn:disabled{opacity:.45;cursor:default}
.btn-save{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;box-shadow:0 8px 18px rgba(16,185,129,.22)}
.btn-save:not(:disabled):hover{filter:saturate(1.05) brightness(1.02)}
.btn-reset{background:#fff;color:#64748b;border:1px solid rgba(203,213,225,.9)}
.btn-reset:not(:disabled):hover{color:#0f172a;border-color:#94a3b8}
.status{font-size:12px;margin-left:4px;font-weight:600}
.status-ok{color:#10b981}
.status-err{color:#ef4444}
.char-count{font-size:12px;color:#94a3b8;margin-left:auto;font-weight:600}
.page-header{text-align:center;max-width:820px;margin:0 auto 36px}
.modal-overlay{position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,0.45);display:none;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px)}
.modal-overlay.show{display:flex}
.modal-box{background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:22px;padding:32px 36px;max-width:500px;width:100%;text-align:center;box-shadow:0 24px 60px rgba(15,23,42,.18)}
.modal-box.modal-ok{border-color:#6ee7b7}
.modal-box.modal-err{border-color:#fca5a5}
.modal-icon{font-size:48px;line-height:1;margin-bottom:14px}
.modal-icon.ok{color:#10b981}
.modal-icon.err{color:#ef4444}
.modal-title{font-size:20px;font-weight:800;color:#0f172a;margin-bottom:8px;letter-spacing:-.01em}
.modal-msg{font-size:14px;color:#64748b;line-height:1.6;margin-bottom:22px;word-break:break-word}
.modal-btn{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;border:none;border-radius:999px;padding:10px 32px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 8px 18px rgba(16,185,129,.22);font-family:inherit}
.modal-btn:hover{filter:saturate(1.05) brightness(1.02)}
.last-saved{font-size:11px;color:#10b981;margin-left:8px;font-weight:600}
.variant-section{background:rgba(255,255,255,.86);backdrop-filter:blur(12px);border:1px solid rgba(203,213,225,.7);border-radius:22px;padding:28px;width:100%;max-width:820px;margin:0 auto 22px;box-shadow:0 18px 42px rgba(15,23,42,.06)}
.variant-section-title{font-size:16px;font-weight:800;color:#0f172a;margin-bottom:4px;letter-spacing:-.01em}
.variant-section-desc{font-size:13px;color:#64748b;margin-bottom:20px;line-height:1.6}
.variant-tabs{display:flex;gap:0;border-bottom:1px solid rgba(203,213,225,.6);margin-bottom:20px}
.variant-tab{padding:10px 20px;font-size:13px;font-weight:700;color:#64748b;cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s,border-color .15s;font-family:inherit}
.variant-tab.active{color:#0ea56f;border-bottom-color:#10b981}
.variant-tab:hover:not(.active){color:#0f172a}
.variant-tab-panel{display:none}
.variant-tab-panel.active{display:block}
.variant-tab-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:10px}
.variant-toggle{display:flex;align-items:center;gap:8px;font-size:13px;color:#64748b}
.toggle-switch{position:relative;width:38px;height:22px;cursor:pointer}
.toggle-switch input{opacity:0;width:0;height:0}
.toggle-track{position:absolute;inset:0;background:#cbd5e1;border-radius:999px;transition:background .2s}
.toggle-switch input:checked + .toggle-track{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%)}
.toggle-thumb{position:absolute;top:3px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(15,23,42,.18)}
.toggle-switch input:checked ~ .toggle-thumb{transform:translateX(16px)}
.toggle-label{font-weight:700}
.toggle-label.on{color:#10b981}
.toggle-label.off{color:#94a3b8}
.variant-stats-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:14px}
.variant-stats-table th{text-align:left;padding:10px 12px;color:#94a3b8;font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid rgba(203,213,225,.6)}
.variant-stats-table td{padding:11px 12px;border-bottom:1px solid rgba(226,232,240,.6);color:#475569}
.variant-stats-table tr:last-child td{border-bottom:none}
.vs-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:800}
.vs-badge-A{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe}
.vs-badge-B{background:#fff7ed;color:#b45309;border:1px solid #fdba74}
.vs-badge-C{background:#ecfdf5;color:#047857;border:1px solid #6ee7b7}
.vs-enabled{color:#10b981;font-weight:700}
.vs-disabled{color:#94a3b8;font-weight:700}
.rate-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
.rate-high{background:#ecfdf5;color:#047857;border:1px solid #a7f3d0}
.rate-mid{background:#fff7ed;color:#b45309;border:1px solid #fed7aa}
.rate-low{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}
.action-btn{display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;padding:9px 16px;border-radius:12px;border:1px solid rgba(203,213,225,.9);background:#fff;color:#334155;cursor:pointer;transition:all .15s;box-shadow:0 1px 2px rgba(15,23,42,.04);font-family:inherit}
.action-btn:hover{border-color:#94a3b8;color:#0f172a}
.action-btn-warn{background:#fff5f5;border-color:#fecaca;color:#dc2626}
.action-btn-warn:hover{background:#fee2e2;border-color:#fca5a5;color:#b91c1c}
</style>
</head>
<body>
<div class="modal-overlay" id="save-modal" role="dialog" aria-modal="true" onclick="if(event.target===this)closeModal()">
  <div class="modal-box" id="modal-box">
    <div class="modal-icon" id="modal-icon"></div>
    <div class="modal-title" id="modal-title"></div>
    <div class="modal-msg" id="modal-msg"></div>
    <button class="modal-btn" onclick="closeModal()">OK</button>
  </div>
</div>
<div class="logo">Powered Up AI</div>
<a href="/admin?key=${adminKey}" class="back-link">&larr; Back to Dashboard</a>
<div class="page-header">
  <h1>Prompt Editor</h1>
  <p class="subtitle">View and edit every AI prompt. Changes take effect immediately — no restart needed.</p>
  <div class="build-pill">BUILD v8 (fast-preview) · LOADED ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC</div>
</div>
<div id="variant-section"></div>
<div id="prompts"></div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
const ALL_PROMPTS = ${promptsJson};
const VARIANTS = ${variantsJson};

function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

// ─── Variant Section ──────────────────────────────────────────────────────────

let _activeTab = 'A';

function renderVariantSection() {
  const container = document.getElementById('variant-section');
  const tabsHtml = ['A','B','C','D'].map(v =>
    \`<button class="variant-tab\${v===_activeTab?' active':''}" onclick="setTab('\${v}')">Variant \${v}</button>\`
  ).join('');

  const panelsHtml = VARIANTS.map(vd => {
    const isActive = vd.variant === _activeTab;
    const charCount = vd.text.length;
    return \`
      <div class="variant-tab-panel\${isActive?' active':''}" id="vp-\${vd.variant}">
        <div class="variant-tab-header">
          <div style="font-size:13px;color:#888">Discovery script for contacts assigned to Variant \${vd.variant}</div>
          <div class="variant-toggle">
            <span class="toggle-label \${vd.enabled?'on':'off'}" id="vtl-\${vd.variant}">\${vd.enabled?'Enabled':'Disabled'}</span>
            <label class="toggle-switch" title="Enable / disable this variant">
              <input type="checkbox" id="vtog-\${vd.variant}" \${vd.enabled?'checked':''} onchange="toggleVariant('\${vd.variant}',this.checked)">
              <span class="toggle-track"></span>
              <span class="toggle-thumb"></span>
            </label>
          </div>
        </div>
        <textarea id="vta-\${vd.variant}" rows="16" spellcheck="false" \${vd.enabled?'':'readonly style="opacity:.45;cursor:not-allowed"'}>\${escapeHtml(vd.text)}</textarea>
        <div class="actions">
          <button class="btn btn-save" id="vsave-\${vd.variant}" onclick="saveVariant('\${vd.variant}')" \${vd.enabled?'':'disabled'}>Save Variant \${vd.variant}</button>
          <span class="status" id="vstatus-\${vd.variant}"></span>
          <span class="char-count" id="vchars-\${vd.variant}">\${charCount} chars</span>
          \${vd.enabled?'':'<span style="font-size:12px;color:#555;margin-left:8px">Enable variant to edit</span>'}
        </div>
      </div>
    \`;
  }).join('');

  container.innerHTML = \`
    <div style="max-width:820px;margin:0 auto 0;padding-bottom:12px;border-bottom:1px solid rgba(203,213,225,.6);margin-bottom:20px">
      <span style="font-size:12px;font-weight:800;letter-spacing:.12em;color:#64748b;text-transform:uppercase">Discovery Script Variants (A / B / C / D)</span>
    </div>
    <div class="variant-section" id="variant-card">
      <div class="variant-section-title">A/B/C/D Discovery Script Testing</div>
      <div class="variant-section-desc">Each new contact is permanently assigned one variant. Edit scripts independently below, then enable or disable each variant from the rotation.</div>
      <div class="variant-tabs">\${tabsHtml}</div>
      <div id="variant-panels">\${panelsHtml}</div>
      <div style="margin-top:26px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">
        <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:12px;letter-spacing:-.01em">Performance Comparison</div>
        <div id="variant-stats-table"><span style="font-size:13px;color:#94a3b8">Loading stats\u2026</span></div>
      </div>
      <div style="margin-top:24px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">
        <div style="font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Data Reset</div>
        <div style="font-size:13px;color:#64748b;margin-bottom:14px;line-height:1.6">Wipe all variant assignments and start tracking from scratch. Everything else (contacts, replies, bookings, follow-ups) is kept.</div>
        <button class="action-btn action-btn-warn" onclick="resetVariantData()">Reset Variant Data</button>
        <span id="variant-reset-status" style="margin-left:12px;font-size:13px;color:#64748b;font-weight:600"></span>
      </div>
    </div>
  \`;

  // Bind char counters
  VARIANTS.forEach(vd => {
    const ta = document.getElementById('vta-' + vd.variant);
    if (ta) ta.addEventListener('input', () => {
      document.getElementById('vchars-' + vd.variant).textContent = ta.value.length + ' chars';
    });
  });

  loadVariantStats();
}

function setTab(v) {
  _activeTab = v;
  document.querySelectorAll('.variant-tab').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.variant-tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.variant-tab').forEach(btn => { if (btn.textContent.includes(v)) btn.classList.add('active'); });
  const panel = document.getElementById('vp-' + v);
  if (panel) panel.classList.add('active');
}

async function saveVariant(v) {
  const ta = document.getElementById('vta-' + v);
  const statusEl = document.getElementById('vstatus-' + v);
  if (!ta) return;
  const name = 'conversationPrompt.' + v;
  showModal('Saving\u2026', 'Saving Variant ' + v + ' script\u2026', false);
  try {
    const res = await fetch('/admin/prompts/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ text: ta.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const timeStr = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    statusEl.innerHTML = '\u2713 Saved <span class="last-saved">at ' + timeStr + '</span>';
    statusEl.className = 'status status-ok';
    const vd = VARIANTS.find(x => x.variant === v);
    if (vd) vd.text = ta.value;
    showModal('Variant Saved', 'Variant ' + v + ' script saved at ' + timeStr + '.', false);
  } catch(err) {
    statusEl.textContent = '\u2717 Error: ' + err.message;
    statusEl.className = 'status status-err';
    showModal('Save Failed', 'Could not save Variant ' + v + ': ' + err.message, true);
  }
}

async function toggleVariant(v, enabled) {
  const statusEl = document.getElementById('vstatus-' + v);
  const labelEl  = document.getElementById('vtl-' + v);
  const chk      = document.getElementById('vtog-' + v);
  const ta       = document.getElementById('vta-' + v);
  const saveBtn  = document.getElementById('vsave-' + v);
  try {
    const res = await fetch('/admin/variants/' + v + '/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const vd = VARIANTS.find(x => x.variant === v);
    if (vd) vd.enabled = enabled;
    // Update label
    labelEl.textContent = enabled ? 'Enabled' : 'Disabled';
    labelEl.className = 'toggle-label ' + (enabled ? 'on' : 'off');
    // Lock / unlock editor
    if (ta) {
      ta.readOnly = !enabled;
      ta.style.opacity = enabled ? '' : '0.45';
      ta.style.cursor  = enabled ? '' : 'not-allowed';
    }
    if (saveBtn) saveBtn.disabled = !enabled;
    if (statusEl) { statusEl.textContent = enabled ? '\u2713 Enabled' : 'Disabled'; statusEl.className = 'status ' + (enabled ? 'status-ok' : ''); }
  } catch(err) {
    if (chk) chk.checked = !enabled; // revert
    showModal('Toggle Failed', 'Could not toggle Variant ' + v + ': ' + err.message, true);
  }
}

// Persisted on the table container so the chosen Lead Form filter survives
// the prompt editor's normal refresh cycles.
async function loadVariantStats() {
  const el = document.getElementById('variant-stats-table');
  if (!el) return;
  try {
    const activeForm = el.dataset.leadFormFilter || '';
    const url = '/api/brain/variants' + (activeForm ? ('?leadForm=' + encodeURIComponent(activeForm)) : '');
    const res = await fetch(url, { headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    if (!res.ok || !data.variants) { el.innerHTML = '<span style="font-size:13px;color:#555">No variant data yet.</span>'; return; }
    const vv = data.variants;

    function ratePill(rate) {
      if (rate === null || rate === undefined) return '<span style="color:#555">—</span>';
      const cls = rate >= 30 ? 'rate-high' : rate >= 10 ? 'rate-mid' : 'rate-low';
      return \`<span class="rate-pill \${cls}">\${rate}%</span>\`;
    }

    const rows = vv.map(v => \`<tr>
      <td><span class="vs-badge vs-badge-\${v.variant}">\${v.variant}</span></td>
      <td><span class="\${v.enabled?'vs-enabled':'vs-disabled'}">\${v.enabled?'Yes':'No'}</span></td>
      <td>\${v.contactsAssigned}</td>
      <td>\${ratePill(v.repliedOncePct)}</td>
      <td>\${ratePill(v.replied4Pct)}</td>
      <td>\${ratePill(v.bookingRatePct)}</td>
    </tr>\`).join('');

    // Lead Form filter chips — render whenever any form bucket exists
    // (matching the Performance dashboard, which always shows the picker).
    // The "All forms" pill is always present so a single-bucket setup still
    // shows the user the filter exists.
    const forms = data.leadForms || [];
    let chips = '';
    if (forms.length >= 1) {
      const items = ['', ...forms].map(f => {
        const label = f === '' ? 'All forms' : f;
        const isActive = (f === '' && !activeForm) || (f !== '' && f === activeForm);
        const style = isActive
          ? 'background:#0ea56f;color:#fff;border-color:#0ea56f'
          : 'background:#f1f5f9;color:#0f172a;border-color:#cbd5e1';
        return \`<button type="button" onclick="setVariantStatsLeadFormFilter(\${JSON.stringify(f)})" style="padding:4px 10px;border-radius:999px;border:1px solid;cursor:pointer;font-size:11px;font-weight:600;\${style}">\${escHtml(label)}</button>\`;
      }).join('');
      chips = \`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;align-items:center"><span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-right:4px">Lead form:</span>\${items}</div>\`;
    }

    el.innerHTML = \`\${chips}<table class="variant-stats-table">
      <thead><tr>
        <th>Variant</th><th>Enabled</th><th>Contacts</th><th>Replied Once</th><th>4+ Replies</th><th>Booking Rate</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
  } catch(err) {
    el.innerHTML = '<span style="font-size:13px;color:#ef4444">Failed to load stats: ' + err.message + '</span>';
  }
}

function setVariantStatsLeadFormFilter(form) {
  const el = document.getElementById('variant-stats-table');
  if (!el) return;
  el.dataset.leadFormFilter = form || '';
  loadVariantStats();
}

async function resetVariantData() {
  const statusEl = document.getElementById('variant-reset-status');
  if (!confirm('This will wipe all variant assignments from every contact and start fresh.\\n\\nEverything else (contacts, replies, bookings, follow-ups) stays intact.\\n\\nContinue?')) return;
  statusEl.textContent = 'Resetting\u2026';
  try {
    const res = await fetch('/api/admin/reset-variants', {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    statusEl.style.color = '#22c55e';
    statusEl.textContent = \`Done — \${data.contactsCleared} contacts cleared. New leads will be assigned fresh.\`;
    loadVariantStats();
  } catch (err) {
    statusEl.style.color = '#ef4444';
    statusEl.textContent = 'Error: ' + err.message;
  }
}

function renderPrompts() {
  const container = document.getElementById('prompts');
  container.innerHTML = '';
  // 'conversationPrompt' is now managed by the A/B/C variant tabs above — skip it here.
  ALL_PROMPTS.filter(p => p.name !== 'conversationPrompt').forEach(p => {
    if (p.sectionLabel) {
      const heading = document.createElement('div');
      heading.style.cssText = 'max-width:820px;margin:40px auto 20px;padding-bottom:10px;border-bottom:1px solid rgba(203,213,225,.6);';
      heading.innerHTML = \`<span style="font-size:13px;font-weight:700;letter-spacing:.06em;color:#555;text-transform:uppercase">\${escapeHtml(p.sectionLabel)}</span>\`;
      container.appendChild(heading);
    }
    const card = document.createElement('div');
    card.className = 'prompt-card' + (p.isModified ? ' modified' : '');
    card.id = 'card-' + p.name;
    card.innerHTML = \`
      <div class="prompt-header">
        <div class="prompt-label">\${escapeHtml(p.label)}</div>
        <span class="badge \${p.isModified ? 'badge-modified' : 'badge-default'}" id="badge-\${p.name}">
          \${p.isModified ? 'Modified' : 'Default'}
        </span>
      </div>
      <div class="prompt-desc">\${escapeHtml(p.description)}</div>
      <textarea id="ta-\${p.name}" rows="14" spellcheck="false">\${escapeHtml(p.current)}</textarea>
      <div class="actions">
        <button class="btn btn-save" id="save-\${p.name}" data-name="\${p.name}">Save</button>
        <button class="btn btn-reset" id="reset-\${p.name}" data-name="\${p.name}" \${p.isModified ? '' : 'disabled'}>Reset to default</button>
        <span class="status" id="status-\${p.name}"></span>
        <span class="char-count" id="chars-\${p.name}">\${p.current.length} chars</span>
      </div>
    \`;
    container.appendChild(card);
    // Bind via addEventListener to avoid HTML attribute escaping issues with quotes in prompt names.
    document.getElementById('save-' + p.name).addEventListener('click', () => savePrompt(p.name));
    document.getElementById('reset-' + p.name).addEventListener('click', () => resetPrompt(p.name));
    const ta = document.getElementById('ta-' + p.name);
    ta.addEventListener('input', () => {
      document.getElementById('chars-' + p.name).textContent = ta.value.length + ' chars';
    });
  });
}

function showModal(title, msg, isError) {
  const overlay = document.getElementById('save-modal');
  const box = document.getElementById('modal-box');
  const icon = document.getElementById('modal-icon');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-msg').textContent = msg;
  if (isError) {
    box.className = 'modal-box modal-err';
    icon.className = 'modal-icon err';
    icon.textContent = '\u2717';
  } else {
    box.className = 'modal-box modal-ok';
    icon.className = 'modal-icon ok';
    icon.textContent = '\u2713';
  }
  overlay.classList.add('show');
}
function closeModal() {
  document.getElementById('save-modal').classList.remove('show');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

async function savePrompt(name) {
  console.log('[Prompts] savePrompt called for:', name);
  const ta = document.getElementById('ta-' + name);
  const saveBtn = document.getElementById('save-' + name);
  const resetBtn = document.getElementById('reset-' + name);
  const statusEl = document.getElementById('status-' + name);
  const label = ALL_PROMPTS.find(x => x.name === name)?.label || name;
  // Show modal IMMEDIATELY so user knows the click registered.
  showModal('Saving\u2026', 'Sending "' + label + '" to the server. This box will update when the save completes.', false);
  saveBtn.disabled = true;
  statusEl.textContent = 'Saving\u2026';
  statusEl.className = 'status';
  try {
    const res = await fetch('/admin/prompts/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ text: ta.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const timeStr = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    statusEl.innerHTML = '\u2713 Saved <span class="last-saved">at ' + timeStr + '</span>';
    statusEl.className = 'status status-ok';
    const p = ALL_PROMPTS.find(x => x.name === name);
    if (p) { p.current = ta.value; p.isModified = true; }
    document.getElementById('badge-' + name).textContent = 'Modified';
    document.getElementById('badge-' + name).className = 'badge badge-modified';
    document.getElementById('card-' + name).className = 'prompt-card modified';
    resetBtn.disabled = false;
    showModal('Prompt Saved', '"' + label + '" was saved successfully at ' + timeStr + '. Refresh the page to confirm — your edits will still be there.', false);
  } catch(err) {
    statusEl.textContent = '\u2717 Error: ' + err.message;
    statusEl.className = 'status status-err';
    showModal('Save Failed', 'Could not save "' + label + '". Reason: ' + err.message, true);
  } finally {
    saveBtn.disabled = false;
  }
}

async function resetPrompt(name) {
  const label = ALL_PROMPTS.find(x => x.name === name)?.label || name;
  if (!confirm('Reset "' + label + '" to its hardcoded default? This will discard your edits.')) return;
  const resetBtn = document.getElementById('reset-' + name);
  const statusEl = document.getElementById('status-' + name);
  resetBtn.disabled = true;
  statusEl.textContent = 'Resetting\u2026';
  statusEl.className = 'status';
  try {
    const res = await fetch('/admin/prompts/' + encodeURIComponent(name) + '/reset', {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const ta = document.getElementById('ta-' + name);
    ta.value = data.text;
    document.getElementById('chars-' + name).textContent = data.text.length + ' chars';
    statusEl.textContent = 'Reset to default';
    statusEl.className = 'status status-ok';
    const p = ALL_PROMPTS.find(x => x.name === name);
    if (p) { p.current = data.text; p.isModified = false; }
    document.getElementById('badge-' + name).textContent = 'Default';
    document.getElementById('badge-' + name).className = 'badge badge-default';
    document.getElementById('card-' + name).className = 'prompt-card';
    showModal('Prompt Reset', '"' + label + '" has been reset to its default value.', false);
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
  } catch(err) {
    statusEl.textContent = '\u2717 Error: ' + err.message;
    statusEl.className = 'status status-err';
    resetBtn.disabled = false;
    showModal('Reset Failed', 'Could not reset "' + label + '". Reason: ' + err.message, true);
  }
}

renderVariantSection();
renderPrompts();
</script>
</body>
</html>`;
}

// ─── Admin Enroll Page ────────────────────────────────────────────────────────

function buildEnrollPage(adminKey) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lead Enrollment — Powered Up AI</title>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:
  radial-gradient(circle at 8% 82%, rgba(45,212,191,.12) 0, rgba(45,212,191,0) 26%),
  radial-gradient(circle at 92% 12%, rgba(56,189,248,.12) 0, rgba(56,189,248,0) 24%),
  linear-gradient(180deg,#fbfbfb 0%,#f7fbfb 48%,#ffffff 100%);
  color:#0f172a;font-family:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:32px 16px 80px;-webkit-font-smoothing:antialiased}
.logo{font-size:12px;font-weight:600;letter-spacing:.32em;color:#9ca3af;text-transform:uppercase;text-align:center;margin-bottom:28px}
h1{font-size:clamp(36px,5.5vw,56px);font-weight:900;color:#0f172a;text-align:center;margin-bottom:14px;letter-spacing:-.04em;line-height:1}
.subtitle{font-size:15px;color:#475569;text-align:center;margin-bottom:14px;line-height:1.65;max-width:680px;margin-left:auto;margin-right:auto}
.build-pill{display:inline-block;margin-top:14px;padding:7px 16px;background:rgba(255,255,255,.88);border:1px solid rgba(148,163,184,.28);box-shadow:0 8px 22px rgba(15,23,42,.06);color:#334155;font-size:12px;font-weight:700;border-radius:999px;letter-spacing:.04em}
.panel{background:rgba(255,255,255,.86);backdrop-filter:blur(12px);border:1px solid rgba(203,213,225,.7);border-radius:22px;padding:28px;width:100%;max-width:1080px;margin:0 auto 22px;box-shadow:0 18px 42px rgba(15,23,42,.06)}
.panel-title{font-size:16px;font-weight:800;color:#0f172a;margin-bottom:18px;display:flex;align-items:center;gap:10px;letter-spacing:-.01em}
.panel-title a{font-size:13px;font-weight:600;color:#0ea56f;text-decoration:none;margin-left:auto}
.panel-title a:hover{text-decoration:underline}
.controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:0}
label{font-size:13px;color:#64748b;font-weight:600}
input[type=text]{background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:12px;color:#0f172a;font-size:13px;padding:10px 14px;width:220px;outline:none;font-family:inherit;transition:border-color .15s,box-shadow .15s;box-shadow:0 1px 0 rgba(255,255,255,.8) inset}
input[type=text]:focus{border-color:#2dd4bf;box-shadow:0 0 0 4px rgba(45,212,191,.12)}
button{cursor:pointer;font-size:13px;font-weight:700;padding:10px 20px;border-radius:12px;border:none;transition:all .15s;font-family:inherit}
button:disabled{opacity:.45;cursor:default}
.btn-preview{background:#fff;color:#334155;border:1px solid rgba(203,213,225,.9);box-shadow:0 1px 2px rgba(15,23,42,.04)}
.btn-preview:hover:not(:disabled){border-color:#94a3b8;color:#0f172a;box-shadow:0 4px 10px rgba(15,23,42,.06)}
.btn-run{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;box-shadow:0 8px 18px rgba(16,185,129,.22)}
.btn-run:hover:not(:disabled){filter:saturate(1.05) brightness(1.02)}
.status-bar{font-size:13px;color:#64748b;margin-top:14px;min-height:20px;font-weight:500}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:14px;margin-bottom:0}
.stat-box{background:rgba(248,250,252,.72);border:1px solid rgba(203,213,225,.7);border-radius:14px;padding:16px 12px;text-align:center}
.stat-box .val{font-size:28px;font-weight:900;color:#0f172a;line-height:1;letter-spacing:-.02em}
.stat-box .lbl{font-size:11px;color:#64748b;margin-top:6px;text-transform:uppercase;letter-spacing:.1em;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#94a3b8;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.08em;padding:0 12px 10px;border-bottom:1px solid rgba(203,213,225,.6)}
td{padding:11px 12px;border-bottom:1px solid rgba(226,232,240,.6);color:#475569;vertical-align:top}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap}
.badge-enroll{background:#ecfdf5;color:#047857;border:1px solid #6ee7b7}
.badge-skip{background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}
.badge-error{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.empty{color:#94a3b8;font-size:13px;padding:24px 0;text-align:center}
.warn{color:#b45309;font-size:13px;margin-top:10px;font-weight:600;padding:10px 14px;background:#fff7ed;border:1px solid #fdba74;border-radius:12px}
.err{color:#b91c1c;font-size:14px;font-weight:700;margin-top:10px;padding:12px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:12px}
</style>
</head>
<body>
<div class="logo">Powered Up AI</div>
<div style="text-align:center;max-width:1080px;margin:0 auto 36px">
  <h1>Lead Enrollment</h1>
  <p class="subtitle">Preview and enroll GHL contacts into the follow-up sequence.<br>Run a dry-run first to see what will happen, then click Run Enrollment to commit.</p>
  <div class="build-pill">BUILD v8 (fast-preview) · LOADED ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC</div>
</div>

<div class="panel">
  <div class="panel-title">Controls <a href="/admin?key=${adminKey}">&larr; Dashboard</a></div>
  <div class="controls">
    <label for="tag-input">Tag</label>
    <input type="text" id="tag-input" value="" placeholder="enter your GHL tag name">
    <button class="btn-preview" id="btn-preview" onclick="doPreview()">Preview (Dry Run)</button>
    <button class="btn-run" id="btn-run" onclick="doRun()" disabled>Run Enrollment</button>
  </div>
  <div class="status-bar" id="status-bar"></div>
</div>

<div class="panel" id="stats-panel" style="display:none">
  <div class="panel-title">Summary</div>
  <div class="stat-grid" id="stat-grid"></div>
</div>

<div class="panel" id="results-panel" style="display:none">
  <div class="panel-title" id="results-title">Results</div>
  <div id="results-content"></div>
</div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
let lastRows = [];

function setStatus(msg, level) {
  // level: undefined/falsy = info, 'warn' = yellow, 'err' = red box
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  if (level === 'err')       el.className = 'status-bar err';
  else if (level === 'warn') el.className = 'status-bar warn';
  else                       el.className = 'status-bar';
}

function setBusy(busy) {
  document.getElementById('btn-preview').disabled = busy;
  document.getElementById('btn-run').disabled = busy;
}

function renderStats(stats, dryRun) {
  const panel = document.getElementById('stats-panel');
  panel.style.display = '';
  const scannedNote = stats.scanned != null ? \`<div class="stat-box"><div class="val" style="color:#888">\${stats.scanned}</div><div class="lbl">Contacts Scanned</div></div>\` : '';
  document.getElementById('stat-grid').innerHTML = \`
    \${scannedNote}
    <div class="stat-box"><div class="val">\${stats.total}</div><div class="lbl">Matched Tag</div></div>
    <div class="stat-box"><div class="val" style="color:#4ade80">\${stats.enrolled}</div><div class="lbl">\${dryRun ? 'Would Enroll' : 'Enrolled'}</div></div>
    <div class="stat-box"><div class="val" style="color:#888">\${stats.skipped}</div><div class="lbl">Skipped</div></div>
    <div class="stat-box"><div class="val" style="color:#f87171">\${stats.errors}</div><div class="lbl">Errors</div></div>
  \`;
  if (stats.total === 0 && stats.scanned > 0) {
    setStatus(\`No contacts matched the tag "\${document.getElementById('tag-input').value.trim()}". Check the tag name — it must match exactly (case-insensitive) the tag on your GHL contacts.\`, 'warn');
  }
}

function badgeFor(action) {
  if (action === 'ENROLL') return '<span class="badge badge-enroll">Enroll</span>';
  if (action === 'SKIP')   return '<span class="badge badge-skip">Skip</span>';
  return '<span class="badge badge-error">Error</span>';
}

function renderRows(rows, dryRun) {
  const panel = document.getElementById('results-panel');
  panel.style.display = '';
  document.getElementById('results-title').textContent =
    dryRun ? 'Preview — no changes written' : 'Enrollment Results';

  if (!rows.length) {
    document.getElementById('results-content').innerHTML = '<div class="empty">No contacts found.</div>';
    return;
  }

  const rowsHtml = rows.map(r => \`
    <tr>
      <td>\${esc(r.firstName)}</td>
      <td>\${esc(r.phone)}</td>
      <td>\${esc(r.city || '—')}</td>
      <td>\${badgeFor(r.action)}</td>
      <td>\${r.position != null ? r.position : '—'}</td>
      <td>\${r.step != null ? r.step : '—'}</td>
      <td style="color:#777;font-size:12px">\${esc(r.reason || '')}</td>
    </tr>
  \`).join('');

  document.getElementById('results-content').innerHTML = \`
    <table>
      <thead><tr>
        <th>Name</th><th>Phone</th><th>City</th><th>Action</th><th>Pos</th><th>Step</th><th>Reason</th>
      </tr></thead>
      <tbody>\${rowsHtml}</tbody>
    </table>
  \`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Poll a background job until done. Shows elapsed time in the status bar.
async function pollJob(jobId, dryRun) {
  const start = Date.now();
  while (true) {
    await new Promise(r => setTimeout(r, 2500));
    const secs = Math.round((Date.now() - start) / 1000);
    setStatus('Scanning GHL contacts\u2026 ' + secs + 's elapsed (safe to wait \u2014 no timeout)');
    let data;
    try {
      const r = await fetch('/api/enroll/status/' + jobId, { headers: { 'x-admin-key': ADMIN_KEY } });
      data = await r.json();
    } catch (e) { continue; }
    if (data.status === 'running') continue;
    if (!data.ok || data.status === 'error') throw new Error(data.error || 'Unknown error');
    return data; // status === 'done'
  }
}

async function startJob(tag, dryRun) {
  const res = await fetch('/api/enroll/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ tag, dryRun })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
  return data.jobId;
}

async function doPreview() {
  const tag = document.getElementById('tag-input').value.trim();
  if (!tag) { setStatus('Please enter a GHL tag name first.', 'err'); return; }
  setBusy(true);
  setStatus('Starting scan\u2026');
  document.getElementById('stats-panel').style.display = 'none';
  document.getElementById('results-panel').style.display = 'none';
  document.getElementById('btn-run').disabled = true;
  try {
    const jobId = await startJob(tag, true);
    setStatus('Scanning GHL contacts\u2026 0s elapsed (safe to wait \u2014 no timeout)');
    const data = await pollJob(jobId, true);
    lastRows = data.rows || [];
    renderStats(data.stats, true);
    renderRows(data.rows, true);
    setStatus(data.stats.total > 0
      ? 'Dry-run complete. Review the table, then click Run Enrollment to commit.'
      : 'Scan complete \u2014 no contacts matched that tag.');
    document.getElementById('btn-run').disabled = (data.stats.total === 0);
  } catch (err) {
    setStatus('\u2717 Error: ' + err.message, 'err');
  } finally {
    document.getElementById('btn-preview').disabled = false;
  }
}

async function doRun() {
  const tag = document.getElementById('tag-input').value.trim();
  if (!confirm('This will write to conversations and schedule follow-up jobs. Continue?')) return;
  setBusy(true);
  setStatus('Starting enrollment\u2026');
  try {
    const jobId = await startJob(tag, false);
    setStatus('Enrolling contacts\u2026 0s elapsed (safe to wait \u2014 no timeout)');
    const data = await pollJob(jobId, false);
    renderStats(data.stats, false);
    renderRows(data.rows, false);
    setStatus('Enrollment complete.');
  } catch (err) {
    setStatus('\u2717 Error: ' + err.message, 'err');
  } finally {
    setBusy(false);
  }
}
</script>
</body>
</html>`;
}

// ─── Admin: Conversation Tester (Playground) Page ─────────────────────────────

function buildPlaygroundPage(adminKey) {
  const enabledVariants = prompts.getEnabledVariants();
  const enabledJson = JSON.stringify(enabledVariants);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversation Tester — Powered Up AI</title>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
.screen{position:relative;min-height:100vh;overflow:hidden;background:
  radial-gradient(circle at 8% 82%, rgba(45,212,191,.12) 0, rgba(45,212,191,0) 26%),
  radial-gradient(circle at 92% 12%, rgba(56,189,248,.12) 0, rgba(56,189,248,0) 24%),
  linear-gradient(180deg,#fbfbfb 0%,#f7fbfb 48%,#ffffff 100%);
  color:#1f2937;font-family:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:22px 16px 80px}
.logo{font-size:12px;font-weight:600;letter-spacing:.32em;color:#9ca3af;text-transform:uppercase;text-align:center;margin-bottom:28px}
.back{max-width:1180px;margin:0 auto 10px;display:block}
.back a{color:#6b7280;font-size:13px;text-decoration:none;font-weight:600}
.page-header{text-align:center;max-width:920px;margin:0 auto 28px}
h1{font-size:clamp(42px,7vw,74px);line-height:.95;font-weight:900;letter-spacing:-.06em;color:#0f172a;margin-bottom:14px}
.subtitle{font-size:18px;color:#475569;line-height:1.7;max-width:760px;margin:0 auto}
.badge{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.88);border:1px solid rgba(148,163,184,.28);box-shadow:0 8px 30px rgba(15,23,42,.06);border-radius:999px;padding:9px 16px;font-size:14px;font-weight:600;color:#334155;margin-bottom:22px}
.badge:before{content:'';width:8px;height:8px;border-radius:999px;background:linear-gradient(135deg,#10b981,#14b8a6)}
.hero-actions{display:flex;justify-content:center;gap:18px;flex-wrap:wrap;margin-top:30px}
.hero-btn{display:inline-flex;align-items:center;justify-content:center;min-width:152px;height:48px;padding:0 22px;border-radius:999px;border:1px solid rgba(16,185,129,.35);background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;font-size:15px;font-weight:700;text-decoration:none;box-shadow:0 12px 24px rgba(16,185,129,.22),inset 0 1px 0 rgba(255,255,255,.28)}
.hero-link{display:inline-flex;align-items:center;justify-content:center;height:48px;padding:0 10px;color:#334155;font-size:15px;font-weight:600;text-decoration:none}
.hero-link span{margin-left:8px}
.layout{max-width:1180px;margin:34px auto 0;display:grid;grid-template-columns:1fr 330px;gap:24px}
@media (max-width:880px){.layout{grid-template-columns:1fr}}
.chat-card{background:rgba(255,255,255,.82);backdrop-filter:blur(14px);border:1px solid rgba(203,213,225,.7);box-shadow:0 22px 50px rgba(15,23,42,.08);border-radius:22px;padding:0;display:flex;flex-direction:column;min-height:560px;overflow:hidden}
.controls{padding:18px 20px;border-bottom:1px solid rgba(203,213,225,.7);display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;background:rgba(255,255,255,.55)}
.control{display:flex;flex-direction:column;gap:6px}
.control label{font-size:11px;color:#64748b;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.control input{background:rgba(255,255,255,.9);border:1px solid rgba(203,213,225,.9);border-radius:12px;color:#0f172a;font-size:13px;padding:10px 12px;outline:none;width:160px;box-shadow:0 1px 0 rgba(255,255,255,.8) inset}
.control input:focus{border-color:#2dd4bf;box-shadow:0 0 0 4px rgba(45,212,191,.12)}
.variant-pills{display:flex;gap:6px}
.vpill{padding:8px 14px;border-radius:12px;font-size:13px;font-weight:800;cursor:pointer;border:1px solid rgba(203,213,225,.9);background:#fff;color:#64748b;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.vpill.active.A{background:linear-gradient(180deg,#edf2ff,#e0e7ff);color:#374151;border-color:#93c5fd}
.vpill.active.B{background:linear-gradient(180deg,#fff7ed,#ffedd5);color:#92400e;border-color:#fdba74}
.vpill.active.C{background:linear-gradient(180deg,#ecfdf5,#d1fae5);color:#065f46;border-color:#6ee7b7}
.vpill.active.CUSTOM{background:linear-gradient(180deg,#f5f3ff,#ede9fe);color:#5b21b6;border-color:#c4b5fd}
.vpill.scan.active.SCAN-REAL{background:linear-gradient(180deg,#ecfeff,#cffafe);color:#0e7490;border-color:#67e8f9}
.vpill.scan.active.SCAN-STUB{background:linear-gradient(180deg,#fef9c3,#fef08a);color:#854d0e;border-color:#fde047}
.vpill.disabled{opacity:.4;cursor:not-allowed;text-decoration:line-through}
.bubble.scan-status{background:#fff7ed;border:1px dashed #fdba74;color:#92400e;font-style:italic}
.bubble.scan-status.complete{background:#ecfdf5;border-color:#6ee7b7;color:#065f46;font-style:normal}
.bubble.scan-status.failed{background:#fef2f2;border-color:#fca5a5;color:#991b1b;font-style:normal}
.custom-prompt-row{padding:14px 20px;border-bottom:1px solid rgba(203,213,225,.7);background:rgba(245,243,255,.45);display:none}
.custom-prompt-row.visible{display:block}
.custom-prompt-row label{display:block;font-size:11px;color:#5b21b6;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
.custom-prompt-row textarea{width:100%;background:#fff;border:1px solid rgba(196,181,253,.9);border-radius:12px;color:#0f172a;font-family:'SF Mono',Consolas,monospace;font-size:12px;line-height:1.55;padding:10px 12px;outline:none;resize:vertical;min-height:120px;box-shadow:0 1px 0 rgba(255,255,255,.8) inset}
.custom-prompt-row textarea:focus{border-color:#8b5cf6;box-shadow:0 0 0 4px rgba(139,92,246,.12)}
.custom-prompt-row .hint{font-size:11px;color:#7c3aed;margin-top:6px;font-style:italic}
.start-cta{display:flex;flex-direction:column;align-items:center;gap:14px;padding:18px 0}
.btn-start{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:14px 26px;border-radius:999px;border:1px solid rgba(16,185,129,.35);background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;font-size:15px;font-weight:800;cursor:pointer;box-shadow:0 12px 24px rgba(16,185,129,.22),inset 0 1px 0 rgba(255,255,255,.28)}
.btn-start:hover:not(:disabled){filter:saturate(1.05) brightness(1.02)}
.btn-start:disabled{opacity:.5;cursor:default}
.start-or{font-size:12px;color:#94a3b8;letter-spacing:.12em;text-transform:uppercase;font-weight:700}
.btn-reset{margin-left:auto;background:#fff;color:#64748b;border:1px solid rgba(203,213,225,.9);padding:10px 16px;border-radius:12px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.btn-reset:hover{color:#0f172a;border-color:#94a3b8}
.messages{flex:1;padding:26px 24px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;min-height:360px;max-height:520px}
.empty-state{margin:auto;text-align:center;color:#94a3b8;font-size:14px;line-height:1.8;max-width:380px}
.bubble{max-width:78%;padding:12px 16px;border-radius:20px;font-size:15px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 10px 22px rgba(15,23,42,.05)}
.bubble.user{align-self:flex-end;background:linear-gradient(180deg,#16c18b,#0ea36f);color:#fff;border-bottom-right-radius:6px}
.bubble.ai{align-self:flex-start;background:rgba(255,255,255,.96);color:#0f172a;border-bottom-left-radius:6px;border:1px solid rgba(203,213,225,.9)}
.bubble.ai.thinking{color:#94a3b8;font-style:italic}
.bubble-meta{font-size:10px;color:#94a3b8;margin-top:4px;letter-spacing:.08em;text-transform:uppercase;font-weight:700}
.bubble.user .bubble-meta{color:rgba(255,255,255,0.78);text-align:right}
.input-row{padding:14px 16px;border-top:1px solid rgba(203,213,225,.7);display:flex;gap:10px;background:rgba(255,255,255,.66)}
.input-row textarea{flex:1;background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:16px;color:#0f172a;font-family:inherit;font-size:14px;padding:12px 14px;outline:none;resize:none;min-height:46px;max-height:140px;line-height:1.45;box-shadow:0 1px 0 rgba(255,255,255,.8) inset}
.input-row textarea:focus{border-color:#2dd4bf;box-shadow:0 0 0 4px rgba(45,212,191,.12)}
.btn-send{background:linear-gradient(180deg,#25c58c,#0ea56f);color:#fff;border:none;border-radius:16px;padding:0 22px;font-size:14px;font-weight:800;cursor:pointer;align-self:stretch;box-shadow:0 12px 24px rgba(16,185,129,.18)}
.btn-send:hover:not(:disabled){filter:saturate(1.05) brightness(1.01)}
.btn-send:disabled{opacity:.45;cursor:default}
.sidebar{display:flex;flex-direction:column;gap:16px}
.side-card{background:rgba(255,255,255,.82);backdrop-filter:blur(14px);border:1px solid rgba(203,213,225,.7);border-radius:18px;padding:18px 20px;box-shadow:0 18px 40px rgba(15,23,42,.06)}
.side-title{font-size:11px;color:#64748b;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px}
.stat-row{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;color:#64748b;padding:6px 0}
.stat-row .v{color:#0f172a;font-weight:700;font-variant-numeric:tabular-nums}
.markers-list{display:flex;flex-direction:column;gap:6px}
.marker{font-size:12px;font-family:'SF Mono',Consolas,monospace;background:#f8fafc;padding:7px 10px;border-radius:10px;color:#475569;border:1px solid rgba(203,213,225,.9);word-break:break-all}
.marker .mtag{color:#10b981;font-weight:800;margin-right:6px}
.muted{color:#94a3b8;font-size:12px;font-style:italic;text-align:center;padding:6px 0}
.system-prev{font-size:11px;color:#475569;font-family:'SF Mono',Consolas,monospace;background:#f8fafc;padding:10px 12px;border-radius:10px;line-height:1.55;max-height:160px;overflow-y:auto;border:1px solid rgba(203,213,225,.9);white-space:pre-wrap;word-wrap:break-word}
.warn-banner{max-width:1180px;margin:0 auto 20px;background:rgba(236,253,245,.82);border:1px solid rgba(110,231,183,.55);border-radius:16px;padding:12px 16px;font-size:13px;color:#334155;line-height:1.6;box-shadow:0 10px 24px rgba(15,23,42,.05)}
.warn-banner b{color:#0f766e}
</style>
</head>
<body>
<div class="screen">
<div class="logo">Powered Up AI</div>
<div class="back"><a href="/admin?key=${adminKey}">&larr; Back to Dashboard</a></div>
<div class="page-header">
  <div class="badge">Built exclusively for audiology practices</div>
  <h1>Conversation Tester</h1>
  <p class="subtitle">Talk to the AI as a fake prospect. Pick a variant (A, B, or C) — or paste a Custom prompt — to compare them. Hit ▶ Start Conversation to have the AI open first, or just type a message yourself. Real Claude calls run, but nothing writes to the database, no SMS goes out, no follow-ups schedule.</p>
  <div class="hero-actions">
    <a class="hero-btn" href="/admin?key=${adminKey}">Back to Dashboard</a>
    <a class="hero-link" href="#messages">See how it works <span>&rarr;</span></a>
  </div>
</div>
<div class="warn-banner"><b>Sandbox mode.</b> This page is fully isolated from your live conversations. Sessions live in memory only and clear when the server restarts.</div>
<div class="layout">
  <div class="chat-card">
    <div class="controls">
      <div class="control">
        <label>Variant</label>
        <div class="variant-pills">
          <button class="vpill A active" data-v="A" onclick="pickVariant('A')">A</button>
          <button class="vpill B" data-v="B" onclick="pickVariant('B')">B</button>
          <button class="vpill C" data-v="C" onclick="pickVariant('C')">C</button>
          <button class="vpill CUSTOM" data-v="CUSTOM" onclick="pickVariant('CUSTOM')">Custom</button>
        </div>
      </div>
      <div class="control">
        <label>Scan data</label>
        <div class="variant-pills" title="Real scan runs the live Google Places research + 25-point grid scan against the prospect's confirmed listing (~$1 per practice, 10–20s). Stub uses fast synthetic numbers.">
          <button class="vpill scan SCAN-REAL active" data-scan="real" onclick="pickScanMode('real')">Real scan</button>
          <button class="vpill scan SCAN-STUB" data-scan="stub" onclick="pickScanMode('stub')">Stub</button>
        </div>
      </div>
      <div class="control">
        <label>First Name</label>
        <input id="fname" type="text" value="Test" placeholder="Test"/>
      </div>
      <div class="control">
        <label>City</label>
        <input id="city" type="text" placeholder="Optional"/>
      </div>
      <button class="btn-reset" onclick="resetConvo()">Reset</button>
    </div>
    <div class="custom-prompt-row" id="custom-prompt-row">
      <label for="custom-prompt">Custom System Prompt</label>
      <textarea id="custom-prompt" placeholder="Paste any system prompt here. The AI will follow these instructions exactly — no stored variant text is used."></textarea>
      <div class="hint">In-memory only — never saved. Edit freely between sends.</div>
    </div>
    <div class="messages" id="messages">
      <div class="empty-state" id="empty-state">
        Start a conversation by typing a message below — like a real prospect would — or hit the button to have the AI send the opening message first.<br><br>Try replies like "yes", "what's this about", or even rude messages to see how each variant handles them.
        <div class="start-cta">
          <button class="btn-start" id="btn-start" onclick="startConvo()">▶ Start Conversation</button>
          <div class="start-or">— or type below —</div>
        </div>
      </div>
    </div>
    <div class="input-row">
      <textarea id="msg-input" placeholder="Type a message as the prospect…" onkeydown="onKeyDown(event)"></textarea>
      <button class="btn-send" id="btn-send" onclick="sendMsg()">Send</button>
    </div>
  </div>
  <div class="sidebar">
    <div class="side-card">
      <div class="side-title">Conversation State</div>
      <div class="stat-row"><span>Variant</span><span class="v" id="s-variant">A</span></div>
      <div class="stat-row"><span>Current step</span><span class="v" id="s-step">0</span></div>
      <div class="stat-row"><span>Last response</span><span class="v" id="s-elapsed">—</span></div>
      <div class="stat-row"><span>Last cost</span><span class="v" id="s-cost">—</span></div>
      <div class="stat-row"><span>Tokens (in/out)</span><span class="v" id="s-tokens">—</span></div>
    </div>
    <div class="side-card">
      <div class="side-title">Hidden markers from last reply</div>
      <div class="markers-list" id="markers-list">
        <div class="muted">None yet</div>
      </div>
    </div>
    <div class="side-card">
      <div class="side-title">System prompt preview</div>
      <div class="system-prev" id="sys-prev">Send a message to see the prompt the AI is reading.</div>
    </div>
  </div>
</div>
<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
const ENABLED_VARIANTS = ${enabledJson};
let SESSION_ID = 'pg-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
let VARIANT = 'A';
let SENDING = false;
// Real scan default; persisted to localStorage so the choice survives reloads.
let USE_REAL_SCAN = true;
try {
  const stored = localStorage.getItem('pg_useRealScan');
  if (stored === 'false') USE_REAL_SCAN = false;
} catch {}
// True after the system has just emitted an address-confirmation bubble. The
// next user reply should trigger the real scan, so we swap the loading
// indicator from "AI is typing…" to "Running visibility scan…".
let AWAITING_CONFIRM_REPLY = false;
// Reference to a "Scan running in background…" bubble that was rendered on
// a previous turn whose response came back with scanStatus='running'. We
// hold onto it so the next response (which will report 'complete' or
// 'failed') can update it in place instead of leaving stale text on screen.
let ACTIVE_SCAN_BUBBLE = null;

// Scope to actual variant pills — without [data-v], this selector also
// matched the Real-scan / Stub pills (which share the .vpill class for
// styling), and since they have no data-v attribute, they would all get
// flagged as "disabled" and made non-interactive. The result was the user
// could never click "Stub". Constrain to variant pills only.
document.querySelectorAll('.vpill[data-v]').forEach(b => {
  const v = b.dataset.v;
  // Custom is always available — it doesn't depend on stored prompts.
  if (v === 'CUSTOM') return;
  if (ENABLED_VARIANTS.length && !ENABLED_VARIANTS.includes(v)) {
    b.classList.add('disabled');
    b.title = 'Variant ' + v + ' is currently disabled in production. Enable it in Prompt Editor.';
    b.onclick = null;
  }
});
if (ENABLED_VARIANTS.length && !ENABLED_VARIANTS.includes('A')) {
  pickVariant(ENABLED_VARIANTS[0]);
}

function pickVariant(v) {
  const previousVariant = VARIANT;
  VARIANT = v;
  // Same scoping rule as the disable-initializer above — only touch the
  // variant pills, never the scan-mode pills (which manage their own
  // active state via pickScanMode).
  document.querySelectorAll('.vpill[data-v]').forEach(b => {
    b.classList.toggle('active', b.dataset.v === v);
  });
  document.getElementById('s-variant').textContent = v;
  document.getElementById('custom-prompt-row').classList.toggle('visible', v === 'CUSTOM');
  // If a conversation is already underway, warn that the prior context is
  // being kept — variant comparisons are only clean when started from scratch.
  if (previousVariant && previousVariant !== v && hasConvoStarted()) {
    appendBubble('ai', '\u2139 Switched to variant ' + v + '. Prior context is kept — click Reset for a clean A/B comparison.');
  }
}

function hasConvoStarted() {
  return !!document.querySelector('#messages .bubble');
}

function getCustomPrompt() {
  return document.getElementById('custom-prompt').value;
}

function buildPayloadBase() {
  return {
    sessionId: SESSION_ID,
    variant: VARIANT,
    customPrompt: VARIANT === 'CUSTOM' ? getCustomPrompt() : undefined,
    firstName: document.getElementById('fname').value,
    city: document.getElementById('city').value,
    useRealScan: USE_REAL_SCAN
  };
}

function pickScanMode(mode) {
  USE_REAL_SCAN = (mode === 'real');
  try { localStorage.setItem('pg_useRealScan', USE_REAL_SCAN ? 'true' : 'false'); } catch {}
  document.querySelectorAll('.vpill.scan').forEach(b => {
    b.classList.toggle('active', b.dataset.scan === mode);
  });
}

// Apply the persisted choice to the UI on load (after DOM is ready).
function applyInitialScanMode() {
  document.querySelectorAll('.vpill.scan').forEach(b => {
    b.classList.toggle('active', b.dataset.scan === (USE_REAL_SCAN ? 'real' : 'stub'));
  });
}
applyInitialScanMode();

function validateCustomBeforeSend() {
  if (VARIANT === 'CUSTOM' && !getCustomPrompt().trim()) {
    appendBubble('ai', '\u26A0 Paste a custom prompt above before sending.');
    return false;
  }
  return true;
}

function hideStartCta() {
  const empty = document.getElementById('empty-state');
  if (empty) empty.remove();
}

function applyResponseStats(data) {
  document.getElementById('s-step').textContent = data.currentStep;
  document.getElementById('s-elapsed').textContent = (data.elapsedMs / 1000).toFixed(1) + 's';
  document.getElementById('s-cost').textContent = data.estCost != null ? '$' + data.estCost.toFixed(4) : '\u2014';
  document.getElementById('s-tokens').textContent = data.tokenUsage.input + ' / ' + data.tokenUsage.output;
  const ml = document.getElementById('markers-list');
  ml.innerHTML = '';
  if (!data.markers || data.markers.length === 0) {
    ml.innerHTML = '<div class="muted">None this turn</div>';
  } else {
    data.markers.forEach(m => {
      const d = document.createElement('div');
      d.className = 'marker';
      d.innerHTML = '<span class="mtag">[' + escapeHtml(m.type) + ']</span>' + escapeHtml(String(m.value));
      ml.appendChild(d);
    });
  }
  document.getElementById('sys-prev').textContent = data.systemPromptPreview || '';
}

function onKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMsg();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function appendBubble(role, text, meta) {
  const m = document.getElementById('messages');
  const empty = m.querySelector('.empty-state');
  if (empty) empty.remove();
  const b = document.createElement('div');
  b.className = 'bubble ' + role;
  b.innerHTML = escapeHtml(text) + (meta ? '<div class="bubble-meta">' + escapeHtml(meta) + '</div>' : '');
  m.appendChild(b);
  m.scrollTop = m.scrollHeight;
  return b;
}

async function sendMsg() {
  if (SENDING) return;
  const inp = document.getElementById('msg-input');
  const message = inp.value.trim();
  if (!message) return;
  if (!validateCustomBeforeSend()) return;
  SENDING = true;
  document.getElementById('btn-send').disabled = true;
  inp.value = '';

  hideStartCta();
  appendBubble('user', message);
  // When a confirmation bubble was just shown and Real scan is on, the
  // server will (a) kick off the live Google Places research + scan in
  // the BACKGROUND and (b) immediately return Claude's Step 4 question.
  // The scan keeps running while the user types their answer; the next
  // turn (the data reveal) is what awaits the scan. Surface a distinct
  // status bubble either way so the operator knows the scan is happening.
  const willKickOffScan = AWAITING_CONFIRM_REPLY && USE_REAL_SCAN;
  let scanStatusBubble = null;
  if (willKickOffScan) {
    scanStatusBubble = appendBubble('ai', '\u23F3 Kicking off live visibility scan\u2026 (Google Places research + 25-point grid, runs in background)');
    scanStatusBubble.classList.add('scan-status');
  }
  const thinking = appendBubble('ai', 'AI is typing\u2026');
  thinking.classList.add('thinking');
  // Reset for next turn — the server's response will re-arm if needed.
  AWAITING_CONFIRM_REPLY = false;

  try {
    const res = await fetch('/admin/playground/message?key=' + encodeURIComponent(ADMIN_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(buildPayloadBase(), { message }))
    });
    const data = await res.json();
    thinking.remove();
    if (!res.ok) {
      if (scanStatusBubble) scanStatusBubble.remove();
      appendBubble('ai', '\u26A0 Error: ' + (data.error || res.statusText));
    } else {
      // Two scan bubbles to reconcile against the server's scanStatus:
      //   - scanStatusBubble: just rendered above for THIS turn (kick-off)
      //   - ACTIVE_SCAN_BUBBLE: a 'running' bubble left over from an
      //     earlier turn whose scan hadn't completed yet
      // For each turn, exactly one of them might be relevant.
      const bubble = scanStatusBubble || ACTIVE_SCAN_BUBBLE;
      if (bubble) {
        if (data.scanStatus === 'complete') {
          bubble.classList.remove('running');
          bubble.classList.add('complete');
          bubble.innerHTML = '\u2713 Visibility scan complete \u2014 real Google Maps numbers loaded.';
          ACTIVE_SCAN_BUBBLE = null;
        } else if (data.scanStatus === 'failed') {
          bubble.classList.remove('running');
          bubble.classList.add('failed');
          bubble.innerHTML = '\u26A0 Scan failed or timed out \u2014 falling back to seed numbers so the conversation can continue.';
          ACTIVE_SCAN_BUBBLE = null;
        } else if (data.scanStatus === 'running') {
          bubble.classList.add('running');
          bubble.innerHTML = '\u23F3 Scan running in background \u2014 real Maps numbers will land on the next turn.';
          // Keep tracking it so the NEXT turn's response can finalize it.
          ACTIVE_SCAN_BUBBLE = bubble;
        } else if (scanStatusBubble) {
          // Newly created bubble but server reported no scan happening
          // (e.g. operator flipped to Stub mid-flow). Drop it; leave any
          // pre-existing ACTIVE_SCAN_BUBBLE alone.
          scanStatusBubble.remove();
        }
      }
      const meta = 'Variant ' + data.variant + ' \u00B7 step ' + data.currentStep;
      appendBubble('ai', data.reply || '(empty reply)', meta);
      // Render any system-emitted follow-ups (e.g. address confirmation
      // after PRACTICE_DETECTED) so the playground mirrors what the live
      // SMS thread actually shows.
      if (Array.isArray(data.extraMessages)) {
        for (const extra of data.extraMessages) {
          appendBubble('ai', extra.reply, extra.meta || 'system');
        }
      }
      // Re-arm the scan indicator if the server says the next user reply
      // will be a yes/no/correction on a confirmation bubble.
      AWAITING_CONFIRM_REPLY = !!data.awaitingConfirmReply;
      applyResponseStats(data);
    }
  } catch (err) {
    thinking.remove();
    if (scanStatusBubble) scanStatusBubble.remove();
    appendBubble('ai', '\u26A0 Network error: ' + err.message);
  } finally {
    SENDING = false;
    document.getElementById('btn-send').disabled = false;
    inp.focus();
  }
}

async function startConvo() {
  if (SENDING) return;
  if (!validateCustomBeforeSend()) return;
  const startBtn = document.getElementById('btn-start');
  SENDING = true;
  // Brand-new conversation — clear any leftover scan-indicator armed state
  // from a previous run in this tab.
  AWAITING_CONFIRM_REPLY = false;
  ACTIVE_SCAN_BUBBLE = null;
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Composing\u2026';
  }
  document.getElementById('btn-send').disabled = true;

  let restoreStartButton = () => {
    const b = document.getElementById('btn-start');
    if (b) { b.disabled = false; b.textContent = '\u25B6 Start Conversation'; }
  };

  try {
    const res = await fetch('/admin/playground/start?key=' + encodeURIComponent(ADMIN_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayloadBase())
    });
    const data = await res.json();
    if (!res.ok) {
      // Keep the start CTA visible so the user can retry without resetting.
      restoreStartButton();
      appendStatusInline('\u26A0 Error: ' + (data.error || res.statusText));
    } else {
      hideStartCta();
      const meta = 'Variant ' + data.variant + ' \u00B7 opener \u00B7 step ' + data.currentStep;
      appendBubble('ai', data.reply || '(empty reply)', meta);
      applyResponseStats(data);
    }
  } catch (err) {
    restoreStartButton();
    appendStatusInline('\u26A0 Network error: ' + err.message);
  } finally {
    SENDING = false;
    document.getElementById('btn-send').disabled = false;
    document.getElementById('msg-input').focus();
  }
}

// Renders an inline status line inside the empty-state (so the start CTA
// stays visible) — falls back to a normal AI bubble if the empty-state was
// already removed.
function appendStatusInline(text) {
  const empty = document.getElementById('empty-state');
  if (!empty) return appendBubble('ai', text);
  let line = empty.querySelector('.start-status');
  if (!line) {
    line = document.createElement('div');
    line.className = 'start-status';
    line.style.cssText = 'margin-top:12px;color:#dc2626;font-size:13px;font-weight:600;';
    empty.appendChild(line);
  }
  line.textContent = text;
}

async function resetConvo() {
  // Block reset while a Claude call is in flight — otherwise the in-flight
  // response would land in the new (rotated) session UI and confuse stats.
  if (SENDING) {
    appendBubble('ai', '\u2139 Wait for the current reply to finish before resetting.');
    return;
  }
  try {
    await fetch('/admin/playground/reset?key=' + encodeURIComponent(ADMIN_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
  } catch {}
  SESSION_ID = 'pg-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
  // Drop any armed scan-indicator state — the next turn is on a fresh
  // session and won't be a confirmation reply.
  AWAITING_CONFIRM_REPLY = false;
  ACTIVE_SCAN_BUBBLE = null;
  document.getElementById('messages').innerHTML =
    '<div class="empty-state" id="empty-state">Conversation reset. Type a message below or hit ▶ to have the AI open first.' +
    '<div class="start-cta">' +
      '<button class="btn-start" id="btn-start" onclick="startConvo()">▶ Start Conversation</button>' +
      '<div class="start-or">— or type below —</div>' +
    '</div></div>';
  document.getElementById('s-step').textContent = '0';
  document.getElementById('s-elapsed').textContent = '\u2014';
  document.getElementById('s-cost').textContent = '\u2014';
  document.getElementById('s-tokens').textContent = '\u2014';
  document.getElementById('markers-list').innerHTML = '<div class="muted">None yet</div>';
  document.getElementById('sys-prev').textContent = 'Send a message to see the prompt the AI is reading.';
}
</script>
</div>
</body>
</html>`;
}
