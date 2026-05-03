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
const reconciliation = require('./reconciliation');
const prompts = require('./prompts');
const industry = require('./industry');
const variantBuilder = require('./variant-builder');

// Resolve the system-prompt body for a given variant id. Prefers a structured
// variant built in /admin/variants; falls back to the legacy raw-text prompt
// keyed by `conversationPrompt.${id}` so existing data keeps working.
function resolveVariantPrompt(variantId) {
  if (variantId) {
    const sv = variantBuilder.getVariant(variantId);
    if (sv) return variantBuilder.compileVariant(sv);
  }
  const key = variantId ? `conversationPrompt.${variantId}` : 'conversationPrompt';
  return prompts.get(key) || prompts.get('conversationPrompt');
}
const { runEnrollment } = require('./enrollment');
const spend = require('./spend');
const optouts = require('./optouts');
const outboundLock = require('./outbound-lock');

// Rapid-reply debounce — when a prospect sends two texts in quick succession
// (e.g. a main reply followed by "lol" a couple seconds later), each triggers a
// separate inbound webhook.  Without debouncing both webhooks fire the AI and two
// replies go out.  Instead we delay the AI call briefly: if a SECOND inbound for the
// same contact lands inside the window we cancel the first timer and restart it, so
// only ONE AI call fires — but by then both messages are recorded in exchanges and
// the AI sees the full turn and acknowledges everything they said.
const REPLY_DEBOUNCE_MS = 3500;
const _pendingAiReplies = new Map(); // contactId → { timer }

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

// ─── DND / Opt-Out Helpers ────────────────────────────────────────────────────
// GHL sets a contact's `dnd` flag (and per-channel `dndSettings`) when the
// prospect texts STOP, when staff toggle DND in the GHL UI, or when carrier
// opt-out events are recorded. Treat ANY DND signal — global or any channel —
// as a full opt-out: stop both SMS and email immediately.
function isDndFromPayload(payload) {
  if (!payload) return false;
  const c = payload.contact || payload;

  // Top-level boolean (string/number/bool variants from different GHL shapes).
  if (c.dnd === true || c.dnd === 'true' || c.dnd === 1 || c.dnd === '1') {
    return true;
  }

  // Per-channel dndSettings: { Email: { status: 'active' }, SMS: {...}, Call: {...}, ... }
  const settings = c.dndSettings || c.dnd_settings;
  if (settings && typeof settings === 'object') {
    for (const ch of Object.values(settings)) {
      if (!ch) continue;
      const status = String(ch.status || ch.Status || '').toLowerCase();
      if (status === 'active') return true;
    }
  }
  return false;
}

