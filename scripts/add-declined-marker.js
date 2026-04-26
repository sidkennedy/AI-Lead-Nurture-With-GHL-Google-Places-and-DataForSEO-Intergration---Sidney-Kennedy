#!/usr/bin/env node
// One-shot: prevent the AI from following a "Not interested" rejection with
// a hallucinated [BOOKED] (the "Saeed bug").
//
// Two changes per conversationPrompt variant (A, B, C, D, legacy):
//   1. Append " [DECLINED]" to the "Not interested:" objection handler so the
//      server can detect the decline and pause the contact properly.
//   2. Insert an "AFTER A DECLINE — CONVERSATION IS OVER" rule block right
//      after the OBJECTIONS section so Claude treats the rejection as a
//      hard stop (no [BOOKED] follow-up, no step advancement).
//
// Plus a one-time backfill: mark Saeed (PwRWftZkhWkcDiJkyrOZ) as declined
// so he disappears from Pending Booking Confirmations on the dashboard.
//
// Idempotent — sentinel substrings prevent double-edits. Safe to re-run.
//
// Sources of truth touched:
//   • data/prompts.json  — local cache used at boot if DB lookup fails
//   • ai_prompts table   — durable source of truth (DEV_MODE → PROD DB)
//   • contacts table     — Saeed paused_reason backfill

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PROMPTS_PATH = path.join(__dirname, '..', 'data', 'prompts.json');
const VARIANT_KEYS = [
  'conversationPrompt',       // legacy
  'conversationPrompt.A',
  'conversationPrompt.B',
  'conversationPrompt.C',
  'conversationPrompt.D'
];

const SENTINEL_DECLINED_MARKER = 'text me if anything changes." [DECLINED]';
const SENTINEL_DECLINE_RULES   = 'AFTER A DECLINE — CONVERSATION IS OVER';

const REJECTION_RULES_BLOCK = `

━━━ AFTER A DECLINE — CONVERSATION IS OVER ━━━
The instant you send the "Not interested" rejection handler with [DECLINED], the conversation is TERMINATED. If the prospect replies with anything afterward — "ok", "thanks", "k", "no problem", "👍", "sounds good", silence-breakers, even a vague "maybe later" — you do NOT generate any reply. Specifically:
- NEVER follow a [DECLINED] with [BOOKED]. Their last clear stated intent was no.
- NEVER treat a single-word reply ("ok", "thanks") after a decline as a booking confirmation.
- NEVER say "Locked in.", "I'll send the calendar invite.", "Sid will be in touch", or any Step 5/6 language.
- Do NOT advance steps past the rejection handler under any circumstance.
The "ALWAYS ADVANCE" / step-progression rules elsewhere in this prompt do NOT apply once [DECLINED] has fired. A decline is a hard stop.`;

// Patterns we will rewrite. Variant A uses {{contact.first_name}}; the others
// use [first name]. Both shapes get covered by the regex.
const REJECTION_RE = /(- Not interested: "No worries (?:\[first name\]|\{\{contact\.first_name\}\}) — text me if anything changes\.")(?!\s*\[DECLINED\])/g;

function patchPrompt(text, label) {
  if (!text || typeof text !== 'string') return { text, changed: false, notes: ['empty'] };
  const notes = [];
  let out = text;

  // 1) Append [DECLINED] to the rejection objection (idempotent).
  if (out.includes(SENTINEL_DECLINED_MARKER)) {
    notes.push('rejection marker already present');
  } else {
    const before = out;
    out = out.replace(REJECTION_RE, '$1 [DECLINED]');
    if (out === before) {
      notes.push('WARNING: rejection line not found — skipped marker append');
    } else {
      notes.push('appended [DECLINED] to rejection line');
    }
  }

  // 2) Insert the AFTER A DECLINE block after the "Is this a bot?" line
  //    (which is the last line of the OBJECTIONS section across all variants).
  if (out.includes(SENTINEL_DECLINE_RULES)) {
    notes.push('decline rules block already present');
  } else {
    // Match the WHOLE bot-objection line up to (but not including) its newline.
    // Variants differ in the bot reply (some append "Tomorrow morning?", some
    // don't), so we capture the entire line to anchor reliably across all
    // five variants.
    const anchorRe = /(- Is this a bot\?:[^\n]*)/;
    const before = out;
    out = out.replace(anchorRe, `$1${REJECTION_RULES_BLOCK}`);
    if (out === before) {
      notes.push('WARNING: bot anchor not found — skipped rules block insert');
    } else {
      notes.push('inserted AFTER A DECLINE rules block');
    }
  }

  return { text: out, changed: out !== text, notes };
}

