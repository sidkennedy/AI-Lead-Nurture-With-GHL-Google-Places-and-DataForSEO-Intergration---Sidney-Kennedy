#!/usr/bin/env node
/**
 * enroll-existing-leads.js
 *
 * One-time script to enroll existing GHL contacts (tagged "amplify") into
 * the follow-up sequence based on their conversation history.
 *
 * Usage:
 *   node scripts/enroll-existing-leads.js              ← dry-run (safe, no writes)
 *   node scripts/enroll-existing-leads.js --execute    ← actually enrolls contacts
 *   node scripts/enroll-existing-leads.js --tag "amplify" --execute --delay 3000
 *
 * Flags:
 *   --tag <name>      GHL tag to filter by (default: "amplify")
 *   --execute         Write to the database and schedule jobs
 *   --delay <ms>      Pause between contacts in execute mode (default: 2000ms)
 */

'use strict';

const path = require('path');

// Load .env for local CLI runs
try {
  const fs  = require('fs');
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m && process.env[m[1].trim()] === undefined) {
      process.env[m[1].trim()] = m[2].trim();
    }
  }
} catch {}

// ─── Parse CLI args ────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');
const TAG     = (() => {
  const i = args.indexOf('--tag');
  return i !== -1 && args[i + 1] ? args[i + 1] : 'amplify';
})();
const DELAY_MS = (() => {
  const i = args.indexOf('--delay');
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : 2000;
})();

const { runEnrollment } = require(path.join(__dirname, '..', 'enrollment'));

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Amplify Lead Enrollment Script');
  console.log(`  Mode:  ${DRY_RUN ? '🔍 DRY RUN (no writes)' : '🚀 EXECUTE'}`);
  console.log(`  Tag:   "${TAG}"`);
  console.log(`  Delay: ${DELAY_MS}ms between contacts`);
  console.log('══════════════════════════════════════════════════════\n');

  if (!DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY not set — Claude analysis will be skipped for mid-conversation leads.\n');
  }

  const { stats, rows } = await runEnrollment({ tag: TAG, dryRun: DRY_RUN, delayMs: DELAY_MS });

  // ─── Print results table ─────────────────────────────────────────────────────
  const W = 100;
  console.log('\n' + '─'.repeat(W));
  console.log(
    'Name'.padEnd(20) +
    'Phone'.padEnd(18) +
    'City'.padEnd(16) +
    'Action'.padEnd(10) +
    'Pos'.padEnd(5) +
    'Step'.padEnd(6) +
    'Reason'
  );
  console.log('─'.repeat(W));

  for (const r of rows) {
    const symbol = r.action === 'ENROLL' ? '✓' : r.action === 'SKIP' ? '–' : '✗';
    console.log(
      `${symbol} ${r.firstName}`.padEnd(20) +
      r.phone.padEnd(18) +
      (r.city || '—').padEnd(16) +
      r.action.padEnd(10) +
      (r.position != null ? String(r.position) : '—').padEnd(5) +
      (r.step     != null ? String(r.step)     : '—').padEnd(6) +
      (r.reason || '')
    );
  }

  console.log('─'.repeat(W));
  console.log('\nSummary:');
  console.log(`  Total found:  ${stats.total}`);
  console.log(`  Enrolled:     ${stats.enrolled}${DRY_RUN ? ' (dry run — not written)' : ''}`);
  console.log(`  Skipped:      ${stats.skipped}`);
  console.log(`  Errors:       ${stats.errors}`);

  if (DRY_RUN && stats.enrolled > 0) {
    console.log('\n  Run with --execute to actually enroll these contacts.');
  }
  console.log();
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