// Add to opt-out blocklist and cancel all pending SMS + email jobs.
// Order matters: blocklist write first so the scheduler's isOptedOut check
// catches any job that picks up between cancellation and commit.
// Idempotent — safe to call multiple times for the same contact.
async function applyOptOut(contactId, reason) {
  // Capture the contact's variant at opt-out time so per-variant opt-out
  // rates can be computed in the admin dashboard. Falls back to null when
  // the contact isn't in the local cache (e.g. carrier STOP for a contact
  // that never got fully enrolled) — the optouts module accepts null.
  const variant = conversations.get(contactId)?.variant || null;
  await optouts.add(contactId, variant);
  const cancelledSms = followups.cancelContactJobs(contactId);
  const cancelledEmail = followups.cancelEmailJobs(contactId);
  console.log(`[Optout] ${contactId} blocklisted (${reason}, variant=${variant || 'unknown'}) — cancelled ${cancelledSms} SMS + ${cancelledEmail} email job(s)`);
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

  // ── Activity-event guard (added Apr 28, 2026) ────────────────────────────────
  // GHL fires inbound webhooks for non-message events too: DnD toggles
  // ("DnD enabled by customer"), opportunity-stage changes, contact tag
  // updates, etc. These carry messageType values like TYPE_ACTIVITY_CONTACT
  // or TYPE_ACTIVITY_OPPORTUNITY and a body string describing the event.
  // Without this filter the activity body slips into handleInbound, gets
  // treated as a prospect reply, and triggers an AI generation that — with
  // no real conversational context — defaults to re-emitting Step 1.
  // Root cause of the duplicate-opener regression observed for Kate
  // (dPr5UoTRyB66NMsKZj08, variant C) on Apr 28.
  const _msgType = payload.messageType || payload.message?.messageType || '';
  if (typeof _msgType === 'string' && _msgType.startsWith('TYPE_ACTIVITY')) {
    console.log(`[Webhook] Skipping non-SMS activity event: ${_msgType}`);
    return res.json({ received: true, skipped: 'activity-event' });
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

  // GHL message ID — used for dedup against the reconciliation poller so the
  // same inbound is never processed twice (once via webhook, once via poll).
  // GHL ships several payload shapes; cover the common ones.
  const messageId =
    payload.messageId ||
    payload.message_id ||
    payload.message?.id ||
    payload.id ||
    null;

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

  // ── DND check ─────────────────────────────────────────────────────────────
  // If GHL has already flagged this contact as DND (e.g. carrier processed STOP
  // before forwarding the message), treat it as a full opt-out and bail.
  if (isDndFromPayload(payload)) {
    console.log(`[Webhook] Contact ${contactId} has DND set on inbound — applying opt-out`);
    await applyOptOut(contactId, 'inbound DND');
    return;
  }

  // ── Opt-out keyword detection ─────────────────────────────────────────────
  if (optouts.isOptOutKeyword(messageBody)) {
    console.log(`[Webhook] Contact ${contactId} sent opt-out keyword "${messageBody}" — cancelling jobs and confirming`);
    await applyOptOut(contactId, `keyword: ${messageBody.slice(0, 30)}`);
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

  enqueueJob({ contactId, conversationId, messageBody, firstName, city, phone, messageId });
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

// ─── Sid handoff alert (Task #86) ────────────────────────────────────────────
// Lightweight one-way SMS to Sid whenever a contact moves into verbal-commit.
// Reuses the existing GHL pipe — Sid adds himself as a contact in GHL once,
// puts his contact UUID in SID_GHL_CONTACT_ID. If the env var is unset, this
// is a silent no-op so the system runs identically to before. DEV_MODE prints
// a "would have texted" line instead of sending. Failures are logged and
// swallowed — they MUST NOT block the [BOOKED] write that triggered them.
async function notifySid(text) {
  if (!process.env.SID_GHL_CONTACT_ID) return;
  if (DEV_MODE) { console.log('[Notify][DEV MODE] Would have texted Sid: ' + text); return; }
  try {
    // ghl.sendMessage swallows its own errors and returns null on failure
    // (see ghl.js line ~69), so a falsy return is the failure signal we have
    // to surface here. The try/catch is kept as a belt-and-suspenders in case
    // the wrapper ever stops swallowing.
    const result = await ghl.sendMessage(process.env.SID_GHL_CONTACT_ID, text);
    if (!result) console.warn('[Notify] Sid alert failed: ghl.sendMessage returned null (see [GHL] sendMessage error log above for details)');
  } catch (err) {
    console.warn('[Notify] Sid alert failed: ' + err.message);
  }
}

// ─── Variant E Prompt Builder ──────────────────────────────────────────────────
// Steps 0-9: shared + opening + all four branches (routing turn needs exact copy).
// Steps 10+: shared + active branch only.
//
// Branch lock: once a contact has entered a branch (first step >= 10 marker
// detected), the branch letter is stamped onto the contact as `variantEBranch`
// and passed in here. When set, branchLock takes precedence over currentStep
// for branch selection. This guards against an out-of-sequence step marker
// (retry, hallucination, AI emitting [STEP:29] after [STEP:30]) flipping the
// active branch script mid-conversation, which would otherwise feed the AI
// the wrong script copy on the next inbound.
function buildVariantESystemPrompt(currentStep, branchLock) {
  const shared  = prompts.get('conversationPrompt.E.shared')  || '';
  const opening = prompts.get('conversationPrompt.E.opening') || '';
  const branchA = prompts.get('conversationPrompt.E.branchA') || '';
  const branchB = prompts.get('conversationPrompt.E.branchB') || '';
  const branchC = prompts.get('conversationPrompt.E.branchC') || '';
  const branchD = prompts.get('conversationPrompt.E.branchD') || '';

  if (branchLock === 'A') return [shared, branchA].filter(Boolean).join('\n\n');
  if (branchLock === 'B') return [shared, branchB].filter(Boolean).join('\n\n');
  if (branchLock === 'C') return [shared, branchC].filter(Boolean).join('\n\n');
  if (branchLock === 'D') return [shared, branchD].filter(Boolean).join('\n\n');

  if (currentStep < 10) {
    return [shared, opening, branchA, branchB, branchC, branchD].filter(Boolean).join('\n\n');
  } else if (currentStep <= 29) {
    return [shared, branchA].filter(Boolean).join('\n\n');
  } else if (currentStep <= 49) {
    return [shared, branchB].filter(Boolean).join('\n\n');
  } else if (currentStep <= 69) {
    return [shared, branchC].filter(Boolean).join('\n\n');
  } else {
    return [shared, branchD].filter(Boolean).join('\n\n');
  }
}

// Map a step number to its branch letter. Returns null for opening steps (< 10).
// Kept in sync with buildVariantESystemPrompt's currentStep ranges above.
function _variantEBranchForStep(step) {
  if (typeof step !== 'number' || step < 10) return null;
  if (step <= 29) return 'A';
  if (step <= 49) return 'B';
  if (step <= 69) return 'C';
  return 'D';
}

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
    let systemContent;
    if (variant === 'E' && !variantBuilder.getVariant('E')) {
      systemContent = buildVariantESystemPrompt(0);
    } else {
      systemContent = resolveVariantPrompt(variant);
    }
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
    // Use the LAST [STEP:N] marker in case Claude emits multiple step markers
    // in one turn (e.g. Variant E Steps 2+3 sent together).
    const allOpenerStepMatches = [...openerText.matchAll(/\[STEP:(\d+)\]/gi)];
    const detectedStep = allOpenerStepMatches.length > 0
      ? parseInt(allOpenerStepMatches[allOpenerStepMatches.length - 1][1], 10) : null;
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
    let openerConvId = null;
    if (DEV_MODE) {
      console.log(`[Opener][DEV MODE] Generated opener for ${contactId} (variant ${variant || 'none'}), not sending: "${openerText.slice(0, 120)}"`);
      sendResult = { id: 'dev-mode-stub' };
    } else {
      sendResult = await ghl.sendMessage(contactId, openerText);
      if (!sendResult) {
        console.error(`[Opener] GHL send returned null for ${contactId} — not persisting`);
        return;
      }
      // Resolve conversationId so the reconciliation poller (trap #9 safety
      // net) can poll this contact if any future inbound webhook is dropped
      // by GHL. Without this, the contact's exchanges all carry
      // conversationId=null and the poller skips them entirely — meaning a
      // dropped reply is never recovered. Best-effort: a failed lookup just
      // means we lose the recon safety net for this one contact, not a
      // hard error.
      try {
        openerConvId = await ghl.getOrCreateConversation(contactId);
      } catch (err) {
        console.warn(`[Opener] Could not resolve conversationId for ${contactId}:`, err.message);
      }
    }

    // Persist as Hook 1 so the silence-check dedup correctly suppresses
    // the legacy "Hey, you there?" static fallback.
    conversations.addExchange(contactId, {
      direction: 'outbound',
      body: openerText,
      step: detectedStep ?? 0,
      conversationId: openerConvId,
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

  // Guard: already opted out (carrier STOP, prior keyword, manual blocklist)
  if (await optouts.isOptedOut(contactId)) {
    console.log(`[Enrolled] Skipping ${contactId} — already on opt-out blocklist`);
    return;
  }

  // Guard: GHL DND set on this contact → record the opt-out and skip
  if (isDndFromPayload(payload)) {
    console.log(`[Enrolled] Skipping ${contactId} — DND set on enrollment, recording opt-out`);
    await applyOptOut(contactId, 'enrollment DND');
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

  // If GHL has flagged this contact as DND (carrier STOP, manual toggle, or
  // any per-channel DND), apply a full opt-out — cancel SMS + email and add
  // to blocklist so the scheduler skips any race-window jobs.
  if (isDndFromPayload(payload)) {
    console.log(`[ContactUpdated] DND detected for ${contactId} — applying opt-out`);
    await applyOptOut(contactId, 'contact-updated DND');
  }
});

// ─── State Recovery from GHL History ─────────────────────────────────────────
// Called when local state may be incomplete (e.g. server restart). Scans the
// raw GHL message history and patches any missing flags back into the contact.

function recoverStateFromHistory(contactId, fresh, rawGhlMessages) {
  if (!rawGhlMessages || rawGhlMessages.length === 0) return;

  // GHL messages come newest-first — find the most recent outbound we sent.
  // (Direction is always a string in GHL's fetch shape; the bogus
  // `m.type === 2` fallback was removed Apr 28, 2026 — type=2 is TYPE_SMS,
  // a messageType code, not a direction.)
  const lastOutbound = rawGhlMessages.find(m => {
    const isInbound = m.direction === 'inbound' ||
                      m.messageType === 'inbound';
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

async function handleInbound({ contactId, conversationId, messageBody, firstName, city, phone, messageId }) {
  // ── 0a. Dedup against reconciliation poller ──────────────────────────────────
  // If we've already recorded an inbound exchange with this GHL messageId, the
  // webhook and the reconciliation poller raced to deliver the same message —
  // drop the second one silently to prevent a double AI reply.
  if (messageId && await conversations.hasExchangeWithMessageId(messageId)) {
    console.log(`[Webhook] Dedup — messageId ${messageId} already processed for ${contactId}`);
    return;
  }

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

  // ── 3. Record this inbound message — ATOMIC CLAIM ───────────────────────────
  // Closes the race window between this caller (webhook or reconciliation
  // poller) and any other caller processing the same GHL messageId. The
  // upfront 0a check is a fast-path optimization; this claim is the
  // authoritative single-winner gate. Backed by a partial unique index on
  // exchanges(message_id) — DB-enforced, app cannot accidentally bypass.
  // If we lost (rowCount=0), Claude is never called for this message.
  const claimed = await conversations.tryClaimInbound(contactId, {
    body: messageBody,
    step: conversations.get(contactId)?.currentStep || 0,
    conversationId,
    messageId: messageId || null
  });
  if (!claimed) {
    console.log(`[Webhook] Race lost — messageId ${messageId} already claimed for ${contactId}, skipping AI`);
    return;
  }

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

  // ── 4.6. Rapid-reply debounce → AI generation pipeline ───────────────────────
  // Defer the AI call by REPLY_DEBOUNCE_MS.  If a second inbound for this contact
  // arrives inside the window, the first timer is cancelled and a new one is set —
  // so only ONE AI call fires.  Both messages are already stored in exchanges by
  // tryClaimInbound, so generateAndSendAiReply sees the full turn (re-fetches fresh
  // state on its own, so no need to pass stale opts).
  {
    const existing = _pendingAiReplies.get(contactId);
    if (existing) {
      clearTimeout(existing.timer);
      console.log(`[Webhook] Debounce — batching rapid reply for ${contactId}, resetting timer`);
    }
    const timer = setTimeout(async () => {
      _pendingAiReplies.delete(contactId);
      try {
        await generateAndSendAiReply(contactId, resolvedConvId, {
          resolvedFirstName,
          resolvedCity
          // Intentionally omit fresh & rawGhlMessages — re-fetched for latest state,
          // which now includes all batched rapid-fire messages from this prospect.
        });
      } catch (err) {
        console.error(`[Webhook] Debounced AI call failed for ${contactId}:`, err.message);
      }
    }, REPLY_DEBOUNCE_MS);
    _pendingAiReplies.set(contactId, { timer });
  }
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
  const messageBody = opts.messageBody ?? '';
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
  // prompt (A/B/C/D/E); fall back to the base prompt if no variant is assigned.
  // Variant E uses a modular composition: shared rules + branch script selected
  // by currentStep. All other variants use a single flat prompt key.
  const contactVariant = fresh?.variant || null;
  let systemContent;
  if (contactVariant === 'E' && !variantBuilder.getVariant('E')) {
    systemContent = buildVariantESystemPrompt(fresh?.currentStep ?? 0, fresh?.variantEBranch || null);
  } else {
    systemContent = resolveVariantPrompt(contactVariant);
  }

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

  // ─── Defensive outbound-quality guard (added Apr 26, pre-launch) ───
  // Two failure modes observed in stress testing on variant A under extreme
  // low-engagement prospects (4× "ok", or "maybe"/"I dunno" loops):
  //   (a) verbatim duplicate of the last outbound
  //   (b) third consecutive outbound carrying the same [STEP:N] marker —
  //       which violates the prompt-level "HARD CAP" rule
  // The prompt-level rules cover ~99% of cases; this guard catches the
  // residual 1%. On a detected violation we retry the Claude call ONCE
  // with a corrective system-prompt addendum, then let the retried reply
  // fall through into the normal marker pipeline below. Single retry only —
  // no infinite loops. Applies to every variant; benign on B/C/D since the
  // guard only fires on actual violations.
  {
    const stripMarkers = (s) => String(s || '')
      .replace(/\[(?:STEP:\d+|DECLINED|BOOKED|PRACTICE_DETECTED:[^\]]+)\]\s*/gi, '');
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const recentOutbounds = (fresh?.exchanges || [])
      .filter(e => e.direction === 'outbound')
      .slice(-2);
    const lastOut = recentOutbounds.length
      ? recentOutbounds[recentOutbounds.length - 1].body
      : '';
    const replyClean = norm(stripMarkers(reply));
    const lastClean = norm(lastOut);
    const isDuplicate = !!replyClean && !!lastClean && replyClean === lastClean;

    let isHardCapViolation = false;
    const _stepPreMatches = [...reply.matchAll(/\[STEP:(\d+)\]/gi)];
    const _newStepPre = _stepPreMatches.length > 0
      ? parseInt(_stepPreMatches[_stepPreMatches.length - 1][1], 10) : null;
    if (_newStepPre !== null && recentOutbounds.length === 2 &&
        recentOutbounds[0].step === _newStepPre &&
        recentOutbounds[1].step === _newStepPre) {
      isHardCapViolation = true;
    }

    // Same-step re-ask guard: if the very last outbound was also [STEP:N] and we're
    // about to emit [STEP:N] again, that means the AI re-asked after a prospect reply
    // (the Mary Ellen case: political joke → AI re-sent step 2 verbatim). The existing
    // hard-cap only fires on 3-in-a-row; this catches the 2-in-a-row re-ask. We nudge
    // rather than silently drop — the nudge explicitly allows genuine one-time clarifiers
    // (short, specific follow-up question NOT restating the scripted text) while blocking
    // the verbatim re-ask pattern.
    let isSameStepReask = false;
    // Variant E step 3 is the routing turn: one legitimate [STEP:3] clarifying question
    // is allowed after an ambiguous menu reply. The hard-cap (3-in-a-row) still applies.
    const isVariantEStep3Clarifier = contactVariant === 'E' && _newStepPre === 3;
    if (!isHardCapViolation && !isVariantEStep3Clarifier && _newStepPre !== null && recentOutbounds.length > 0) {
      const _lastStep = recentOutbounds[recentOutbounds.length - 1].step;
      if (_lastStep !== null && _lastStep !== undefined && _lastStep === _newStepPre) {
        isSameStepReask = true;
      }
    }

    const violation = isDuplicate ? 'duplicate' : (isHardCapViolation ? 'hard_cap' : (isSameStepReask ? 'same_step_reask' : null));
    if (violation) {
      const fname = resolvedFirstName || fresh?.firstName || 'there';
      const nudge = violation === 'duplicate'
        ? `\n\n!! REGENERATION REQUIRED: your draft is identical to the last message you already sent. Do NOT repeat yourself verbatim. The prospect is being vague. Either ask a DIFFERENT concrete yes/no clarifying question, or send the polite exit ("No worries ${fname} — text me if anything changes.") followed by [DECLINED].`
        : violation === 'same_step_reask'
        ? `\n\n!! SAME-STEP RE-ASK DETECTED: your last outbound was [STEP:${_newStepPre}] and you are about to send [STEP:${_newStepPre}] again after a prospect reply. After any prospect reply you MUST do one of: (1) advance to [STEP:${_newStepPre + 1}] — if the prospect gave any reply, even a joke, deflection, or tangent, that reply COUNTS as answering and you advance; OR (2) send ONE short tight clarifying question (NOT the scripted question text verbatim) only if their reply was genuinely numerically or factually ambiguous; OR (3) send the polite exit ("No worries ${fname} — text me if anything changes.") followed by [DECLINED]. Humor, politics, tangents, and deflections all count as answered — acknowledge what they said specifically and warmly, then advance. Do NOT re-send the scripted step question.`
        : `\n\n!! REGENERATION REQUIRED: you have already sent [STEP:${_newStepPre}] in your two most recent outbound messages. The HARD CAP forbids three in a row. You MUST either advance to [STEP:${_newStepPre + 1}] OR send the polite exit ("No worries ${fname} — text me if anything changes.") followed by [DECLINED]. Do NOT emit [STEP:${_newStepPre}] again.`;

      console.warn(`[AiGen] Outbound rule violation (${violation}) for ${contactId} on variant ${contactVariant || 'none'} — retrying once with corrective nudge`);
      try {
        const retry = await anthropic.messages.create({
          model,
          max_tokens: 512,
          system: systemContent + nudge,
          messages
        });
        spend.track(contactId, model, retry.usage);
        const retryText = retry.content[0]?.text?.trim() || '';
        if (retryText) {
          reply = retryText;
        } else {
          console.warn(`[AiGen] Retry returned empty for ${contactId} — keeping original draft`);
        }
      } catch (err) {
        console.error(`[AiGen] Retry call failed for ${contactId}:`, err.message);
        // Keep original reply: better to send a duplicate than nothing.
      }
    }
  }

  // ── Extract hidden markers ──

  // [STEP:N] — track current step.
  // Use the LAST marker in case Claude emits multiple step markers in one turn
  // (e.g. Variant E Steps 2+3 sent together). Using the last marker ensures
  // currentStep lands on the final state of the turn (e.g. step 3, not step 2).
  const allStepMatches = [...reply.matchAll(/\[STEP:(\d+)\]/gi)];
  const detectedStep = allStepMatches.length > 0
    ? parseInt(allStepMatches[allStepMatches.length - 1][1], 10) : null;
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

          if (contactVariant === 'E') {
            // Variant E: same confirmation flow as all other variants.
            // After the prospect says "yes", handleConfirmationReply fires
            // startResearchAndScan + scheduleAiResponseAfterResearch, which calls
            // Claude again to generate the video link step cleanly.
            // Defensive truncation: if the AI bundled [Link] into the same reply as
            // [PRACTICE_DETECTED], strip everything from the second paragraph onwards
            // so only the bridge sentence ("Got it, [name]... Checking now...") is sent.
            // Claude re-generates the video step after confirmation.
            if (reply.includes('[Link]')) {
              reply = (reply.split(/\n\n/)[0] || reply).trim();
              console.log(`[AiGen] Variant E: stripped video link from pre-confirmation reply for ${contactId}`);
            }
            conversations.update(contactId, {
              confirmationPending: { placeId: topResult.place_id, name: confirmName, address: confirmAddress, city: practiceCity }
            });
            confirmationMsg = `Found ${confirmName} at ${confirmAddress} — is that the right one?`;
            console.log(`[AiGen] Variant E: address confirmation queued for ${contactId}: ${confirmName}`);
          } else {
            conversations.update(contactId, {
              confirmationPending: { placeId: topResult.place_id, name: confirmName, address: confirmAddress, city: practiceCity }
            });
            confirmationMsg = `Found ${confirmName} at ${confirmAddress} — is that the right one?`;
            console.log(`[AiGen] Address confirmation queued for ${contactId}: ${confirmName}`);
          }
        } else {
          console.log(`[AiGen] No listing found for "${searchQuery}" — skipping confirmation`);
          startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
          if (contactVariant !== 'E') scheduleAiResponseAfterResearch(contactId, resolvedConvId);
        }
      } catch (err) {
        console.error('[AiGen] Fast lookup error:', err.message);
        startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
        if (contactVariant !== 'E') scheduleAiResponseAfterResearch(contactId, resolvedConvId);
      }
    } else {
      startResearchAndScan(contactId, practiceName, practiceStreet, practiceCity, null);
      if (contactVariant !== 'E') scheduleAiResponseAfterResearch(contactId, resolvedConvId);
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
    // Hard gate (added Apr 26): refuse to honor [BOOKED] until both LIVE
    // RESEARCH DATA and SCAN RESULTS were present in the system context for
    // this generation. Without both, the prospect was never qualified — the
    // founder Sid would join the call without the personalized data the
    // entire pitch hinges on. The prompt-level "NEVER BOOK BEFORE QUALIFYING"
    // rule covers 99% of cases; this gate is the belt-and-suspenders for the
    // 1% where the model drifts. Strip the marker, keep the conversation
    // active, and DON'T pause the AI so the next prospect message gets a
    // normal reply (model will redirect via the in-prompt pivot string).
    //
    // CARVE-OUT (added Apr 28, Carson regression): when the prospect EXPLICITLY
    // asks for the video or for a human, the qualification gate is bypassed.
    // The prompt's WANT-VIDEO-NOW / WANT-HUMAN handlers in OFF-SCRIPT REPLIES
    // tell Claude to fire [BOOKED] in those cases without research/scan; this
    // server-side belt-and-suspenders matches that contract by inspecting the
    // most recent inbound text against a generous handoff-signal regex list.
    // If the inbound matches, [BOOKED] is allowed through (booked=true,
    // paused_reason='verbal-commit' as normal). Sid takes the handoff from
    // there. The regex list is intentionally loose — false positives just mean
    // a slightly eager handoff, which is the entire point of these handlers.
    const lacksQualification = !fresh?.researchData || !fresh?.scanResults;
    const HANDOFF_REGEXES = [
      // WANT-VIDEO-NOW patterns
      /\bjust\s+(?:send|give)\s+(?:me\s+)?(?:the\s+)?(?:link|video|meeting|training|program)\b/i,
      /\b(?:send|shoot|fire)\s+(?:me\s+|it\s+)?(?:the\s+)?(?:link|video|over|it\s+over|the\s+meeting|the\s+program|it\s+now)\b/i,
      /\bshow\s+me\s+(?:it|the\s+video|the\s+link)\b/i,
      /\bgive\s+me\s+(?:the\s+)?(?:video|link|meeting|training|program)\b/i,
      /\bi\s+(?:want|wanna)\s+(?:to\s+)?(?:watch|see)\s+(?:it|the\s+video)\b/i,
      /\bfire\s+it\s+over\b/i,
      // WANT-HUMAN patterns. NOTE: "stop the bot/chatbot" is intentionally
      // EXCLUDED — it collides with the TCPA opt-out keyword \bstop\b in
      // optouts.js, which fires before AI generation and is the safer
      // (TCPA-compliant) interpretation. Same for "are you a bot?" — that
      // is a curiosity question handled by the OBJECTIONS "Is this a bot?"
      // deflection, NOT a rejection. Only kill/no-more/I-don't-want-AI
      // patterns route here as explicit rejection-of-bot signals.
      /\btalk\s+to\s+(?:someone|a\s+(?:real\s+)?person|a\s+human|sid|the\s+founder)\b/i,
      /\bspeak\s+(?:to|with)\s+(?:someone|a\s+(?:real\s+)?person|a\s+human|sid|the\s+founder)\b/i,
      /\bhave\s+(?:someone|sid)\s+(?:call|reach\s+out|contact)\s+me\b/i,
      /\bi\s+(?:want|need)\s+(?:a\s+)?human\b/i,
      /\bi\s+(?:want|need)\s+(?:to\s+)?(?:talk|speak)\s+to\s+(?:someone|a\s+(?:real\s+)?person|a\s+human)\b/i,
      /\b(?:i\s+)?(?:don'?t|do\s+not)\s+want\s+(?:to\s+talk\s+to\s+)?(?:an?\s+)?ai\b/i,
      /\b(?:i\s+)?(?:don'?t|do\s+not)\s+want\s+(?:to\s+talk\s+to\s+)?(?:an?\s+)?(?:chat\s?)?bot\b/i,
      /\bchat\s?bot\b/i,
      /\bkill\s+(?:the\s+)?(?:chat\s?)?bot\b/i,
      /\bno\s+more\s+(?:chat\s?)?bot\b/i,
      /\bgive\s+me\s+a\s+call\b/i,
    ];
    const inboundForHandoff = (typeof messageBody === 'string') ? messageBody : '';
    const handoffMatch = HANDOFF_REGEXES.find(r => r.test(inboundForHandoff));
    if (isHallucination) {
      console.warn(`[AiGen] [BOOKED] hallucination suppressed for ${contactId} (declined-context). Reply discarded: "${reply.slice(0, 80)}"`);
      conversations.update(contactId, { booked: true, pausedReason: 'declined' });
      reply = '';
    } else if (lacksQualification && !handoffMatch) {
      console.warn(`[AiGen] [BOOKED] suppressed for ${contactId} (premature: researchData=${!!fresh?.researchData}, scanResults=${!!fresh?.scanResults}). Reply kept, AI not paused. Reply: "${reply.slice(0, 80)}"`);
      // Do NOT pause. Do NOT mark booked. Reply text stays so the prospect
      // gets some response, but the conversation continues so the AI can
      // properly qualify on the next turn. (The prompt's pivot string should
      // be in the reply already; if not, at least we preserved the message.)
    } else {
      if (lacksQualification && handoffMatch) {
        console.log(`[AiGen] [BOOKED] allowed via handoff carve-out for ${contactId} (matched: ${handoffMatch.source}). Inbound: "${inboundForHandoff.slice(0, 80)}"`);
      }
      conversations.update(contactId, { booked: true, pausedReason: 'verbal-commit' });
      console.log(`[AiGen] Contact ${contactId} agreed to book — AI paused (paused_reason=verbal-commit), awaiting GHL appointment confirmation`);
      // Sid handoff alert (Task #86) — fire-and-forget, never blocks the booking write
      notifySid(`🚨 ${fresh?.firstName || 'Prospect'} just booked. Last said: "${(messageBody || '').slice(0, 140)}"`);
    }
  }

  // Update step
  if (detectedStep !== null) {
    const stepUpdates = { currentStep: detectedStep };
    // Variant E branch lock: the first time a branch-range step marker
    // (>= 10) is detected, stamp the branch letter onto the contact.
    // From this point on buildVariantESystemPrompt() routes by the lock,
    // not by currentStep, so an out-of-sequence step marker (retry,
    // hallucination) cannot flip the active branch script mid-conversation.
    if (contactVariant === 'E' && !fresh?.variantEBranch) {
      const branch = _variantEBranchForStep(detectedStep);
      if (branch) {
        stepUpdates.variantEBranch = branch;
        console.log(`[VariantE] Branch lock set to ${branch} for ${contactId} at step ${detectedStep}`);
      }
    }
    conversations.update(contactId, stepUpdates);
  }

  // Persisted step: prefer Claude's marker, fall back to the contact's last
  // known step so brain/followups never receive null when we have prior state.
  const persistStep = detectedStep ?? fresh?.currentStep ?? null;

  // Variant E: inject VSL URL into [Link] placeholder.
  // Resolved from VARIANT_E_VSL_URL env var then conversationPrompt.E.vslUrl prompt key.
  // Fail-closed: no send if neither is configured (prevents broken message).
  if (contactVariant === 'E' && reply.includes('[Link]')) {
    const vslUrl = process.env.VARIANT_E_VSL_URL || prompts.get('conversationPrompt.E.vslUrl') || '';
    if (vslUrl) {
      reply = reply.replace(/\[Link\]/gi, vslUrl);
    } else {
      console.error(`[AiGen] Variant E video step blocked for ${contactId}: no VSL URL configured`);
      reply = '';
    }
  }

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
    // Variant E video link steps (12/32/52/72): suppress the normal 5-minute
    // silence nudge. The only planned follow-up for prospects who haven't booked
    // after receiving the video is the Data Payload (scheduled below). Scheduling
    // both would send two unsolicited follow-ups, which violates the spec.
    const isVariantEVideoStep = contactVariant === 'E' && [12, 32, 52, 72].includes(detectedStep);
    if (!isVariantEVideoStep) {
      followups.scheduleSilenceCheck(contactId, persistStep, reply);
    }
    console.log(`[AiGen] Sent to ${contactId} (step ${persistStep}, variant ${contactVariant || 'none'}): "${reply.slice(0, 80)}"`);

    // Variant E: schedule Data Payload follow-up 15–20 min after video link steps.
    // Deduplicate: skip if a pending or sent data-payload job already exists for
    // this contact (e.g. hesitation handler fires step 12 while a job is pending).
    if (contactVariant === 'E' && [12, 32, 52, 72].includes(detectedStep)) {
      const existingDataPayload = followups.getAllJobs().find(
        j => j.contactId === contactId && j.type === 'data-payload' &&
             (j.status === 'pending' || j.status === 'sent')
      );
      if (!existingDataPayload) {
        const delayMs = (15 + Math.random() * 5) * 60 * 1000;
        followups.scheduleJob({
          contactId,
          type: 'data-payload',
          position: 1,
          sendAt: Date.now() + delayMs,
          context: { variant: 'E', videoStep: detectedStep, retries: 0 }
        });
        console.log(`[DataPayload] Scheduled for ${contactId} in ~${Math.round(delayMs / 60000)} min (after step ${detectedStep})`);
      } else {
        console.log(`[DataPayload] Skipping schedule for ${contactId} — job already exists (${existingDataPayload.status})`);
      }
    }
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

  // GHL appends "\nReply STOP to unsubscribe." to the FIRST outbound of every
  // new conversation as a TCPA compliance footer. When fetched back, that
  // suffix used to cause the entire opener to be dropped here as a "system
  // message" — leaving Claude with no conversational context and triggering
  // a duplicate-opener regeneration on the prospect's first reply. Strip the
  // suffix instead of dropping the message. (Root cause of the recurring
  // duplicate-opener bug fixed Apr 28, 2026.)
  const TCPA_OPTOUT_SUFFIX = /[\s\.]*Reply\s+STOP\s+to\s+unsubscribe\.?\s*$/i;

  const mapped = chronological
    .filter(m => m.body || m.message)
    .filter(m => {
      // Drop outbound messages that GHL/Twilio failed to deliver — Claude should
      // not treat them as received by the prospect.
      // NOTE: in GHL's /conversations/messages fetch shape, `direction` is
      // always a string ('inbound' | 'outbound'). The numeric `type` field is
      // the *messageType code* (1=CALL, 2=SMS, 25=ACTIVITY_CONTACT, …) — NOT
      // a direction code. An earlier `m.type === 1` fallback here mis-flagged
      // every outbound SMS as inbound. Removed Apr 28, 2026.
      const outbound = m.direction === 'outbound' ||
                       m.messageType === 'outbound';
      if (outbound && m.status === 'failed') return false;
      // Drop GHL activity / system-event entries (DnD toggles, opportunity-stage
      // changes, contact tag updates). They aren't real messages and would
      // pollute Claude's view of the conversation.
      const mt = m.messageType || m.type || '';
      if (typeof mt === 'string' && mt.startsWith('TYPE_ACTIVITY')) return false;
      // Strip automated GHL system messages (CRM notifications, workflow triggers, etc.)
      const text = (m.body || m.message || '').trim();
      if (/CRM ID:/i.test(text)) return false;
      if (/opportunity created/i.test(text)) return false;
      // Don't drop messages that merely CONTAIN the TCPA opt-out boilerplate —
      // GHL appends it as a suffix to legitimate first outbounds. The suffix
      // is stripped in the .map() below and the body is preserved.
      return true;
    })
    .map(m => {
      // GHL fetch shape: `direction` is always a string. Same bug as above —
      // `m.type === 2` was a bogus direction-fallback (type=2 is TYPE_SMS,
      // a messageType code, not a direction). Removed Apr 28, 2026.
      const isInbound =
        m.direction === 'inbound' ||
        m.messageType === 'inbound';
      let content = (m.body || m.message || '').trim();
      // Outbound-only: strip the TCPA opt-out suffix appended by GHL.
      if (!isInbound) {
        content = content.replace(TCPA_OPTOUT_SUFFIX, '').trim();
      }
      return {
        role: isInbound ? 'user' : 'assistant',
        content
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
  // Claude requires the first message to be 'user'. Every funnel legitimately
  // starts with the bot's opener (assistant), so naively shifting it off would
  // erase the entire conversational context — leaving Claude with just the
  // prospect's reply and CURRENT STEP=N, which causes it to default to
  // re-emitting Step 1 (the duplicate-opener regression seen Apr 28, 2026).
  // Instead, prepend a synthetic user trigger that mirrors the prompt used by
  // generateAndSendOpener so the opener stays visible as assistant context.
  if (merged.length > 0 && merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: 'Begin the conversation now.' });
  }
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
  const leadFormFilter = (req.query.leadForm || '').toString().trim().toLowerCase() || null;
  const allContacts = conversations.getAll();
  const allContactValues = Object.values(allContacts);

  // Collect all distinct named lead forms (before any filter) for the pill list
  const leadFormSet = new Set(allContactValues.map(c => c.leadForm || 'unknown'));
  const leadForms = Array.from(leadFormSet).filter(f => f !== 'unknown').sort();

  // Build filtered contact set — day and lead-form filters compose
  const cutoff = days ? Date.now() - days * 86400000 : null;
  let enrolledIds = null;
  let enrolledTotal;

  if (cutoff || leadFormFilter) {
    const filtered = allContactValues.filter(c => {
      if (cutoff && (c.createdAt || 0) < cutoff) return false;
      if (leadFormFilter && (c.leadForm || 'unknown') !== leadFormFilter) return false;
      return true;
    });
    enrolledIds = new Set(filtered.map(c => c.contactId));
    enrolledTotal = enrolledIds.size;
  } else {
    enrolledTotal = Object.keys(allContacts).length;
  }

  const stats = brain.getStats(enrolledIds);

  // Fetch week-over-week snapshot delta (most recent vs ~7 days ago).
  // Only meaningful on the global unfiltered view.
  let snapshotDelta = null;
  if (!leadFormFilter) {
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
  }

  res.json({ ...stats, enrolledTotal, snapshotDelta, leadForms });
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

app.get('/api/admin/issues', requireAdmin, async (req, res) => {
  try {
    const { rows } = await _promptsPool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `).then(() => _promptsPool.query(`SELECT value FROM app_settings WHERE key = 'issue_log' LIMIT 1`));
    const issues = rows.length ? JSON.parse(rows[0].value || '[]') : [];
    res.json({ ok: true, issues: Array.isArray(issues) ? issues : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/issues', requireAdmin, async (req, res) => {
  const { title, issue, solution, status, contactId, id } = req.body || {};
  if (!title || !issue) return res.status(400).json({ error: 'title and issue are required' });
  try {
    await _promptsPool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const { rows } = await _promptsPool.query(`SELECT value FROM app_settings WHERE key = 'issue_log' LIMIT 1`);
    const issues = rows.length ? JSON.parse(rows[0].value || '[]') : [];
    const item = {
      id: id || `issue-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: String(title).trim(),
      issue: String(issue).trim(),
      solution: String(solution || '').trim(),
      status: status === 'done' ? 'done' : 'open',
      contactId: String(contactId || '').trim() || null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const existingIndex = issues.findIndex(i => i.id === item.id);
    if (existingIndex >= 0) {
      issues[existingIndex] = { ...issues[existingIndex], ...item, updatedAt: Date.now() };
    } else {
      issues.unshift(item);
    }
    await _promptsPool.query(
      `INSERT INTO app_settings (key, value) VALUES ('issue_log', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(issues)]
    );
    res.json({ ok: true, issue: item, issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/issues/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await _promptsPool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const { rows } = await _promptsPool.query(`SELECT value FROM app_settings WHERE key = 'issue_log' LIMIT 1`);
    const issues = rows.length ? JSON.parse(rows[0].value || '[]') : [];
    const next = issues.filter(i => i.id !== id);
    await _promptsPool.query(
      `INSERT INTO app_settings (key, value) VALUES ('issue_log', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(next)]
    );
    res.json({ ok: true, issues: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    // Skip: already opted out (carrier STOP, prior keyword, manual blocklist)
    if (await optouts.isOptedOut(contactId)) { skipped.push({ firstName, reason: 'opted out' }); continue; }

    // Skip: GHL DND set on this contact → record opt-out and skip
    if (isDndFromPayload(c)) {
      await applyOptOut(contactId, 'enrollment-sync DND');
      skipped.push({ firstName, reason: 'dnd' });
      continue;
    }

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

  if (await optouts.isOptedOut(contactId)) return res.status(400).json({ error: 'Contact has opted out — skipping.' });

  if (isDndFromPayload(ghlContact)) {
    await applyOptOut(contactId, 'manual-enroll DND');
    return res.status(400).json({ error: 'Contact has Do Not Disturb set in GHL — added to opt-out list and skipped.' });
  }

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
  const { contactId, messageBody, messageId } = req.body || {};
  if (!contactId || !messageBody) {
    return res.status(400).json({ error: 'contactId and messageBody are required' });
  }
  res.json({ ok: true, message: 'Replay triggered — AI is generating a response now.' });
  try {
    await handleInbound({ contactId, conversationId: null, messageBody, firstName: '', city: '', phone: '', messageId: messageId || null });
    console.log(`[Admin] Replay-inbound complete for ${contactId}`);
  } catch (err) {
    console.error(`[Admin] Replay-inbound error for ${contactId}:`, err.message);
  }
});

// ─── Admin: Reconciliation poller status ──────────────────────────────────────
// Returns recent replays + cycle stats so the admin panel can show the poller
// is alive and what it's catching. Manual `?run=1` triggers an immediate run.
app.get('/api/admin/reconciliation', requireAdmin, async (req, res) => {
  try {
    if (req.query.run === '1') {
      // Fire-and-await so the response includes the freshly-updated stats.
      await reconciliation.runReconciliation();
    }
    res.json({
      stats: reconciliation.getStats(),
      replays: reconciliation.getRecentReplays(),
      devMode: DEV_MODE
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  // Sid handoff alert (Task #86) — fire-and-forget, never blocks the admin response
  notifySid(`🚨 ${contact.firstName || 'Prospect'} promoted to booking by admin.`);
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
  const key = _checkAdminPage(req, res); if (!key) return;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.send(buildAdminDashboardPage(key));
});

// ─── Admin: Prompt Editor ─────────────────────────────────────────────────────

app.get('/admin/prompts', (req, res) => {
  const key = _checkAdminPage(req, res); if (!key) return;
  const all = prompts.listAll();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.send(buildPromptEditorPage(key, all));
});

// ─── Admin: Industry Setup Wizard ─────────────────────────────────────────────

function _checkAdminPage(req, res) {
  if (!process.env.ADMIN_KEY) {
    res.status(503).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildSetupGuidePage('not_configured'));
    return null;
  }
  const key = req.query.key || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildSetupGuidePage(key ? 'wrong_key' : 'no_key'));
    return null;
  }
  return key;
}

app.get('/admin/setup', (req, res) => {
  const key = _checkAdminPage(req, res); if (!key) return;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildIndustrySetupPage(key, industry.load()));
});

app.get('/admin/api/industry', requireAdmin, (req, res) => {
  res.json({ ok: true, industry: industry.load() });
});

app.post('/admin/api/industry', requireAdmin, express.json({ limit: '256kb' }), (req, res) => {
  try {
    const saved = industry.set(req.body || {});
    res.json({ ok: true, industry: saved });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Admin: Structured Variant Builder ────────────────────────────────────────

app.get('/admin/variants', (req, res) => {
  const key = _checkAdminPage(req, res); if (!key) return;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildVariantBuilderPage(key));
});

app.get('/admin/api/structured-variants', requireAdmin, (req, res) => {
  res.json({ ok: true, variants: variantBuilder.listVariants() });
});

app.post('/admin/api/structured-variants', requireAdmin, express.json({ limit: '512kb' }), (req, res) => {
  try {
    variantBuilder.createVariant(req.body || {});
    res.json({ ok: true, variants: variantBuilder.listVariants() });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.put('/admin/api/structured-variants/:id', requireAdmin, express.json({ limit: '512kb' }), (req, res) => {
  try {
    variantBuilder.updateVariant(req.params.id, req.body || {});
    res.json({ ok: true, variants: variantBuilder.listVariants() });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.delete('/admin/api/structured-variants/:id', requireAdmin, (req, res) => {
  try {
    variantBuilder.deleteVariant(req.params.id);
    res.json({ ok: true, variants: variantBuilder.listVariants() });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

app.get('/admin/api/structured-variants/:id/preview', requireAdmin, (req, res) => {
  const v = variantBuilder.getVariant(req.params.id);
  if (!v) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, compiled: variantBuilder.compileVariant(v) });
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

  // Respect currently-enabled variants so backfill honours the same pool
  // as new-contact assignment (pickVariant uses getEnabledVariants() too).
  const enabledV = prompts.getEnabledVariants();
  const backfillVariants = enabledV.length > 0 ? enabledV : [...config.SCRIPTED_VARIANTS];
  // Count current assignments to continue the round-robin fairly
  const counts = Object.fromEntries(backfillVariants.map(v => [v, 0]));
  for (const c of Object.values(all)) {
    if (c.variant && counts[c.variant] !== undefined) counts[c.variant]++;
  }

  let assigned = 0;
  for (const [contactId] of unassigned) {
    // Always pick the variant with the fewest contacts
    const next = backfillVariants.slice().sort((a, b) => counts[a] - counts[b])[0];
    conversations.update(contactId, { variant: next });
    counts[next]++;
    assigned++;
  }

  const dist = backfillVariants.map(v => `${v}=${counts[v]}`).join(' ');
  console.log(`[Variants] Backfilled ${assigned} contacts. Distribution: ${dist}`);
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
  const allVariants = [...config.SCRIPTED_VARIANTS];
  if (!allVariants.includes(variant)) return res.status(400).json({ error: `Invalid variant. Must be one of: ${allVariants.join(', ')}.` });
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

app.get('/api/brain/variants', requireAdmin, async (req, res) => {
  try {
    const enabledList = prompts.getEnabledVariants();
    const allContacts = conversations.getAll();

    // Optional filters — leadForm and days compose, matching /api/brain/stats behaviour
    const leadFormFilter = (req.query.leadForm || '').toString().trim().toLowerCase() || null;
    const days = parseInt(req.query.days, 10) || null;
    const cutoff = days ? Date.now() - days * 86400000 : null;

    const _emptyCount = () => ({ assigned: 0, repliedOnce: 0, replied4: 0, booked: 0, optedOut: 0 });
    const counts = Object.fromEntries(config.SCRIPTED_VARIANTS.map(v => [v, _emptyCount()]));

    // Step funnel tracking: collect contacts per variant keyed by their currentStep
    const stepRaw = Object.fromEntries(config.SCRIPTED_VARIANTS.map(v => [v, []]));

    // Track which lead forms are present in the data so the dashboard can
    // render filter chips dynamically (no hard-coded form list).
    const leadFormSet = new Set();

    // Real-bookings source-of-truth — only contacts confirmed by the GHL
    // appointment webhook (or the manual admin backfill) appear here. The
    // AI's [BOOKED] marker pauses the AI but does NOT count for stats.
    const bookedSet = brain.getBookedContactIds();

    // Opt-out set — contacts that hit STOP keyword, GHL DND flag, or were
    // manually blocklisted. Counted per-variant to surface which scripts
    // are burning out the audience the fastest.
    const optedOutSet = await optouts.getAllSet();

    for (const c of Object.values(allContacts)) {
      const cForm = c.leadForm || 'unknown';
      leadFormSet.add(cForm);
      if (leadFormFilter && cForm !== leadFormFilter) continue;
      if (cutoff && (c.createdAt || 0) < cutoff) continue;
      if (!c.variant || !counts[c.variant]) continue;
      const vc = counts[c.variant];
      vc.assigned++;
      const inbound = (c.exchanges || []).filter(e => e.direction === 'inbound').length;
      if (inbound >= 1) vc.repliedOnce++;
      if (inbound >= 4) vc.replied4++;
      if (bookedSet.has(c.contactId)) vc.booked++;
      if (optedOutSet.has(c.contactId)) vc.optedOut++;
      // Collect step data for funnel breakdown
      const step = typeof c.currentStep === 'number' ? c.currentStep : null;
      if (step !== null && step >= 1 && stepRaw[c.variant]) {
        stepRaw[c.variant].push({
          firstName:     c.firstName || 'Unknown',
          lastMessageAt: Number(c.lastMessageAt) || 0,
          step
        });
      }
    }

    // ── Step description extractor ────────────────────────────────────────────
    // Parses STEP N / STEP N (description) / STEP N — label lines from the
    // variant prompt text. First match per step number wins (ignores sub-sections
    // like "STEP 4 CALCULATION LOGIC" that share the same step number prefix).
    function _extractStepDescs(promptKey) {
      const txt = prompts.get(promptKey) || '';
      const desc = {};
      const re = /^STEP\s+(\d+)(.*?)$/gim;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const n = parseInt(m[1], 10);
        if (desc[n]) continue;
        let label = m[2].trim()
          .replace(/^[\s\u2014\-:]+/, '')
          .replace(/:+$/, '')
          .trim();
        if (label.startsWith('(') && label.includes(')')) {
          label = label.slice(1, label.indexOf(')')).trim();
        }
        if (label.length > 80) label = label.slice(0, 77) + '...';
        desc[n] = label;
      }
      return desc;
    }

    const variantPromptKeys = Object.fromEntries(
      config.SCRIPTED_VARIANTS.map(v => [v, prompts.get(`conversationPrompt.${v}`) ? `conversationPrompt.${v}` : 'conversationPrompt'])
    );

    // Variant E uses modular sub-prompts. Concatenate all parts for step
    // description extraction so the funnel can label steps 1-3 (opening)
    // and branch steps (10-89 map onto step 7+ in the clamped funnel).
    function _extractStepDescsFromText(text) {
      const desc = {};
      const re = /^STEP\s+(\d+)(.*?)$/gim;
      let m;
      while ((m = re.exec(text)) !== null) {
        const n = parseInt(m[1], 10);
        if (desc[n]) continue;
        let label = m[2].trim().replace(/^[\s\u2014\-:]+/, '').replace(/:+$/, '').trim();
        if (label.startsWith('(') && label.includes(')')) {
          label = label.slice(1, label.indexOf(')')).trim();
        }
        if (label.length > 80) label = label.slice(0, 77) + '...';
        desc[n] = label;
      }
      return desc;
    }

    const stepDescs = {
      ...Object.fromEntries(config.SCRIPTED_VARIANTS.map(v => [v, _extractStepDescs(variantPromptKeys[v])]))
    };

    // Column count: max prompt-defined step across all variants, clamped to 7.
    // Contacts at steps > 7 are counted in S7's funnel (step >= 7).
    const maxStepFromPrompts = Math.max(0, ...Object.values(stepDescs).flatMap(d => Object.keys(d).map(Number)));
    const maxStep = Math.min(Math.max(maxStepFromPrompts, 1), 7);

    // Build stepData[variant][stepN] for each step 1..maxStep
    function _buildStepData(variantKey, contacts, assigned) {
      const descs = stepDescs[variantKey];
      const result = {};
      for (let n = 1; n <= maxStep; n++) {
        const hasStep = Object.prototype.hasOwnProperty.call(descs, n);
        if (!hasStep) { result[n] = null; continue; } // variant doesn't define this step → show —
        const funnelContacts = contacts.filter(c => c.step >= n);
        const atStep = contacts
          .filter(c => c.step === n)
          .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        const overflow = atStep.length > 10 ? atStep.length - 10 : 0;
        const funnelCount = funnelContacts.length;
        result[n] = {
          funnelCount,
          funnelPct:    assigned > 0 && funnelCount > 0 ? Math.round((funnelCount / assigned) * 100) : null,
          stepDesc:     descs[n] || '',
          atStepNames:  atStep.slice(0, 10).map(c => c.firstName),
          overflow
        };
      }
      return result;
    }

    const stepDataByVariant = {
      ...Object.fromEntries(config.SCRIPTED_VARIANTS.map(v => [v, _buildStepData(v, stepRaw[v], counts[v].assigned)]))
    };

    const pct = (n, d) => d > 0 ? Math.round((n / d) * 100) : null;

    // ── Bayesian P(Best) via Monte Carlo ─────────────────────────────────────
    // For each variant we model its unknown true booking rate as a Beta
    // distribution: Beta(bookings + 1, non-bookings + 1). We start from a
    // uniform prior Beta(1,1) — "we have no idea" — then update it with the
    // observed data. Each of 50,000 simulated worlds independently draws a
    // plausible booking rate from every variant's distribution; the variant
    // with the highest draw wins that world. P(Best) = fraction of worlds won.
    //
    // Sampling Beta(α,β) for integer params via the Gamma relationship:
    //   X ~ Gamma(α,1) = sum of α independent Exp(1) = -sum(log(U))
    //   X/(X+Y) ~ Beta(α,β) when Y ~ Gamma(β,1)
    // This is exact for integer parameters — no approximation needed.
    function sampleBeta(a, b) {
      let x = 0; for (let i = 0; i < a; i++) x -= Math.log(Math.random());
      let y = 0; for (let i = 0; i < b; i++) y -= Math.log(Math.random());
      return x / (x + y);
    }

    const ALL_VARIANTS = [...config.SCRIPTED_VARIANTS];
    const MIN_CONTACTS_FOR_PBEST = 3; // suppress P(Best) when sample is too small to mean anything
    const SAMPLES = 50000;
    const activeVariants = ALL_VARIANTS.filter(v => counts[v] && counts[v].assigned >= MIN_CONTACTS_FOR_PBEST);
    const wins = Object.fromEntries(ALL_VARIANTS.map(v => [v, 0]));

    if (activeVariants.length >= 2) {
      for (let i = 0; i < SAMPLES; i++) {
        let bestV = null, bestVal = -1;
        for (const v of activeVariants) {
          const vc = counts[v];
          const s = sampleBeta(vc.booked + 1, (vc.assigned - vc.booked) + 1);
          if (s > bestVal) { bestVal = s; bestV = v; }
        }
        wins[bestV]++;
      }
    }

    const variants = ALL_VARIANTS.map(v => {
      const vc = counts[v];
      const hasEnoughData = vc.assigned >= MIN_CONTACTS_FOR_PBEST && activeVariants.length >= 2;
      return {
        variant:          v,
        enabled:          enabledList.includes(v),
        contactsAssigned: vc.assigned,
        repliedOncePct:   pct(vc.repliedOnce, vc.assigned),
        replied4Pct:      pct(vc.replied4,    vc.assigned),
        bookingRatePct:   pct(vc.booked,      vc.assigned),
        bookedRaw:        vc.booked,
        optedOutRaw:      vc.optedOut,
        optOutRatePct:    pct(vc.optedOut,    vc.assigned),
        pBest:            hasEnoughData ? Math.round((wins[v] / SAMPLES) * 100) : null,
        stepData:         stepDataByVariant[v],
        notes:            prompts.get(`conversationPrompt.${v}.notes`) || ''
      };
    });

    res.json({
      ok: true,
      variants,
      maxStep,
      leadForms:            Array.from(leadFormSet).sort(),
      leadFormFilter,
      qualitativeInsights:  brain.getQualitativeInsights()
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
  const key = _checkAdminPage(req, res); if (!key) return;
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
  } else if (session.variant === 'E' && !variantBuilder.getVariant('E')) {
    systemContent = buildVariantESystemPrompt(session.currentStep || 0);
  } else {
    systemContent = resolveVariantPrompt(session.variant);
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
  const raw = String(variant || 'A').trim();
  const v = raw.toUpperCase();
  const trimmedCustom = String(customPrompt || '').trim();

  // Per the task contract: when customPrompt is present and non-empty, use it
  // as the system prompt regardless of the variant field. variant === 'CUSTOM'
  // requires a non-empty customPrompt; otherwise variant must be a known id.
  if (trimmedCustom) {
    if (trimmedCustom.length > _PLAYGROUND_CUSTOM_PROMPT_MAX) {
      return { error: `customPrompt is too long (max ${_PLAYGROUND_CUSTOM_PROMPT_MAX} chars)` };
    }
    return { variant: 'CUSTOM', customPrompt: trimmedCustom };
  }
  if (v === 'CUSTOM') return { error: 'customPrompt is required when variant is CUSTOM' };

  // Legacy scripted variants always use single uppercase letters. Check them
  // FIRST so existing callers passing 'a'/'b'/etc. continue to map to the
  // legacy uppercase variant even if a structured variant happens to share a
  // single-letter id. (Structured ids are conventionally multi-char like 'D1'.)
  const _validLegacy = [...config.SCRIPTED_VARIANTS, 'E'];
  if (_validLegacy.includes(v)) return { variant: v };

  // Accept any structured variant id (case-preserved) built via the Variant
  // Builder. An operator who builds 'D1' or 'restaurant' can test it directly.
  if (variantBuilder.getVariant(raw)) return { variant: raw };

  const structuredIds = variantBuilder.listVariants().map(x => x.id);
  const allValid = [..._validLegacy, ...structuredIds];
  return { error: `variant must be one of: ${allValid.length ? allValid.join(', ') : '(none configured)'}, or CUSTOM` };
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

    // Revalidate the session's stored variant on every turn — an operator may
    // have deleted a structured variant in another tab while this session is
    // mid-conversation. If so, fail loud rather than silently falling through
    // to a default prompt inside _buildPlaygroundSystemPrompt.
    if (session.variant && session.variant !== 'CUSTOM') {
      const legacyOk = [...config.SCRIPTED_VARIANTS, 'E'].includes(session.variant);
      const structuredOk = !!variantBuilder.getVariant(session.variant);
      if (!legacyOk && !structuredOk) {
        return res.status(409).json({
          error: `Variant "${session.variant}" is no longer available (it may have been deleted). Reset the playground session and pick a current variant.`
        });
      }
    }

    // Append user message to history
    session.messages.push({ role: 'user', content: message });

    // ── TCPA opt-out: STOP/UNSUBSCRIBE/etc. always wins ──
    // Mirrors live handleInbound, where carrier/keyword opt-outs are processed
    // before any state-machine routing. Without this, a STOP arriving while
    // confirmationPending is set would just re-prompt for yes/no.
    if (optouts.isOptOutKeyword(message)) {
      const fname = session.firstName || 'there';
      const farewell = `You're all set, ${fname} — I've removed you from our list and you won't hear from us again. Take care!`;
      session.confirmationPending = null;
      session.awaitingRetryName = null;
      session.currentStep = 4;
      session.messages.push({ role: 'assistant', content: farewell });
      return res.json({
        ok: true,
        reply: farewell,
        raw: farewell,
        markers: [{ type: 'STEP', value: 4 }, { type: 'DECLINED', value: true }],
        extraMessages: [],
        currentStep: session.currentStep,
        variant: session.variant,
        tokenUsage: { input: 0, output: 0 },
        elapsedMs: 0,
        estCost: 0,
        scanStatus: session.scanStatus || null,
        awaitingConfirmReply: false,
        systemPromptPreview: '(intercepted: TCPA opt-out keyword)'
      });
    }

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
  const key = _checkAdminPage(req, res); if (!key) return;
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

// ─── Admin: Off-Script Reply Handler Regression Harness ───────────────────────
// Wraps `scripts/test-off-script-handlers.js` so it can be triggered from the
// admin panel (or any HTTP client) in addition to the CLI. Uses the same
// background-job pattern as enrollment so the proxy can't time it out.
const _offScriptJobs = new Map(); // jobId → { status, result, error, expiresAt }

app.post('/admin/test-off-script', requireAdmin, (req, res) => {
  // Accept the same filter knobs the CLI honors so the panel can run
  // either the full 12-case suite or a narrow re-check.
  // `mode` ('direct' | 'via-server') lets the panel force the
  // authoritative server-pipeline run without requiring the operator to
  // set OFF_VIA_SERVER in the workflow environment first.
  const { variant, handler, batch, mode } = req.body || {};

  // Strict input validation — silently ignoring an invalid filter would
  // mask operator typos as a 0-case successful run.
  const VALID_VARIANTS = config.SCRIPTED_VARIANTS;
  const VALID_HANDLERS = ['CURIOSITY', 'IDENTITY', 'SOLUTION-SEEKING'];
  const VALID_MODES = ['direct', 'via-server'];
  const requestedMode = mode ? String(mode).toLowerCase() : null;
  if (requestedMode && !VALID_MODES.includes(requestedMode)) {
    return res.status(400).json({ ok: false, error: `Invalid mode "${mode}". Expected one of: ${VALID_MODES.join(', ')}.` });
  }
  if (variant !== undefined && variant !== null && variant !== '' && !VALID_VARIANTS.includes(String(variant).toUpperCase())) {
    return res.status(400).json({ ok: false, error: `Invalid variant "${variant}". Expected one of: ${VALID_VARIANTS.join(', ')}.` });
  }
  if (handler !== undefined && handler !== null && handler !== '' && !VALID_HANDLERS.includes(String(handler).toUpperCase())) {
    return res.status(400).json({ ok: false, error: `Invalid handler "${handler}". Expected one of: ${VALID_HANDLERS.join(', ')}.` });
  }
  let batchNum = null;
  if (batch !== undefined && batch !== null && batch !== '') {
    batchNum = Number(batch);
    if (!Number.isInteger(batchNum) || batchNum < 1 || batchNum > 12) {
      return res.status(400).json({ ok: false, error: `Invalid batch "${batch}". Expected integer 1–12.` });
    }
  }

  for (const [id, job] of _offScriptJobs) if (job.expiresAt < Date.now()) _offScriptJobs.delete(id);

  const jobId = `os-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Per-job report basename so concurrent harness runs never race each
  // other on the "latest file in sim-out" lookup. Must match the script's
  // OFF_REPORT_BASENAME validation regex.
  const reportBasename = `off-script-job-${jobId}`;

  // Default mode = whatever env already says (so the workflow can pin
  // it), falling back to direct. Explicit body `mode` overrides.
  const envSaysViaServer = process.env.OFF_VIA_SERVER === '1';
  const effectiveMode = requestedMode || (envSaysViaServer ? 'via-server' : 'direct');

  // Stash mode on the job record so polling reflects it immediately,
  // not just after completion.
  _offScriptJobs.set(jobId, { status: 'running', mode: effectiveMode, result: null, error: null, expiresAt: Date.now() + 10 * 60 * 1000 });

  setImmediate(() => {
    const { spawn } = require('child_process');
    const env = { ...process.env };
    if (variant) env.OFF_VARIANT = String(variant).toUpperCase();
    if (handler) env.OFF_HANDLER = String(handler).toUpperCase();
    if (batchNum) env.OFF_BATCH = String(batchNum);
    env.OFF_REPORT_BASENAME = reportBasename;

    if (effectiveMode === 'via-server') {
      // The harness needs to reach this very server. Default to the
      // local listener; let an explicit OFF_SERVER_URL override (e.g.
      // hitting a different deployment).
      env.OFF_VIA_SERVER = '1';
      if (!env.OFF_SERVER_URL) {
        env.OFF_SERVER_URL = `http://localhost:${process.env.PORT || 5000}`;
      }
      // ADMIN_KEY is already present in process.env (we just authed
      // this request with it), so the harness can call back in.
    } else {
      // Force direct even if OFF_VIA_SERVER=1 leaked in from the parent
      // env, so 'direct' from the request really means direct.
      delete env.OFF_VIA_SERVER;
    }

    const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'test-off-script-handlers.js')], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => {
      // Read the report the script just wrote for THIS job (per-job basename
      // pinned via env above), so concurrent jobs can't return each other's
      // results.
      const fs = require('fs');
      let reportMd = null, reportJson = null;
      try {
        const outDir = path.join(__dirname, '.local', 'sim-out');
        const mdPath = path.join(outDir, `${reportBasename}.md`);
        const jsonPath = path.join(outDir, `${reportBasename}.json`);
        if (fs.existsSync(mdPath)) reportMd = fs.readFileSync(mdPath, 'utf8');
        if (fs.existsSync(jsonPath)) reportJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (err) {
        stderr += `\n[harness] failed to read report: ${err.message}`;
      }
      _offScriptJobs.set(jobId, {
        status: code === 0 ? 'done' : 'failed',
        result: { exitCode: code, stdout, stderr, reportMd, reportJson, reportBasename, mode: effectiveMode },
        error: code === 0 ? null : `exit code ${code}`,
        expiresAt: Date.now() + 10 * 60 * 1000
      });
    });
    child.on('error', (err) => {
      _offScriptJobs.set(jobId, {
        status: 'error',
        result: { mode: effectiveMode },
        error: err.message,
        expiresAt: Date.now() + 10 * 60 * 1000
      });
    });
  });

  res.json({ ok: true, jobId, status: 'running', mode: effectiveMode });
});

app.get('/admin/test-off-script/:jobId', requireAdmin, (req, res) => {
  const job = _offScriptJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found or expired.' });
  // `mode` is echoed in every response (running, error, done, failed) so the
  // operator/UI can confirm direct vs via-server without waiting for completion.
  if (job.status === 'running') return res.json({ ok: true, status: 'running', mode: job.mode });
  if (job.status === 'error')   return res.json({ ok: false, status: 'error', mode: job.mode, error: job.error });
  // status === 'done' or 'failed' (non-zero exit): include the report so the
  // caller (admin panel curl, etc.) gets a full picture in one response.
  res.json({ ok: job.status === 'done', status: job.status, mode: job.mode, error: job.error, ...job.result });
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
    const variantKeys = config.SCRIPTED_VARIANTS.flatMap(v => [
      `conversationPrompt.${v}`,
      `conversationPrompt.${v}.enabled`
    ]);
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
    console.log('[Reconciliation] DEV MODE — scheduler not started (would have polled GHL every 30s)');
  } else {
    followups.startScheduler();
    // Register handleInbound with the reconciliation module to break the
    // circular require (reconciliation.js needs handleInbound; server.js
    // needs reconciliation). Done here, after handleInbound is defined.
    reconciliation.setHandleInbound(handleInbound);
    reconciliation.startScheduler(30 * 1000);
  }
  Promise.all([bootstrapStateFromGHL(), conversations.whenReady()])
    .then(() => {
      console.log('[Bootstrap] GHL state and conversations ready.');

      // Backfill historical opt-out variants now that the contacts table is
      // guaranteed to be ready (variant column was added in conversations.js
      // bootstrap). One-time recovery for opt-outs recorded before the
      // optouts.variant column existed.
      optouts.backfillVariants().catch(err =>
        console.error('[Optouts] Backfill failed:', err.message));

      // Variant E VSL URL check: warn if E is enabled but the URL has been
      // cleared to empty. The default ships as a placeholder; replace it with
      // the real URL via VARIANT_E_VSL_URL (env) or conversationPrompt.E.vslUrl.
      const isEEnabled = prompts.getEnabledVariants().includes('E');
      const vslUrlConfigured = !!(process.env.VARIANT_E_VSL_URL || prompts.get('conversationPrompt.E.vslUrl'));
      if (isEEnabled && !vslUrlConfigured) {
        console.error('[VariantE] WARNING: Variant E is enabled but conversationPrompt.E.vslUrl is empty.');
        console.error('[VariantE]   → Set VARIANT_E_VSL_URL env var or update conversationPrompt.E.vslUrl');
        console.error('[VariantE]     in the admin prompt editor with the real video URL before going live.');
      }
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

/* ── Variant notes (main dashboard) ── */
.vnotes-toggle{background:none;border:none;cursor:pointer;font-size:12px;color:#94a3b8;font-weight:600;padding:0;display:inline-flex;align-items:center;gap:5px;font-family:inherit}
.vnotes-toggle:hover{color:#475569}
.vnotes-body textarea{width:100%;box-sizing:border-box;font-size:12.5px;color:#374151;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;resize:vertical;font-family:inherit;background:#fff;min-height:72px}
.vnotes-save{padding:5px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid rgba(203,213,225,.9);background:#fff;color:#374151;font-family:inherit}
.vnotes-save:hover{border-color:#94a3b8;color:#0f172a}
.vnotes-status{font-size:12px;font-weight:600;color:#10b981}

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
    <a class="btn" href="/admin/setup?key=${adminKey}">Industry Setup &rarr;</a>
    <a class="btn" href="/admin/variants?key=${adminKey}">Variant Builder &rarr;</a>
    <a class="btn" href="/admin/playground?key=${adminKey}">Conversation Tester &rarr;</a>
    <a class="btn" href="/admin/prompts?key=${adminKey}">Prompt Editor &rarr;</a>
    <a class="btn btn-primary" href="/admin/enroll?key=${adminKey}">Lead Enrollment &rarr;</a>
  </div>
</div>

<div class="refresh-bar"><span class="dot-live"></span>Auto-refreshes every 30s &nbsp;&bull;&nbsp; next refresh in <span id="countdown">30</span>s</div>

<!-- ── Funnel Header ── -->
<div class="funnel-header">
  <span class="funnel-label">Funnel</span>
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
    <div class="filter-pills" id="days-filter-pills">
      <button class="filter-pill active" onclick="setDaysFilter(null,this)">All time</button>
      <button class="filter-pill" onclick="setDaysFilter(30,this)">30d</button>
      <button class="filter-pill" onclick="setDaysFilter(7,this)">7d</button>
      <button class="filter-pill" onclick="setDaysFilter(3,this)">3d</button>
    </div>
    <div id="lead-form-pills" class="filter-pills" style="display:none;border-left:1px solid rgba(203,213,225,.9);padding-left:10px;margin-left:2px"></div>
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

  <div class="subpanel-divider">
    <div class="subpanel-title">Webhook Reconciliation Poller</div>
    <div class="subpanel-desc">Background safety net that polls GHL every 30 seconds for inbound messages the webhook may have missed and replays them through the AI. Anything caught here is shown below — if this list is empty most days, the webhook is delivering reliably.</div>
    <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:10px">
      <button class="action-btn action-btn-info" id="recon-run-btn" onclick="runReconciliationNow(this)">↻ Run Now</button>
      <span id="recon-summary" style="font-size:12px;color:#64748b;font-weight:500">Loading&hellip;</span>
    </div>
    <div id="recon-replays-list" style="font-size:13px;color:#94a3b8">Loading&hellip;</div>
  </div>
</div>

<!-- ── Spend Monitor ── -->
<div class="panel">
  <div class="panel-header"><div class="panel-title">API Spend Monitor</div></div>
  <p class="panel-desc">Claude API cost per contact. Each contact is capped at $1.00 — once hit, AI responses stop and all pending jobs are cancelled. Use the override button to resume a high-value prospect.</p>
  <div id="spend-content"><div class="loading">Loading&hellip;</div></div>
</div>

<div class="panel">
  <div class="panel-header">
    <div>
      <div class="panel-title">Saved Issues</div>
    </div>
  </div>
  <p class="panel-desc">Drop in small bugs or weird replies you want to revisit later. Save the problem and the likely fix together so you do not have to rediscover it next time.</p>
  <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px">
    <input id="issue-title" type="text" placeholder="Short title" class="field-input" style="width:220px">
    <input id="issue-contact" type="text" placeholder="Contact ID or name" class="field-input" style="width:220px">
    <input id="issue-status" type="text" placeholder="open / done" value="open" class="field-input" style="width:120px">
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
    <textarea id="issue-problem" class="field-input" rows="4" placeholder="What happened?" style="width:100%;resize:vertical"></textarea>
    <textarea id="issue-solution" class="field-input" rows="4" placeholder="What was the fix or next step?" style="width:100%;resize:vertical"></textarea>
  </div>
  <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
    <button class="action-btn action-btn-primary" onclick="saveIssue()">Save Issue</button>
    <button class="action-btn" onclick="loadIssues()">Refresh</button>
    <span id="issue-status-text" style="font-size:12px;color:#64748b;font-weight:600"></span>
  </div>
  <div id="issues-content"><div class="loading">Loading&hellip;</div></div>
</div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
let currentTab = 'pending';
let allJobs = [];
let contactMap = {};
let currentDays = null;
let currentLeadForm = null;
let savedIssues = [];

function setDaysFilter(days, btn) {
  currentDays = days;
  document.querySelectorAll('#days-filter-pills .filter-pill').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  loadBrain();
}

function setLeadFormFilter(form) {
  currentLeadForm = form || null;
  const container = document.getElementById('lead-form-pills');
  if (container) {
    container.querySelectorAll('.filter-pill').forEach(el => el.classList.remove('active'));
    Array.from(container.querySelectorAll('.filter-pill')).forEach(b => {
      if ((b.dataset.form || '') === (form || '')) b.classList.add('active');
    });
  }
  loadBrain();
}

function fmtIssueTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function issueCard(i) {
  var badge = i.status === 'done'
    ? '<span class="badge b-booked">Done</span>'
    : '<span class="badge b-pending">Open</span>';
  var contact = i.contactId ? ' &bull; ' + escHtml(i.contactId) : '';
  var solution = i.solution ? '<div style="margin-top:8px;font-size:13px;color:#475569;line-height:1.6"><strong>Solution:</strong> ' + escHtml(i.solution) + '</div>' : '';
  var statusToggle = i.status === 'done' ? 'Reopen' : 'Done';
  return '<div style="border:1px solid rgba(203,213,225,.7);border-radius:16px;padding:14px;margin-bottom:10px;background:#fff">' +
    '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">' +
      '<div>' +
        '<div style="font-weight:800;color:#0f172a">' + escHtml(i.title || 'Untitled') + '</div>' +
        '<div style="font-size:12px;color:#64748b;margin-top:4px">' + badge + '<span style="margin-left:8px">Saved ' + fmtIssueTime(i.createdAt) + '</span>' + contact + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="action-btn" onclick="editIssue(&#39;' + i.id + '&#39;)">Edit</button>' +
        '<button class="action-btn action-btn-info" onclick="toggleIssueStatus(&#39;' + i.id + '&#39;)">' + statusToggle + '</button>' +
        '<button class="action-btn action-btn-warn" onclick="deleteIssue(&#39;' + i.id + '&#39;)">Delete</button>' +
      '</div>' +
    '</div>' +
    '<div style="margin-top:10px;font-size:13px;color:#475569;line-height:1.6"><strong>Problem:</strong> ' + escHtml(i.issue || '') + '</div>' +
    solution +
  '</div>';
}

async function loadIssues() {
  const box = document.getElementById('issues-content');
  if (!box) return;
  try {
    const res = await fetchWithTimeout('/api/admin/issues', { headers: { 'x-admin-key': ADMIN_KEY } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    savedIssues = data.issues || [];
    box.innerHTML = savedIssues.length ? savedIssues.map(issueCard).join('') : '<div class="empty">No saved issues yet.</div>';
  } catch (err) {
    box.innerHTML = '<div class="empty">Failed to load issues: ' + escHtml(err.message) + '</div>';
  }
}

async function saveIssue(existingId) {
  const title = document.getElementById('issue-title').value.trim();
  const contactId = document.getElementById('issue-contact').value.trim();
  const status = document.getElementById('issue-status').value.trim().toLowerCase();
  const issue = document.getElementById('issue-problem').value.trim();
  const solution = document.getElementById('issue-solution').value.trim();
  const statusEl = document.getElementById('issue-status-text');
  if (!title || !issue) {
    statusEl.textContent = 'Title and problem are required.';
    return;
  }
  statusEl.textContent = 'Saving…';
  try {
    const url = existingId ? '/api/admin/issues/' + encodeURIComponent(existingId) : '/api/admin/issues';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ title, contactId, status, issue, solution })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    document.getElementById('issue-title').value = '';
    document.getElementById('issue-contact').value = '';
    document.getElementById('issue-status').value = 'open';
    document.getElementById('issue-problem').value = '';
    document.getElementById('issue-solution').value = '';
    statusEl.textContent = 'Saved.';
    await loadIssues();
  } catch (err) {
    statusEl.textContent = 'Save failed: ' + err.message;
  }
}

async function toggleIssueStatus(id) {
  const item = savedIssues.find(i => i.id === id);
  if (!item) return;
  await fetch('/api/admin/issues/' + encodeURIComponent(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ status: item.status === 'done' ? 'open' : 'done' })
  });
  await loadIssues();
}

async function deleteIssue(id) {
  if (!confirm('Delete this saved issue?')) return;
  await fetch('/api/admin/issues/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  await loadIssues();
}

async function editIssue(id) {
  const item = savedIssues.find(i => i.id === id);
  if (!item) return;
  document.getElementById('issue-title').value = item.title || '';
  document.getElementById('issue-contact').value = item.contactId || '';
  document.getElementById('issue-status').value = item.status || 'open';
  document.getElementById('issue-problem').value = item.issue || '';
  document.getElementById('issue-solution').value = item.solution || '';
  document.getElementById('issue-status-text').textContent = 'Loaded into editor.';
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fetchWithTimeout(url, opts, ms) {
  ms = ms || 15000;
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, ms);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
    .then(function(r) { clearTimeout(timer); return r; })
    .catch(function(e) { clearTimeout(timer); throw e.name === 'AbortError' ? new Error('Request timed out — server may still be starting. Refresh to retry.') : e; });
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
      el.innerHTML = '<span style="color:#64748b">None — all AI-paused contacts are confirmed or the AI has not detected any verbal commitments yet.</span>';
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

  function showMatches(contacts) {
    const matches = contacts
      .filter(c => ((c.firstName || '') + ' ' + (c.lastName || '') + ' ' + (c.contactId || '')).toLowerCase().includes(q))
      .slice(0, 8);
    if (matches.length === 0) { dd.style.display = 'none'; return; }
    dd.style.display = 'block';
    dd.innerHTML = matches.map(c => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactId;
      return '<div onclick="replaySelectContact(&#39;' + c.contactId + '&#39;,&#39;' + escHtml(name).replace(/'/g, '&#39;') + '&#39;)"' +
        ' style="padding:10px 14px;font-size:13px;color:#334155;cursor:pointer;border-bottom:1px solid rgba(226,232,240,.6);font-weight:500"' +
        ' onmouseover="this.style.background=&#39;rgba(236,253,245,.6)&#39;" onmouseout="this.style.background=&#39;&#39;">' + escHtml(name) + '</div>';
    }).join('');
  }

  const cached = Object.values(contactMap);
  if (cached.length > 0) {
    showMatches(cached);
  } else {
    fetch('/api/contacts', { headers: { 'x-admin-key': ADMIN_KEY } })
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(contacts) {
        contacts.forEach(function(c) { contactMap[c.contactId] = c; });
        showMatches(contacts);
      })
      .catch(function() { dd.style.display = 'none'; });
  }
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
      fetchWithTimeout('/api/followups?status=pending', { headers: { 'x-admin-key': ADMIN_KEY } }),
      fetchWithTimeout('/api/contacts', { headers: { 'x-admin-key': ADMIN_KEY } }),
      fetchWithTimeout('/api/followups?status=sent', { headers: { 'x-admin-key': ADMIN_KEY } })
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
    // Build stats URL — day and lead-form filters compose
    const statsParams = [];
    if (currentDays) statsParams.push('days=' + currentDays);
    if (currentLeadForm) statsParams.push('leadForm=' + encodeURIComponent(currentLeadForm));
    const statsUrl = '/api/brain/stats' + (statsParams.length ? '?' + statsParams.join('&') : '');

    const res = await fetchWithTimeout(statsUrl, { headers: { 'x-admin-key': ADMIN_KEY } });
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

    // Populate lead-form pills in the funnel header from API response.
    // Pills are always rebuilt so the list stays in sync with live GHL tags.
    const pillContainer = document.getElementById('lead-form-pills');
    if (pillContainer) {
      const forms = data.leadForms || [];
      if (forms.length >= 1) {
        pillContainer.innerHTML = ['', ...forms].map(f => {
          const label = f === '' ? 'All forms' : f;
          const isActive = (!f && !currentLeadForm) || (f && f === currentLeadForm);
          const cls = isActive ? 'filter-pill active' : 'filter-pill';
          return \`<button class="\${cls}" data-form="\${escHtml(f)}" onclick="setLeadFormFilter(\${JSON.stringify(f).replace(/"/g, '&quot;')})">\${escHtml(label)}</button>\`;
        }).join('');
        pillContainer.style.display = '';
      } else {
        pillContainer.innerHTML = '';
        pillContainer.style.display = 'none';
        currentLeadForm = null;
      }
    }

    // Week-over-week delta badges — suppressed when any filter is active
    // (snapshot data is global so the delta would be misleading on a filtered view).
    function applyDelta(elId, diff, isCount) {
      const el = document.getElementById(elId);
      if (!el) return;
      if (diff === null || diff === undefined || isNaN(diff)) { el.textContent = ''; return; }
      const sign = diff > 0 ? '+' : '';
      const label = isCount ? \`\${sign}\${diff} vs last wk\` : \`\${sign}\${Math.round(diff)}pp vs last wk\`;
      el.textContent = label;
      el.className = 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
    }
    const sd = (!currentDays && !currentLeadForm && data.snapshotDelta) ? data.snapshotDelta : null;
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
    // When a form filter is active, brain.getStats() has already narrowed the
    // data, so this table naturally collapses to the one matching row.
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
          <code style="background:#f1f5f9;padding:1px 6px;border-radius:6px;font-size:11px">ampifyform:high-intent-2FA</code>) &mdash; new buckets appear here automatically.
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

    // ── Variant Performance ──────────────────────────────────────────────────
    // Lead form and day filters are driven by the globals set at the top of
    // the page. Both compose — same as /api/brain/stats.
    let variantRows = '';
    let insightsHtml = '';
    try {
      const vParams = [];
      if (currentDays) vParams.push('days=' + currentDays);
      if (currentLeadForm) vParams.push('leadForm=' + encodeURIComponent(currentLeadForm));
      const vUrl = '/api/brain/variants' + (vParams.length ? '?' + vParams.join('&') : '');
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
          function vOptOutPill(rate, raw) {
            if (rate === null || rate === undefined) return '<span style="color:#94a3b8;font-size:12px">—</span>';
            const bg   = rate >= 15 ? '#fee2e2' : rate >= 5 ? '#fef3c7' : '#dcfce7';
            const fg   = rate >= 15 ? '#b91c1c' : rate >= 5 ? '#b45309' : '#16a34a';
            const ring = rate >= 15 ? '#fca5a5' : rate >= 5 ? '#fcd34d' : '#86efac';
            const rawTxt = (raw !== undefined && raw !== null) ? ' <span style="font-weight:500;opacity:.75">(' + raw + ')</span>' : '';
            return '<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:' + bg + ';color:' + fg + ';border:1px solid ' + ring + ';font-weight:700;font-size:12px">' + rate + '%' + rawTxt + '</span>';
          }
          function vPBestPill(p) {
            if (p === null || p === undefined) return '<span style="color:#94a3b8;font-size:12px">—</span>';
            const bg   = p >= 85 ? '#dcfce7' : p >= 70 ? '#fef3c7' : '#f1f5f9';
            const fg   = p >= 85 ? '#16a34a' : p >= 70 ? '#b45309' : '#64748b';
            const ring = p >= 85 ? '#86efac' : p >= 70 ? '#fcd34d' : '#cbd5e1';
            return '<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:' + bg + ';color:' + fg + ';border:1px solid ' + ring + ';font-weight:700;font-size:12px">' + p + '%</span>';
          }
          function vStep(sd, n) {
            if (sd === null || sd === undefined) return '<span style="color:#c4c4c4">—</span>';
            if (sd.funnelPct === null || sd.funnelPct === undefined) return '<span style="color:#d4d4d4;font-size:11px">—</span>';
            const p = sd.funnelPct;
            const col = p >= 60 ? '#22c55e' : p >= 30 ? '#f59e0b' : '#6b7280';
            const names = (sd.atStepNames && sd.atStepNames.length > 0)
              ? sd.atStepNames.join(', ') + (sd.overflow > 0 ? ' +' + sd.overflow + ' more' : '')
              : 'No contacts here now';
            const label = ('Step ' + n + (sd.stepDesc ? ': ' + sd.stepDesc : ''))
              .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            const tip = label + '&#10;Here now: ' + names.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            return '<span style="font-weight:600;color:' + col + ';cursor:default" title="' + tip + '">' + p + '%</span>';
          }
          const ms = vData.maxStep || 7;
          const stepThs = Array.from({length: ms}, (_, i) =>
            '<th style="font-size:11px;white-space:nowrap;color:#64748b">S' + (i+1) + '</th>').join('');
          variantRows = \`
            <div style="margin-top:28px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
                <div style="font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em">Script Variant Performance</div>
              </div>
              <div class="table-wrap"><table class="perf-table">
                <thead><tr>
                  <th>Variant</th><th>Enabled</th><th>Contacts</th><th>Replied Once</th>\${stepThs}<th>Booking Rate</th>
                  <th style="white-space:nowrap">Opt-Out Rate</th>
                  <th style="white-space:nowrap">P(Best)</th>
                </tr></thead>
                <tbody>\${vData.variants.map(v => {
                  const col = variantColors[v.variant] || '#aaa';
                  const stepCells = Array.from({length: ms}, (_, i) => {
                    const n = i + 1;
                    const sd = v.stepData ? v.stepData[n] : null;
                    return '<td style="text-align:center">' + vStep(sd, n) + '</td>';
                  }).join('');
                  return \`<tr>
                    <td><span style="font-weight:700;color:\${col}">Variant \${v.variant}</span></td>
                    <td><span style="\${v.enabled ? 'color:#22c55e' : 'color:#555'};font-weight:600">\${v.enabled ? 'Yes' : 'No'}</span></td>
                    <td>\${v.contactsAssigned}</td>
                    <td>\${vPct(v.repliedOncePct)}</td>
                    \${stepCells}
                    <td>\${vPct(v.bookingRatePct)}</td>
                    <td>\${vOptOutPill(v.optOutRatePct, v.optedOutRaw)}</td>
                    <td>\${vPBestPill(v.pBest)}</td>
                  </tr>\`;
                }).join('')}</tbody>
              </table></div>
              <div style="margin-top:12px;padding:10px 12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;font-size:11px;color:#475569;line-height:1.6">
                <strong style="color:#0f172a">P(Best)</strong> = probability this variant has the highest <em>true</em> booking rate across 50,000 simulated outcomes.
                <span style="margin-left:6px;padding:1px 7px;border-radius:999px;background:#dcfce7;color:#16a34a;border:1px solid #86efac;font-weight:700">85%+</span> Strong signal.
                <span style="margin-left:4px;padding:1px 7px;border-radius:999px;background:#fef3c7;color:#b45309;border:1px solid #fcd34d;font-weight:700">70&ndash;84%</span> Keep testing.
                <span style="margin-left:4px;padding:1px 7px;border-radius:999px;background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;font-weight:700">&lt;70%</span> Too early to call.
                &nbsp;&nbsp;<span style="color:#94a3b8">— = fewer than 3 contacts.</span>
                &nbsp;&nbsp;\${currentLeadForm ? 'Filtered to lead form: <strong>' + escHtml(currentLeadForm) + '</strong>.' : ''} Edit scripts at <a href="/admin/prompts?key=\${ADMIN_KEY}" style="color:#0ea56f">Prompt Editor</a>.
              </div>
              <div style="margin-top:14px;border-top:1px solid rgba(203,213,225,.4);padding-top:12px">
                <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Variant Notes</div>
                \${vData.variants.filter(v => v.variant !== 'E').map(v => \`
                  <div style="margin-bottom:4px">
                    <button class="vnotes-toggle" onclick="toggleVNotes('\${v.variant}')" id="vnbtn-\${v.variant}">
                      <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" id="vnarrow-\${v.variant}" style="transform:rotate(-90deg);transition:transform .15s"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
                      Variant \${v.variant}\${v.notes ? '<span style="color:#10b981;margin-left:3px;font-size:10px">&#9679;</span>' : ''}
                    </button>
                    <div class="vnotes-body" id="vnbody-\${v.variant}" style="display:none;margin-top:6px;padding-left:18px">
                      <textarea id="vnta-\${v.variant}" rows="3" placeholder="Notes about Variant \${v.variant}..." spellcheck="true">\${escHtml(v.notes)}</textarea>
                      <div style="margin-top:6px;display:flex;align-items:center;gap:10px">
                        <button class="vnotes-save" onclick="saveVariantNotes('\${v.variant}')">Save notes</button>
                        <span class="vnotes-status" id="vnstatus-\${v.variant}"></span>
                      </div>
                    </div>
                  </div>
                \`).join('')}
              </div>
            </div>\`;
        }
        const qi = vData.qualitativeInsights;
        if (qi && qi.text) {
          const _genMs = Number(qi.generatedAt);
          const _tsOpts = {timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true};
          const genAtStr  = Number.isFinite(_genMs) ? new Date(_genMs).toLocaleString('en-US', _tsOpts) : 'Unknown';
          const nextAtStr = Number.isFinite(_genMs) ? new Date(_genMs + 259200000).toLocaleString('en-US', _tsOpts) : 'Unknown';
          const paras = qi.text.split('\\n\\n').filter(function(p){return p.trim();}).map(function(p){return '<p style="margin:0 0 14px">' + escHtml(p.trim()) + '</p>';}).join('');
          insightsHtml = '<div style="margin-top:28px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">'
            + '<div style="font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">AI Analysis</div>'
            + '<div style="font-size:14px;color:#334155;line-height:1.75;padding:16px 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">'
            + paras
            + '</div>'
            + '<div style="margin-top:8px;font-size:11px;color:#94a3b8">'
            + 'Last generated: <strong style="color:#64748b">' + escHtml(genAtStr) + ' PT</strong>'
            + ' &nbsp;&bull;&nbsp; Next scheduled: <strong style="color:#64748b">' + escHtml(nextAtStr) + ' PT</strong>'
            + '</div>'
            + '</div>';
        } else {
          insightsHtml = '<div style="margin-top:28px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">'
            + '<div style="font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">AI Analysis</div>'
            + '<div style="font-size:13px;color:#94a3b8;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">Analysis not yet generated — will run within 72h of first data.</div>'
            + '</div>';
        }
      }
    } catch (_) { /* variant stats are supplemental — ignore errors */ }

    el.innerHTML = \`
      \${stageHtml}
      \${leadFormHtml}
      \${variantRows}
      \${insightsHtml}
    \`;
  } catch (err) {
    el.innerHTML = '<div class="empty">Failed to load: ' + escHtml(err.message) + '</div>';
  }
}

function toggleVNotes(v) {
  var body = document.getElementById('vnbody-' + v);
  var arrow = document.getElementById('vnarrow-' + v);
  if (!body) return;
  var isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (arrow) arrow.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
}

async function saveVariantNotes(v) {
  var ta = document.getElementById('vnta-' + v);
  var statusEl = document.getElementById('vnstatus-' + v);
  if (!ta) return;
  var name = 'conversationPrompt.' + v + '.notes';
  if (statusEl) statusEl.textContent = 'Saving\u2026';
  try {
    var res = await fetch('/admin/prompts/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ text: ta.value })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (statusEl) { statusEl.textContent = '\u2713 Saved'; setTimeout(function() { statusEl.textContent = ''; }, 2500); }
  } catch(err) {
    if (statusEl) statusEl.textContent = '\u2717 ' + err.message;
  }
}

async function loadSpend() {
  const el = document.getElementById('spend-content');
  try {
    const res = await fetchWithTimeout('/api/contacts', { headers: { 'x-admin-key': ADMIN_KEY } });
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

async function loadReconciliation(opts) {
  const summaryEl = document.getElementById('recon-summary');
  const listEl = document.getElementById('recon-replays-list');
  const runFlag = opts && opts.run ? '?run=1' : '';
  try {
    const res = await fetchWithTimeout('/api/admin/reconciliation' + runFlag, { headers: { 'x-admin-key': ADMIN_KEY } }, 35000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const s = data.stats || {};
    const replays = data.replays || [];
    const lastRunStr = s.lastRunAt ? new Date(s.lastRunAt).toLocaleTimeString() : 'never';
    const startedStr = s.startedAt ? new Date(s.startedAt).toLocaleString() : (data.devMode ? 'DEV MODE — not running' : 'not started');
    summaryEl.textContent =
      'Last run: ' + lastRunStr +
      ' | Cycles: ' + (s.totalRuns || 0) +
      ' | Replays today: ' + replays.filter(r => r.ts > Date.now() - 86400000).length +
      ' | Total replays: ' + (s.totalReplays || 0) +
      ' | Started: ' + startedStr;
    if (replays.length === 0) {
      listEl.innerHTML = '<div style="padding:10px 0;color:#94a3b8">No replays yet — the webhook is keeping up.</div>';
    } else {
      listEl.innerHTML = replays.slice(0, 10).map(function(r) {
        const when = new Date(r.ts).toLocaleString();
        const name = (r.firstName || r.contactId || '').replace(/[<>&]/g, '');
        const preview = (r.bodyPreview || '').replace(/[<>&]/g, '');
        const devTag = r.devModeSkipped ? ' <span style="color:#f59e0b;font-weight:600">[DEV — skipped]</span>' : '';
        return '<div style="padding:8px 10px;border-bottom:1px solid rgba(203,213,225,.4)">' +
          '<div style="font-weight:600;color:#0f172a">' + name + devTag + ' <span style="color:#64748b;font-weight:500;font-size:11px">' + when + '</span></div>' +
          '<div style="color:#475569;font-size:12px;margin-top:2px">&ldquo;' + preview + '&rdquo;</div>' +
          '</div>';
      }).join('');
    }
  } catch (err) {
    summaryEl.textContent = 'Error loading: ' + err.message;
  }
}
async function runReconciliationNow(btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Running…';
  try {
    await loadReconciliation({ run: true });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
function loadAll() { loadFollowups(); loadBrain(); loadSpend(); loadAwaitingConfirmation(); refreshPauseState(); loadIssues(); loadReconciliation(); }
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

  // Build variant data: text + enabled flag for all scripted variants
  const variantsJson = JSON.stringify(config.SCRIPTED_VARIANTS.map(v => ({
    variant: v,
    text: prompts.get(`conversationPrompt.${v}`) || prompts.get('conversationPrompt'),
    enabled: prompts.get(`conversationPrompt.${v}.enabled`) === 'true',
    notes: prompts.get(`conversationPrompt.${v}.notes`) || ''
  })));

  // Base conversation script — used as the underlying template for all scripted variants
  const _variantLetters = config.SCRIPTED_VARIANTS.join('/');
  const baseConvPrompt = { name: 'conversationPrompt', label: `Base Discovery Script (${_variantLetters} Template)`, description: `The underlying script all scripted variants started from. Edit individual variants in the ${_variantLetters} section above — edits here are not applied to variants that already have their own saved copy.`, current: prompts.get('conversationPrompt') || '', isModified: (prompts.listAll().find(p => p.name === 'conversationPrompt') || {}).isModified || false };

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
.vnotes-wrap{margin-top:10px;border-top:1px solid rgba(203,213,225,.5);padding-top:8px}
.vnotes-toggle{background:none;border:none;cursor:pointer;font-size:12px;color:#94a3b8;font-weight:600;padding:0;display:flex;align-items:center;gap:4px;font-family:inherit}
.vnotes-toggle:hover{color:#475569}
.vnotes-body{margin-top:8px}
.vnotes-body textarea{min-height:72px;font-size:12.5px;border-radius:8px;padding:10px 12px}
.vnotes-save{padding:5px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid rgba(203,213,225,.9);background:#fff;color:#374151;font-family:inherit}
.vnotes-save:hover{border-color:#94a3b8;color:#0f172a}
.vnotes-status{font-size:12px;font-weight:600;color:#10b981}
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
.collapsible-section{max-width:820px;margin:0 auto 16px;border:1px solid rgba(203,213,225,.7);border-radius:22px;background:rgba(255,255,255,.86);backdrop-filter:blur(12px);overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,.05)}
.cs-header{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;cursor:pointer;user-select:none;gap:12px}
.cs-header:hover{background:rgba(248,250,252,.6)}
.cs-left{display:flex;align-items:center;gap:12px}
.cs-title{font-size:15px;font-weight:800;color:#0f172a;letter-spacing:-.01em}
.cs-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cs-count{font-size:11px;font-weight:700;color:#94a3b8;background:#f1f5f9;border:1px solid #e2e8f0;padding:2px 8px;border-radius:999px}
.cs-modified-dot{width:7px;height:7px;border-radius:50%;background:#10b981;flex-shrink:0}
.cs-chevron{width:18px;height:18px;color:#94a3b8;transition:transform .25s;flex-shrink:0}
.cs-header.open .cs-chevron{transform:rotate(180deg)}
.cs-body{border-top:1px solid rgba(203,213,225,.5);padding:20px 20px 20px}
.cs-body.hidden{display:none}
.variant-section{background:transparent;border:none;border-radius:0;padding:0;width:100%;max-width:820px;margin:0 auto;box-shadow:none}
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
<div id="sections-root"></div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
const ALL_PROMPTS = ${promptsJson};
const VARIANTS = ${variantsJson};
const BASE_CONV_PROMPT = ${JSON.stringify(baseConvPrompt)};

function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

// ─── Collapsible Section Builder ──────────────────────────────────────────────

function makeCollapsibleSection(id, title, countLabel, startOpen, bodyHtml) {
  const sec = document.createElement('div');
  sec.className = 'collapsible-section';
  sec.id = 'csec-' + id;
  sec.innerHTML = \`
    <div class="cs-header\${startOpen ? ' open' : ''}" onclick="toggleSection('\${id}')">
      <div class="cs-left">
        <div class="cs-title">\${escapeHtml(title)}</div>
        <div class="cs-meta">
          <span class="cs-count" id="cslabel-\${id}">\${escapeHtml(countLabel)}</span>
          <span class="cs-modified-dot" id="csdot-\${id}" style="display:none"></span>
        </div>
      </div>
      <svg class="cs-chevron" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/>
      </svg>
    </div>
    <div class="cs-body\${startOpen ? '' : ' hidden'}" id="csbody-\${id}">\${bodyHtml}</div>
  \`;
  return sec;
}

function toggleSection(id) {
  const header = document.querySelector('#csec-' + id + ' .cs-header');
  const body   = document.getElementById('csbody-' + id);
  if (!header || !body) return;
  const isOpen = header.classList.contains('open');
  header.classList.toggle('open', !isOpen);
  body.classList.toggle('hidden', isOpen);
}

// ─── A/B/C/D Variant Section ──────────────────────────────────────────────────

let _activeTab = 'A';

function renderVariantSection() {
  const wrapper = document.getElementById('sections-root');
  const placeholder = document.createElement('div');
  placeholder.id = 'variant-section';
  wrapper.appendChild(placeholder);
  const container = document.getElementById('variant-section');
  const tabsHtml = VARIANTS.map(vd => vd.variant).map(v =>
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
        <div class="vnotes-wrap">
          <button class="vnotes-toggle" onclick="toggleVNotes('\${vd.variant}')" id="vnbtn-\${vd.variant}">
            <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" id="vnarrow-\${vd.variant}" style="transform:rotate(-90deg);transition:transform .15s"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
            Notes\${vd.notes ? ' <span style="color:#10b981;font-size:10px">&#9679;</span>' : ''}
          </button>
          <div class="vnotes-body" id="vnbody-\${vd.variant}" style="display:none">
            <textarea id="vnta-\${vd.variant}" rows="4" placeholder="What is this variant testing? How is it performing? Any ideas for next iteration..." spellcheck="true">\${escapeHtml(vd.notes)}</textarea>
            <div style="margin-top:6px;display:flex;align-items:center;gap:10px">
              <button class="vnotes-save" onclick="saveVariantNotes('\${vd.variant}')">Save notes</button>
              <span class="vnotes-status" id="vnstatus-\${vd.variant}"></span>
            </div>
          </div>
        </div>
      </div>
    \`;
  }).join('');

  const innerHtml = \`
    <div class="variant-section" id="variant-card">
      <div class="variant-section-desc" style="margin-bottom:16px">Each new contact is permanently assigned one variant. Edit scripts independently, then enable or disable each variant from the rotation.</div>
      <div class="variant-tabs">\${tabsHtml}</div>
      <div id="variant-panels">\${panelsHtml}</div>
      <div style="margin-top:26px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">
        <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:12px;letter-spacing:-.01em">Performance Comparison</div>
        <div id="variant-stats-table"><span style="font-size:13px;color:#94a3b8">No data yet — run some conversations to see comparison stats here.</span></div>
      </div>
      <div style="margin-top:24px;border-top:1px solid rgba(203,213,225,.6);padding-top:20px">
        <div style="font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Data Reset</div>
        <div style="font-size:13px;color:#64748b;margin-bottom:14px;line-height:1.6">Wipe all variant assignments and start tracking from scratch. Everything else (contacts, replies, bookings, follow-ups) is kept.</div>
        <button class="action-btn action-btn-warn" onclick="resetVariantData()">Reset Variant Data</button>
        <span id="variant-reset-status" style="margin-left:12px;font-size:13px;color:#64748b;font-weight:600"></span>
      </div>
    </div>
  \`;

  const enabledCount = VARIANTS.filter(v => v.enabled).length;
  const enabledLabel = enabledCount > 0 ? enabledCount + ' of ' + VARIANTS.length + ' enabled' : 'none enabled';
  const sec = makeCollapsibleSection('abcd', 'Discovery Scripts', enabledLabel, true, innerHtml);
  document.getElementById('sections-root').appendChild(sec);

  // Bind char counters
  VARIANTS.forEach(vd => {
    const ta = document.getElementById('vta-' + vd.variant);
    if (ta) ta.addEventListener('input', () => {
      document.getElementById('vchars-' + vd.variant).textContent = ta.value.length + ' chars';
    });
  });
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

function toggleVNotes(v) {
  const body = document.getElementById('vnbody-' + v);
  const arrow = document.getElementById('vnarrow-' + v);
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  arrow.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
}

async function saveVariantNotes(v) {
  const ta = document.getElementById('vnta-' + v);
  const statusEl = document.getElementById('vnstatus-' + v);
  if (!ta) return;
  const name = 'conversationPrompt.' + v + '.notes';
  statusEl.textContent = 'Saving\u2026';
  try {
    const res = await fetch('/admin/prompts/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ text: ta.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    statusEl.textContent = '\u2713 Saved';
    const vd = VARIANTS.find(function(x) { return x.variant === v; });
    if (vd) vd.notes = ta.value;
    setTimeout(function() { statusEl.textContent = ''; }, 2500);
  } catch(err) {
    statusEl.textContent = '\u2717 ' + err.message;
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

    // Opt-out rate uses INVERTED color logic: low rate is good (green),
    // high rate is bad (red). Thresholds picked to roughly mirror normal
    // SMS-channel opt-out benchmarks: <5% healthy, 5-15% concerning, >15% bad.
    function optOutPill(rate, raw) {
      if (rate === null || rate === undefined) return '<span style="color:#555">—</span>';
      const bg   = rate >= 15 ? '#fee2e2' : rate >= 5 ? '#fef3c7' : '#dcfce7';
      const fg   = rate >= 15 ? '#b91c1c' : rate >= 5 ? '#b45309' : '#16a34a';
      const ring = rate >= 15 ? '#fca5a5' : rate >= 5 ? '#fcd34d' : '#86efac';
      const rawTxt = (raw !== undefined && raw !== null) ? \` <span style="font-weight:500;opacity:.75">(\${raw})</span>\` : '';
      return \`<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:\${bg};color:\${fg};border:1px solid \${ring};font-weight:700;font-size:12px">\${rate}%\${rawTxt}</span>\`;
    }

    function pBestPill(p) {
      if (p === null || p === undefined) return '<span style="color:#94a3b8;font-size:12px">—</span>';
      const bg   = p >= 85 ? '#dcfce7' : p >= 70 ? '#fef3c7' : '#f1f5f9';
      const fg   = p >= 85 ? '#16a34a' : p >= 70 ? '#b45309' : '#64748b';
      const ring = p >= 85 ? '#86efac' : p >= 70 ? '#fcd34d' : '#cbd5e1';
      return \`<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:\${bg};color:\${fg};border:1px solid \${ring};font-weight:700;font-size:12px">\${p}%</span>\`;
    }

    const rows = vv.map(v => \`<tr>
      <td><span class="vs-badge vs-badge-\${v.variant}">\${v.variant}</span></td>
      <td><span class="\${v.enabled?'vs-enabled':'vs-disabled'}">\${v.enabled?'Yes':'No'}</span></td>
      <td>\${v.contactsAssigned}</td>
      <td>\${ratePill(v.repliedOncePct)}</td>
      <td>\${ratePill(v.replied4Pct)}</td>
      <td>\${ratePill(v.bookingRatePct)}</td>
      <td>\${optOutPill(v.optOutRatePct, v.optedOutRaw)}</td>
      <td>\${pBestPill(v.pBest)}</td>
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
        return \`<button type="button" onclick="setVariantStatsLeadFormFilter(\${JSON.stringify(f).replace(/"/g, '&quot;')})" style="padding:4px 10px;border-radius:999px;border:1px solid;cursor:pointer;font-size:11px;font-weight:600;\${style}">\${escHtml(label)}</button>\`;
      }).join('');
      chips = \`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;align-items:center"><span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-right:4px">Lead form:</span>\${items}</div>\`;
    }

    el.innerHTML = \`\${chips}<table class="variant-stats-table">
      <thead><tr>
        <th>Variant</th><th>Enabled</th><th>Contacts</th><th>Replied Once</th><th>4+ Replies</th><th>Booking Rate</th>
        <th style="white-space:nowrap">Opt-Out Rate</th>
        <th style="white-space:nowrap">P(Best) <span style="font-weight:400;font-size:10px;color:#94a3b8;letter-spacing:0">&#9432;</span></th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>
    <div style="margin-top:14px;padding:12px 14px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;font-size:12px;color:#475569;line-height:1.6">
      <strong style="color:#0f172a">What is P(Best)?</strong><br>
      The probability — based on 50,000 simulated outcomes — that this variant has the highest <em>true</em> booking rate, accounting for sample size.
      A variant showing 28% with only 10 contacts could just be luck; P(Best) captures that uncertainty.
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px">
        <span style="padding:2px 9px;border-radius:999px;background:#dcfce7;color:#16a34a;border:1px solid #86efac;font-weight:700;font-size:11px">85%+</span><span style="font-size:11px;color:#475569">Strong signal — consider shifting more traffic here.</span>
        <span style="padding:2px 9px;border-radius:999px;background:#fef3c7;color:#b45309;border:1px solid #fcd34d;font-weight:700;font-size:11px">70–84%</span><span style="font-size:11px;color:#475569">Leaning this way — keep collecting data.</span>
        <span style="padding:2px 9px;border-radius:999px;background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;font-weight:700;font-size:11px">&lt;70%</span><span style="font-size:11px;color:#475569">Too early to call — results could flip.</span>
        <span style="font-size:11px;color:#94a3b8">— = fewer than 3 contacts (not enough data to compute).</span>
      </div>
    </div>\`;
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

// Keys managed by dedicated sections — excluded from generic prompt renderer
const EXCLUDE_FROM_GENERIC = new Set([
  'conversationPrompt'
]);

function buildPromptCard(p) {
  const wrap = document.createElement('div');
  wrap.className = 'prompt-card' + (p.isModified ? ' modified' : '');
  wrap.id = 'card-' + p.name;
  wrap.innerHTML = \`
    <div class="prompt-header">
      <div class="prompt-label">\${escapeHtml(p.label)}</div>
      <span class="badge \${p.isModified ? 'badge-modified' : 'badge-default'}" id="badge-\${p.name}">\${p.isModified ? 'Modified' : 'Default'}</span>
    </div>
    <div class="prompt-desc">\${escapeHtml(p.description)}</div>
    <textarea id="ta-\${p.name}" rows="14" spellcheck="false">\${escapeHtml(p.current)}</textarea>
    <div class="actions">
      <button class="btn btn-save" id="save-\${p.name}">Save</button>
      <button class="btn btn-reset" id="reset-\${p.name}" \${p.isModified ? '' : 'disabled'}>Reset to default</button>
      <span class="status" id="status-\${p.name}"></span>
      <span class="char-count" id="chars-\${p.name}">\${p.current.length} chars</span>
    </div>
  \`;
  return wrap;
}

function bindPromptCard(p) {
  document.getElementById('save-' + p.name).addEventListener('click', () => savePrompt(p.name));
  document.getElementById('reset-' + p.name).addEventListener('click', () => resetPrompt(p.name));
  const ta = document.getElementById('ta-' + p.name);
  if (ta) ta.addEventListener('input', () => {
    document.getElementById('chars-' + p.name).textContent = ta.value.length + ' chars';
  });
}

function renderGroupSection(id, title, promptList, startOpen) {
  const root = document.getElementById('sections-root');
  const modCount = promptList.filter(p => p.isModified).length;
  const label = promptList.length + ' prompt' + (promptList.length !== 1 ? 's' : '') + (modCount ? ', ' + modCount + ' modified' : '');

  // Build placeholder body — we'll fill it with cards after appending to DOM
  const sec = makeCollapsibleSection(id, title, label, startOpen, '<div id="group-' + id + '"></div>');
  root.appendChild(sec);
  const groupEl = document.getElementById('group-' + id);
  promptList.forEach(p => {
    const card = buildPromptCard(p);
    groupEl.appendChild(card);
    bindPromptCard(p);
  });
  if (modCount > 0) {
    const dot = document.getElementById('csdot-' + id);
    if (dot) dot.style.display = '';
  }
}

function renderPrompts() {
  const genericPrompts = ALL_PROMPTS.filter(p => !EXCLUDE_FROM_GENERIC.has(p.name));

  const GROUPS = [
    {
      id: 'behavior',
      title: 'System Behavior & GMB Generator',
      keys: ['systemPrompt'],
      extra: [BASE_CONV_PROMPT]
    },
    {
      id: 'followup',
      title: 'Follow-up Messages',
      keys: ['followup.system','followup.hook','followup.nurture']
    },
    {
      id: 'email',
      title: 'Email Templates',
      keys: ['email.system','email.hook','email.nurture','email.monthly']
    },
    {
      id: 'analysis',
      title: 'AI Learning & Analysis',
      keys: ['brain.analysisPrompt']
    }
  ];

  GROUPS.forEach(g => {
    const listed = genericPrompts.filter(p => g.keys.includes(p.name));
    const all = [...listed, ...(g.extra || [])];
    if (all.length) renderGroupSection(g.id, g.title, all, false);
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
.vpill.active.D{background:linear-gradient(180deg,#fef2f2,#fee2e2);color:#991b1b;border-color:#fca5a5}
.vpill.active.E{background:linear-gradient(180deg,#fdf4ff,#fae8ff);color:#6b21a8;border-color:#d8b4fe}
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
          <button class="vpill D" data-v="D" onclick="pickVariant('D')">D</button>
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

// ─── Industry Setup Wizard Page ───────────────────────────────────────────────

function buildIndustrySetupPage(adminKey, current) {
  const safe = JSON.stringify(current || {});
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Industry Setup — White-Label SMS Engine</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(circle at 8% 82%,rgba(45,212,191,.12) 0,rgba(45,212,191,0) 26%),radial-gradient(circle at 92% 12%,rgba(56,189,248,.12) 0,rgba(56,189,248,0) 24%),linear-gradient(180deg,#fbfbfb 0%,#f7fbfb 48%,#ffffff 100%);color:#0f172a;font-family:'Inter',system-ui,sans-serif;min-height:100vh;padding:32px 16px 80px;-webkit-font-smoothing:antialiased}
.back-link{display:block;max-width:820px;margin:0 auto 16px;color:#6b7280;font-size:13px;text-decoration:none;font-weight:600}
.logo{font-size:12px;font-weight:600;letter-spacing:.32em;color:#9ca3af;text-transform:uppercase;text-align:center;margin-bottom:18px}
h1{font-size:clamp(34px,5vw,52px);font-weight:900;text-align:center;margin-bottom:14px;letter-spacing:-.04em;line-height:1.05}
.subtitle{font-size:15px;color:#475569;text-align:center;max-width:680px;margin:0 auto 28px;line-height:1.6}
.card{background:rgba(255,255,255,.86);backdrop-filter:blur(12px);border:1px solid rgba(203,213,225,.7);border-radius:22px;padding:28px;max-width:820px;margin:0 auto 22px;box-shadow:0 18px 42px rgba(15,23,42,.06)}
.card h2{font-size:16px;font-weight:800;letter-spacing:-.01em;margin-bottom:6px}
.card .desc{font-size:13px;color:#64748b;margin-bottom:16px;line-height:1.6}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.field .hint{font-size:12px;color:#94a3b8;margin-bottom:6px;line-height:1.5}
input[type="text"],input[type="url"],textarea{width:100%;background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:12px;padding:11px 14px;font-family:inherit;font-size:14px;color:#0f172a;outline:none;transition:border-color .15s,box-shadow .15s}
textarea{font-family:'SF Mono',Consolas,monospace;font-size:12.5px;line-height:1.55;min-height:110px;resize:vertical}
input:focus,textarea:focus{border-color:#0ea56f;box-shadow:0 0 0 3px rgba(16,185,129,.12)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:560px){.row{grid-template-columns:1fr}}
.btn{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:700;padding:11px 20px;border-radius:999px;border:1px solid rgba(203,213,225,.9);background:#fff;color:#334155;cursor:pointer;text-decoration:none;transition:all .15s}
.btn:hover{border-color:#94a3b8;color:#0f172a}
.btn-primary{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);border-color:transparent;color:#fff;box-shadow:0 8px 18px rgba(16,185,129,.22)}
.actions{display:flex;justify-content:space-between;align-items:center;max-width:820px;margin:0 auto;gap:12px;flex-wrap:wrap}
.status{font-size:13px;font-weight:600;color:#0ea56f}
.status.err{color:#dc2626}
.examples{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.ex-chip{font-size:12px;font-weight:700;padding:7px 14px;border-radius:999px;border:1px solid rgba(203,213,225,.9);background:#fff;color:#334155;cursor:pointer;transition:all .15s}
.ex-chip:hover{border-color:#0ea56f;color:#0ea56f}
</style></head>
<body>
<a class="back-link" href="/admin?key=${adminKey}">&larr; Back to Dashboard</a>
<div class="logo">White-Label SMS Engine</div>
<h1>Industry Setup</h1>
<p class="subtitle">This is the AI's briefing. Before every message it sends, it reads all of this — your brand, your audience, your product, the pain points you solve, and the outcomes you deliver. Fill it in once and every conversation reflects it instantly.</p>

<div class="card">
  <h2>Quick start: pick an example to pre-fill</h2>
  <div class="desc">These are starter scaffolds — edit anything before saving.</div>
  <div class="examples">
    <button class="ex-chip" onclick="loadExample('dental')">Dental practices</button>
    <button class="ex-chip" onclick="loadExample('restaurant')">Restaurants</button>
    <button class="ex-chip" onclick="loadExample('realestate')">Real estate</button>
    <button class="ex-chip" onclick="loadExample('gym')">Gyms / studios</button>
    <button class="ex-chip" onclick="loadExample('clear')" style="color:#dc2626;border-color:#fecaca">Clear all</button>
  </div>
</div>

<form id="form" class="card" onsubmit="return save(event)">
  <h2>Brand</h2>
  <div class="row">
    <div class="field">
      <label>Brand name <span style="color:#dc2626">*</span></label>
      <div class="hint">Your company name. Token: {{brandName}}</div>
      <input type="text" id="brandName" placeholder="e.g. Acme AI" required>
    </div>
    <div class="field">
      <label>Persona (signature)</label>
      <div class="hint">The human first name the AI texts as. Token: {{brandPersona}}</div>
      <input type="text" id="brandPersona" placeholder="e.g. Sidney">
    </div>
  </div>
</form>

<form class="card">
  <h2>Audience</h2>
  <div class="row">
    <div class="field">
      <label>Industry name <span style="color:#dc2626">*</span></label>
      <div class="hint">Lowercase noun the AI uses in conversation. Token: {{industryName}}</div>
      <input type="text" id="industryName" placeholder="e.g. dental, restaurant, real estate">
    </div>
    <div class="field">
      <label>Audience descriptor <span style="color:#dc2626">*</span></label>
      <div class="hint">Who you're texting. Token: {{audienceDescriptor}}</div>
      <input type="text" id="audienceDescriptor" placeholder="e.g. dental practice owners">
    </div>
  </div>
  <div class="row">
    <div class="field">
      <label>Business noun</label>
      <div class="hint">Word for their business. Token: {{businessNoun}}</div>
      <input type="text" id="businessNoun" placeholder="e.g. practice, clinic, shop">
    </div>
    <div class="field">
      <label>Customer noun</label>
      <div class="hint">Word for the people they serve. Token: {{customerNoun}}</div>
      <input type="text" id="customerNoun" placeholder="e.g. patient, client, guest">
    </div>
  </div>
</form>

<form class="card">
  <h2>Product context</h2>
  <div class="field">
    <label>What your product does</label>
    <div class="hint">2–4 sentences in plain language. Token: {{productDescription}}</div>
    <textarea id="productDescription" placeholder="e.g. We run automated SMS campaigns that wake up your dormant patient list, fill empty appointment slots, and stop nearby competitors from outranking you on Google."></textarea>
  </div>
  <div class="field">
    <label>Pain points your audience feels</label>
    <div class="hint">One per line. The AI references these when bridging off-script replies. Token: {{painPoints}}</div>
    <textarea id="painPoints" placeholder="- Empty appointment slots cost hundreds of dollars each&#10;- Front desk forgets to follow up with no-shows&#10;- Reviews lag behind the competitor down the street"></textarea>
  </div>
  <div class="field">
    <label>Outcomes you deliver</label>
    <div class="hint">One per line. Token: {{valueProps}}</div>
    <textarea id="valueProps" placeholder="- 30+ recovered appointments per month from dormant lists&#10;- 12% reply rate on automated outreach&#10;- New 5-star reviews on autopilot"></textarea>
  </div>
  <div class="field">
    <label>Extra context (optional)</label>
    <div class="hint">Anything else the AI should know — competitors, terms to avoid, jargon your audience uses, objection handling notes.</div>
    <textarea id="extraContext" placeholder="e.g. Never mention our competitor HealthFirst. Prospects often say they already have a system — handle by asking what it does for them."></textarea>
  </div>
</form>

<div class="actions">
  <span class="status" id="status"></span>
  <div style="display:flex;gap:10px">
    <a class="btn" href="/admin/variants?key=${adminKey}">Variant Builder &rarr;</a>
    <button class="btn btn-primary" onclick="save(event)">Save Industry Config</button>
  </div>
</div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
const FIELDS = ['brandName','brandPersona','industryName','audienceDescriptor','businessNoun','customerNoun','productDescription','painPoints','valueProps','extraContext'];
const initial = ${safe};
FIELDS.forEach(f => { const el = document.getElementById(f); if (el && initial[f] != null) el.value = initial[f]; });

const EXAMPLES = {
  dental: {brandName:'',brandPersona:'',industryName:'dental',audienceDescriptor:'dental practice owners',businessNoun:'practice',customerNoun:'patient',productDescription:'We run automated SMS campaigns that wake up dormant patient lists, fill empty appointment slots, and stop nearby practices from outranking you on Google.',painPoints:'- Empty chairs cost $200+ each\\n- Patients drift to the practice with more Google reviews\\n- Front desk forgets to follow up on unscheduled treatment',valueProps:'- 30+ recovered appointments per month\\n- New 5-star reviews on autopilot\\n- Dormant patients reactivated without staff effort',extraContext:''},
  restaurant: {brandName:'',brandPersona:'',industryName:'restaurant',audienceDescriptor:'independent restaurant owners',businessNoun:'restaurant',customerNoun:'guest',productDescription:'We run AI text campaigns that bring back lapsed regulars, fill slow weeknights, and grow Google review counts faster than the chain across the street.',painPoints:'- Slow Tuesdays / Wednesdays cut margin in half\\n- Regulars vanish after 60 days and never come back\\n- Review counts trail the franchise nearby',valueProps:'- 20–40 reactivated regulars per month\\n- Slow-night covers up 15–25%\\n- Steady stream of new 5-star Google reviews',extraContext:''},
  realestate: {brandName:'',brandPersona:'',industryName:'real estate',audienceDescriptor:'residential real estate agents',businessNoun:'team',customerNoun:'client',productDescription:'We text past leads on your behalf so listings get viewed, dormant buyers get re-engaged, and seller appointments fill your calendar.',painPoints:'- Old leads sit cold and never get a follow-up text\\n- Open houses are under-attended\\n- Competing agents are top of mind, you are not',valueProps:'- 5–10 reactivated buyer/seller convos per month\\n- Open-house RSVPs without manual texting\\n- Past clients refer you because you stay in front of them',extraContext:''},
  gym: {brandName:'',brandPersona:'',industryName:'fitness',audienceDescriptor:'gym and studio owners',businessNoun:'gym',customerNoun:'member',productDescription:'We text former and at-risk members to re-enroll them, plus run new-lead nurture so trial sign-ups actually convert into paying members.',painPoints:'- Dropped members never come back\\n- Trial-to-paid conversion stalls below 30%\\n- Front desk has no time to follow up',valueProps:'- 15–25 reactivated members per month\\n- Trial conversion lifted to 50%+\\n- Hands-off lead nurture',extraContext:''},
  clear: Object.fromEntries(FIELDS.map(f => [f, '']))
};

function loadExample(key) {
  const ex = EXAMPLES[key]; if (!ex) return;
  FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = ex[f] || ''; });
}

async function save(e) {
  if (e) e.preventDefault();
  const status = document.getElementById('status');
  const payload = {};
  FIELDS.forEach(f => { const el = document.getElementById(f); if (el) payload[f] = el.value.trim(); });
  if (!payload.brandName || !payload.industryName || !payload.audienceDescriptor) {
    status.textContent = 'Brand, industry, and audience descriptor are required.';
    status.className = 'status err'; return false;
  }
  status.textContent = 'Saving…'; status.className = 'status';
  try {
    const r = await fetch('/admin/api/industry?key=' + encodeURIComponent(ADMIN_KEY), {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'save failed');
    status.textContent = 'Saved ✓ — every prompt in the system now uses these values.';
    status.className = 'status';
  } catch (err) {
    status.textContent = 'Error: ' + err.message; status.className = 'status err';
  }
  return false;
}
</script>
</body></html>`;
}

// ─── Variant Builder Page ─────────────────────────────────────────────────────

function buildVariantBuilderPage(adminKey) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Variant Builder — White-Label SMS Engine</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(circle at 8% 82%,rgba(45,212,191,.12) 0,rgba(45,212,191,0) 26%),radial-gradient(circle at 92% 12%,rgba(56,189,248,.12) 0,rgba(56,189,248,0) 24%),linear-gradient(180deg,#fbfbfb 0%,#f7fbfb 48%,#ffffff 100%);color:#0f172a;font-family:'Inter',system-ui,sans-serif;min-height:100vh;padding:32px 16px 80px;-webkit-font-smoothing:antialiased}
.back-link{display:block;max-width:1100px;margin:0 auto 16px;color:#6b7280;font-size:13px;text-decoration:none;font-weight:600}
.logo{font-size:12px;font-weight:600;letter-spacing:.32em;color:#9ca3af;text-transform:uppercase;text-align:center;margin-bottom:18px}
h1{font-size:clamp(34px,5vw,50px);font-weight:900;text-align:center;margin-bottom:14px;letter-spacing:-.04em;line-height:1.05}
.subtitle{font-size:15px;color:#475569;text-align:center;max-width:760px;margin:0 auto 28px;line-height:1.6}
.layout{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:280px 1fr;gap:18px}
@media(max-width:820px){.layout{grid-template-columns:1fr}}
.card{background:rgba(255,255,255,.86);backdrop-filter:blur(12px);border:1px solid rgba(203,213,225,.7);border-radius:22px;padding:22px;box-shadow:0 18px 42px rgba(15,23,42,.06)}
.side h3{font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px}
.var-list{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.var-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:12px;cursor:pointer;font-weight:600;font-size:13px;color:#334155}
.var-item:hover{border-color:#94a3b8}
.var-item.active{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;border-color:transparent;box-shadow:0 6px 14px rgba(16,185,129,.22)}
.var-item .id{font-family:'SF Mono',monospace;font-size:11px;opacity:.75}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:700;padding:9px 14px;border-radius:999px;border:1px solid rgba(203,213,225,.9);background:#fff;color:#334155;cursor:pointer;text-decoration:none;transition:all .15s;font-family:inherit}
.btn:hover{border-color:#94a3b8;color:#0f172a}
.btn-primary{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);border-color:transparent;color:#fff;box-shadow:0 6px 14px rgba(16,185,129,.22)}
.btn-danger{background:#fff;color:#dc2626;border-color:#fecaca}
.btn-danger:hover{border-color:#dc2626}
.btn-block{width:100%}
.empty{text-align:center;color:#94a3b8;font-size:13px;padding:40px 20px;font-weight:500}
.editor-head{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.editor-head input{flex:1;min-width:160px;background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;font-weight:600;color:#0f172a;outline:none}
.editor-head input:focus{border-color:#0ea56f}
.editor-head .id-badge{font-family:'SF Mono',monospace;font-size:11px;background:#f1f5f9;padding:5px 10px;border-radius:6px;color:#0f172a;border:1px solid #e2e8f0;font-weight:700}
.steps-list{display:flex;flex-direction:column;gap:12px;margin-bottom:18px}
.step{background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:14px;padding:14px}
.step-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.step-num{width:30px;height:30px;border-radius:50%;background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;box-shadow:0 4px 8px rgba(16,185,129,.22)}
.step-head select{background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:8px;padding:6px 10px;font-family:inherit;font-size:12.5px;font-weight:600;color:#0f172a;outline:none;cursor:pointer}
.step-head select:focus{border-color:#0ea56f}
.step-spacer{flex:1}
.step-iconbtn{background:transparent;border:1px solid rgba(203,213,225,.9);border-radius:8px;padding:5px 9px;font-size:12px;cursor:pointer;color:#64748b;font-family:inherit;font-weight:600}
.step-iconbtn:hover{border-color:#94a3b8;color:#0f172a}
.step-iconbtn.del{color:#dc2626;border-color:#fecaca}
.step textarea{width:100%;background:#fafafa;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-family:'SF Mono',Consolas,monospace;font-size:12.5px;line-height:1.55;color:#0f172a;min-height:90px;resize:vertical;outline:none}
.step textarea:focus{background:#fff;border-color:#0ea56f}
.step-info{font-size:12px;color:#64748b;line-height:1.5;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:9px 12px}
.add-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.actions-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid #e2e8f0;padding-top:18px}
.status{font-size:13px;font-weight:600;color:#0ea56f}
.status.err{color:#dc2626}
.preview{margin-top:18px;background:#0f172a;color:#cbd5e1;border-radius:14px;padding:16px;font-family:'SF Mono',monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;max-height:400px;overflow:auto;display:none}
.preview.open{display:block}
/* New-variant modal */
.modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:1000;opacity:0;pointer-events:none;transition:opacity .18s}
.modal-overlay.open{opacity:1;pointer-events:all}
.modal{background:#fff;border-radius:20px;padding:28px 26px 22px;box-shadow:0 24px 60px rgba(15,23,42,.18);width:100%;max-width:400px;transform:translateY(12px);transition:transform .18s}
.modal-overlay.open .modal{transform:translateY(0)}
.modal h3{font-size:16px;font-weight:800;margin-bottom:6px;color:#0f172a}
.modal p{font-size:13px;color:#64748b;line-height:1.55;margin-bottom:16px}
.modal input{width:100%;padding:11px 14px;border:1px solid #cbd5e1;border-radius:10px;font-family:'SF Mono',monospace;font-size:14px;font-weight:600;color:#0f172a;outline:none;margin-bottom:6px}
.modal input:focus{border-color:#0ea56f;box-shadow:0 0 0 3px rgba(16,185,129,.12)}
.modal-hint{font-size:11.5px;color:#94a3b8;margin-bottom:18px;font-family:'SF Mono',monospace}
.modal-err{font-size:12px;color:#dc2626;font-weight:600;min-height:18px;margin-bottom:10px}
.modal-btns{display:flex;gap:8px;justify-content:flex-end}
</style></head>
<body>
<a class="back-link" href="/admin?key=${adminKey}">&larr; Back to Dashboard</a>
<div class="logo">White-Label SMS Engine</div>
<h1>Variant Builder</h1>
<p class="subtitle">Build your conversation flow step by step. Each step is one message the AI sends, then it waits for the prospect to reply before moving on.</p>
<details class="token-ref" style="max-width:860px;margin:-10px auto 22px;background:rgba(255,255,255,.82);border:1px solid rgba(203,213,225,.8);border-radius:14px;padding:14px 18px;cursor:pointer;font-size:13px;color:#334155">
  <summary style="font-weight:700;color:#0f172a;list-style:none;display:flex;align-items:center;gap:8px">
    <span style="background:linear-gradient(180deg,#28c48a,#0ea56f);color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:800">?</span>
    What are <code style="font-size:12px">{{tokens}}</code> and how do I use them?
  </summary>
  <div style="margin-top:10px;line-height:1.7;color:#475569">
    Tokens are <strong>fill-in-the-blank placeholders</strong>. When the AI sends a message, any <code>{{token}}</code> in your step text gets automatically replaced with the values you set in <a href="/admin/setup?key=${adminKey}" style="color:#0ea56f;font-weight:600">Industry Setup</a>.
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin-top:10px;font-size:12.5px">
      <div><code>{{brandName}}</code> — your brand / company name</div>
      <div><code>{{brandPersona}}</code> — the AI's first name (e.g. Morgan)</div>
      <div><code>{{industryName}}</code> — the industry (e.g. dental, gym)</div>
      <div><code>{{businessNoun}}</code> — e.g. practice, restaurant, gym</div>
      <div><code>{{customerNoun}}</code> — e.g. patient, guest, member</div>
      <div><code>{{audienceDescriptor}}</code> — e.g. dental practice owners</div>
      <div><code>[first name]</code> — the prospect's first name</div>
    </div>
    <div style="margin-top:8px;font-size:12px;color:#64748b">Example: <em>"Hey [first name], I help {{audienceDescriptor}} fill empty {{businessNoun}} slots..."</em></div>
  </div>
</details>

<div class="layout">
  <div class="card side">
    <h3>Variants</h3>
    <div class="var-list" id="varList"></div>
    <button class="btn btn-primary btn-block" onclick="openNewVariantModal()">+ New Variant</button>
  </div>

  <div class="card" id="editor">
    <div class="empty" id="emptyState">Select a variant on the left, or create a new one.</div>
    <div id="editorBody" style="display:none">
      <div class="editor-head">
        <span class="id-badge" id="editId"></span>
        <input type="text" id="editName" placeholder="Variant name" maxlength="80">
        <button class="btn btn-danger" onclick="deleteCurrent()">Delete</button>
      </div>
      <div class="steps-list" id="stepsList"></div>
      <div class="add-row">
        <button class="btn" onclick="addStep('text')">+ Text Step</button>
        <button class="btn" onclick="addStep('practice_detection')">+ Ask for Business Name</button>
      </div>
      <div class="actions-bar">
        <span class="status" id="status"></span>
        <div style="display:flex;gap:8px">
          <button class="btn" onclick="togglePreview()">Preview compiled</button>
          <button class="btn btn-primary" onclick="saveCurrent()">Save Variant</button>
        </div>
      </div>
      <pre class="preview" id="preview"></pre>
    </div>
  </div>
</div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
let variants = [];
let current = null;        // { id, name, steps }
let isNew = false;

async function api(method, path, body) {
  const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(ADMIN_KEY), {
    method, headers: body ? {'Content-Type':'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || method + ' failed');
  return j;
}

async function load() {
  const j = await api('GET', '/admin/api/structured-variants');
  variants = j.variants || [];
  renderList();
}

function renderList() {
  const list = document.getElementById('varList');
  if (variants.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:#94a3b8;text-align:center;padding:18px 6px">No variants yet. Create one to get started.</div>';
    return;
  }
  list.innerHTML = variants.map(v =>
    '<div class="var-item ' + (current && current.id === v.id && !isNew ? 'active' : '') + '" onclick="select(' + JSON.stringify(v.id).replace(/"/g, '&quot;') + ')"><span>' + escHtml(v.name) + '</span><span class="id">' + escHtml(v.id) + '</span></div>'
  ).join('');
}

function select(id) {
  const v = variants.find(x => x.id === id); if (!v) return;
  current = JSON.parse(JSON.stringify(v));
  isNew = false;
  showEditor();
}

function openNewVariantModal() {
  document.getElementById('nv-input').value = '';
  document.getElementById('nv-err').textContent = '';
  document.getElementById('nvModal').classList.add('open');
  setTimeout(() => document.getElementById('nv-input').focus(), 80);
}
function closeNewVariantModal() {
  document.getElementById('nvModal').classList.remove('open');
}
function confirmNewVariant() {
  const id = document.getElementById('nv-input').value.trim();
  const err = document.getElementById('nv-err');
  if (!id) { err.textContent = 'Please enter an ID.'; return; }
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(id)) { err.textContent = 'Only letters, numbers, _ and - allowed (max 16 chars).'; return; }
  if (variants.some(v => v.id === id)) { err.textContent = 'That ID already exists — pick another.'; return; }
  closeNewVariantModal();
  current = { id, name: 'Variant ' + id, steps: [] };
  isNew = true;
  showEditor();
}

function showEditor() {
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('editorBody').style.display = 'block';
  document.getElementById('editId').textContent = current.id;
  document.getElementById('editName').value = current.name;
  document.getElementById('status').textContent = '';
  document.getElementById('preview').classList.remove('open');
  renderSteps();
  renderList();
}

function renderSteps() {
  const root = document.getElementById('stepsList');
  if (!current.steps || current.steps.length === 0) {
    root.innerHTML = '<div class="empty">No steps yet — add one below.</div>';
    return;
  }
  root.innerHTML = current.steps.map((s, i) => {
    const num = i + 1;
    let body;
    if (s.type === 'text') {
      body = '<textarea oninput="updateStep(' + i + ',\\'text\\',this.value)" placeholder="Type the message to send. Use [first name] for the prospect\\'s name, or {{tokens}} like {{brandName}}, {{businessNoun}} — see the token reference above.">' + escHtml(s.text || '') + '</textarea>';
    } else if (s.type === 'practice_detection') {
      body =
        '<div class="step-info" style="margin-bottom:10px">' +
          '<strong>What this does:</strong> The AI sends your message below asking for the business name and street. ' +
          'When the prospect replies, the system automatically looks up the business on Google Maps, runs a visibility scan, and feeds that data to the AI before the next step.' +
        '</div>' +
        '<label style="font-size:12px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Message asking for business name &amp; street:</label>' +
        '<textarea oninput="updateStep(' + i + ',\\'text\\',this.value)" placeholder="e.g. \\'What\\'s the name of your {{businessNoun}} and what street is it on? I want to pull up your Google listing.\\'">' + escHtml(s.text || '') + '</textarea>';
    } else if (s.type === 'vsl_send') {
      body = '<textarea oninput="updateStep(' + i + ',\\'text\\',this.value)" placeholder="Message to send with your link. Include {{vslUrl}} where the link should appear, e.g. \\'Check this out: {{vslUrl}}\\'">' + escHtml(s.text || '') + '</textarea>';
    }
    const term = s.terminal || '';
    const typeLabel = s.type === 'practice_detection' ? 'Ask for business name' : s.type === 'vsl_send' ? 'Text step' : 'Text step';
    return '<div class="step">' +
      '<div class="step-head">' +
        '<div class="step-num">' + num + '</div>' +
        '<span style="font-size:12px;font-weight:700;color:#334155;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:5px 10px">' + escHtml(typeLabel) + '</span>' +
        (s.type !== 'practice_detection' ?
          '<select onchange="updateStep(' + i + ',\\'terminal\\',this.value||null)" title="Mark end of conversation" style="font-size:12px">' +
            '<option value=""' + (term===''?' selected':'') + '>Conversation continues</option>' +
            '<option value="booked"' + (term==='booked'?' selected':'') + '>✓ End — prospect booked</option>' +
          '</select>' : '') +
        '<div class="step-spacer"></div>' +
        '<button class="step-iconbtn" onclick="moveStep(' + i + ',-1)" ' + (i===0?'disabled':'') + '>↑</button>' +
        '<button class="step-iconbtn" onclick="moveStep(' + i + ',1)" ' + (i===current.steps.length-1?'disabled':'') + '>↓</button>' +
        '<button class="step-iconbtn del" onclick="deleteStep(' + i + ')">Delete</button>' +
      '</div>' +
      body +
    '</div>';
  }).join('');
}

function updateStep(i, key, val) {
  if (!current.steps[i]) return;
  current.steps[i][key] = val;
  if (key === 'type') renderSteps();
}
function moveStep(i, dir) {
  const j = i + dir; if (j < 0 || j >= current.steps.length) return;
  const tmp = current.steps[i]; current.steps[i] = current.steps[j]; current.steps[j] = tmp;
  renderSteps();
}
function deleteStep(i) {
  if (!confirm('Delete step ' + (i+1) + '?')) return;
  current.steps.splice(i, 1); renderSteps();
}
function addStep(type) {
  current.steps.push({ type, text: type === 'practice_detection' ? '' : '', terminal: null });
  renderSteps();
}

async function saveCurrent() {
  const status = document.getElementById('status');
  current.name = document.getElementById('editName').value.trim() || current.id;
  status.textContent = 'Saving…'; status.className = 'status';
  try {
    if (isNew) await api('POST', '/admin/api/structured-variants', current);
    else       await api('PUT',  '/admin/api/structured-variants/' + encodeURIComponent(current.id), current);
    isNew = false;
    await load();
    select(current.id);
    status.textContent = 'Saved ✓';
  } catch (err) { status.textContent = 'Error: ' + err.message; status.className = 'status err'; }
}

async function deleteCurrent() {
  if (!current) return;
  if (!confirm('Delete variant "' + current.name + '" (id: ' + current.id + ')? This cannot be undone.')) return;
  try {
    if (!isNew) await api('DELETE', '/admin/api/structured-variants/' + encodeURIComponent(current.id));
    current = null;
    document.getElementById('editorBody').style.display = 'none';
    document.getElementById('emptyState').style.display = 'block';
    await load();
  } catch (err) { alert('Error: ' + err.message); }
}

async function togglePreview() {
  const pre = document.getElementById('preview');
  if (pre.classList.contains('open')) { pre.classList.remove('open'); return; }
  if (isNew) { pre.textContent = 'Save the variant first to preview the compiled prompt.'; pre.classList.add('open'); return; }
  try {
    const r = await fetch('/admin/api/structured-variants/' + encodeURIComponent(current.id) + '/preview?key=' + encodeURIComponent(ADMIN_KEY));
    const j = await r.json();
    pre.textContent = j.compiled || j.error || '(empty)';
    pre.classList.add('open');
  } catch (err) { pre.textContent = 'Error: ' + err.message; pre.classList.add('open'); }
}

function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

load().catch(err => alert('Failed to load variants: ' + err.message));
</script>

<!-- New-variant modal -->
<div class="modal-overlay" id="nvModal" onclick="if(event.target===this)closeNewVariantModal()">
  <div class="modal">
    <h3>Name your variant</h3>
    <p>Give it a short ID — you'll use this to select it in the playground and assign it to leads.</p>
    <input id="nv-input" type="text" placeholder="e.g. D1, GYM, launch-v2" maxlength="16"
      oninput="document.getElementById('nv-err').textContent=''"
      onkeydown="if(event.key==='Enter')confirmNewVariant();if(event.key==='Escape')closeNewVariantModal()">
    <div class="modal-hint">Letters, numbers, _ and - only &middot; max 16 chars</div>
    <div class="modal-err" id="nv-err"></div>
    <div class="modal-btns">
      <button class="btn" onclick="closeNewVariantModal()">Cancel</button>
      <button class="btn btn-primary" onclick="confirmNewVariant()">Create Variant</button>
    </div>
  </div>
</div>
</body></html>`;
}

// ─── Setup Guide Page (shown when ADMIN_KEY is missing or wrong) ──────────────

function buildSetupGuidePage(reason) {
  const titles = {
    not_configured: 'Almost there — set your admin key',
    no_key: 'Add your admin key to the URL',
    wrong_key: 'That admin key did not match'
  };
  const intros = {
    not_configured: 'This server is running, but no <code>ADMIN_KEY</code> has been set yet. The admin key is the password that protects your dashboard. Set one as a Replit Secret, then reload.',
    no_key: 'The admin dashboard is protected by an admin key. Add it to the URL as <code>?key=YOUR_ADMIN_KEY</code>.',
    wrong_key: 'The key in the URL does not match the <code>ADMIN_KEY</code> secret on this server. Double-check the value and try again.'
  };
  const showSecretSteps = reason === 'not_configured';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Setup — White-Label SMS Engine</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(circle at 8% 82%,rgba(45,212,191,.14) 0,rgba(45,212,191,0) 28%),radial-gradient(circle at 92% 12%,rgba(56,189,248,.14) 0,rgba(56,189,248,0) 26%),linear-gradient(180deg,#fbfbfb 0%,#f7fbfb 48%,#ffffff 100%);color:#0f172a;font-family:'Inter',system-ui,sans-serif;min-height:100vh;padding:48px 20px 80px;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.32em;color:#0ea56f;text-transform:uppercase;text-align:center;margin-bottom:18px}
h1{font-size:clamp(32px,5vw,46px);font-weight:900;letter-spacing:-.03em;line-height:1.1;text-align:center;margin-bottom:14px}
.intro{font-size:16px;color:#475569;text-align:center;max-width:580px;margin:0 auto 32px;line-height:1.65}
.card{background:rgba(255,255,255,.92);backdrop-filter:blur(12px);border:1px solid rgba(203,213,225,.7);border-radius:22px;padding:28px;margin-bottom:18px;box-shadow:0 18px 42px rgba(15,23,42,.06)}
.card h2{font-size:17px;font-weight:800;letter-spacing:-.01em;margin-bottom:12px}
.steps{list-style:none;counter-reset:step;display:flex;flex-direction:column;gap:14px;margin-top:6px}
.steps li{counter-increment:step;position:relative;padding:14px 16px 14px 56px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;font-size:14px;color:#334155;line-height:1.6}
.steps li::before{content:counter(step);position:absolute;left:14px;top:14px;width:30px;height:30px;border-radius:50%;background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;box-shadow:0 4px 8px rgba(16,185,129,.22)}
.steps li b{color:#0f172a;font-weight:700}
code{font-family:'SF Mono',Consolas,monospace;font-size:12.5px;background:#f1f5f9;padding:3px 8px;border-radius:6px;color:#0f172a;border:1px solid #e2e8f0;font-weight:600}
.tip{font-size:13px;color:#0c4a6e;background:#ecfeff;border:1px solid #bae6fd;border-radius:12px;padding:14px 16px;line-height:1.6;margin-top:14px}
.tip b{color:#0c4a6e}
.kv{display:grid;grid-template-columns:200px 1fr;gap:8px 18px;font-size:13.5px;margin-top:8px}
.kv dt{color:#0f172a;font-weight:700}
.kv dd{color:#475569;line-height:1.55}
.btn-row{display:flex;justify-content:center;gap:10px;margin-top:18px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:700;padding:11px 22px;border-radius:999px;border:1px solid rgba(203,213,225,.9);background:#fff;color:#334155;text-decoration:none;transition:all .15s}
.btn:hover{border-color:#94a3b8;color:#0f172a}
.btn-primary{background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;border-color:transparent;box-shadow:0 8px 18px rgba(16,185,129,.25)}
.try{display:flex;gap:8px;align-items:center;margin-top:16px}
.try input{flex:1;padding:11px 14px;border:1px solid #cbd5e1;border-radius:10px;font-family:'SF Mono',monospace;font-size:13px;outline:none}
.try input:focus{border-color:#0ea56f;box-shadow:0 0 0 3px rgba(16,185,129,.12)}
.try button{padding:11px 20px;border:0;border-radius:10px;background:linear-gradient(180deg,#28c48a 0%,#0ea56f 100%);color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}
.foot{text-align:center;font-size:12px;color:#94a3b8;margin-top:30px;font-weight:600;letter-spacing:.04em}
.foot a{color:#0ea56f;text-decoration:none}
</style></head>
<body><div class="wrap">
<div class="eyebrow">White-Label SMS Engine</div>
<h1>${titles[reason]}</h1>
<p class="intro">${intros[reason]}</p>

${showSecretSteps ? `
<div class="card">
  <h2>Set your admin key (1 minute)</h2>
  <ol class="steps">
    <li>In your Replit workspace, open the <b>Tools</b> panel on the left and click <b>Secrets</b> (the lock icon).</li>
    <li>Click <b>+ New Secret</b>. For the key, type <code>ADMIN_KEY</code>. For the value, type any password you want — make it long and random (e.g. <code>k9_x4vQ-8sB2-mP7w</code>).</li>
    <li>Click <b>Add Secret</b>, then restart this Repl (the workflow auto-restarts when secrets change, but a manual restart never hurts).</li>
    <li>Reload this page and use the URL <code>/admin?key=YOUR_ADMIN_KEY</code> with the value you just set.</li>
  </ol>
  <div class="tip"><b>Security note:</b> the admin key acts as your password. Treat it like one. Don't commit it to GitHub. Replit Secrets are stored separately from your code, so they're safe — but anyone with the key can control your conversation engine.</div>
</div>` : `
<div class="card">
  <h2>Try opening the dashboard</h2>
  <p style="font-size:14px;color:#475569;line-height:1.65;margin-bottom:6px">Paste your admin key below and we'll build the right URL for you.</p>
  <div class="try">
    <input id="key" type="text" placeholder="Your ADMIN_KEY value" autocomplete="off">
    <button onclick="go()">Open Admin</button>
  </div>
  <script>
    function go(){var k=document.getElementById('key').value.trim();if(!k)return;location.href='/admin?key='+encodeURIComponent(k);}
    document.getElementById('key').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  </script>
  <div class="tip" style="margin-top:18px"><b>Forgot your key?</b> Open the Replit <b>Tools &rarr; Secrets</b> panel and look at the <code>ADMIN_KEY</code> value. If you want to change it, edit it there and restart the Repl.</div>
</div>`}

<div class="card">
  <h2>What else you'll want to set up</h2>
  <p style="font-size:14px;color:#475569;line-height:1.65;margin-bottom:14px">The admin key is enough to log in, but for the engine to actually run conversations, you'll also need these secrets. Add them the same way (Tools &rarr; Secrets):</p>
  <dl class="kv">
    <dt><code>ANTHROPIC_API_KEY</code></dt><dd>Required. Powers all AI replies. Get one at console.anthropic.com.</dd>
    <dt><code>DATABASE_URL</code></dt><dd>Required. Postgres connection string. Replit gives you one for free under <b>Tools &rarr; Database</b>.</dd>
    <dt><code>GHL_API_KEY</code></dt><dd>Required for live SMS. Your GoHighLevel sub-account API key.</dd>
    <dt><code>GHL_LOCATION_ID</code></dt><dd>Required for live SMS. The GHL location/sub-account this engine sends from.</dd>
    <dt><code>GHL_WEBHOOK_SECRET</code></dt><dd>Recommended. Protects your inbound webhook from spoofing.</dd>
    <dt><code>DATAFORSEO_LOGIN</code> + <code>DATAFORSEO_PASSWORD</code></dt><dd>Recommended. Powers the visibility scanner — the engine pings the local Google Maps grid around the prospect's business and tells the AI exactly where they rank vs competitors. This is the <b>primary</b> scan path. Sign up at dataforseo.com.</dd>
    <dt><code>GOOGLE_PLACES_KEY</code></dt><dd>Recommended. Used for the prospect business lookup (name + address + reviews). Also acts as the <b>fallback</b> scanner if DataForSEO fails or is not set.</dd>
    <dt><code>DEV_MODE</code></dt><dd>Optional. Set to <code>1</code> while testing — disables the scheduler &amp; outbound SMS so nothing actually sends.</dd>
  </dl>
  <div class="tip"><b>Local-only testing?</b> Set <code>ADMIN_KEY</code> + <code>ANTHROPIC_API_KEY</code> + <code>DATABASE_URL</code> + <code>DEV_MODE=1</code>. You can build variants, run the playground simulator, and design conversations without ever wiring up GHL or sending real texts.</div>
</div>

<div class="btn-row">
  <a class="btn" href="/">&larr; Back to landing</a>
  ${showSecretSteps ? '' : '<a class="btn btn-primary" href="/admin">I added the key — try again &rarr;</a>'}
</div>

<div class="foot">White-Label SMS Sales Engine &middot; <a href="/">home</a></div>
</div></body></html>`;
}
