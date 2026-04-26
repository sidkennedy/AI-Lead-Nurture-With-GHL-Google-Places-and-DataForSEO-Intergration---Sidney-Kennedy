# Powered Up AI — Project Notes

## What This Is

GHL-integrated AI sales assistant for audiology practices. Node/Express backend, PostgreSQL database, Claude (claude-sonnet) for AI, GHL webhooks for contact management.

Admin dashboard lives at `/admin?key=YOUR_ADMIN_KEY`.

---

## ⚠️ AGENT: ALWAYS USE PROD_DATABASE_URL FOR ONE-OFF SCRIPTS ⚠️

**The trap:** This Replit workspace ships with its own empty Postgres at `DATABASE_URL` (host `helium`). The real data lives in Neon at `PROD_DATABASE_URL`. The running server flips `process.env.DATABASE_URL = process.env.PROD_DATABASE_URL` inside `server.js` (lines 17–22), so the app is always on prod. **But that flip never runs in a fresh shell process** — so any standalone `node -e "..."` or `node scripts/foo.js` invocation that uses `DATABASE_URL` will silently hit the empty local DB and return wrong/stale results.

**Hard rule for any one-off DB query the agent writes:** always use `process.env.PROD_DATABASE_URL` directly. Never use `DATABASE_URL` from a shell-launched script. If you find yourself about to type `connectionString: process.env.DATABASE_URL` in an ad-hoc script, stop and use the snippet below.

**Canonical snippet — copy-paste into every one-off script:**
```js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.PROD_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
```

**Sanity check before trusting any query result:** if a row count, length, or table list looks surprisingly small, empty, or "all identical", you are probably on the wrong DB. Verify by logging the host:
```js
console.log('DB host:', (process.env.PROD_DATABASE_URL || '').match(/@([^/]+)/)?.[1]);
// Should print something like: ep-falling-haze-anlase71.c-6.us-east-1.aws.neon.tech
// If it prints "helium" or is empty, STOP — you're on the wrong DB.
```

**Existing module code is fine.** server.js, conversations.js, brain.js, followups.js, optouts.js, and prompts.js all use `DATABASE_URL` and that's correct — they only run inside the server process where the flip has already happened. This rule is exclusively for ad-hoc shell scripts the agent writes during a session.

---

## ⚠️ AGENT: OTHER RECURRING TRAPS ⚠️

### 1. Variants A, B, C, D are intentionally distinct — never "reconcile" them
The four conversation prompt variants have deliberately different voices, step counts, and booking-close lines (A neutral with 9 steps, B punchy with 10 steps, C urgent with 8 steps, D bold with 8 steps). They are **not** A/B/C/D copies of one script — they are four different scripts being tested against each other. If you query the prompts and see them looking identical, byte-equal, or near-equal in length, **you are reading the wrong source** (almost certainly the wrong DB — see the section above). Do not propose unifying them, deduplicating them, or suggesting one is "out of sync" with the others. Confirm distinctness against the prod DB before saying anything about variant content.

### 2. The admin dashboard is one giant template literal in `server.js` — quote-nesting is a real footgun
The entire admin UI HTML+CSS+JS is rendered by huge backtick template literals inside server.js (most of them under `/admin` and `/api/admin/*` routes). Inside those backticks live single-quoted JS strings, which sometimes contain English contractions. Words like **hasn't, can't, won't, doesn't, you're, it's, I'll, we're** will silently break the page if they sit unescaped inside a single-quoted string inside a backtick template — the prod admin "Loading…" bug at server.js:3777 was caused by exactly this (`'hasn't'` inside a single-quoted string inside a backtick template). Two safe options when editing admin HTML/JS strings:
- Escape: `'has\\'t'` (works but ugly)
- Rephrase: `'has not'`, `'cannot'`, `'will not'`, `'does not'`, `'you are'`, `'it is'`, `'I will'`, `'we are'` (preferred)

When editing anything inside the admin template, scan your changes for contractions before saving.

**Same trap, different shape — nested backtick template literals inside the page template:** Any JavaScript function added to the admin `<script>` block lives inside the outer backtick template literal that builds the whole page. If that function uses its own backtick template literal (e.g. `` return `<div>...</div>`; ``), it terminates the outer template early, causing a Node.js `SyntaxError: Unexpected identifier 'style'` (or similar) that crashes the server on boot. This happened three times during the Saved Issues feature build (Apr 26). **Hard rule:** all JS helper functions added inside the admin `<script>` block must use plain string concatenation (`'<div>' + x + '</div>'`) — never backtick template literals. The outer page template can use `${}` interpolation freely, but inner JS function bodies cannot.

