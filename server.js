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

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Simple In-Memory Job Queue ───────────────────────────────────────────────
// Ensures one webhook job processes at a time; prevents race conditions on
// concurrent webhooks for the same contact.

const jobQueue = [];
let processing = false;

// ─── Step-3 Auto-Send Tracker ─────────────────────────────────────────────────
// When PRACTICE_DETECTED fires, a pure bridge is sent and Step 3 is auto-sent
// 10 seconds later so questions flow while the scan runs in the background. Timeouts are tracked
// here so they can be cancelled if the prospect replies before the delay fires.
const pendingStep3 = new Map(); // contactId → setTimeout handle

const STEP3_DELAY_MS = 10 * 1000;
const STEP3_TEXT = 'Now think about this — you\'ve got patients you haven\'t seen in 2+ years. Their hearing has gotten worse. Their benefits have reset. They\'re not coming back on their own. What are you doing to bring them back in before they end up at the practice down the road?';

function scheduleStep3AutoSend(contactId, resolvedConvId, skipReplyGuard = false) {
  clearPendingStep3(contactId);
  const handle = setTimeout(async () => {
    pendingStep3.delete(contactId);
    const contact = conversations.get(contactId);
    if (!contact || contact.booked) return;

    // Cancel if prospect already replied after the bridge — but skip this check
    // when called from the confirmation flow (their last message WAS the confirmation)
    if (!skipReplyGuard) {
      const exch = contact.exchanges || [];
      const lastOut = [...exch].reverse().find(e => e.direction === 'outbound');
      const lastIn = [...exch].reverse().find(e => e.direction === 'inbound');
      if (lastIn && lastOut && lastIn.timestamp > lastOut.timestamp) {
        console.log(`[Step3Auto] ${contactId} already replied — skipping auto-send`);
        return;
      }
    }

    try {
      await ghl.sendMessage(contactId, STEP3_TEXT);
      conversations.addExchange(contactId, {
        direction: 'outbound',
        body: STEP3_TEXT,
        step: 3,
        conversationId: resolvedConvId || null
      });
      brain.recordOutbound(contactId, STEP3_TEXT, 3);
      conversations.update(contactId, { currentStep: 3 });
      followups.scheduleSilenceCheck(contactId, 3, STEP3_TEXT);
      console.log(`[Step3Auto] Step 3 question sent to ${contactId}`);
    } catch (err) {
      console.error(`[Step3Auto] Failed to send Step 3 for ${contactId}:`, err.message);
    }
  }, STEP3_DELAY_MS);
  pendingStep3.set(contactId, handle);
  console.log(`[Step3Auto] Scheduled Step 3 for ${contactId} in ${STEP3_DELAY_MS / 1000}s`);
}

function clearPendingStep3(contactId) {
  if (pendingStep3.has(contactId)) {
    clearTimeout(pendingStep3.get(contactId));
    pendingStep3.delete(contactId);
    console.log(`[Step3Auto] Cancelled pending Step 3 for ${contactId}`);
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

  console.log(`[Webhook] Queuing job for contact ${contactId}: "${messageBody.slice(0, 60)}"`);

  // Cancel follow-up jobs immediately at intake — before enqueue — so a queued
  // AI handler or a due scheduler job cannot fire after this inbound arrives.
  followups.cancelContactJobs(contactId);

  // Cancel any pending auto-send of Step 3 (they replied, so flow resumes normally)
  clearPendingStep3(contactId);

  enqueueJob({ contactId, conversationId, messageBody, firstName, city, phone });
});

// ─── GHL Enrolled Webhook ─────────────────────────────────────────────────────
// Fires the moment GHL sends the static intro message to a new lead.
// We create the local contact record and schedule the 5-min silence check
// (and first email-hook) immediately — without waiting for them to reply.

