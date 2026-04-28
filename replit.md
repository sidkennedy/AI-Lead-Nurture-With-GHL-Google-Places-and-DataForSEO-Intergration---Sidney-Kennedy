# Powered Up AI — Project Notes

## What This Is

GHL-integrated AI sales assistant for audiology practices. Node/Express backend, PostgreSQL database, Claude (claude-sonnet) for AI, GHL webhooks for contact management.

Admin dashboard lives at `/admin?key=YOUR_ADMIN_KEY`.

---

## ⚠️ AGENT: HOW TO MAINTAIN THIS FILE ⚠️

This file is loaded into memory at the start of every conversation. It is the primary mechanism for not repeating mistakes. Follow these rules without being prompted:

1. **After fixing any bug that was not immediately obvious — document it here before closing the task.** Not after the second occurrence. The first. If you had to investigate, test, or iterate more than once to find the cause, it belongs here.

2. **Write the trap entry at the pattern level, not the symptom level.** "Admin dashboard showed Loading forever" is a symptom. "Writing `\'` inside a single-quoted string inside an outer backtick template silently drops the backslash, breaking the entire script" is the trap. Future you needs the root cause, not the surface behavior.

3. **Include the fix pattern alongside the trap.** State what broke, why it broke, and the exact pattern that prevents recurrence. A trap entry without a fix is incomplete.

4. **Do not wait for the user to ask.** The user should never have to say "update the replit.md" — that means the trap was left undocumented. If you find yourself thinking "I should probably document this later", do it now.

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