**Same trap, different shape — `JSON.stringify` interpolated into an HTML attribute:** `JSON.stringify(x)` always wraps strings in double quotes. Embedding that inside `onclick="..."` (or any `attr="..."`) collides with the attribute delimiter and silently truncates the JS — clicking the element then throws `SyntaxError: Unexpected end of input`. The unknown-lead-form-button crash on 2026-04-26 (server.js lines 4168 and 4636) was exactly this: `onclick="setVariantLeadFormFilter(${JSON.stringify(f)})"` rendered as `onclick="setVariantLeadFormFilter("unknown")"`. Fix pattern used: `${JSON.stringify(x).replace(/"/g, '&quot;')}` — the browser HTML-decodes `&quot;` back to `"` when invoking the handler. (Switching the attribute to single quotes also works as long as the string can't contain a single quote.)

### 3. Admin dashboard "Loading forever" after a fresh publish — always use fetchWithTimeout
Every data-loading function in the admin dashboard (`loadBrain`, `loadFollowups`, `loadSpend`, `loadIssues`) wraps its fetch calls in `fetchWithTimeout(url, opts, ms)` (defined near the top of the admin `<script>` block). Without a timeout, if the production server is still cold-starting when the admin page first loads, fetch calls hang indefinitely and spinners never clear. The wrapper uses `AbortController` and defaults to 15 seconds; on abort it throws `"Request timed out — server may still be starting. Refresh to retry."` which the catch blocks surface in the UI. **Any new `fetch(...)` call added to a load function must use `fetchWithTimeout(...)` instead.** This recurred twice before the fix was in place (Apr 26).

### 4. The user republishes manually — file/code changes are NOT live in prod until they confirm
Two things to keep straight when reporting status to the user:
- **DB writes** (anything written to the prod Neon database via `PROD_DATABASE_URL`) — these are live in prod **immediately**. Admin UI shows them on next refresh.
- **File/code changes** (edits to `.js`, `.json`, `.md`, etc. in this workspace) — these only ship to prod when the user clicks Publish. Until then, prod runs the previously-deployed code.

When telling the user something is "done" or "live", be explicit about which: "the DB is updated now; the file change ships on your next deploy" — never just "this is live now". This prevents the user from thinking a code-path change has reached prod when it hasn't.

### 5. GHL webhook misses — AI goes silent after a prospect reply
GHL occasionally fails to deliver the inbound webhook to the server, even when the prospect's reply is visible in the GHL UI. The symptom: the prospect sent a message (e.g. "Go"), you can see it in GHL, but the DB has no inbound exchange record for that contact and the AI never responded. Confirmed cases: Yung Tommy Walker (Apr 26 08:01 "I'm sorry"), Lester Herbertson (Apr 26 09:21 "Go").

**Immediate fix:** Admin dashboard → "Missed Reply Trigger" section → search the contact name → type exactly what they sent → hit Trigger AI Response. The AI responds immediately. Before triggering, check whether the conversation has moved on manually — if a human has already taken over and sent subsequent messages, do NOT trigger (it would send an out-of-context AI reply).

**Root cause:** GHL webhook delivery is best-effort; the server has no polling/replay mechanism. Long-term fix (not yet built): a reconciliation job that periodically pulls recent GHL messages and backfills any inbound the server missed — medium complexity, ~1-2 hours. This is documented in the Saved Issues panel on the admin dashboard.

**Saved Issues panel:** Added Apr 26. Lives at the bottom of the admin dashboard. Stores bugs/patterns you want to revisit later without fixing immediately — title, problem description, solution/next-step notes, optional contact reference, open/done status. The GHL webhook-miss issue is pre-seeded there. Use it whenever something weird happens and you are not ready to fix it yet — saves re-investigation cost next time.

### 6. Source of truth for prompt content is the prod DB `ai_prompts` table — not the file
`data/prompts.json` is a mirror, not a source. The boot logic in `prompts.js` (`syncFromDb`) is "DB wins": on every server start, the file gets overwritten with whatever is in `ai_prompts`. So:
- **Read order:** trust the DB first. If the file disagrees with the DB, the DB is right.
- **Write order:** when you change a prompt, write to BOTH places (file + DB) in the same operation. Use the canonical pool snippet from the wrong-DB section above against `PROD_DATABASE_URL`. The pattern `INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value=$2, updated_at=$3` is what `prompts.js syncToDb` uses — copy it.
- If you only edit the file, your change is alive only until the next server restart, then it gets erased by the DB content.
- If you only edit the DB, the file in git stays stale — the next person reading the repo sees old content, and a future deploy of an empty DB would re-seed the wrong text.

The admin UI's "Save" button on the Prompt Editor already does both correctly (`POST /admin/prompts/:name` writes to file AND calls `syncToDb`). Match that pattern in any one-off script.

### 7. When you renumber steps in a prompt variant, cross-references break silently
The variant prompts are full of internal step references — RULES section ("EXCEPT the Step N bridge"), MAPS CONFIRMATION LOOP ("after the [PRACTICE_DETECTED] bridge in Step N"), EARLY BOOKING ("skip directly to Step N"), LIVE DATA ("use the real numbers in Step N"), NEVER REPEAT A QUESTION (which questions belong to which step), and the [STEP:N] valid-range note in RULES ("integer 1-N"). When you change the numbering of any step, **every one** of those references must be updated in the same edit pass. The Apr 26 Variant B renumber (8 steps → 7) missed the RULES line "EXCEPT the Step 6 bridge" — that contradiction made the bridge non-deterministic until hotfixed. Audit checklist before saving a renumber: search the prompt text for every `Step \d` occurrence and reconcile each one against the new numbering, then re-confirm the [STEP:N] integer range cap matches the highest step number.

### 8. All 4 variants now carry two non-negotiable safety blocks — preserve them on any future edit
Inserted Apr 26 right above the `━━━ AFTER A DECLINE` header in every variant (A/B/C/D):
1. **`━━━ NEVER BOOK BEFORE QUALIFYING ━━━`** — gates `[BOOKED]` on BOTH `LIVE RESEARCH DATA` AND `SCAN RESULTS` being present in the system context. Provides the verbatim pivot string `"Love the energy [first name] — I just need to confirm one thing first so the call's actually useful for you."` for premature-book attempts. The pivot is written as an instruction (NOT a template with bracketed placeholders) so the model substitutes the first name and asks its current-step question without leaking any literal brackets into the SMS. Without this block, all 4 variants will fire `[BOOKED]` on a turn-1 "yes book me tomorrow at 10am" with no discovery, no research, no scan — confirmed via `/tmp/stress.js` before the patch.
2. **`━━━ HOSTILE / AGGRESSIVE OPT-OUT — IMMEDIATE [DECLINED] ━━━`** — explicit phrase list (profanity at the bot incl. "fuck you" / "go fuck yourself", spam complaints, removal requests incl. "lose my number" / "stop contacting me", TCPA STOP/QUIT/END/CANCEL/OPTOUT/UNSUBSCRIBE matched as standalone tokens with an edge-case caveat against false-positives like "I tried to call but it stopped ringing") that force the "Not interested" handler regardless of `CURRENT STEP`. Without this, variant B in particular will try to win-back hostile openers ("One look and if it's not for you, I'm gone") instead of folding. A/C/D fold on the same input naturally because their voices are less aggressive — but the explicit rule belt-and-suspenders all four.

**Server-side belt-and-suspenders for #1 (added same patch):** `server.js` line ~1278 — when `[BOOKED]` is emitted but `fresh.researchData` OR `fresh.scanResults` is missing, the marker is stripped, the AI is NOT paused, and the conversation continues. This catches the rare case where the model drifts past the prompt-level rule. Logs the suppression with `[AiGen] [BOOKED] suppressed for ${contactId} (premature: ...)`.

**Silence-nudge duplicate guard (added Apr 26 pre-launch, Sidney FB-form repro):** A FB-lead-form test on contact `gplX4FlLRZ1omhJ9Ezx8` (variant D) produced TWO outbound `silence-nudge` messages 1.5s apart from a SINGLE silence-check job (`fu-1777183192992-4mmba`, status=sent). Root cause: the dedup at `followups.js` ~line 1027 (`exchanges.some(e => e.type === 'silence-nudge')`) runs BEFORE the per-contact outbound lock — so two concurrent `processSilenceCheck` calls (e.g., scheduler-tick race, transient duplicate cache entry, OR a brief deploy-rollover overlap with two instances polling the shared DB) both pass the dedup on stale state and both call `sendHook1Static`. **Three layers of defense shipped together:**
1. **`getDueJobs` ID dedup** — filters duplicates by job ID before returning the due list. Cheap belt-and-suspenders against any future cache-corruption bug.
2. **In-lock re-check inside `sendHook1Static`** (in-process) — after acquiring the per-contact outbound lock, re-reads the job (must still be `pending` in cache) AND the contact's exchanges (no `silence-nudge` may already exist). On either hit, logs `(lock-time dedup)` and aborts. The cancellation rewrite is gated on `freshJob.status === 'pending'` so we never overwrite a `sent`/`skipped` final state with `cancelled`.
3. **Atomic DB claim `_dbAtomicClaim(jobId)`** (cross-process) — `UPDATE followup_jobs SET status='sending' WHERE id=$1 AND status='pending' RETURNING id`. Only the process whose UPDATE returns rowCount=1 proceeds to call `ghl.sendMessage`; the loser logs `(DB claim failed)` and aborts. The subsequent `updateJob({status:'sent'})` (or `'skipped'` on send error) overwrites `'sending'` → final state via the existing `_dbUpsertJob` `ON CONFLICT DO UPDATE`. **Trade-off:** if the process crashes AFTER the claim but BEFORE finalize, the row sits in `'sending'` forever and the nudge is silently dropped (`getDueJobs` filters by `status='pending'`). For a low-stakes 5-min nudge, silent drop is preferable to a duplicate send. Atomic-claim is currently scoped to `sendHook1Static` only — `sendFollowUp` (positions 2–5) and `processEmailHook` were not touched in this patch.

DB error in `_dbAtomicClaim` fails CLOSED (returns false → skip the send) so a transient Postgres blip cannot cause a duplicate. Validated by `/tmp/test_silence_dedup.js` (two simultaneous silence-check jobs → exactly 1 GHL send + 1 nudge exchange after a 500ms DB-write settle delay; the delay simulates the real-world condition where silence-check is always scheduled with `sendAt = now + 5min`, giving the fire-and-forget `_dbUpsertJob` ample time to commit before the atomic claim runs).

**Server-side outbound-quality guard (added Apr 26 pre-launch):** `server.js` lines ~1178–1240 inside `generateAndSendAiReply`, runs immediately after the Claude call and BEFORE marker extraction. Detects two failure modes from stress testing on variant A under extreme low-engagement prospects (4× "ok"/"maybe"/"I dunno"): (a) verbatim duplicate of the last outbound, (b) third consecutive outbound carrying the same `[STEP:N]` marker (violates A's prompt-level HARD CAP rule). On detection, retries the Claude call ONCE with a corrective system-prompt addendum that instructs the model to either advance the step / vary the wording, or send the polite `[DECLINED]` exit using the prospect's first name. Single retry only — no infinite loops. The retried reply replaces `reply` and falls through into the existing marker pipeline so `[BOOKED]` / `[DECLINED]` / `[PRACTICE_DETECTED:...]` handling all still applies. Applies to every variant; benign on B/C/D since the guard only fires on actual violations. Validated by `/tmp/test_guard.js` against both failure scenarios + a healthy-conversation no-false-positive check.

If you renumber steps, restructure the OBJECTIONS section, or do any large prompt edit: re-confirm both blocks survived intact. Verify with `node -e ...` against the prod DB checking both `value.includes('NEVER BOOK BEFORE QUALIFYING')` and `value.includes('HOSTILE / AGGRESSIVE OPT-OUT')` for all four `conversationPrompt.{A,B,C,D}` rows. Stress harness lives at `/tmp/stress.js` (12 brutal scenarios) and `/tmp/retest.js` (7-scenario regression of these two safety properties).

---

## Dev Mode (Local UI Testing)

### What it does
Setting `DEV_MODE=true` in your local environment puts the server into a safe testing mode:
- **Scheduler is disabled** — no automatic follow-up jobs fire from your local instance. Production keeps running normally.
- **GHL sends are stubbed** — no real SMS or emails go out, no matter what you click. The console logs what *would* have been sent.
- **Dev banner shows** — a bright orange bar across the top of the admin dashboard confirms you're in dev mode.
- **Real production data is visible** — when `PROD_DATABASE_URL` is also set as a Replit secret, the local server connects to the LIVE production database instead of the empty workspace database. The admin UI shows actual contacts, conversations, and stats in real time.

### How to enable it locally
1. Add `DEV_MODE=true` to your `.env` file (the one in the project root, never committed).
2. Add the production database connection string as a Replit secret named `PROD_DATABASE_URL` (find it in Deployments → your live deployment → Database tab). This is workspace-only — never put it in deployment secrets.
3. Restart the workflow. You'll see two confirmation lines in the console:
   ```
   [DB] DEV_MODE — DATABASE_URL routed to PROD_DATABASE_URL (local server now uses the LIVE production database)
   ╔══════════════════════════════════════════════════╗
   ║  DEV MODE — scheduler + GHL sends are disabled   ║
   ╚══════════════════════════════════════════════════╝
   ```

### Safety guards
- The `PROD_DATABASE_URL` override is hard-gated on `DEV_MODE === 'true'`. If `PROD_DATABASE_URL` somehow ends up in deployment secrets, production logs a warning and ignores it.
- Even though you're connected to the live database, no SMS/email goes out (the GHL wrappers are stubbed) and the scheduler doesn't fire follow-ups from your local instance. **You can still write to the database, though** — clicking "enroll lead" or sending a test reply WILL change real production data. Be deliberate.
- **Never set `DEV_MODE=true` in the Replit Secrets/deployment environment.** It should only exist in your local `.env`.

### What you can safely do in dev mode
- Design and test any admin UI changes
- Add new panels, graphs, stats
- Test AI prompt changes (Claude is called, response is shown in console, but nothing sends)
- Click any admin button without risk

### Preview pane
The Replit preview pane (`/`) redirects directly to `/admin`. Add `?key=YOUR_ADMIN_KEY` to the URL and bookmark it.

---

## Architecture

- `server.js` — all API endpoints, admin dashboard HTML/JS/CSS
- `ghl.js` — GHL API wrapper (sendMessage, sendEmail, fetchContact, fetchContactsByTag)
- `conversations.js` — in-memory + DB contact state (contactMap)
- `followups.js` — job scheduler, silence checks, hook/nurture sends
- `brain.js` — stats, variant analytics, outbound/inbound recording (each outbound message snapshots the contact's `leadForm` for historical lead-form analytics)
- `prompts.js` — DB-backed prompt storage, variant picking (A/B/C)
- `enrollment.js` — AI-powered conversation history analysis for re-enrollment
- `spend.js` — per-contact Claude API spend tracking
- `optouts.js` — opt-out keyword detection and blocklist
- `outbound-lock.js` — race-condition guard for SEND→PERSIST window (see below)

## Race-Condition Protection (outbound-lock.js)

**The bug:** Every outbound message is sent then persisted (`ghl.sendMessage` → `conversations.addExchange`). If a fast prospect replies between those two steps, the inbound webhook reads stale state and Claude regenerates the same message — duplicate sends.

**The fix:** Every outbound flow acquires a per-contactId lock around its SEND→PERSIST critical section. `handleInbound` calls `await outboundLock.waitForSettle(contactId)` at the very top before reading any state. Concurrent outbounds for the same contact chain via `Promise.all` so an inbound waits for ALL in-flight outbounds, not just the latest. Stuck locks self-clear on 60s timeout to prevent recurring delays.

**Wrapped flows** (any change must preserve these): `generateAndSendOpener`, `generateAndSendAiReply`, `sendScanVisibilityMessage`, `handleConfirmationReply`, `handleRetryName` (all in server.js); `sendHook1Static`, `sendFollowUp` (followups.js).

## Outbound Message Markers (`exchange.type`)

Every outbound message stamps `exchange.type` so dedup checks survive a server restart. Persistence runs through `conversations.addExchange` → in-memory cache, → `_dbInsertExchange` (writes into `exchanges.extra` JSON), → `initFromDb` (restores on boot). All three layers must continue to round-trip the field.

Markers in use:
- `followup-hook-pos1` — the AI opener (Hook 1). Set by `generateAndSendOpener` in server.js. Used to dedup the opener itself and as the "opener already sent" guard for the enrolled webhook.
- `silence-nudge` — the 5-min static "Hey <name>, you there?" nudge sent by `sendHook1Static` in followups.js when the prospect goes silent after the opener. Used by `processSilenceCheck` to dedup the nudge so it never fires twice. The nudge does **not** call `scheduleNext` — Hook 2 is already queued by the opener.

## Booking Flow

Four signals can flip a contact's local "stop talking to them" flag — but only confirmed-calendar signals count for dashboard stats. The `contacts.paused_reason` column classifies *why* the AI was paused so the Pending Booking Confirmations panel can surface true verbal commits and hide rejections.

| Path | Trigger | `contacts.booked` | `paused_reason` | `brain_messages.booked` (dashboard stat) |
|------|---------|:-----------------:|:---------------:|:----------------------------------------:|
| 1. GHL appointment webhook (`/webhooks/ghl/appointment`) | Calendar appointment created in GHL | ✅ | `verbal-commit` | ✅ |
| 2. AI `[BOOKED]` marker in reply | The AI thinks the prospect agreed to a time | ✅ | `verbal-commit` | ❌ (just pauses the AI) |
| 3. AI `[DECLINED]` marker in reply | The AI fired the "Not interested" rejection handler | ✅ | `declined` | ❌ (pauses the AI as a hard stop) |
| 4. Admin manual backfill / "Confirm Booking" | User clicks the confirmation button on the dashboard | ✅ | `verbal-commit` | ✅ |

**Why split:** Path 2 is the AI's optimistic interpretation — counting it as a real booking inflates the booking-rate stat with prospects who never actually showed up on the calendar. So Path 2 only pauses the AI; it doesn't get recorded in `brain_messages.booked`. Path 3 (`[DECLINED]`) is the same idea in reverse: pause the AI on a clean rejection without polluting the verbal-commit panel.

**Source of truth for stats:** All dashboard booking metrics MUST read from `brain_messages.booked` (via `brain.getStats()` for totals or `brain.getBookedContactIds()` for per-variant counting), NEVER from `contacts.booked`. The variant performance endpoint at `/api/brain/variants` was the last reader of `contacts.booked` for stat purposes — it now uses `brain.getBookedContactIds()`.

**Pending Booking Confirmations panel** (`/api/admin/awaiting-confirmation`): surfaces contacts with `booked=true` AND no `brain_messages.booked` row AND `paused_reason !== 'declined'`. Each row has two actions: **Confirm Booking** (calls `brain.recordBooking()` + flips `paused_reason` → `verbal-commit`, counts toward stats) and **Not a booking** (calls `/api/admin/dismiss-booking` to flip `paused_reason` → `declined`, removes the row without counting). Legacy rows (`paused_reason=NULL`) are treated as `verbal-commit` for back-compat.

**Hallucination guard** (`server.js _wasLastOutboundRejection`): if Claude emits `[BOOKED]` after a prior rejection (either `paused_reason='declined'` already set, or the most recent outbound contained the rejection signature `text me if anything changes`), the bogus reply is discarded — the marker is stripped, `paused_reason` stays `declined`, and nothing is sent. This is the safety net for the prompt-level "AFTER A DECLINE — CONVERSATION IS OVER" rules in every variant.

**Idempotency:** All four paths early-exit if the contact is already `booked`, so paths firing in any order (or all four for the same contact) won't double-count.

## Lead Form Segmentation
Contacts are bucketed by their Facebook lead form via the GHL tag `ampifyform:<slug>` (e.g. `ampifyform:high-volume`, `ampifyform:high-intent`, `ampifyform:high-intent-2FA`). The slug is lowercased and stored on `contacts.lead_form`; missing tags default to `unknown`. The value is re-derived on every `ContactUpdate` webhook and snapshotted onto each outbound `brain_messages.lead_form` so historical analytics stay accurate even if tags change. The admin dashboard's Performance panel and Prompt Editor both surface per-form breakdowns and let you filter A/B/C/D variant performance by lead form. Measurement only — script selection is unaffected.

## Database
PostgreSQL (Neon). The deployed app uses `DATABASE_URL`. The local workspace gets its own empty Replit-provided database by default; in dev mode (with `PROD_DATABASE_URL` set) the local server is routed to the live production DB instead. Tables include: `contacts` (with `lead_form`), `brain_messages` (with `lead_form` snapshot), `winning_patterns`, `funnel_snapshots`, `followup_jobs`, `ai_prompts`, `exchanges`, `optouts`.

## Key Environment Variables
- `ADMIN_KEY` — protects all `/admin/*` routes and API endpoints
- `GHL_API_KEY` — GHL API access
- `GHL_LOCATION_ID` — GHL location identifier
- `GHL_WEBHOOK_SECRET` — (optional) validates incoming GHL webhook signatures
- `ANTHROPIC_API_KEY` — Claude API access
- `DATABASE_URL` — PostgreSQL connection string
- `DEV_MODE` — set to `true` locally only to enable safe dev mode