app.post('/webhooks/ghl/enrolled', async (req, res) => {
  // Fail-closed auth: accept if GHL_WEBHOOK_SECRET matches, OR if ADMIN_KEY is provided.
  // Unlike the inbound webhook, this endpoint never runs in "open mode" — if neither
  // credential is configured/provided, the request is rejected.
  const adminKey = process.env.ADMIN_KEY;
  const providedKey =
    req.headers['x-admin-key'] ||
    req.query.key ||
    req.headers['x-ghl-signature'] ||
    req.headers['x-api-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    '';

  const secret = process.env.GHL_WEBHOOK_SECRET;
  const secretOk  = secret  && providedKey === secret;
  const adminOk   = adminKey && providedKey === adminKey;

  if (!secretOk && !adminOk) {
    console.warn('[Enrolled] Auth failed — missing or invalid credentials');
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
  const adminKey = process.env.ADMIN_KEY;
  const providedKey =
    req.headers['x-admin-key'] ||
    req.query.key ||
    req.headers['x-ghl-signature'] ||
    req.headers['x-api-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    '';

  const secret = process.env.GHL_WEBHOOK_SECRET;
  const secretOk = secret  && providedKey === secret;
  const adminOk  = adminKey && providedKey === adminKey;

  if (!secretOk && !adminOk) {
    console.warn('[ContactUpdated] Auth failed — missing or invalid credentials');
    return res.status(401).json({ error: 'Unauthorized' });
  }

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

  // If "Disable AI" tag is present, cancel all pending email jobs immediately
  if (tags.includes('disable ai')) {
    const cancelled = followups.cancelEmailJobs(contactId);
    console.log(`[ContactUpdated] Disable AI tag detected for ${contactId} — cancelled ${cancelled} pending email job(s)`);
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
    if (bodyLower.includes("you've got patients you haven't seen in 2+")) {
      updates.currentStep = 3;
    } else if (bodyLower.includes('i pulled up') && bodyLower.includes('while we were talking')) {
      updates.currentStep = 4;
    } else if (bodyLower.includes('lot not being captured') || (bodyLower.includes('expiring benefits') && bodyLower.includes('dormant'))) {
      updates.currentStep = 7;
    } else if (bodyLower.includes('sid, our founder')) {
      updates.currentStep = 8;
    } else if (bodyLower.includes('locked in') && bodyLower.includes('calendar invite')) {
      updates.currentStep = 9;
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
  let systemContent = prompts.get('conversationPrompt');

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
  const winningPromptSnippet = brain.buildWinningPatternsPrompt(currentStage);
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
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: systemContent,
    messages
  });

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
      conversationId: resolvedConvId || null
    });
    brain.recordOutbound(contactId, reply, detectedStep);
    followups.scheduleSilenceCheck(contactId, detectedStep, reply);
    console.log(`[Webhook] Sent to ${contactId} (step ${detectedStep}): "${reply.slice(0, 80)}"`);
  }

  // ── 9. Send address confirmation (if queued from PRACTICE_DETECTED) ───────────
  if (confirmationMsg) {
    try {
      await ghl.sendMessage(contactId, confirmationMsg);
      conversations.addExchange(contactId, {
        direction: 'outbound',
        body: confirmationMsg,
        step: 3,
        conversationId: resolvedConvId || null
      });
      brain.recordOutbound(contactId, confirmationMsg, 3);
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
    conversations.addExchange(contactId, { direction: 'outbound', body: clarification, step: 3, conversationId: resolvedConvId || null });
    brain.recordOutbound(contactId, clarification, 3);
    followups.scheduleSilenceCheck(contactId, 3, clarification);
    console.log(`[Webhook] Confirmation denied for ${contactId} — asking for correction`);
    return;
  }

  // Require explicit affirmative — ambiguous replies re-prompt so Step 3 stays held
  const isYes = /^(yes|yeah|yep|yup|correct|right|that('s| is)( it| right| the one)?|sure|exactly|affirmative|ok(ay)?|y)\b/.test(msg);
  if (!isYes) {
    const reprompt = "Just want to make sure — is that your practice listing? Reply yes or no.";
    await ghl.sendMessage(contactId, reprompt);
    conversations.addExchange(contactId, { direction: 'outbound', body: reprompt, step: 3, conversationId: resolvedConvId || null });
    brain.recordOutbound(contactId, reprompt, 3);
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
        conversations.addExchange(contactId, { direction: 'outbound', body: confirmMsg, step: 3, conversationId: resolvedConvId || null });
        brain.recordOutbound(contactId, confirmMsg, 3);
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
    const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
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
      contactId: c.contactId,
      firstName: c.firstName,
      city: c.city,
      practiceName: c.practiceName,
      booked: c.booked,
      currentStep: c.currentStep,
      exchangeCount: (c.exchanges || []).length,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt
    }));
  res.json(list);
});

app.get('/api/contacts/:contactId', requireAdmin, (req, res) => {
  const c = conversations.get(req.params.contactId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
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
  jobs = jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  res.json(jobs);
});

app.get('/api/followups/:contactId', requireAdmin, (req, res) => {
  const jobs = followups.getContactJobs(req.params.contactId);
  res.json(jobs.sort((a, b) => b.createdAt - a.createdAt));
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
  if (typeof text !== 'string') return res.status(400).json({ error: 'text field required' });
  try {
    prompts.set(name, text);
    res.json({ ok: true, name, length: text.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
  res.send(buildEnrollPage(key));
});

app.post('/api/enroll/run', requireAdmin, async (req, res) => {
  const tag    = typeof req.body.tag === 'string' && req.body.tag.trim() ? req.body.tag.trim() : 'amplify';
  const dryRun = req.body.dryRun !== false && req.body.dryRun !== 'false';
  try {
    const result = await runEnrollment({ tag, dryRun, delayMs: 1500 });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
  prompts.seed();
  brain.startScheduledAnalysis();
  followups.startScheduler();
  bootstrapStateFromGHL().catch(err => console.error('[Bootstrap] Error:', err.message));
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
body{background:#0f0f0f;color:#e8e8e8;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;padding:40px 16px 80px}
.logo{font-size:13px;font-weight:600;letter-spacing:.08em;color:#555;text-transform:uppercase;text-align:center;margin-bottom:40px}
h1{font-size:22px;font-weight:700;color:#fff;text-align:center;margin-bottom:8px}
.subtitle{font-size:14px;color:#666;text-align:center;margin-bottom:8px;line-height:1.5}
.refresh-info{font-size:12px;color:#444;text-align:center;margin-bottom:40px}
.panel{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;padding:28px;width:100%;max-width:960px;margin:0 auto 24px}
.panel-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:18px;display:flex;align-items:center;gap:10px}
.panel-title a{font-size:13px;font-weight:500;color:#748ffc;text-decoration:none;margin-left:auto}
.panel-title a:hover{text-decoration:underline}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:16px;margin-bottom:0}
.stat-box{background:#111;border:1px solid #2a2a2a;border-radius:10px;padding:16px 14px;text-align:center}
.stat-box .val{font-size:28px;font-weight:700;color:#fff;line-height:1}
.stat-box .lbl{font-size:11px;color:#666;margin-top:6px;text-transform:uppercase;letter-spacing:.06em}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:#555;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:0 10px 10px;border-bottom:1px solid #2a2a2a}
td{padding:10px;border-bottom:1px solid #1e1e1e;color:#ccc;vertical-align:top}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;white-space:nowrap}
.badge-booked{background:#14532d33;color:#4ade80;border:1px solid #14532d66}
.badge-active{background:#1e3a5f33;color:#60a5fa;border:1px solid #1e3a5f66}
.badge-pending{background:#3b2f1133;color:#fbbf24;border:1px solid #78450f66}
.badge-sent{background:#14532d33;color:#4ade80;border:1px solid #14532d66}
.badge-skipped{background:#2a1a1a33;color:#888;border:1px solid #3a2a2a66}
.badge-cancelled{background:#2a1a1a33;color:#666;border:1px solid #3a2a2a44}
.stage-row td{font-size:12.5px}
.empty{color:#444;font-size:13px;padding:20px 0;text-align:center}
.reply-rate{font-size:13px;color:#748ffc;font-weight:600}
.loading{color:#444;text-align:center;padding:20px;font-size:13px}
</style>
</head>
<body>
<div class="logo">Powered Up AI</div>
<div style="text-align:center;max-width:960px;margin:0 auto 40px">
  <h1>Admin Dashboard</h1>
  <p class="subtitle">Live overview of contacts, brain stats, and follow-up jobs.</p>
  <p class="refresh-info">Auto-refreshes every 30 seconds &bull; <span id="countdown">30</span>s until next refresh</p>
</div>

<div class="panel" id="panel-brain">
  <div class="panel-title">Brain Stats <a href="/admin/enroll?key=${adminKey}" style="margin-right:12px">Lead Enrollment &rarr;</a><a href="/admin/prompts?key=${adminKey}">Prompt Editor &rarr;</a></div>
  <div id="brain-content"><div class="loading">Loading&hellip;</div></div>
</div>

<div class="panel" id="panel-contacts">
  <div class="panel-title">Contacts</div>
  <div id="contacts-content"><div class="loading">Loading&hellip;</div></div>
</div>

<div class="panel" id="panel-followups">
  <div class="panel-title">Follow-Up Queue</div>
  <div id="followups-content"><div class="loading">Loading&hellip;</div></div>
</div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function loadBrain() {
  const el = document.getElementById('brain-content');
  try {
    const res = await fetch('/api/brain/stats', { headers: { 'x-admin-key': ADMIN_KEY } });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const t = data.totals || {};
    const replyRate = t.outbound > 0 ? Math.round((t.inbound / t.outbound) * 100) : 0;
    const bookedRate = t.contacts > 0 ? Math.round((t.booked / t.contacts) * 100) : 0;

    let stageRows = '';
    const stages = Object.entries(data.byStage || {});
    if (stages.length > 0) {
      stageRows = \`<table style="margin-top:20px">
        <thead><tr>
          <th>Stage</th><th>Sent</th><th>Replied</th><th>Reply Rate</th><th>Booked</th>
        </tr></thead>
        <tbody>\${stages.map(([stage, s]) => {
          const rate = s.sent > 0 ? Math.round((s.replied / s.sent) * 100) : 0;
          return \`<tr class="stage-row">
            <td>\${escHtml(stage)}</td>
            <td>\${s.sent}</td>
            <td>\${s.replied}</td>
            <td><span class="reply-rate">\${rate}%</span></td>
            <td>\${s.booked}</td>
          </tr>\`;
        }).join('')}</tbody>
      </table>\`;
    }

    el.innerHTML = \`
      <div class="stat-grid">
        <div class="stat-box"><div class="val">\${t.outbound || 0}</div><div class="lbl">Messages Sent</div></div>
        <div class="stat-box"><div class="val">\${t.inbound || 0}</div><div class="lbl">Replies In</div></div>
        <div class="stat-box"><div class="val">\${replyRate}%</div><div class="lbl">Reply Rate</div></div>
        <div class="stat-box"><div class="val">\${t.contacts || 0}</div><div class="lbl">Contacts</div></div>
        <div class="stat-box"><div class="val">\${t.booked || 0}</div><div class="lbl">Booked</div></div>
        <div class="stat-box"><div class="val">\${bookedRate}%</div><div class="lbl">Book Rate</div></div>
      </div>
      \${stageRows}
    \`;
  } catch (err) {
    el.innerHTML = '<div class="empty">Failed to load: ' + escHtml(err.message) + '</div>';
  }
}

async function loadContacts() {
  const el = document.getElementById('contacts-content');
  try {
    const res = await fetch('/api/contacts', { headers: { 'x-admin-key': ADMIN_KEY } });
    if (!res.ok) throw new Error(res.statusText);
    const list = await res.json();
    if (list.length === 0) {
      el.innerHTML = '<div class="empty">No contacts yet.</div>';
      return;
    }
    el.innerHTML = \`<table>
      <thead><tr>
        <th>Name</th><th>Practice</th><th>Step</th><th>Status</th><th>Messages</th><th>Last Activity</th>
      </tr></thead>
      <tbody>\${list.map(c => {
        const status = c.booked
          ? '<span class="badge badge-booked">Booked</span>'
          : '<span class="badge badge-active">Active</span>';
        return \`<tr>
          <td>\${escHtml(c.firstName || '—')}</td>
          <td>\${escHtml(c.practiceName || c.city || '—')}</td>
          <td>\${c.currentStep != null ? c.currentStep : '—'}</td>
          <td>\${status}</td>
          <td>\${c.exchangeCount || 0}</td>
          <td title="\${fmtTime(c.lastMessageAt)}">\${fmtRelative(c.lastMessageAt)}</td>
        </tr>\`;
      }).join('')}</tbody>
    </table>\`;
  } catch (err) {
    el.innerHTML = '<div class="empty">Failed to load: ' + escHtml(err.message) + '</div>';
  }
}

async function loadFollowups() {
  const el = document.getElementById('followups-content');
  try {
    const [jobsRes, contactsRes] = await Promise.all([
      fetch('/api/followups', { headers: { 'x-admin-key': ADMIN_KEY } }),
      fetch('/api/contacts', { headers: { 'x-admin-key': ADMIN_KEY } })
    ]);
    if (!jobsRes.ok) throw new Error(jobsRes.statusText);
    const jobs = await jobsRes.json();
    const contactMap = {};
    if (contactsRes.ok) {
      const contacts = await contactsRes.json();
      contacts.forEach(c => { contactMap[c.contactId] = c; });
    }
    if (jobs.length === 0) {
      el.innerHTML = '<div class="empty">No follow-up jobs found.</div>';
      return;
    }

    function contactName(contactId) {
      const c = contactMap[contactId];
      if (!c) return escHtml(contactId);
      const name = [c.firstName, c.practiceName || c.city].filter(Boolean).join(' — ');
      return \`<span title="\${escHtml(contactId)}">\${escHtml(name || contactId)}</span>\`;
    }

    function statusBadge(s) {
      const map = { pending:'badge-pending', sent:'badge-sent', skipped:'badge-skipped', cancelled:'badge-cancelled' };
      return \`<span class="badge \${map[s] || 'badge-skipped'}">\${escHtml(s)}</span>\`;
    }

    function channelBadge(type) {
      if ((type || '').startsWith('email-')) return '<span class="badge" style="background:#1a3a2a;color:#34d399;border:1px solid #166534">Email</span>';
      return '<span class="badge" style="background:#1a2a3a;color:#60a5fa;border:1px solid #1e40af">SMS</span>';
    }

    el.innerHTML = \`<table>
      <thead><tr>
        <th>Contact</th><th>Channel</th><th>Type</th><th>Position</th><th>Status</th><th>Scheduled</th><th>Created</th>
      </tr></thead>
      <tbody>\${jobs.map(j => \`<tr>
        <td>\${contactName(j.contactId)}</td>
        <td>\${channelBadge(j.type)}</td>
        <td>\${escHtml(j.type || '—')}</td>
        <td>\${j.position != null ? j.position : '—'}</td>
        <td>\${statusBadge(j.status)}</td>
        <td title="\${fmtTime(j.sendAt)}">\${fmtRelative(j.sendAt)}</td>
        <td title="\${fmtTime(j.createdAt)}">\${fmtRelative(j.createdAt)}</td>
      </tr>\`).join('')}</tbody>
    </table>\`;
  } catch (err) {
    el.innerHTML = '<div class="empty">Failed to load: ' + escHtml(err.message) + '</div>';
  }
}

function loadAll() {
  loadBrain();
  loadContacts();
  loadFollowups();
}

loadAll();

let secondsLeft = 30;
setInterval(() => {
  secondsLeft--;
  document.getElementById('countdown').textContent = secondsLeft;
  if (secondsLeft <= 0) {
    secondsLeft = 30;
    loadAll();
  }
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Prompt Editor — Powered Up AI</title>
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
</style>
</head>
<body>
<div class="logo">Powered Up AI</div>
<div class="page-header">
  <h1>Prompt Editor</h1>
  <p class="subtitle">View and edit every AI prompt. Changes take effect immediately — no restart needed.</p>
</div>
<div id="prompts"></div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
const ALL_PROMPTS = ${promptsJson};

function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

function renderPrompts() {
  const container = document.getElementById('prompts');
  container.innerHTML = '';
  ALL_PROMPTS.forEach(p => {
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
        <button class="btn btn-save" id="save-\${p.name}" onclick="savePrompt(\${JSON.stringify(p.name)})">Save</button>
        <button class="btn btn-reset" id="reset-\${p.name}" onclick="resetPrompt(\${JSON.stringify(p.name)})" \${p.isModified ? '' : 'disabled'}>Reset to default</button>
        <span class="status" id="status-\${p.name}"></span>
        <span class="char-count" id="chars-\${p.name}">\${p.current.length} chars</span>
      </div>
    \`;
    container.appendChild(card);
    const ta = document.getElementById('ta-' + p.name);
    ta.addEventListener('input', () => {
      document.getElementById('chars-' + p.name).textContent = ta.value.length + ' chars';
    });
  });
}

async function savePrompt(name) {
  const ta = document.getElementById('ta-' + name);
  const saveBtn = document.getElementById('save-' + name);
  const resetBtn = document.getElementById('reset-' + name);
  const statusEl = document.getElementById('status-' + name);
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
    statusEl.textContent = 'Saved';
    statusEl.className = 'status status-ok';
    const p = ALL_PROMPTS.find(x => x.name === name);
    if (p) { p.current = ta.value; p.isModified = true; }
    document.getElementById('badge-' + name).textContent = 'Modified';
    document.getElementById('badge-' + name).className = 'badge badge-modified';
    document.getElementById('card-' + name).className = 'prompt-card modified';
    resetBtn.disabled = false;
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch(err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'status status-err';
  } finally {
    saveBtn.disabled = false;
  }
}

async function resetPrompt(name) {
  if (!confirm('Reset "' + name + '" to its hardcoded default? This will discard your edits.')) return;
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
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch(err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'status status-err';
    resetBtn.disabled = false;
  }
}

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
</style>
</head>
<body>
<div class="logo">Powered Up AI</div>
<div style="text-align:center;max-width:1080px;margin:0 auto 40px">
  <h1>Lead Enrollment</h1>
  <p class="subtitle">Preview and enroll GHL contacts into the follow-up sequence.<br>Run a dry-run first to see what will happen, then click Run Enrollment to commit.</p>
</div>

<div class="panel">
  <div class="panel-title">Controls <a href="/admin?key=${adminKey}">&larr; Dashboard</a></div>
  <div class="controls">
    <label for="tag-input">Tag</label>
    <input type="text" id="tag-input" value="amplify" placeholder="amplify">
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

function setStatus(msg, warn) {
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className = warn ? 'status-bar warn' : 'status-bar';
}

function setBusy(busy) {
  document.getElementById('btn-preview').disabled = busy;
  document.getElementById('btn-run').disabled = busy;
}

function renderStats(stats, dryRun) {
  const panel = document.getElementById('stats-panel');
  panel.style.display = '';
  document.getElementById('stat-grid').innerHTML = \`
    <div class="stat-box"><div class="val">\${stats.total}</div><div class="lbl">Found</div></div>
    <div class="stat-box"><div class="val" style="color:#4ade80">\${stats.enrolled}</div><div class="lbl">\${dryRun ? 'Would Enroll' : 'Enrolled'}</div></div>
    <div class="stat-box"><div class="val" style="color:#888">\${stats.skipped}</div><div class="lbl">Skipped</div></div>
    <div class="stat-box"><div class="val" style="color:#f87171">\${stats.errors}</div><div class="lbl">Errors</div></div>
  \`;
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

async function doPreview() {
  const tag = document.getElementById('tag-input').value.trim() || 'amplify';
  setBusy(true);
  setStatus('Running dry-run preview\u2026');
  document.getElementById('stats-panel').style.display = 'none';
  document.getElementById('results-panel').style.display = 'none';
  document.getElementById('btn-run').disabled = true;

  try {
    const res = await fetch('/api/enroll/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ tag, dryRun: true })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
    lastRows = data.rows || [];
    renderStats(data.stats, true);
    renderRows(data.rows, true);
    setStatus('Dry-run complete. Review the table, then click Run Enrollment to commit.');
    document.getElementById('btn-run').disabled = false;
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    document.getElementById('btn-preview').disabled = false;
  }
}

window.addEventListener('DOMContentLoaded', () => doPreview());

async function doRun() {
  const tag = document.getElementById('tag-input').value.trim() || 'amplify';
  if (!confirm('This will write to conversations and schedule follow-up jobs. Continue?')) return;
  setBusy(true);
  setStatus('Running enrollment\u2026 (this may take a minute)');

  try {
    const res = await fetch('/api/enroll/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ tag, dryRun: false })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
    renderStats(data.stats, false);
    renderRows(data.rows, false);
    setStatus('Enrollment complete.');
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    setBusy(false);
  }
}
</script>
</body>
</html>`;
}