**Same trap, different shape — `\'` inside a single-quoted string inside an outer backtick template gets eaten:** In a JS template literal (backtick), `\'` is a "useless escape" that the parser silently consumes to produce just `'`. So writing `'<button onclick=\'foo()\'>'` inside the admin page template renders as `'<button onclick='foo()'>'` in the browser, which the browser JS parser sees as the string `'<button onclick='`, then bare identifier `foo` → SyntaxError, the entire admin script fails to parse, and EVERY panel shows "Loading…" forever (no fetch ever fires, no timeout ever triggers, no error is ever caught — because no JS runs at all). This bug crashed the whole admin dashboard on 2026-04-26 in two places (Saved Issues edit/toggle/delete buttons and the replay-search dropdown's `onmouseover='rgba(...)'`). **Hard rule:** never write `\'` inside any string that lives inside the outer page backtick template. Use HTML entities instead — `&#39;` in HTML attributes (the browser decodes it back to `'` when parsing the attribute), e.g. `'<button onclick="foo(&#39;' + id + '&#39;)">'`. **Verification:** after editing admin script strings, run `node -e "const h=require('fs').readFileSync('/tmp/x.html','utf8');const m=h.match(/<script[^>]*>([\s\S]*?)<\/script>/);try{new Function(m[1]);console.log('OK')}catch(e){console.log(e.message)}"` against the rendered `/admin` HTML to catch parse errors before the user sees them.

### 3. Admin dashboard "Loading forever" after a fresh publish — always use fetchWithTimeout
Every data-loading function in the admin dashboard (`loadBrain`, `loadFollowups`, `loadSpend`, `loadIssues`) wraps its fetch calls in `fetchWithTimeout(url, opts, ms)` (defined near the top of the admin `<script>` block). Without a timeout, if the production server is still cold-starting when the admin page first loads, fetch calls hang indefinitely and spinners never clear. The wrapper uses `AbortController` and defaults to 15 seconds; on abort it throws `"Request timed out — server may still be starting. Refresh to retry."` which the catch blocks surface in the UI. **Any new `fetch(...)` call added to a load function must use `fetchWithTimeout(...)` instead.** This recurred twice before the fix was in place (Apr 26).

### 4. The user republishes manually — file/code changes are NOT live in prod until they confirm
Two things to keep straight when reporting status to the user:
- **DB writes** (anything written to the prod Neon database via `PROD_DATABASE_URL`) — these are live in prod **immediately**. Admin UI shows them on next refresh.
- **File/code changes** (edits to `.js`, `.json`, `.md`, etc. in this workspace) — these only ship to prod when the user clicks Publish. Until then, prod runs the previously-deployed code.

When telling the user something is "done" or "live", be explicit about which: "the DB is updated now; the file change ships on your next deploy" — never just "this is live now". This prevents the user from thinking a code-path change has reached prod when it hasn't.

### 5. GHL webhook misses — AI goes silent after a prospect reply
GHL occasionally fails to deliver the inbound webhook to the server, even when the prospect's reply is visible in the GHL UI. The symptom: the prospect sent a message (e.g. "Go"), you can see it in GHL, but the DB has no inbound exchange record for that contact and the AI never responded. Confirmed cases: Yung Tommy Walker (Apr 26 08:01 "I'm sorry"), Lester Herbertson (Apr 26 09:21 "Go").

**Long-term fix (built Apr 26 2026):** `reconciliation.js` polls GHL every 30 seconds for active contacts and replays any missed inbound through `handleInbound`. See trap #9 for the architecture, dedup story, and tuning knobs. The webhook is still primary; the poller is a safety net that should typically catch zero or one message per day.

**Manual fallback:** Admin dashboard → "Missed Reply Trigger" section → search the contact name → type exactly what they sent → hit Trigger AI Response. The AI responds immediately. Before triggering, check whether the conversation has moved on manually — if a human has already taken over and sent subsequent messages, do NOT trigger (it would send an out-of-context AI reply).

**Saved Issues panel:** Added Apr 26. Lives at the bottom of the admin dashboard. Stores bugs/patterns you want to revisit later without fixing immediately — title, problem description, solution/next-step notes, optional contact reference, open/done status. The GHL webhook-miss issue is pre-seeded there. Use it whenever something weird happens and you are not ready to fix it yet — saves re-investigation cost next time.

### 6. Prompt file/DB sync — auto-heal landed 2026-04-27, but the trap shape is permanent
**Symptom that keeps biting:** "I edited `data/prompts.json` (or it changed via git/deploy), redeployed, AI on production is STILL using the old prompt content." Bit the project at least 3 times. Most recently caused live SMS to keep saying "want to get that in the calendar?" / "Locked in. I'll send the calendar invite. [BOOKED]" after the VSL flow overhaul commits `d842968` and `486e02e` were deployed.

**Root cause:** Prompts live in two places — `data/prompts.json` (read by `prompts.get()` on every call, no in-memory cache) and the `ai_prompts` table (durable across deploys). The original `syncFromDb` was hardcoded "DB wins": at boot it would unconditionally overwrite the file with DB content. So a fresh deploy that shipped new file content would have that content **erased** by stale DB rows from a previous UI edit (or from before a prompt change was committed), and the AI would silently keep using the old script forever.

**Auto-heal (2026-04-27, `prompts.js syncFromDb`):** The boot now compares `fs.statSync(FILE).mtimeMs` against `MAX(ai_prompts.updated_at)` (with a 5-second slop) and lets the **newer side win**:
- Fresh deploy → file mtime = checkout time, > DB updated_at → **file → DB push** (the new content survives).
- Admin UI prompt save → DB updated_at = now, file untouched on prod fs → **DB → file pull** (UI edits persist across restarts).
- Boot logs `[Prompts] File is newer than DB ... pushed N prompt(s) FILE → DB (auto-heal of trap #6)` or `[Prompts] DB is newer than file ... pulled N prompt(s) DB → FILE` so the direction is always visible. **Watch for these on every prod boot.**

**Manual escape hatch:** If the auto-heal doesn't fire (e.g. mtime got clobbered, or you want to force file-wins regardless), run `npm run prompts:push` (= `node scripts/prompts-sync-file-to-db.js`). It UPSERTs every `conversationPrompt*` / `followup.*` / `email.*` key from the file into prod `ai_prompts` with `updated_at = now`, then tells you to restart prod so the next `syncFromDb` pulls the corrected DB into the prod file.

**Recovery checklist when this bites again:**
1. `node -e "..."` query `SELECT name, LENGTH(value), updated_at FROM ai_prompts ORDER BY name` — does the DB length match `data/prompts.json` length? If not, divergence confirmed.
2. Check the boot log for the `[Prompts] File is newer / DB is newer` line — what direction did the auto-heal pick? If "DB → file" but you expected the opposite, force it with `npm run prompts:push` then restart prod.
3. After restart, the boot log should show `[Prompts] DB sync complete — N prompt(s) already up to date`. If not, divergence is still present.

**Write order for one-off scripts:** when you change a prompt programmatically, write to BOTH places in the same operation. The canonical UPSERT is `INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value=$2, updated_at=$3`. The admin UI's "Save" on `POST /admin/prompts/:name` already does this correctly via `set()` (file) + `syncToDb` (DB) — match that pattern.

### 7. When you renumber steps in a prompt variant, cross-references break silently
The variant prompts are full of internal step references — RULES section ("EXCEPT the Step N bridge"), MAPS CONFIRMATION LOOP ("after the [PRACTICE_DETECTED] bridge in Step N"), EARLY BOOKING ("skip directly to Step N"), LIVE DATA ("use the real numbers in Step N"), NEVER REPEAT A QUESTION (which questions belong to which step), and the [STEP:N] valid-range note in RULES ("integer 1-N"). When you change the numbering of any step, **every one** of those references must be updated in the same edit pass. The Apr 26 Variant B renumber (8 steps → 7) missed the RULES line "EXCEPT the Step 6 bridge" — that contradiction made the bridge non-deterministic until hotfixed. Audit checklist before saving a renumber: search the prompt text for every `Step \d` occurrence and reconcile each one against the new numbering, then re-confirm the [STEP:N] integer range cap matches the highest step number.

### 9. Webhook reconciliation poller — architecture and tuning (`reconciliation.js`)
A background `setInterval(runReconciliation, 30_000)` started at server boot (skipped in DEV_MODE) that catches inbound webhook misses. It is a safety net, not the primary path — the GHL webhook is still the fast path. Live admin panel: "Webhook Reconciliation Poller" subpanel under Followups.

**Dedup mechanism (the linchpin):** every inbound exchange now stores the GHL `messageId` in `exchanges.message_id`. There are TWO layers, and you need both — the first layer alone is not sufficient because of the race window between check and act:

1. **Cheap fast-path check** at the top of `handleInbound` (`conversations.hasExchangeWithMessageId`). Catches the common case where the poller fires after the webhook already finished.
2. **Atomic claim** at "step 3" of `handleInbound` via `conversations.tryClaimInbound`, backed by a partial unique index `exchanges_message_id_unique ON exchanges(message_id) WHERE message_id IS NOT NULL` and `INSERT ... ON CONFLICT DO NOTHING`. This is the authoritative single-winner gate — if rowCount comes back 0, we lost the race and `handleInbound` returns BEFORE calling Claude. The cheap check alone is not enough because both webhook and poller can pass it before either has inserted (window: ~200-500ms while GHL fetchContact runs).

The column already existed in the DB before this build; we just started populating it (`addExchange` previously stripped `messageId` before calling `_dbInsertExchange` — that bug meant every inbound row had `message_id = null`, breaking the entire dedup story). Existing 336 rows still have NULL message_id, which the partial index allows. Outbound messageIds are intentionally NOT captured — the poller only needs inbound IDs for dedup, and updating every outbound `addExchange` call site was out of scope.

**Why TWO functions (`addExchange` + `tryClaimInbound`):** `addExchange` is synchronous and fire-and-forget (called from ~13 outbound paths that don't care about race outcomes — outbound messageId is always null, ON CONFLICT never fires for them). `tryClaimInbound` is async and returns boolean — used by `handleInbound` only, where we MUST know if we won the race so Claude is gated correctly. Don't merge them; the two semantics matter.

**Per-cycle flow:** select candidates (contacts with `lastMessageAt` in last 24h, not booked, no `pausedReason`, not opt'd out, no "disable ai" tag) → resolve conversationId (prefer one stored in recent exchanges; fall back to `ghl.getOrCreateConversation(contactId)` cached in-memory for legacy contacts whose exchanges all carry `conversationId=null`) → for each, `ghl.fetchMessages(conversationId, 20)` → filter to inbounds in the last 60 min that we don't already have by messageId → safety check `_hasLaterOutbound` (skip if a human/AI already replied) → final `optouts.isOptedOut` re-check → call `handleInbound`. Each cycle skips itself if the previous one is still running (`_running` guard) so a slow GHL response can never queue up parallel cycles.

**Carson regression (Apr 27 2026) — opener stored conversationId=null trap:** Live contact `sYVGEfUpY5GMHJYa7odh` (Carson, variant C) replied "Costco" 1 min after the opener. The webhook was lost (or never sent by GHL — root cause unconfirmed, GHL webhook delivery is best-effort), and the poller was supposed to recover it within 30s but did NOT. Root cause: the opener's `addExchange` call hardcoded `conversationId: null` instead of resolving via `ghl.getOrCreateConversation`. With every Carson exchange carrying `conversationId=null`, `_selectCandidates` skipped him entirely on every cycle (line 130's `if (!conversationId) continue`). The 5-min silence-check fired on schedule because it doesn't depend on inbound delivery — so the contact got "Hey Carson, you there?" while his real reply sat lost in GHL's UI. **Two-pronged fix:** (1) opener now awaits `ghl.getOrCreateConversation` after the SMS send and stores the result in the exchange's `extra.conversationId` so all future contacts have it from message #1 (`server.js` ~line 588–599). (2) `_selectCandidates` falls back to `ghl.getOrCreateConversation(contactId)` when no exchange carries one, with a process-lifetime `Map` cache so legacy contacts cost exactly one GHL lookup ever (`reconciliation.js` ~line 139–158). (3) `POLL_WINDOW_MS` widened from 10→60 min to give dropped webhooks a longer recovery window — at typical engagement velocity, a 60-min-old reply is still actionable. **Symptom to watch for:** `[Reconciliation]` cycle log activity but a specific recent contact is silently never picked up — query their exchange rows for `extra->>'conversationId' IS NULL` to confirm.

**DEV_MODE behavior:** the scheduler does NOT start. A would-have-replayed line is still logged so local dev can see what the poller would do, but it never calls `handleInbound` (which would fire real SMS via the prod GHL account, since `DATABASE_URL` is routed to `PROD_DATABASE_URL` in dev).

**Tuning knobs (top of `reconciliation.js`):** `POLL_WINDOW_MS` (60 min — widened from 10 after the Carson regression so dropped webhooks have a meaningful recovery window; raise further if you ever observe replays cut off because a prospect took >1h to reply during a webhook outage), `ACTIVE_WINDOW_MS` (24h — only poll recently-active contacts), `MAX_REPLAYS_LOG` (50 — admin panel ring buffer), `PER_CONTACT_FETCH_LIMIT` (20 messages per GHL fetch). At ~74 active contacts the cycle is roughly 2-3 GHL req/sec, well under GHL's per-location rate limit. If the active set grows to >300, consider batching or extending the cycle to 60s.

**Circular require resolution:** `reconciliation.js` needs `handleInbound` (defined in `server.js`); `server.js` needs `reconciliation` to start the scheduler. Solved by `reconciliation.setHandleInbound(handleInbound)` called from inside `app.listen` callback after `handleInbound` has been defined. Don't `require('./server')` from `reconciliation.js` — it will deadlock the module loader.

**What "working" looks like:** the admin panel shows "Last run: <recent>", cycle count climbs every 30s, replay count usually stays at 0 or low single digits per day. A spike means GHL webhook delivery degraded — investigate before assuming the poller is "doing its job" as the new normal.

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

### 10. Duplicate-opener regression — three independent bugs in the message-history pipeline (fixed Apr 28, 2026)
**Symptom that recurred at least twice in production:** A prospect gets the AI opener, replies "GO" (or any short affirmative), and ~6 seconds later receives the **exact same opener again**. Confirmed cases: `TI5l9x1lezhZcTxGaFVm` (variant A, "New Mountain Outfitters") at 9:04/9:05 PDT — prospect texted STOP after the dupe, lost lead. `dPr5UoTRyB66NMsKZj08` (variant C, "Kate") at 9:13 PDT via a different trigger path. The defensive duplicate-outbound guard at `server.js:~1252` (which retries Claude with a corrective nudge) DID fire but produced the same opener on retry — because the underlying message context was starved.

**Root cause is THREE independent bugs stacking — fix any one of them and the regression goes away, but defense in depth means fixing all three:**

1. **GHL TCPA suffix collides with the system-message filter.** GHL appends `\nReply STOP to unsubscribe.` to the **first** outbound of every new conversation (TCPA workflow setting). Subsequent outbounds in the same conversation do NOT get it. The old `buildMessagesFromGhl` filter at the original line 1656 dropped any message containing `/reply STOP to unsubscribe/i` as a "GHL system message" — which silently ate the bot's own opener every single time. **Fix:** removed the broad drop. Added a `TCPA_OPTOUT_SUFFIX = /[\s\.]*Reply\s+STOP\s+to\s+unsubscribe\.?\s*$/i` regex applied **outbound-only in the .map() step** to STRIP the suffix while preserving the message body. CRM-ID and "opportunity created" drops are kept (those really are GHL automation).

2. **`mergeAndNormalise` shifted off the leading assistant turn — erasing all conversational context.** Anthropic's API requires `messages` to start with `role: 'user'`. Every funnel legitimately starts with the bot's opener (assistant), so the original `while merged[0].role !== 'user' merged.shift()` removed the opener from history. With only `[user: "GO"]` left and a `CURRENT STEP: 1` system-prompt suffix, Claude rationally treated it as "begin the conversation" and re-emitted Step 1. **Fix:** replaced the shift with a synthetic prepend — `if (merged[0].role === 'assistant') merged.unshift({role:'user', content:'Begin the conversation now.'})`. The synthetic trigger mirrors the exact prompt used by `generateAndSendOpener` (`server.js:569`), so Claude sees `[user: "Begin", assistant: <opener>, user: "GO"]` and naturally advances to Step 2.

3. **`m.type === 1 / 2` was used as a direction-detection fallback — but `type` is the messageType numeric code, NOT direction.** GHL's `/conversations/messages` fetch shape uses `direction` (string `'inbound'` / `'outbound'`) and `type` (numeric: `1`=CALL, `2`=SMS, `25`=TYPE_ACTIVITY_CONTACT, `28`=TYPE_ACTIVITY_OPPORTUNITY, etc.). The fallbacks `m.direction === 1 || m.type === 1` (outbound) and `m.direction === 2 || m.type === 2` (inbound) caused **every outbound SMS** (type=2) to be mis-classified as inbound. After the .map step, `mergeAndNormalise` would then merge consecutive same-role messages into a single user blob, garbling the entire transcript Claude saw. The TCPA filter (#1) was masking this for the GHL fetch path — when the opener was filtered out, only the prospect's reply remained, accidentally producing valid input. Fixing #1 alone would have made things WORSE without fixing #3. **Fix:** removed the bogus numeric fallbacks in three places — `buildMessagesFromGhl` filter + map (`server.js:~1682, ~1703`), `recoverStateFromHistory` (`server.js:~941`), and `enrollment.js:isInbound` (~line 42). Direction is now `m.direction === 'inbound' || m.messageType === 'inbound'` everywhere.

**Bonus root cause for the Kate case:** GHL fires inbound webhooks for non-message events too — DnD toggles (`messageType: 'TYPE_ACTIVITY_CONTACT'`, body `"DnD enabled by customer"`), opportunity-stage changes, contact tag updates. These slipped through `/webhooks/ghl/inbound` (the original direction guard only checked outbound), got recorded as inbound exchanges, and triggered an AI generation. **Fix:** added a `messageType.startsWith('TYPE_ACTIVITY')` skip at the top of the webhook handler (`server.js:~384`) returning `{ skipped: 'activity-event' }`. Mirrored in `buildMessagesFromGhl` so any historical activity rows still in GHL never reach Claude either.

**Why the duplicate-detection retry didn't save us:** the retry guard at `server.js:~1252` checks `recentOutbounds[last].body` (LOCAL state) against the new draft and retries Claude with a corrective nudge. For New Mountain, local exchanges DID contain the opener — so the comparison correctly detected the duplicate. But the retry call uses the SAME message context, which (per #1+#2+#3 above) was starved of the opener. With nothing to advance from, Claude re-emitted Step 1 again. The guard's final fallback ("keep original draft — better to send a duplicate than nothing") then sent the dupe. **The structural fix above means the guard never has to fire on this scenario** — Claude sees the opener in history and produces Step 2 first try.

**Verification snippet** (run after any future change to the message-history pipeline):
```js
const { Pool } = require('pg');
const ghl = require('./ghl');
const TCPA = /[\s\.]*Reply\s+STOP\s+to\s+unsubscribe\.?\s*$/i;
// Pull the GHL fetch for any post-fix opener+GO contact and verify the
// builder produces 3+ messages with alternating roles starting [user, assistant, user, ...]
```

**Hard rules going forward:**
- **NEVER use `m.type === N` as a direction fallback in any GHL message-history parser.** `type` is messageType (a content-kind code), not direction. Direction is `m.direction` (string) or `m.messageType` (string `'inbound'`/`'outbound'`). If you find a new parser site, audit it against this rule.
- **NEVER drop a GHL message just because its body contains a TCPA opt-out phrase.** Strip the suffix; preserve the body.
- **NEVER strip a leading-assistant turn from the message history without prepending a synthetic user trigger.** The opener must remain visible to Claude as context, or Step 1 will regenerate.
- **ALWAYS filter `messageType.startsWith('TYPE_ACTIVITY')` at the inbound webhook entry.** Activity events are not prospect replies.

**Open follow-ups noted by the architect review (NOT yet queued as project tasks):** (a) write a regression-test suite for `buildMessagesFromGhl` + `mergeAndNormalise` covering the four bug shapes above (TCPA suffix, leading-assistant shift, type-vs-direction confusion, activity-event leak); (b) extract a single shared `isInboundMessage(m)` / `isOutboundMessage(m)` / `isActivityEvent(m)` helper module so the four current call sites and any future GHL parser can't re-introduce the `m.type === 2` confusion. Both should be requested as new tasks the next time the agent has a free follow-up slot.

**Off-script reply handler harness (`scripts/test-off-script-handlers.js`, added Apr 28 2026 with task #82):** Drives the playground pipeline against each variant (A/B/C/D) with one canned prospect reply per OFF-SCRIPT REPLIES handler — CURIOSITY ("Ok what is it and how do I use it"), IDENTITY ("Who is this?"), SOLUTION-SEEKING ("What's the solution?"). Asserts handler-specific fingerprints: IDENTITY must contain "Sidney from Ampify AI" + a landing-page reference; SOLUTION-SEEKING must contain a reassurance + a video tease and must NOT stack new pain ("brutal truth", "leak", "bleeding", "$X lost"); CURIOSITY must include mission-context vocabulary (database / patients / insurance / Google) and bridge into a question. Two drive modes: **direct** (default) calls Anthropic with the same variant prompt the playground would use — fast, no server needed, best for iteration; **via-server** (`OFF_VIA_SERVER=1` plus `OFF_SERVER_URL` and `ADMIN_KEY`) POSTs to the real `/admin/playground/start` and `/admin/playground/message` endpoints — this is the **authoritative regression path** before shipping a prompt change because it also exercises `_buildPlaygroundSystemPrompt` (winning-pattern injection, etc.), marker extraction, and the session state machine. Run with `npm run test:off-script` (full 12-case suite). Filter with `OFF_VARIANT=B` or `OFF_HANDLER=IDENTITY`; tune parallelism with `OFF_BATCH=N`. Reports + JSON dumps land in `.local/sim-out/off-script-*.{md,json}`. Exit code is 1 on any failure. The harness can also be triggered from the admin panel via `POST /admin/test-off-script` (JSON body accepts optional `variant`/`handler`/`batch` filters and a `mode` of `direct` or `via-server`); poll `GET /admin/test-off-script/:jobId` for status. When `mode: "via-server"` is requested the endpoint sets `OFF_VIA_SERVER=1` and points the harness at this same listener (so the panel can run the authoritative pipeline without env preconfig); the chosen mode is echoed in both the launch response and the status payload so operators can never confuse direct vs via-server runs. The status response includes the latest report markdown and parsed JSON (per-job basename — concurrent jobs cannot return each other's reports) so a UI can render the full transcript without re-running the suite. Both endpoints require the standard admin key. Initial baseline run (Apr 28 2026, direct mode): A 3/3, B 2/3 (SOLUTION-SEEKING dropped video tease), C 3/3, D 2/3 (SOLUTION-SEEKING dropped video tease) — variants B/D need a follow-up to tighten that handler.

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
