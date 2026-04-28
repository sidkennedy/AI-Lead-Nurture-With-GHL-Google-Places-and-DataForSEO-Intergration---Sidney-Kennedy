/**
 * Off-script reply handler regression harness.
 *
 * Task #80 added a structured OFF-SCRIPT REPLIES section to the canonical
 * conversationPrompt and to all four A/B/C/D variants, with three handlers:
 *   • CURIOSITY        ("what is it?", "how does this work?", …)
 *   • IDENTITY         ("who is this?", "do I know you?", …)
 *   • SOLUTION-SEEKING ("what's the answer?", "what do I need to do?", …)
 *
 * This script drives the same Claude pipeline the playground uses, replays
 * one canned prospect reply per handler against each variant, and asserts
 * that the assistant reply contains the expected fingerprints (e.g. the
 * "Sidney from Ampify AI" intro for IDENTITY; a video tease with no fresh
 * pain stack for SOLUTION-SEEKING; a brief value-prop tease that bridges
 * back into the scripted next step for CURIOSITY).
 *
 * Pattern lifted from `scripts/sim-roleplay.js` (the regression harness for
 * the conversation-tester real-scan flow).
 *
 * Two drive modes:
 *   1. Direct (default) — calls Anthropic with the same variant prompt the
 *      playground would use, but bypasses the Express layer. Fast, no
 *      running server needed. Best for quick smoke checks while you're
 *      iterating on prompt copy.
 *   2. Via server (OFF_VIA_SERVER=1) — POSTs to the real
 *      /admin/playground/start and /admin/playground/message endpoints,
 *      so the assertions also exercise _buildPlaygroundSystemPrompt
 *      (which can append things like winning-pattern hints that the
 *      direct mode does not include), marker extraction, and the
 *      session state machine. **This is the authoritative regression
 *      path** — run it before you ship a prompt change. Requires the
 *      server to be running and ADMIN_KEY in env.
 *
 * Usage:
 *   node scripts/test-off-script-handlers.js
 *   OFF_VARIANT=B node scripts/test-off-script-handlers.js
 *   OFF_HANDLER=IDENTITY node scripts/test-off-script-handlers.js
 *   OFF_VIA_SERVER=1 OFF_SERVER_URL=http://localhost:3000 \
 *     ADMIN_KEY=... node scripts/test-off-script-handlers.js
 *
 * Exit code: 0 if every variant×handler passes, 1 if any fail.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const prompts = require('../prompts');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const VARIANTS = ['A', 'B', 'C', 'D'];

// The canonical Step 1 opener — used as the fake assistant turn so the
// off-script reply lands in a realistic place (right after the opener,
// before any practice/scan data has been gathered).
const FAKE_OPENER =
  "Hey Test, so you're interested in AI for your audiology practice... " +
  "I ran some numbers on practices last year and found something most owners " +
  "would lose sleep over if they knew. Takes 3 minutes. Reply GO. [STEP:1]";

const HANDLERS = {
  CURIOSITY: {
    canned: 'Ok what is it and how do I use it',
    description:
      'Brief value-prop tease (no fabricated numbers) → bridge into the ' +
      'scripted next step, all in ONE text.',
    asserts: {
      // Must touch the mission-context vocabulary (database / patients /
      // insurance benefits / Google visibility / reactivation). Detects a
      // regression where the model just answers "we help you grow" with no
      // tease at all.
      mustMatchAny: {
        mission_context_tease: [
          /\bdatabase\b/i,
          /\bpatients?\b/i,
          /\binsurance\b/i,
          /\bgoogle\b/i,
          /\bvisibility\b/i,
          /\breactivat/i,
          /\bbenefits?\b/i
        ]
      },
      // The handler must bridge into the scripted next step — every message
      // in the script ends in a question. No question = it stalled.
      mustHaveQuestionMark: true,
      // Forbid: fabricated numbers about the prospect's practice (the prompt
      // explicitly bans this on a CURIOSITY reply because we have no scan
      // data yet).
      banned: {
        fabricated_practice_stat: [
          /\$[\d,]+\s*(per|\/)\s*(month|year)/i,
          /\b\d{2,3}\s*(patients|leads|reviews)\b/i,
          /you'?re losing \$/i
        ]
      },
      // Should remain a single SMS — not split across paragraphs.
      maxNewlines: 2
    }
  },

  IDENTITY: {
    canned: 'Who is this?',
    description:
      'Open with "It\'s Sidney from Ampify AI" → remind they signed up on ' +
      'the landing page → short MISSION CONTEXT tease → bridge back to the ' +
      'current scripted step. All in ONE text.',
    asserts: {
      // Hardest fingerprint: the literal "Sidney from Ampify AI" intro.
      mustMatchAll: {
        sidney_intro: [/sidney/i, /ampify\s*ai/i]
      },
      mustMatchAny: {
        landing_page_reference: [
          /signed up/i,
          /landing page/i,
          /\bour page\b/i,
          /our site/i
        ]
      },
      mustHaveQuestionMark: true,
      // No `banned` block here: the `mustMatchAll` Sidney+Ampify check
      // is the real invariant — if the model invents a different name
      // it cannot satisfy `mustMatchAll`. A separate "no other capitalized
      // name" regex created false positives on benign phrasings like
      // "I'm reaching out because…".
      maxNewlines: 2
    }
  },

  'SOLUTION-SEEKING': {
    canned: "What's the solution?",
    description:
      'Reassure the full roadmap is coming → continue with the next ' +
      'scripted info-gathering question → one-line tease that Sid\'s video ' +
      'walks through the entire fix. All in ONE text. Critically, do NOT ' +
      'stack more pain on a solution-seeking reply.',
    asserts: {
      mustMatchAny: {
        // Reassurance vocabulary — model must signal the path is coming.
        roadmap_reassurance: [
          /building up to/i,
          /one more (piece|thing|question)/i,
          /just need (one|a)/i,
          /getting (you )?to/i,
          /\bcoming\b/i,
          /walks? (you |the )?(whole |entire )?(fix|thing|roadmap)/i
        ],
        // Video tease — the handler is supposed to namedrop Sid's video
        // (Sid = the human persona behind the brand).
        video_tease: [
          /\bvideo\b/i,
          /walkthrough/i,
          /walk(s)?\s+(you\s+)?through/i
        ]
      },
      mustHaveQuestionMark: true,
      // Forbid stacking new pain — the OFF-SCRIPT spec is explicit:
      // "do NOT stack more problems / leaks / pain on a solution-seeking
      //  reply." These patterns are characteristic of the data-reveal /
      // pain-stacking copy elsewhere in the script.
      banned: {
        new_pain_stack: [
          /\bleak(ing|s)?\b/i,
          /\bbleeding\b/i,
          /you'?re losing/i,
          /walking out without/i,
          /invisible (in|on) (google|search)/i,
          /\$[\d,]+\s*(in|of)\s*(lost|missed)/i
        ]
      },
      maxNewlines: 2
    }
  }
};

function buildSystem(variant) {
  const key = `conversationPrompt.${variant}`;
  let s = prompts.get(key) || prompts.get('conversationPrompt');
  s += `\n\nPROSPECT FIRST NAME: Test`;
  s += `\n\nCURRENT STEP: 1 (continue from here)`;
  return s;
}

async function callClaudeWithRetry(args, label) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await anthropic.messages.create(args);
    } catch (err) {
      const status = err.status || (err.error && err.error.status);
      const isRateLimit = status === 429 || /rate_limit|429/i.test(err.message || '');
      if (!isRateLimit || attempt === maxAttempts) throw err;
      const waitMs = 8000 * attempt;
      console.log(`[OffScript]   429 ${label}, waiting ${waitMs/1000}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

function stripMarkers(text) {
  return text
    .replace(/\[(STEP:\d+|BOOKED|DECLINED|PRACTICE_DETECTED:[^\]]+)\]\s*/gi, '')
    .trim();
}

