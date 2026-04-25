# Powered Up AI — Project Notes

## What This Is

GHL-integrated AI sales assistant for audiology practices. Node/Express backend, PostgreSQL database, Claude (claude-sonnet) for AI, GHL webhooks for contact management.

Admin dashboard lives at `/admin?key=YOUR_ADMIN_KEY`.

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

Three signals can flip a contact's local "stop talking to them" flag — but only confirmed-calendar signals count for dashboard stats.

| Path | Trigger | `contacts.booked` | `brain_messages.booked` (dashboard stat) |
|------|---------|:-----------------:|:----------------------------------------:|
| 1. GHL appointment webhook (`/webhooks/ghl/appointment`) | Calendar appointment created in GHL | ✅ | ✅ |
| 2. AI `[BOOKED]` marker in reply | The AI thinks the prospect agreed to a time | ✅ | ❌ (just pauses the AI) |
| 3. Admin manual backfill | User clicks "mark as booked" | ✅ | ✅ |

**Why split:** Path 2 is the AI's optimistic interpretation — counting it as a real booking inflates the booking-rate stat with prospects who never actually showed up on the calendar. So Path 2 only pauses the AI; it doesn't get recorded in `brain_messages.booked`.

**Source of truth for stats:** All dashboard booking metrics MUST read from `brain_messages.booked` (via `brain.getStats()` for totals or `brain.getBookedContactIds()` for per-variant counting), NEVER from `contacts.booked`. The variant performance endpoint at `/api/brain/variants` was the last reader of `contacts.booked` for stat purposes — it now uses `brain.getBookedContactIds()`.

**Idempotency:** All three paths early-exit if the contact is already `booked`, so paths firing in any order (or all three for the same contact) won't double-count.

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
