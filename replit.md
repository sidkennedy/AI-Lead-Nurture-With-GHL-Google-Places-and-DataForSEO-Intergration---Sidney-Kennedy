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

### 3. The user republishes manually — file/code changes are NOT live in prod until they confirm
Two things to keep straight when reporting status to the user:
- **DB writes** (anything written to the prod Neon database via `PROD_DATABASE_URL`) — these are live in prod **immediately**. Admin UI shows them on next refresh.
- **File/code changes** (edits to `.js`, `.json`, `.md`, etc. in this workspace) — these only ship to prod when the user clicks Publish. Until then, prod runs the previously-deployed code.

When telling the user something is "done" or "live", be explicit about which: "the DB is updated now; the file change ships on your next deploy" — never just "this is live now". This prevents the user from thinking a code-path change has reached prod when it hasn't.

### 4. Source of truth for prompt content is the prod DB `ai_prompts` table — not the file
`data/prompts.json` is a mirror, not a source. The boot logic in `prompts.js` (`syncFromDb`) is "DB wins": on every server start, the file gets overwritten with whatever is in `ai_prompts`. So:
- **Read order:** trust the DB first. If the file disagrees with the DB, the DB is right.
- **Write order:** when you change a prompt, write to BOTH places (file + DB) in the same operation. Use the canonical pool snippet from the wrong-DB section above against `PROD_DATABASE_URL`. The pattern `INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value=$2, updated_at=$3` is what `prompts.js syncToDb` uses — copy it.
- If you only edit the file, your change is alive only until the next server restart, then it gets erased by the DB content.
- If you only edit the DB, the file in git stays stale — the next person reading the repo sees old content, and a future deploy of an empty DB would re-seed the wrong text.

The admin UI's "Save" button on the Prompt Editor already does both correctly (`POST /admin/prompts/:name` writes to file AND calls `syncToDb`). Match that pattern in any one-off script.

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