async function runOneDirect(variant, handlerName) {
  const handler = HANDLERS[handlerName];
  const system = buildSystem(variant);

  // Replays the playground pipeline shape: a synthetic "Begin" trigger
  // (so the API has a leading user message), the canned opener as the
  // assistant's first turn, then the prospect's off-script reply.
  const messages = [
    { role: 'user', content: 'Begin the conversation.' },
    { role: 'assistant', content: FAKE_OPENER },
    { role: 'user', content: handler.canned }
  ];

  const t0 = Date.now();
  const r = await callClaudeWithRetry({
    model: MODEL,
    max_tokens: 512,
    system,
    messages
  }, `${variant}/${handlerName}`);
  const elapsedMs = Date.now() - t0;

  const raw = r.content[0]?.text?.trim() || '';
  const display = stripMarkers(raw);

  return { raw, display, elapsedMs };
}

async function runOneViaServer(variant, handlerName) {
  const handler = HANDLERS[handlerName];
  const baseUrl = (process.env.OFF_SERVER_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    throw new Error('OFF_VIA_SERVER=1 requires ADMIN_KEY in env');
  }

  const sessionId = `off-script-${variant}-${handlerName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const headers = { 'Content-Type': 'application/json', 'x-admin-key': adminKey };
  const t0 = Date.now();

  // 1. Start session — this generates the opener via the same /admin/playground/start
  //    endpoint the in-product conversation tester hits.
  const startRes = await fetch(`${baseUrl}/admin/playground/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sessionId,
      variant,
      firstName: 'Test',
      city: '',
      // Disable real Maps scan path — off-script handlers fire before the
      // practice-detection step, so scan integration is irrelevant here
      // and turning it off means we never burn Google Places credits.
      useRealScan: false
    })
  });
  if (!startRes.ok) {
    const txt = await startRes.text().catch(() => '');
    throw new Error(`playground/start ${startRes.status}: ${txt.slice(0, 200)}`);
  }
  const startBody = await startRes.json();
  if (!startBody.ok) throw new Error(`playground/start error: ${startBody.error || 'unknown'}`);

  // 2. Send the canned off-script reply.
  const msgRes = await fetch(`${baseUrl}/admin/playground/message`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, message: handler.canned })
  });
  if (!msgRes.ok) {
    const txt = await msgRes.text().catch(() => '');
    throw new Error(`playground/message ${msgRes.status}: ${txt.slice(0, 200)}`);
  }
  const msgBody = await msgRes.json();
  if (!msgBody.ok) throw new Error(`playground/message error: ${msgBody.error || 'unknown'}`);

  const elapsedMs = Date.now() - t0;
  // The server already strips markers in `display`, but mirror raw for parity.
  return {
    raw: msgBody.raw || msgBody.reply || '',
    display: msgBody.reply || stripMarkers(msgBody.raw || ''),
    elapsedMs
  };
}

