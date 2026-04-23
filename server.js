try {
  const _fs = require('fs'), _p = require('path');
  const _env = _fs.readFileSync(_p.join(__dirname, '.env'), 'utf8');
  for (const line of _env.split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m && process.env[m[1].trim()] === undefined) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

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

// ─── Step-3 Auto-Send Tracker ─────────────────────────────────────────────────
// When PRACTICE_DETECTED fires, the "Pulling up your listing" bridge is sent and
// the Step 3 message is queued. Instead of a fixed delay, we poll until research
// completes (or 90 s timeout) so the AI always has research data when they reply.
// After Step 3 is sent, a second watcher fires the scan-visibility follow-up
// once the map scan completes — but only if the prospect hasn't replied yet.
//
// Conversation order (post-reorder):
//   Step 1  → Google Maps awareness question
//   Step 1b → Collect practice name + street
//   Step 2  → Bridge "Pulling up your listing now" + [PRACTICE_DETECTED:…]
//   Step 3  → (auto-sent below) Hearing aid conversion question — asked while
//             research loads so there's no awkward silence. AI then has both
//             the maps data AND the hearing aid context for the Step 4 reveal.
//   Step 4  → AI-generated: full data reveal (maps + competitors) + dormant
//             patients + expiring benefits + gap stack + booking ask
//   Step 5  → Sid intro / scheduling
//   Booked  → Confirmation
const pendingStep3   = new Map(); // contactId → setInterval handle (research poller)
const pendingScanWatch = new Map(); // contactId → setInterval handle (scan watcher)

const STEP3_POLL_MS    = 2 * 1000;
const STEP3_TIMEOUT_MS = 90 * 1000;
const SCAN_POLL_MS     = 2 * 1000;
const SCAN_TIMEOUT_MS  = 90 * 1000;

const STEP3_TEXT = 'And one more thing while I\'m pulling that up — of the patients you\'ve recommended hearing aids to in the last couple years, what percentage actually went through with it?';

function scheduleStep3AutoSend(contactId, resolvedConvId, skipReplyGuard = false) {
  clearPendingStep3(contactId);
  const started = Date.now();

  const handle = setInterval(async () => {
    const contact = conversations.get(contactId);
    if (!contact || contact.booked) {
      clearPendingStep3(contactId);
      return;
    }

    const session = sessions.get(contactId);
    const researchDone = session?.researchStatus === 'complete' || session?.researchStatus === 'failed';
    const timedOut     = Date.now() - started > STEP3_TIMEOUT_MS;

    if (!researchDone && !timedOut) return; // still waiting

    clearPendingStep3(contactId);

    // Cancel if prospect already replied after the bridge — skip when the
    // confirmation YES was their last message (skipReplyGuard)
    if (!skipReplyGuard) {
      const exch    = contact.exchanges || [];
      const lastOut = [...exch].reverse().find(e => e.direction === 'outbound');
      const lastIn  = [...exch].reverse().find(e => e.direction === 'inbound');
      if (lastIn && lastOut && lastIn.timestamp > lastOut.timestamp) {
        console.log(`[Step3Auto] ${contactId} already replied — skipping auto-send`);
        return;
      }
    }

    if (timedOut && !researchDone) {
      console.log(`[Step3Auto] Research timeout for ${contactId} — sending Step 3 without data`);
    }

    try {
      await ghl.sendMessage(contactId, STEP3_TEXT);
      conversations.addExchange(contactId, {
        direction: 'outbound',
        body: STEP3_TEXT,
        step: 3,
        conversationId: resolvedConvId || null,
        variant: conversations.get(contactId)?.variant || null
      });
      brain.recordOutbound(contactId, STEP3_TEXT, 3, { variant: conversations.get(contactId)?.variant || null });
      conversations.update(contactId, { currentStep: 3 });
      followups.scheduleSilenceCheck(contactId, 3, STEP3_TEXT);
      console.log(`[Step3Auto] Step 3 sent to ${contactId} (research ${researchDone ? 'complete' : 'timed out'})`);

      // Watch for scan completion → send visibility follow-up
      watchForScanAndSendVisibility(contactId, resolvedConvId);
    } catch (err) {
      console.error(`[Step3Auto] Failed to send Step 3 for ${contactId}:`, err.message);
    }
  }, STEP3_POLL_MS);

  pendingStep3.set(contactId, handle);
  console.log(`[Step3Auto] Watching for research completion for ${contactId}`);
}

function clearPendingStep3(contactId) {
  if (pendingStep3.has(contactId)) {
    clearInterval(pendingStep3.get(contactId));
    pendingStep3.delete(contactId);
    console.log(`[Step3Auto] Cancelled pending Step 3 for ${contactId}`);
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

    // Stop if booked or prospect already replied to Step 3 (moved to Step 4+)
    if (!contact || contact.booked || (contact.currentStep !== undefined && contact.currentStep > 3)) {
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

    // Also abort if prospect replied while we were polling
    const exch    = contact.exchanges || [];
    const lastOut = [...exch].reverse().find(e => e.direction === 'outbound' && e.step === 3);
    const lastIn  = [...exch].reverse().find(e => e.direction === 'inbound');
    if (lastIn && lastOut && lastIn.timestamp > lastOut.timestamp) {
      console.log(`[ScanWatch] ${contactId} already replied to Step 3 — skipping visibility message`);
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
  if (!contact || contact.booked || contact.currentStep > 3) return;

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

  try {
    await ghl.sendMessage(contactId, msg);
    conversations.addExchange(contactId, {
      direction: 'outbound',
      body: msg,
      step: 3,
      conversationId: resolvedConvId || null,
      variant: conversations.get(contactId)?.variant || null
    });
    brain.recordOutbound(contactId, msg, 3, { variant: conversations.get(contactId)?.variant || null });
    console.log(`[ScanWatch] Visibility follow-up sent to ${contactId}`);
  } catch (err) {
    console.error(`[ScanWatch] Failed to send visibility message for ${contactId}:`, err.message);
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

  // Cancel any pending auto-send of Step 3 (they replied, so flow resumes normally)
  clearPendingStep3(contactId);
  // Cancel scan-visibility watcher if the prospect replied to Step 3
  clearScanWatch(contactId);

  enqueueJob({ contactId, conversationId, messageBody, firstName, city, phone });
});

// ─── GHL Enrolled Webhook ─────────────────────────────────────────────────────
// Fires the moment GHL sends the static intro message to a new lead.
// We create the local contact record and schedule the 5-min silence check
// (and first email-hook) immediately — without waiting for them to reply.

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

  const rawTags = payload.contact?.tags || payload.tags || [];
  const tags = rawTags.map(t =>
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

  // Guard: dedup — if a pending silence check already exists, skip
  const jobs = followups.getAllJobs('pending');
  const hasSilenceCheck = jobs.some(
    j => j.contactId === contactId && j.type === 'silence-check'
  );
  if (hasSilenceCheck) {
    console.log(`[Enrolled] Skipping ${contactId} — silence check already pending`);
    return;
  }

  // Create/update local contact record
  conversations.ensureContact(contactId, { firstName, city, phone, email, tags });
  conversations.update(contactId, { email, tags });

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

  // Schedule 5-min silence check (triggers "Hey, you there?" SMS)
  followups.scheduleSilenceCheck(contactId, 0, '');

  // Schedule Email #1 at next email window starting from 5min from now
  // (so silence check always fires before the email window is checked)
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

  console.log(`[Enrolled] Contact ${contactId} enrolled — silence check + email queued`);
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
  const rawTagsSource = payload.contact?.tags ?? payload.tags;
  const hasTags = Array.isArray(rawTagsSource);
  const tags = hasTags
    ? rawTagsSource.map(t => (typeof t === 'string' ? t : (t.name || '')).toLowerCase())
    : [];

  console.log(`[ContactUpdated] Received for contact ${contactId} — tags present: ${hasTags}${hasTags ? `, [${tags.join(', ')}]` : ''}`);

  // Update local contact record with the latest tags only when the payload
  // explicitly included a tags array (avoid clearing tags on unrelated updates)
  if (hasTags) {
    const existing = conversations.get(contactId);
    if (existing) {
      conversations.update(contactId, { tags });
      console.log(`[ContactUpdated] Updated tags on local record for ${contactId}`);
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
      updates.currentStep = 3;
    } else if (bodyLower.includes('sid, our founder')) {
      updates.currentStep = 4;
    } else if (bodyLower.includes('locked in') && bodyLower.includes('calendar invite')) {
      updates.currentStep = 5;
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

  // ── 4. Build message history from GHL + local ─────────────────────────────────
  // Resolve conversationId if not present in webhook payload (e.g. some GHL event types)
  let resolvedConvId = conversationId;
  if (!resolvedConvId && contactId) {
    try {
      resolvedConvId = await ghl.getOrCreateConversation(contactId);
      console.log(`[Webhook] Resolved conversationId ${resolvedConvId} for contact ${contactId}`);
    } catch (err) {
      console.warn('[Webhook] Could not resolve conversationId:', err.message);
    }
  }

  // ── 4.5. Handle address confirmation or name-retry states (no Claude call) ────
  if (fresh?.confirmationPending) {
    return await handleConfirmationReply(contactId, messageBody, fresh, resolvedConvId);
  }
  if (fresh?.awaitingRetryName) {
    return await handleRetryName(contactId, messageBody, fresh, resolvedConvId);
  }

  // ── 4.6. Fetch full conversation from GHL (authoritative source) ──────────────
  let messages = [];
  if (resolvedConvId) {
    const ghlMessages = await ghl.fetchMessages(resolvedConvId);
    messages = buildMessagesFromGhl(ghlMessages);
  }
  if (messages.length === 0) {
    messages = buildMessagesFromLocal(fresh?.exchanges || []);
  }

  if (messages.length === 0) {
    console.log(`[Webhook] No message history for ${contactId}`);
    return;
  }

  // ── 5. Build system prompt with live data + winning patterns ─────────────────
  // Pick variant-specific prompt (A/B/C). Fall back to base if not set.
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

  // ── 6. Call Claude ────────────────────────────────────────────────────────────
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: systemContent,
    messages
  });

  spend.track(contactId, model, response.usage);

  let reply = response.content[0]?.text?.trim() || '';

  // ── 7. Extract hidden markers ─────────────────────────────────────────────────

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
    console.log(`[Webhook] Practice detected: "${practiceName}" on "${practiceStreet}" in "${practiceCity}"`);

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
          console.log(`[Webhook] Address confirmation queued for ${contactId}: ${confirmName}`);
        } else {
          console.log(`[Webhook] No listing found for "${searchQuery}" — skipping confirmation`);
          startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
          scheduleStep3AutoSend(contactId, resolvedConvId);
        }
      } catch (err) {
        console.error('[Webhook] Fast lookup error:', err.message);
        startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
        scheduleStep3AutoSend(contactId, resolvedConvId);
      }
    } else {
      startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
      scheduleStep3AutoSend(contactId, resolvedConvId);
    }
  }

  // [BOOKED] — mark contact as booked
  if (reply.includes('[BOOKED]')) {
    reply = reply.replace(/\[BOOKED\]\s*/gi, '').trim();
    conversations.update(contactId, { booked: true });
    brain.recordBooking(contactId);
    console.log(`[Webhook] Contact ${contactId} booked!`);
  }

  // Update step
  if (detectedStep !== null) {
    conversations.update(contactId, { currentStep: detectedStep });
  }

  // ── 8. Send reply via GHL and persist ─────────────────────────────────────────
  if (reply) {
    await ghl.sendMessage(contactId, reply);
    conversations.addExchange(contactId, {
      direction: 'outbound',
      body: reply,
      step: detectedStep,
      conversationId: resolvedConvId || null,
      variant: contactVariant
    });
    brain.recordOutbound(contactId, reply, detectedStep, { variant: contactVariant });
    followups.scheduleSilenceCheck(contactId, detectedStep, reply);
    console.log(`[Webhook] Sent to ${contactId} (step ${detectedStep}, variant ${contactVariant || 'none'}): "${reply.slice(0, 80)}"`);
  }

  // ── 9. Send address confirmation (if queued from PRACTICE_DETECTED) ───────────
  if (confirmationMsg) {
    try {
      await ghl.sendMessage(contactId, confirmationMsg);
      conversations.addExchange(contactId, {
        direction: 'outbound',
        body: confirmationMsg,
        step: 3,
        conversationId: resolvedConvId || null,
        variant: contactVariant
      });
      brain.recordOutbound(contactId, confirmationMsg, 3, { variant: contactVariant });
      followups.scheduleSilenceCheck(contactId, 3, confirmationMsg);
      console.log(`[Webhook] Sent address confirmation to ${contactId}: "${confirmationMsg.slice(0, 80)}"`);
    } catch (err) {
      console.error('[Webhook] Failed to send confirmation — falling back to auto Step 3:', err.message);
      const ct = conversations.get(contactId);
      if (ct?.confirmationPending) {
        conversations.update(contactId, { confirmationPending: null });
        startResearchAndScan(contactId, ct.practiceName, ct.practiceStreet || '', ct.practiceCity || ct.city || '', null);
        scheduleStep3AutoSend(contactId, resolvedConvId);
      }
    }
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
  const pending = contact.confirmationPending;
  const msg = messageBody.toLowerCase().trim();

  const isNo = /^(no|nope|not (quite|right|that one|it)|wrong|different|nah|incorrect)\b/.test(msg) || msg === 'n';

  if (isNo) {
    conversations.update(contactId, { confirmationPending: null, awaitingRetryName: true });
    const clarification = "No problem — what's the exact name as it appears on Google Maps, and what street is it on?";
    await ghl.sendMessage(contactId, clarification);
    conversations.addExchange(contactId, { direction: 'outbound', body: clarification, step: 3, conversationId: resolvedConvId || null, variant: contact.variant || null });
    brain.recordOutbound(contactId, clarification, 3, { variant: contact.variant || null });
    followups.scheduleSilenceCheck(contactId, 3, clarification);
    console.log(`[Webhook] Confirmation denied for ${contactId} — asking for correction`);
    return;
  }

  // Require explicit affirmative — ambiguous replies re-prompt so Step 3 stays held
  const isYes = /^(yes|yeah|yep|yup|correct|right|that('s| is)( it| right| the one)?|sure|exactly|affirmative|ok(ay)?|y)\b/.test(msg);
  if (!isYes) {
    const reprompt = "Just want to make sure — is that your practice listing? Reply yes or no.";
    await ghl.sendMessage(contactId, reprompt);
    conversations.addExchange(contactId, { direction: 'outbound', body: reprompt, step: 3, conversationId: resolvedConvId || null, variant: contact.variant || null });
    brain.recordOutbound(contactId, reprompt, 3, { variant: contact.variant || null });
    followups.scheduleSilenceCheck(contactId, 3, reprompt);
    return;
  }

  conversations.update(contactId, { confirmationPending: null });
  console.log(`[Webhook] Practice confirmed for ${contactId}: ${pending.name}`);
  startResearchAndScan(contactId, pending.name, contact.practiceStreet || '', pending.city, pending.placeId);
  scheduleStep3AutoSend(contactId, resolvedConvId, true);
}

async function handleRetryName(contactId, messageBody, contact, resolvedConvId) {
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
        conversations.addExchange(contactId, { direction: 'outbound', body: confirmMsg, step: 3, conversationId: resolvedConvId || null, variant: contact.variant || null });
        brain.recordOutbound(contactId, confirmMsg, 3, { variant: contact.variant || null });
        followups.scheduleSilenceCheck(contactId, 3, confirmMsg);
        console.log(`[Webhook] Retry confirmation sent to ${contactId}: ${confirmName}`);
        return;
      }
    } catch (err) {
      console.error('[Webhook] Retry lookup error:', err.message);
    }
  }

  // No result or no API key — proceed without confirmation
  startResearchAndScan(contactId, retryInput, '', city, null);
  scheduleStep3AutoSend(contactId, resolvedConvId, true);
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

app.get('/api/brain/stats', requireAdmin, (req, res) => {
  res.json(brain.getStats());
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

  const variants = ['A', 'B', 'C'];
  // Count current assignments to continue the round-robin fairly
  const counts = { A: 0, B: 0, C: 0 };
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

  console.log(`[Variants] Backfilled ${assigned} contacts. Distribution: A=${counts.A} B=${counts.B} C=${counts.C}`);
  res.json({ ok: true, assigned, distribution: counts });
});

// ─── Admin: Variant Enable/Disable ────────────────────────────────────────────

app.post('/admin/variants/:variant/enabled', requireAdmin, (req, res) => {
  const { variant } = req.params;
  if (!['A', 'B', 'C'].includes(variant)) return res.status(400).json({ error: 'Invalid variant. Must be A, B, or C.' });
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
    const stats = brain.getVariantStats();
    const enabledList = prompts.getEnabledVariants();

    // Count true assigned contacts from contacts.variant (source of truth)
    const allContacts = conversations.getAll();
    const assignedCounts = { A: 0, B: 0, C: 0 };
    for (const c of Object.values(allContacts)) {
      if (c.variant && assignedCounts[c.variant] !== undefined) assignedCounts[c.variant]++;
    }

    const result = stats.map(s => ({
      ...s,
      contactsAssigned: assignedCounts[s.variant] || 0,
      enabled: enabledList.includes(s.variant)
    }));
    res.json({ ok: true, variants: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.listen(PORT, () => {
  console.log(`Powered Up AI — GMB Message Generator running on port ${PORT}`);

  // ── DB migrations (safe, idempotent) ──────────────────────────────────────
  _promptsPool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS variant varchar(1)`)
    .then(() => console.log('[DB] contacts.variant column ensured'))
    .catch(err => console.error('[DB] contacts.variant migration error:', err.message));

  prompts.seed();
  // Sync prompts from DB into local file on every startup — this ensures
  // UI-saved prompts survive redeployments (DB is the durable source of truth)
  prompts.syncFromDb(_promptsPool).then(async () => {
    // Seed any variant prompt keys that aren't in the DB yet (ensures DB is
    // always the full source of truth from day one, no lazy-init surprises).
    const variantKeys = [
      'conversationPrompt.A', 'conversationPrompt.B', 'conversationPrompt.C',
      'conversationPrompt.A.enabled', 'conversationPrompt.B.enabled', 'conversationPrompt.C.enabled'
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
  followups.startScheduler();
  Promise.all([bootstrapStateFromGHL(), conversations.whenReady()])
    .then(() => {
      // Backfill variant assignments for any contacts that don't have one yet.
      // Safe to run on every startup — only touches contacts with a null variant.
      const all = conversations.getAll();
      const unassigned = Object.entries(all).filter(([, c]) => !c.variant);
      if (unassigned.length === 0) {
        console.log('[Variants] All contacts already have a variant assigned');
        return;
      }
      const counts = { A: 0, B: 0, C: 0 };
      for (const c of Object.values(all)) {
        if (c.variant && counts[c.variant] !== undefined) counts[c.variant]++;
      }
      for (const [contactId] of unassigned) {
        const next = ['A', 'B', 'C'].slice().sort((a, b) => counts[a] - counts[b])[0];
        conversations.update(contactId, { variant: next });
        counts[next]++;
      }
      console.log(`[Variants] Backfilled ${unassigned.length} contacts — A:${counts.A} B:${counts.B} C:${counts.C}`);
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
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0c0c0e;color:#e2e2e2;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:32px 16px 80px}
a{color:#818cf8;text-decoration:none}a:hover{text-decoration:underline}

/* ── Header ── */
.header{max-width:980px;margin:0 auto 32px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.header-left .logo{font-size:11px;font-weight:700;letter-spacing:.1em;color:#444;text-transform:uppercase;margin-bottom:4px}
.header-left h1{font-size:20px;font-weight:700;color:#fff}
.header-right{display:flex;gap:10px;flex-wrap:wrap}
.btn{display:inline-block;font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px;border:1px solid #2a2a2a;background:#1a1a1a;color:#aaa;cursor:pointer;text-decoration:none;transition:border-color .15s,color .15s}
.btn:hover{border-color:#818cf8;color:#818cf8;text-decoration:none}
.btn-primary{background:#1e1b4b;border-color:#4f46e5;color:#818cf8}
.btn-primary:hover{background:#2d2b66;color:#a5b4fc}

/* ── Refresh bar ── */
.refresh-bar{max-width:980px;margin:-16px auto 20px;font-size:11px;color:#3a3a3a;text-align:right}

/* ── Stats strip ── */
.stats-strip{max-width:980px;margin:0 auto 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
.stat-card{background:#131316;border:1px solid #222;border-radius:12px;padding:16px;text-align:center}
.stat-card .val{font-size:30px;font-weight:700;color:#fff;line-height:1.1}
.stat-card .lbl{font-size:11px;color:#555;margin-top:5px;text-transform:uppercase;letter-spacing:.07em}
.stat-card .sub{font-size:11px;color:#444;margin-top:3px}
.stat-highlight .val{color:#818cf8}

/* ── Panel ── */
.panel{background:#131316;border:1px solid #1f1f1f;border-radius:16px;padding:24px;width:100%;max-width:980px;margin:0 auto 20px}
.panel-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px;gap:12px;flex-wrap:wrap}
.panel-title{font-size:15px;font-weight:700;color:#fff}
.panel-desc{font-size:12px;color:#444;margin-bottom:18px;line-height:1.5}
.tab-row{display:flex;gap:6px;margin-bottom:18px;flex-wrap:wrap}
.tab{font-size:12px;font-weight:600;padding:5px 12px;border-radius:20px;border:1px solid #2a2a2a;background:transparent;color:#555;cursor:pointer;transition:all .15s}
.tab.active{background:#1e1b4b;border-color:#4f46e5;color:#818cf8}
.tab:hover:not(.active){border-color:#444;color:#aaa}

/* ── Table ── */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#444;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:0 12px 10px;border-bottom:1px solid #1e1e1e;white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid #191919;color:#bbb;vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:#18181c}
.name-cell{font-weight:500;color:#e2e2e2}
.city-cell{font-size:11px;color:#555;margin-top:2px}
.time-cell{font-weight:600;color:#e2e2e2}
.time-sub{font-size:11px;color:#555;margin-top:2px}

/* ── Badges ── */
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;white-space:nowrap}
.b-sms{background:#0f1f3a;color:#60a5fa;border:1px solid #1e3a6a}
.b-email{background:#0d2a1a;color:#34d399;border:1px solid #145228}
.b-pending{background:#2a1f00;color:#f59e0b;border:1px solid #6b4e00}
.b-sent{background:#0d2a1a;color:#34d399;border:1px solid #145228}
.b-skipped{background:#1a1a1a;color:#555;border:1px solid #2a2a2a}
.b-cancelled{background:#1a1a1a;color:#444;border:1px solid #222}
.b-booked{background:#0d2a1a;color:#4ade80;border:1px solid #14532d}
.b-active{background:#0f1f3a;color:#60a5fa;border:1px solid #1e3a6a}

/* ── Stage label ── */
.stage-label{font-weight:600;color:#e2e2e2;display:block}
.stage-sub{font-size:11px;color:#555;margin-top:2px;display:block}

/* ── Summary row above table ── */
.queue-summary{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px}
.qs-item{font-size:13px;color:#555}
.qs-item strong{color:#e2e2e2;font-weight:600}
.qs-item.urgent strong{color:#f59e0b}

/* ── Legend ── */
.legend{background:#0e0e11;border:1px solid #1c1c1f;border-radius:10px;padding:14px 16px;margin-bottom:18px}
.legend-title{font-size:11px;font-weight:700;color:#444;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
.legend-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.legend-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#555;line-height:1.4}
.legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:3px}
.ld-1{background:#6366f1}.ld-2{background:#f59e0b}.ld-3{background:#34d399}.ld-4{background:#818cf8}

/* ── Performance table ── */
.perf-table td:first-child{color:#aaa;font-weight:500}
.rate-good{color:#4ade80;font-weight:700}
.rate-mid{color:#f59e0b;font-weight:700}
.rate-low{color:#888;font-weight:700}

/* ── Misc ── */
.empty{color:#333;font-size:13px;padding:24px 0;text-align:center}
.loading{color:#333;text-align:center;padding:24px;font-size:13px;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
.dot-live{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:6px;animation:livepulse 2s infinite}
@keyframes livepulse{0%,100%{opacity:1}50%{opacity:.4}}

/* ── Table scroll wrapper ── */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}

/* ── Mobile ── */
@media(max-width:640px){
  body{padding:12px 10px 60px}
  .header{margin-bottom:14px;gap:8px}
  .header-left h1{font-size:16px}
  .header-right{width:100%}
  .header-right .btn{flex:1;text-align:center;font-size:11px;padding:7px 8px}
  .refresh-bar{font-size:10px;margin-bottom:12px}
  .stats-strip{grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
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

<div class="header">
  <div class="header-left">
    <div class="logo">Powered Up AI</div>
    <h1>Admin Dashboard</h1>
  </div>
  <div class="header-right">
    <a class="btn" href="/admin/prompts?key=${adminKey}">Prompt Editor &rarr;</a>
    <a class="btn btn-primary" href="/admin/enroll?key=${adminKey}">Lead Enrollment &rarr;</a>
  </div>
</div>

<div class="refresh-bar"><span class="dot-live"></span>Auto-refreshes every 30s &nbsp;&bull;&nbsp; next refresh in <span id="countdown">30</span>s</div>

<!-- ── Stats Strip ── -->
<div class="stats-strip" id="stats-strip">
  <div class="stat-card"><div class="val" id="s-queued">—</div><div class="lbl">In Queue</div><div class="sub">messages pending</div></div>
  <div class="stat-card"><div class="val" id="s-today" style="color:#f59e0b">—</div><div class="lbl">Sending Today</div><div class="sub">scheduled for today</div></div>
  <div class="stat-card stat-highlight"><div class="val" id="s-sent">—</div><div class="lbl">Sent Total</div><div class="sub">all time</div></div>
  <div class="stat-card"><div class="val" id="s-reply">—</div><div class="lbl">Reply Rate</div><div class="sub">inbound ÷ sent</div></div>
  <div class="stat-card"><div class="val" id="s-booked" style="color:#4ade80">—</div><div class="lbl">Booked</div><div class="sub">zoom calls scheduled</div></div>
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
      <div class="legend-item"><div class="legend-dot ld-1"></div><span><strong style="color:#c4b5fd">Pos 2–5 &nbsp;·&nbsp; Hooks</strong><br>4 follow-ups over the first week (day 0, 2, 4, 7). First contact after enrollment.</span></div>
      <div class="legend-item"><div class="legend-dot ld-2"></div><span><strong style="color:#fcd34d">Pos 6–21 &nbsp;·&nbsp; Bi-weekly</strong><br>Every 3–4 days for ~8 weeks. Nurture messages keeping the lead warm.</span></div>
      <div class="legend-item"><div class="legend-dot ld-3"></div><span><strong style="color:#6ee7b7">Pos 22+ &nbsp;·&nbsp; Monthly</strong><br>One message per month, indefinitely. Long-term follow-up for slow-moving leads.</span></div>
      <div class="legend-item"><div class="legend-dot ld-4"></div><span><strong style="color:#a5b4fc">Email hooks</strong><br>Parallel email track for contacts with a known email address.</span></div>
    </div>
  </div>

  <div class="tab-row">
    <button class="tab active" onclick="switchTab('pending',this)">Pending</button>
    <button class="tab" onclick="switchTab('sent',this)">Sent</button>
    <button class="tab" onclick="switchTab('skipped',this)">Skipped / Cancelled</button>
  </div>

  <div class="queue-summary" id="queue-summary"></div>
  <div id="followups-content"><div class="loading">Loading&hellip;</div></div>
  <div style="margin-top:12px;border-top:1px solid #2a2a2a;padding-top:12px;display:flex;align-items:center;gap:12px">
    <button id="pause-btn" onclick="togglePause()" style="background:#3a1a1a;color:#f87171;border:1px solid #5a2d2d;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">⏸ Pause Everything</button>
    <span id="rebuild-status" style="font-size:12px;color:#888"></span>
  </div>
</div>

<!-- ── Spend Monitor ── -->
<div class="panel">
  <div class="panel-header"><div class="panel-title">API Spend Monitor</div></div>
  <p class="panel-desc">Claude API cost per contact. Each contact is capped at $1.00 — once hit, AI responses stop and all pending jobs are cancelled. Use the override button to resume a high-value prospect.</p>
  <div id="spend-content"><div class="loading">Loading&hellip;</div></div>
</div>

<!-- ── Performance Stats ── -->
<div class="panel">
  <div class="panel-header"><div class="panel-title">Performance</div></div>
  <p class="panel-desc">How the AI is performing across all enrolled contacts. The brain updates its analysis every 72 hours to improve future messages.</p>
  <div id="brain-content"><div class="loading">Loading&hellip;</div></div>
</div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
let currentTab = 'pending';
let allJobs = [];
let contactMap = {};

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
async function togglePause() {
  const btn = document.getElementById('pause-btn');
  const status = document.getElementById('rebuild-status');
  btn.disabled = true;
  try {
    const endpoint = _schedulerPaused ? '/api/admin/resume' : '/api/admin/pause';
    const res = await fetch(endpoint, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    _schedulerPaused = data.paused;
    btn.textContent = _schedulerPaused ? '▶ Resume Scheduler' : '⏸ Pause Scheduler';
    btn.style.background = _schedulerPaused ? '#1a3a1a' : '#3a1a1a';
    btn.style.color = _schedulerPaused ? '#4ade80' : '#f87171';
    btn.style.borderColor = _schedulerPaused ? '#2d5a2d' : '#5a2d2d';
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

function switchTab(tab, btn) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  renderQueue();
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
    // Update queue stat cards
    const now = Date.now();
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    document.getElementById('s-queued').textContent = pending.length;
    document.getElementById('s-today').textContent = pending.filter(j => j.sendAt && j.sendAt <= todayEnd.getTime()).length;
    document.getElementById('s-sent').textContent = sent.length;
    renderQueue();
  } catch (err) {
    document.getElementById('followups-content').innerHTML = '<div class="empty">Failed to load queue: ' + escHtml(err.message) + '</div>';
  }
}

/* ── Load brain / performance ── */
async function loadBrain() {
  const el = document.getElementById('brain-content');
  try {
    const res = await fetch('/api/brain/stats', { headers: { 'x-admin-key': ADMIN_KEY } });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const t = data.totals || {};
    const replyRate = t.settled > 0 ? Math.round((t.repliedMsgs / t.settled) * 100) : 0;
    const bookedRate = t.contacts > 0 ? Math.round((t.booked / t.contacts) * 100) : 0;

    // Update stat cards
    document.getElementById('s-reply').textContent = replyRate + '%';
    document.getElementById('s-booked').textContent = t.booked || 0;

    function rateClass(r) { return r >= 30 ? 'rate-good' : r >= 10 ? 'rate-mid' : 'rate-low'; }

    const stages = Object.entries(data.byStage || {});
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

    // Load variant stats in parallel
    let variantRows = '';
    try {
      const vRes = await fetch('/api/brain/variants', { headers: { 'x-admin-key': ADMIN_KEY } });
      if (vRes.ok) {
        const vData = await vRes.json();
        if (vData.variants && vData.variants.some(v => v.sent > 0)) {
          function vRatePill(r) {
            if (r === null) return '<span style="color:#555">—</span>';
            const col = r >= 30 ? '#22c55e' : r >= 15 ? '#f59e0b' : '#6b7280';
            return \`<span style="font-weight:600;color:\${col}">\${r}%</span>\`;
          }
          const variantColors = { A: '#748ffc', B: '#f59e0b', C: '#34d399' };
          variantRows = \`
            <div style="margin-top:24px;border-top:1px solid #1e1e1e;padding-top:20px">
              <div style="font-size:12px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px">A/B/C Script Variant Performance</div>
              <div class="table-wrap"><table class="perf-table">
                <thead><tr>
                  <th>Variant</th><th>Enabled</th><th>Contacts</th><th>Sent</th><th>Replied</th><th>Reply %</th><th>Booked</th><th>Book %</th>
                </tr></thead>
                <tbody>\${vData.variants.map(v => {
                  const col = variantColors[v.variant] || '#aaa';
                  return \`<tr>
                    <td><span style="font-weight:700;color:\${col}">Variant \${v.variant}</span></td>
                    <td><span style="\${v.enabled ? 'color:#22c55e' : 'color:#555'};font-weight:600">\${v.enabled ? 'Yes' : 'No'}</span></td>
                    <td>\${v.contactsAssigned}</td>
                    <td>\${v.sent}</td>
                    <td>\${v.replied}</td>
                    <td>\${vRatePill(v.replyRate)}</td>
                    <td>\${v.booked}</td>
                    <td>\${vRatePill(v.bookingRate)}</td>
                  </tr>\`;
                }).join('')}</tbody>
              </table></div>
              <div style="font-size:11px;color:#3a3a3a;margin-top:10px">Only settled scripted-SMS messages (reply window closed). Edit scripts at <a href="/admin/prompts?key=\${ADMIN_KEY}" style="color:#818cf8">Prompt Editor</a>.</div>
            </div>\`;
        } else {
          variantRows = \`<div style="margin-top:24px;border-top:1px solid #1e1e1e;padding-top:20px"><div style="font-size:12px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">A/B/C Script Variant Performance</div><div style="font-size:13px;color:#444">No variant messages settled yet. Stats appear once reply windows close.</div></div>\`;
        }
      }
    } catch (_) { /* variant stats are supplemental — ignore errors */ }

    el.innerHTML = \`
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">
        <div class="stat-card"><div class="val">\${t.contacts || 0}</div><div class="lbl">Enrolled</div><div class="sub">contacts in AI sequence</div></div>
        <div class="stat-card"><div class="val">\${t.outbound || 0}</div><div class="lbl">Sent</div><div class="sub">total outbound SMS/email</div></div>
        <div class="stat-card"><div class="val">\${t.inbound || 0}</div><div class="lbl">Replied</div><div class="sub">inbound responses</div></div>
        <div class="stat-card stat-highlight"><div class="val">\${replyRate}%</div><div class="lbl">Reply Rate</div><div class="sub">replies ÷ messages sent</div></div>
        <div class="stat-card"><div class="val" style="color:#4ade80">\${t.booked || 0}</div><div class="lbl">Booked</div><div class="sub">zoom calls confirmed</div></div>
        <div class="stat-card"><div class="val" style="color:#4ade80">\${bookedRate}%</div><div class="lbl">Booking Rate</div><div class="sub">booked ÷ enrolled</div></div>
      </div>
      \${stageHtml}
      \${variantRows}
    \`;
  } catch (err) {
    el.innerHTML = '<div class="empty">Failed to load: ' + escHtml(err.message) + '</div>';
  }
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

function loadAll() { loadFollowups(); loadBrain(); loadSpend(); }
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
  const variantsJson = JSON.stringify(['A', 'B', 'C'].map(v => ({
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
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#e8e8e8;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:40px 16px 80px}
.logo{font-size:13px;font-weight:600;letter-spacing:.08em;color:#555;text-transform:uppercase;text-align:center;margin-bottom:40px}
h1{font-size:22px;font-weight:700;color:#fff;text-align:center;margin-bottom:8px}
.subtitle{font-size:14px;color:#666;text-align:center;margin-bottom:40px;line-height:1.5}
.prompt-card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;padding:28px 28px 24px;width:100%;max-width:820px;margin:0 auto 24px}
.prompt-card.modified{border-color:#3b5bdb44}
.prompt-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.prompt-label{font-size:15px;font-weight:600;color:#fff;line-height:1.3}
.badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;white-space:nowrap;flex-shrink:0}
.badge-modified{background:#3b5bdb22;color:#748ffc;border:1px solid #3b5bdb44}
.badge-default{background:#1e1e1e;color:#555;border:1px solid #2a2a2a}
.prompt-desc{font-size:13px;color:#666;margin-bottom:14px;line-height:1.5}
textarea{width:100%;background:#111;border:1px solid #2a2a2a;border-radius:10px;color:#e8e8e8;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:12.5px;line-height:1.6;padding:14px 16px;resize:vertical;min-height:220px;outline:none;transition:border-color .15s}
textarea:focus{border-color:#4263eb}
.actions{display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap}
.btn{padding:9px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:opacity .15s}
.btn:disabled{opacity:.45;cursor:default}
.btn-save{background:#4263eb;color:#fff}
.btn-save:not(:disabled):hover{background:#3b5bdb}
.btn-reset{background:transparent;color:#888;border:1px solid #333}
.btn-reset:not(:disabled):hover{color:#e8e8e8;border-color:#555}
.status{font-size:12px;margin-left:4px}
.status-ok{color:#22c55e}
.status-err{color:#ef4444}
.char-count{font-size:12px;color:#555;margin-left:auto}
.page-header{text-align:center;max-width:820px;margin:0 auto 40px}
.modal-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.75);display:none;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)}
.modal-overlay.show{display:flex}
.modal-box{background:#1a1a1a;border:2px solid #2a2a2a;border-radius:16px;padding:32px 36px;max-width:500px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.8)}
.modal-box.modal-ok{border-color:#22c55e}
.modal-box.modal-err{border-color:#ef4444}
.modal-icon{font-size:48px;line-height:1;margin-bottom:14px}
.modal-icon.ok{color:#22c55e}
.modal-icon.err{color:#ef4444}
.modal-title{font-size:18px;font-weight:700;color:#fff;margin-bottom:8px}
.modal-msg{font-size:14px;color:#aaa;line-height:1.6;margin-bottom:22px;word-break:break-word}
.modal-btn{background:#4263eb;color:#fff;border:none;border-radius:8px;padding:10px 32px;font-size:14px;font-weight:600;cursor:pointer}
.modal-btn:hover{background:#3b5bdb}
.last-saved{font-size:11px;color:#3b5bdb;margin-left:8px}
.variant-section{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;padding:28px 28px 24px;width:100%;max-width:820px;margin:0 auto 24px}
.variant-section-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:4px}
.variant-section-desc{font-size:13px;color:#666;margin-bottom:20px;line-height:1.5}
.variant-tabs{display:flex;gap:0;border-bottom:1px solid #2a2a2a;margin-bottom:20px}
.variant-tab{padding:8px 20px;font-size:13px;font-weight:600;color:#666;cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s,border-color .15s}
.variant-tab.active{color:#748ffc;border-bottom-color:#4263eb}
.variant-tab:hover:not(.active){color:#aaa}
.variant-tab-panel{display:none}
.variant-tab-panel.active{display:block}
.variant-tab-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:10px}
.variant-toggle{display:flex;align-items:center;gap:8px;font-size:13px;color:#888}
.toggle-switch{position:relative;width:36px;height:20px;cursor:pointer}
.toggle-switch input{opacity:0;width:0;height:0}
.toggle-track{position:absolute;inset:0;background:#333;border-radius:20px;transition:background .2s}
.toggle-switch input:checked + .toggle-track{background:#22c55e}
.toggle-thumb{position:absolute;top:3px;left:3px;width:14px;height:14px;background:#fff;border-radius:50%;transition:transform .2s}
.toggle-switch input:checked ~ .toggle-thumb{transform:translateX(16px)}
.toggle-label{font-weight:600}
.toggle-label.on{color:#22c55e}
.toggle-label.off{color:#555}
.variant-stats-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:20px}
.variant-stats-table th{text-align:left;padding:8px 12px;color:#555;font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid #2a2a2a}
.variant-stats-table td{padding:9px 12px;border-bottom:1px solid #1f1f1f;color:#ccc}
.variant-stats-table tr:last-child td{border-bottom:none}
.vs-badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700}
.vs-badge-A{background:#3b5bdb22;color:#748ffc}
.vs-badge-B{background:#d97706/20;color:#f59e0b;background-color:rgba(217,119,6,0.15)}
.vs-badge-C{background:rgba(16,185,129,0.12);color:#34d399}
.vs-enabled{color:#22c55e;font-weight:600}
.vs-disabled{color:#555;font-weight:600}
.rate-pill{display:inline-block;padding:2px 8px;border-radius:8px;font-size:12px;font-weight:600}
.rate-high{background:rgba(34,197,94,0.12);color:#22c55e}
.rate-mid{background:rgba(245,158,11,0.12);color:#f59e0b}
.rate-low{background:rgba(107,114,128,0.12);color:#6b7280}
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
<div style="max-width:820px;margin:0 auto 20px">
  <a href="/admin?key=${adminKey}" style="color:#748ffc;font-size:13px;text-decoration:none">&larr; Back to Dashboard</a>
</div>
<div class="page-header">
  <h1>Prompt Editor</h1>
  <p class="subtitle">View and edit every AI prompt. Changes take effect immediately — no restart needed.</p>
  <div style="display:inline-block;margin-top:12px;padding:6px 14px;background:#1e3a8a;color:#93c5fd;font-size:12px;font-weight:700;border-radius:20px;letter-spacing:.04em">
    BUILD v8 (fast-preview) · LOADED ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC
  </div>
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
  const tabsHtml = ['A','B','C'].map(v =>
    \`<button class="variant-tab\${v===_activeTab?' active':''}" onclick="setTab('\${v}')">\${v === 'A' ? 'Variant A' : v === 'B' ? 'Variant B' : 'Variant C'}</button>\`
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
    <div style="max-width:820px;margin:0 auto 0;padding-bottom:10px;border-bottom:1px solid #2a2a2a;margin-bottom:24px">
      <span style="font-size:13px;font-weight:700;letter-spacing:.06em;color:#555;text-transform:uppercase">Discovery Script Variants (A / B / C)</span>
    </div>
    <div class="variant-section" id="variant-card">
      <div class="variant-section-title">A/B/C Discovery Script Testing</div>
      <div class="variant-section-desc">Each new contact is permanently assigned one variant. Edit scripts independently below, then enable or disable each variant from the rotation.</div>
      <div class="variant-tabs">\${tabsHtml}</div>
      <div id="variant-panels">\${panelsHtml}</div>
      <div style="margin-top:28px;border-top:1px solid #2a2a2a;padding-top:24px">
        <div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:12px">Performance Comparison</div>
        <div id="variant-stats-table"><span style="font-size:13px;color:#555">Loading stats\u2026</span></div>
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

async function loadVariantStats() {
  const el = document.getElementById('variant-stats-table');
  if (!el) return;
  try {
    const res = await fetch('/api/brain/variants', { headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    if (!res.ok || !data.variants) { el.innerHTML = '<span style="font-size:13px;color:#555">No variant data yet.</span>'; return; }
    const vv = data.variants;
    const noData = vv.every(v => v.sent === 0);
    if (noData) { el.innerHTML = '<span style="font-size:13px;color:#555">No variant messages sent yet. Stats will appear here once contacts start being assigned.</span>'; return; }

    function ratePill(rate) {
      if (rate === null) return '<span style="color:#555">—</span>';
      const cls = rate >= 30 ? 'rate-high' : rate >= 15 ? 'rate-mid' : 'rate-low';
      return \`<span class="rate-pill \${cls}">\${rate}%</span>\`;
    }

    const rows = vv.map(v => \`<tr>
      <td><span class="vs-badge vs-badge-\${v.variant}">\${v.variant}</span></td>
      <td><span class="\${v.enabled?'vs-enabled':'vs-disabled'}">\${v.enabled?'Yes':'No'}</span></td>
      <td>\${v.contactsAssigned}</td>
      <td>\${v.sent}</td>
      <td>\${ratePill(v.replyRate)}</td>
      <td>\${v.booked}</td>
      <td>\${ratePill(v.bookingRate)}</td>
    </tr>\`).join('');

    el.innerHTML = \`<table class="variant-stats-table">
      <thead><tr>
        <th>Variant</th><th>Enabled</th><th>Contacts</th><th>Msgs Sent</th><th>Reply Rate</th><th>Booked</th><th>Book Rate</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
  } catch(err) {
    el.innerHTML = '<span style="font-size:13px;color:#ef4444">Failed to load stats: ' + err.message + '</span>';
  }
}

function renderPrompts() {
  const container = document.getElementById('prompts');
  container.innerHTML = '';
  // 'conversationPrompt' is now managed by the A/B/C variant tabs above — skip it here.
  ALL_PROMPTS.filter(p => p.name !== 'conversationPrompt').forEach(p => {
    if (p.sectionLabel) {
      const heading = document.createElement('div');
      heading.style.cssText = 'max-width:820px;margin:40px auto 20px;padding-bottom:10px;border-bottom:1px solid #2a2a2a;';
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
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#e8e8e8;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:40px 16px 80px}
.logo{font-size:13px;font-weight:600;letter-spacing:.08em;color:#555;text-transform:uppercase;text-align:center;margin-bottom:40px}
h1{font-size:22px;font-weight:700;color:#fff;text-align:center;margin-bottom:8px}
.subtitle{font-size:14px;color:#666;text-align:center;margin-bottom:36px;line-height:1.5}
.panel{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;padding:28px;width:100%;max-width:1080px;margin:0 auto 24px}
.panel-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:18px;display:flex;align-items:center;gap:10px}
.panel-title a{font-size:13px;font-weight:500;color:#748ffc;text-decoration:none;margin-left:auto}
.controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:0}
label{font-size:13px;color:#aaa}
input[type=text]{background:#111;border:1px solid #333;border-radius:8px;color:#e8e8e8;font-size:13px;padding:8px 12px;width:160px;outline:none}
input[type=text]:focus{border-color:#748ffc}
button{cursor:pointer;font-size:13px;font-weight:600;padding:9px 20px;border-radius:8px;border:none;transition:opacity .15s}
button:disabled{opacity:.45;cursor:default}
.btn-preview{background:#2a2a2a;color:#e8e8e8}
.btn-preview:hover:not(:disabled){background:#333}
.btn-run{background:#4ade80;color:#0a1a0a}
.btn-run:hover:not(:disabled){opacity:.88}
.status-bar{font-size:13px;color:#666;margin-top:14px;min-height:20px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:14px;margin-bottom:0}
.stat-box{background:#111;border:1px solid #2a2a2a;border-radius:10px;padding:14px 12px;text-align:center}
.stat-box .val{font-size:26px;font-weight:700;color:#fff;line-height:1}
.stat-box .lbl{font-size:11px;color:#666;margin-top:6px;text-transform:uppercase;letter-spacing:.06em}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#555;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:0 10px 10px;border-bottom:1px solid #2a2a2a}
td{padding:9px 10px;border-bottom:1px solid #1e1e1e;color:#ccc;vertical-align:top}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:20px;white-space:nowrap}
.badge-enroll{background:#14532d33;color:#4ade80;border:1px solid #14532d66}
.badge-skip{background:#2a1a1a33;color:#888;border:1px solid #3a2a2a66}
.badge-error{background:#3b0a0a33;color:#f87171;border:1px solid #7f1d1d66}
.empty{color:#444;font-size:13px;padding:20px 0;text-align:center}
.warn{color:#fbbf24;font-size:13px;margin-top:10px}
.err{color:#f87171;font-size:14px;font-weight:600;margin-top:10px;padding:12px 14px;background:#3b0a0a33;border:1px solid #7f1d1d;border-radius:8px}
</style>
</head>
<body>
<div class="logo">Powered Up AI</div>
<div style="text-align:center;max-width:1080px;margin:0 auto 40px">
  <h1>Lead Enrollment</h1>
  <p class="subtitle">Preview and enroll GHL contacts into the follow-up sequence.<br>Run a dry-run first to see what will happen, then click Run Enrollment to commit.</p>
  <div style="display:inline-block;margin-top:12px;padding:6px 14px;background:#1e3a8a;color:#93c5fd;font-size:12px;font-weight:700;border-radius:20px;letter-spacing:.04em">
    BUILD v8 (fast-preview) · LOADED ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC
  </div>
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