(async () => {
  const dbUrl = process.env.DEV_MODE === 'true' || process.env.DEV_MODE === '1'
    ? (process.env.PROD_DATABASE_URL || process.env.DATABASE_URL)
    : process.env.DATABASE_URL;
  if (!dbUrl) { console.error('No DB URL available'); process.exit(1); }

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('neon.tech') ? { rejectUnauthorized: false } : false
  });

  // ── 1. Update local data/prompts.json (mirror what the DB will hold) ──
  const data = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));
  let jsonChanged = false;
  for (const key of VARIANT_KEYS) {
    if (typeof data[key] !== 'string') {
      console.log(`[json] ${key}: not present, skipped`);
      continue;
    }
    const { text, changed, notes } = patchPrompt(data[key], key);
    console.log(`[json] ${key}: ${notes.join('; ')}`);
    if (changed) {
      data[key] = text;
      jsonChanged = true;
    }
  }
  if (jsonChanged) {
    fs.writeFileSync(PROMPTS_PATH, JSON.stringify(data, null, 2));
    console.log('[json] data/prompts.json saved');
  } else {
    console.log('[json] no changes to data/prompts.json');
  }

  // ── 2. Update DB ai_prompts (durable source of truth) ──
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ai_prompts (
       name TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at BIGINT NOT NULL
     )`
  );
  const { rows } = await pool.query(
    'SELECT name, value FROM ai_prompts WHERE name = ANY($1)',
    [VARIANT_KEYS]
  );
  const dbMap = Object.fromEntries(rows.map(r => [r.name, r.value]));
  for (const key of VARIANT_KEYS) {
    const current = dbMap[key];
    if (typeof current !== 'string') {
      console.log(`[db]   ${key}: not in DB, skipped (will seed from defaults on next boot)`);
      continue;
    }
    const { text, changed, notes } = patchPrompt(current, key);
    console.log(`[db]   ${key}: ${notes.join('; ')}`);
    if (changed) {
      await pool.query(
        'UPDATE ai_prompts SET value = $1, updated_at = $2 WHERE name = $3',
        [text, Date.now(), key]
      );
      console.log(`[db]   ${key}: UPDATE committed`);
    }
  }

  // ── 3. Backfill Saeed ──
  await pool.query(
    `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS paused_reason TEXT`
  ).catch(() => {});
  const SAEED_ID = 'PwRWftZkhWkcDiJkyrOZ';
  const { rows: saeedRows } = await pool.query(
    'SELECT contact_id, first_name, booked, paused_reason FROM contacts WHERE contact_id = $1',
    [SAEED_ID]
  );
  if (saeedRows.length === 0) {
    console.log(`[backfill] Saeed (${SAEED_ID}) not found — skipped`);
  } else {
    const r = saeedRows[0];
    console.log(`[backfill] Saeed: booked=${r.booked} paused_reason=${r.paused_reason || 'NULL'}`);
    if (r.paused_reason === 'declined') {
      console.log('[backfill] already set to declined — no-op');
    } else {
      await pool.query(
        'UPDATE contacts SET paused_reason = $1 WHERE contact_id = $2',
        ['declined', SAEED_ID]
      );
      console.log('[backfill] Saeed paused_reason set to declined');
    }
  }

  await pool.end();
  console.log('Done.');
})().catch(err => { console.error(err); process.exit(1); });