async function runOne(variant, handlerName) {
  const handler = HANDLERS[handlerName];
  const useServer = process.env.OFF_VIA_SERVER === '1';

  const { raw, display, elapsedMs } = useServer
    ? await runOneViaServer(variant, handlerName)
    : await runOneDirect(variant, handlerName);

  const failures = analyzeReply(display, handler.asserts);

  return {
    variant,
    handler: handlerName,
    canned: handler.canned,
    mode: useServer ? 'server' : 'direct',
    raw,
    display,
    elapsedMs,
    failures,
    pass: failures.length === 0
  };
}

function analyzeReply(display, asserts) {
  const failures = [];

  if (asserts.mustMatchAll) {
    for (const [name, regexes] of Object.entries(asserts.mustMatchAll)) {
      for (const re of regexes) {
        if (!re.test(display)) {
          failures.push({
            kind: 'MISSING_REQUIRED',
            check: name,
            detail: `expected to match ${re}`
          });
        }
      }
    }
  }

  if (asserts.mustMatchAny) {
    for (const [name, regexes] of Object.entries(asserts.mustMatchAny)) {
      const hit = regexes.some(re => re.test(display));
      if (!hit) {
        failures.push({
          kind: 'MISSING_FINGERPRINT',
          check: name,
          detail: `none of ${regexes.length} patterns matched (e.g. ${regexes[0]})`
        });
      }
    }
  }

  if (asserts.mustHaveQuestionMark && !/\?/.test(display)) {
    failures.push({
      kind: 'MISSING_QUESTION',
      check: 'mustHaveQuestionMark',
      detail: 'reply must bridge into a scripted question (no "?" found)'
    });
  }

  if (asserts.banned) {
    for (const [name, regexes] of Object.entries(asserts.banned)) {
      for (const re of regexes) {
        if (re.test(display)) {
          failures.push({
            kind: 'BANNED_PATTERN',
            check: name,
            detail: `matched forbidden pattern ${re}`
          });
        }
      }
    }
  }

  if (asserts.maxNewlines !== undefined) {
    const nl = (display.match(/\n/g) || []).length;
    if (nl > asserts.maxNewlines) {
      failures.push({
        kind: 'MULTI_PARAGRAPH',
        check: 'maxNewlines',
        detail: `${nl} line breaks (max ${asserts.maxNewlines}) — should be ONE text`
      });
    }
  }

  return failures;
}

