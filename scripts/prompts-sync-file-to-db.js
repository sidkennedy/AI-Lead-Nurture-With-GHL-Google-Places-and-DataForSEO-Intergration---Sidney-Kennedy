#!/usr/bin/env node
/**
 * prompts-sync-file-to-db.js — Manual one-shot push of data/prompts.json into
 * the prod ai_prompts table. Use this when the smart syncFromDb auto-heal in
 * prompts.js didn't fire (e.g. file mtime got clobbered, or you want to force
 * the file to win regardless of timestamps).
 *
 * Symptom that means you need this:
 *   "I edited data/prompts.json, deployed, restarted prod, and the AI is still
 *    using the OLD prompt content."
 *
 * What it does:
 *   - Reads data/prompts.json
 *   - For every key starting with `conversationPrompt`, `followup.`, or
 *     `email.`, UPSERTs the file value into ai_prompts with updated_at = now.
 *   - Prints a before/after length report so you can confirm the push.
 *
 * Run: node scripts/prompts-sync-file-to-db.js
 *
 * Then: restart prod so the next syncFromDb pulls the freshly-written DB
 * content into the prod file. (After restart you should see
 * "[Prompts] DB sync complete — N prompt(s) already up to date" in the logs.)
 *
 * Background: replit.md trap #6 — file/DB divergence has bitten this project
 * multiple times. The boot-time mtime auto-heal added 2026-04-27 should
 * prevent it going forward, but this script is the manual escape hatch.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

const FILE = path.join(__dirname, '..', 'data', 'prompts.json');
const DSN = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;

if (!DSN) {
  console.error('No PROD_DATABASE_URL or DATABASE_URL in env. Aborting.');
  process.exit(1);
}

(async () => {
  const file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const c = new Client({ connectionString: DSN, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const keys = Object.keys(file).filter(
    k => (k.startsWith('conversationPrompt') || k.startsWith('followup.') || k.startsWith('email.'))
         && typeof file[k] === 'string'
  );

  console.log(`Pushing ${keys.length} prompt key(s) FILE → DB:\n`);

  let pushed = 0;
  let unchanged = 0;
  for (const k of keys) {
    const v = file[k];
    const before = await c.query('SELECT LENGTH(value) AS len, value FROM ai_prompts WHERE name=$1', [k]);
    const beforeLen = before.rows[0]?.len ?? '(missing)';
    const beforeVal = before.rows[0]?.value;

    if (beforeVal === v) {
      console.log(`  ${k.padEnd(35)} len:${String(beforeLen).padStart(6)}  (unchanged, skip)`);
      unchanged++;
      continue;
    }

    await c.query(
      'INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value=$2, updated_at=$3',
      [k, v, Date.now()]
    );
    console.log(`  ${k.padEnd(35)} ${String(beforeLen).padStart(6)} → ${String(v.length).padStart(6)}  (pushed)`);
    pushed++;
  }

  console.log(`\nDone. ${pushed} pushed, ${unchanged} already in sync.`);
  console.log(`Now restart your prod app so the next boot pulls the new DB content into the prod file.`);
  await c.end();
})().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