async function runAll() {
  const filterVariant = process.env.OFF_VARIANT || null;
  const filterHandler = process.env.OFF_HANDLER || null;
  const batchRaw = process.env.OFF_BATCH;

  // Fail fast on typos so an invalid filter never masquerades as a
  // green 0-case run. Mirrors the validation on POST /admin/test-off-script.
  if (filterVariant && !VARIANTS.includes(filterVariant)) {
    console.error(`[OffScript] Invalid OFF_VARIANT="${filterVariant}". Expected one of: ${VARIANTS.join(', ')}.`);
    process.exit(2);
  }
  if (filterHandler && !Object.keys(HANDLERS).includes(filterHandler)) {
    console.error(`[OffScript] Invalid OFF_HANDLER="${filterHandler}". Expected one of: ${Object.keys(HANDLERS).join(', ')}.`);
    process.exit(2);
  }
  let batchSize = 4;
  if (batchRaw !== undefined && batchRaw !== '') {
    const n = Number(batchRaw);
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      console.error(`[OffScript] Invalid OFF_BATCH="${batchRaw}". Expected integer 1–12.`);
      process.exit(2);
    }
    batchSize = n;
  }

  const cases = [];
  for (const variant of VARIANTS) {
    if (filterVariant && variant !== filterVariant) continue;
    for (const handlerName of Object.keys(HANDLERS)) {
      if (filterHandler && handlerName !== filterHandler) continue;
      cases.push({ variant, handlerName });
    }
  }

  // Belt-and-braces: even with both filters valid, if for some reason the
  // case set is empty (e.g. future filter logic regression), fail loudly
  // rather than silently exit 0.
  if (cases.length === 0) {
    console.error(`[OffScript] No matching cases for filters (variant=${filterVariant || 'any'}, handler=${filterHandler || 'any'}).`);
    process.exit(2);
  }

  const mode = process.env.OFF_VIA_SERVER === '1' ? 'via-server' : 'direct';
  console.log(`[OffScript] Model: ${MODEL}    Mode: ${mode}`);
  if (mode === 'via-server') {
    const baseUrl = (process.env.OFF_SERVER_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    console.log(`[OffScript] Server: ${baseUrl}`);
  }
  console.log(`[OffScript] Cases: ${cases.length} (${VARIANTS.length} variants × ${Object.keys(HANDLERS).length} handlers, post-filter)\n`);

  const results = [];
  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);
    console.log(`[OffScript] Batch ${Math.floor(i/batchSize)+1}/${Math.ceil(cases.length/batchSize)}: ${batch.map(c => c.variant+'/'+c.handlerName).join(', ')}`);
    const batchResults = await Promise.all(batch.map(async ({ variant, handlerName }) => {
      try {
        const r = await runOne(variant, handlerName);
        const tag = r.pass ? 'PASS' : 'FAIL';
        console.log(`[OffScript]   ${tag} ${variant}/${handlerName} (${Math.round(r.elapsedMs/1000)}s, ${r.failures.length} failures)`);
        return r;
      } catch (err) {
        console.error(`[OffScript]   ERROR ${variant}/${handlerName}: ${err.message}`);
        return {
          variant,
          handler: handlerName,
          canned: HANDLERS[handlerName].canned,
          error: err.message,
          failures: [{ kind: 'HARNESS_ERROR', check: 'api_call', detail: err.message }],
          pass: false
        };
      }
    }));
    results.push(...batchResults);
  }

  // OFF_REPORT_BASENAME lets a caller (e.g. the admin endpoint) pin the
  // output filenames to a job-specific stem so concurrent runs don't race
  // each other on the "latest file" lookup. Falls back to a timestamp.
  const baseRaw = process.env.OFF_REPORT_BASENAME;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = (baseRaw && /^[A-Za-z0-9._-]+$/.test(baseRaw))
    ? baseRaw
    : `off-script-${ts}`;
  const outDir = path.join(__dirname, '..', '.local', 'sim-out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // ── Summary ──
  const passCount = results.filter(r => r.pass).length;
  const failCount = results.length - passCount;

  const lines = [];
  lines.push(`# Off-Script Reply Handler Regression — ${new Date().toISOString()}`);
  lines.push(`Model: ${MODEL}    Mode: ${mode}`);
  lines.push(`Cases: ${results.length}    Pass: ${passCount}    Fail: ${failCount}\n`);

  lines.push('## Per-case result');
  lines.push('| Variant | Handler | Result | Failures |');
  lines.push('|---------|---------|--------|----------|');
  for (const r of results) {
    lines.push(`| ${r.variant} | ${r.handler} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.failures.length} |`);
  }
  lines.push('');

  if (failCount > 0) {
    lines.push('## Failure detail');
    for (const r of results) {
      if (r.pass) continue;
      lines.push(`\n### ${r.variant} / ${r.handler}`);
      lines.push(`Canned reply: "${r.canned}"`);
      lines.push(`Assistant reply:\n> ${(r.display || '(error)').replace(/\n/g, '\n> ')}\n`);
      for (const f of r.failures) {
        lines.push(`- [${f.kind}] ${f.check}: ${f.detail}`);
      }
    }
  }

  // Always write transcripts so successful runs are inspectable too.
  lines.push('\n## All transcripts');
  for (const r of results) {
    lines.push(`\n### ${r.variant} / ${r.handler} — ${r.pass ? 'PASS' : 'FAIL'}`);
    lines.push(`Prospect: "${r.canned}"`);
    lines.push(`Assistant:\n> ${(r.display || '(no reply)').replace(/\n/g, '\n> ')}`);
  }

  const reportPath = path.join(outDir, `${baseName}.md`);
  fs.writeFileSync(reportPath, lines.join('\n'));
  fs.writeFileSync(
    path.join(outDir, `${baseName}.json`),
    JSON.stringify(results, null, 2)
  );

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`SUMMARY: ${passCount}/${results.length} passing`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.variant} / ${r.handler}${r.pass ? '' : '  →  ' + r.failures.map(f => f.check).join(', ')}`);
  }
  console.log('');
  console.log(`Full report: ${path.relative(process.cwd(), reportPath)}`);

  process.exit(failCount > 0 ? 1 : 0);
}

process.on('unhandledRejection', (err) => {
  console.error('[OffScript] UNHANDLED REJECTION:', err && err.stack || err);
  process.exit(3);
});
process.on('uncaughtException', (err) => {
  console.error('[OffScript] UNCAUGHT EXCEPTION:', err && err.stack || err);
  process.exit(4);
});

prompts.seed();
runAll().catch(err => {
  console.error('[OffScript] Fatal:', err && err.stack || err);
  process.exit(2);
});
