#!/usr/bin/env node
// One-shot script to apply 6 small prompt-hardening additions to variants
// A, B, and C in data/prompts.json. Idempotent — re-running is a no-op
// because each addition is detected by a sentinel substring before insert.

const fs = require('fs');
const path = require('path');

const PROMPTS_PATH = path.join(__dirname, '..', 'data', 'prompts.json');
const data = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));

// ── Additions (sentinel → block to insert AFTER, anchor → exact substring) ──

const RULE_TONE_AND_QMARK = [
  '',
  '- One question per free-form message. When you are generating a reframe, an acknowledgment, an objection handler, or any reply that is NOT a scripted FLOW step copied verbatim, your message ends with exactly ONE question mark. Scripted FLOW lines that already contain two question marks stay exactly as written — do not edit them. The cap applies only to the words YOU compose.',
  '- Tone is casual and direct from the first message through the last. Do NOT become warmer, more formal, more apologetic, or more chatty as the conversation progresses. The voice you used in Step 1 is the voice you use in the final step.'
].join('\n');

const ADVANCE_MECHANICAL = '\n\nBefore composing every reply, scan back through your OWN previous outbound messages and find the most recent [STEP:N] marker. Your next outbound MUST end with [STEP:M] where M > N. State the current step number internally before you start writing. If you cannot find any prior [STEP:N] you sent, you are at Step 1.';

const MAPS_DEFAULT_SILENCE = '\n\nWhen in doubt, default to silence. If the most recent assistant message is ambiguous, or LIVE RESEARCH DATA / SCAN RESULTS are not clearly present in the system context yet, DO NOT send anything — wait for the system or the prospect to move first. Silence is always safer than a misplaced bridge.';

const REFRAME_HARD_CAP = '\n\nHard cap: 2 sentences. If you find yourself writing a third sentence in the reframe before the next scripted step, cut it.';

// Old fabrication-warning line that appears once near the end of the data
// reveal section in A and B.
const OLD_FABRICATION_NOTE = 'NOTE: Never fabricate numbers. Only use real data from LIVE RESEARCH DATA or SCAN RESULTS.';
const NEW_FABRICATION_NOTE = 'NOTE: Never fabricate numbers, competitor names, or distances. If you are not 100% certain a specific number, name, or distance came from LIVE RESEARCH DATA or SCAN RESULTS, leave it out. Vague language is always better than a fabricated number.';

// LIVE DATA section trailing line (slightly different across variants).
const LIVE_DATA_PATTERNS = [
  // A
  {
    old: 'Never fabricate numbers. If no data is available, use the scripted fallback language.',
    next: 'Never fabricate numbers. If you are not 100% certain a specific number, competitor name, or distance came from LIVE RESEARCH DATA or SCAN RESULTS, leave it out — vague is always better than fabricated. If no data is available, use the scripted fallback language.'
  },
  // B
  {
    old: 'Never fabricate numbers. If no data is available, rely on the scripted language only.',
    next: 'Never fabricate numbers. If you are not 100% certain a specific number, competitor name, or distance came from LIVE RESEARCH DATA or SCAN RESULTS, leave it out — vague is always better than fabricated. If no data is available, rely on the scripted language only.'
  },
  // C
  {
    old: 'Never fabricate numbers. If no data is available, use the fallback language provided in Step 5.',
    next: 'Never fabricate numbers. If you are not 100% certain a specific number, competitor name, or distance came from LIVE RESEARCH DATA or SCAN RESULTS, leave it out — vague is always better than fabricated. If no data is available, use the fallback language provided in Step 5.'
  }
];

function insertAfter(text, anchor, block, sentinel) {
  if (text.includes(sentinel)) return { text, changed: false, reason: 'already-present' };
  const i = text.indexOf(anchor);
  if (i === -1) return { text, changed: false, reason: 'anchor-missing' };
  const cut = i + anchor.length;
  return { text: text.slice(0, cut) + block + text.slice(cut), changed: true };
}

function replaceOnce(text, oldStr, newStr) {
  if (text.includes(newStr)) return { text, changed: false, reason: 'already-present' };
  if (!text.includes(oldStr)) return { text, changed: false, reason: 'old-missing' };
  return { text: text.replace(oldStr, newStr), changed: true };
}

function applyEdits(variantKey, hasReframes) {
  const before = data[variantKey];
  if (!before) {
    console.log(`[${variantKey}] MISSING — skipping`);
    return;
  }
  let text = before;
  const log = [];

  // 1. RULES — append tone-drift + question-mark cap.
  // Variants A/B end the RULES list with "If there is no prior conversation
  // history…"; variant C ends with the [STEP:N] marker bullet.
  const rulesAnchorAB = '- If there is no prior conversation history, send Step 1 exactly as written. That is always the starting point.';
  const rulesAnchorC = '- After every message you send, include a hidden step marker at the very end: [STEP:N] (where N is the step number). This will be stripped before the message is sent to the prospect.';
  let r = insertAfter(text, rulesAnchorAB, RULE_TONE_AND_QMARK,
    'Maximum ONE question mark per message');
  if (!r.changed && r.reason === 'anchor-missing') {
    r = insertAfter(text, rulesAnchorC, RULE_TONE_AND_QMARK,
      'Maximum ONE question mark per message');
  }
  text = r.text; log.push(['rules-tone-qmark', r.changed ? 'added' : r.reason]);

  // 2. ALWAYS ADVANCE — append mechanical step-tracking.
  const advanceAnchor = 'The dormant-patient / reactivation / "bring them back" / "reach them" / "what are you doing about those patients" question family is asked ONCE per conversation. After it has been asked once in any phrasing, it is permanently retired — even if the prospect didn\'t directly answer it. Move on.';
  r = insertAfter(text, advanceAnchor, ADVANCE_MECHANICAL,
    'scan back through your OWN previous outbound messages');
  text = r.text; log.push(['advance-mechanical', r.changed ? 'added' : r.reason]);

  // 3. MAPS — append "default to silence".
  const mapsAnchor = 'You only resume once LIVE RESEARCH DATA / SCAN RESULTS appear in the system context.';
  r = insertAfter(text, mapsAnchor, MAPS_DEFAULT_SILENCE,
    'When in doubt, default to silence');
  text = r.text; log.push(['maps-default-silence', r.changed ? 'added' : r.reason]);

  // 4. REFRAMES — append 2-sentence hard cap (A and B only; C has no
  //    REFRAMES section, the IF/THEN responses already cap length).
  if (hasReframes) {
    // Variant A REFRAMES ends with this line; variant B's ends differently.
    const reframeAnchorA = 'Don\'t reframe every reply — only when their answer gives you something real. One-word answers like "no" or "nothing" get a simple acknowledgment instead.';
    const reframeAnchorB = 'Only reframe when their answer gives you something specific. Short answers like "no" or "nothing" get a neutral bridge at most.';
    let r2 = insertAfter(text, reframeAnchorA, REFRAME_HARD_CAP, 'Hard cap: 2 sentences');
    if (!r2.changed && r2.reason === 'anchor-missing') {
      r2 = insertAfter(text, reframeAnchorB, REFRAME_HARD_CAP, 'Hard cap: 2 sentences');
    }
    text = r2.text; log.push(['reframe-hard-cap', r2.changed ? 'added' : r2.reason]);
  }

  // 5. Step 7/4/5 fabrication NOTE — strengthen.
  let r3 = replaceOnce(text, OLD_FABRICATION_NOTE, NEW_FABRICATION_NOTE);
  text = r3.text; log.push(['data-reveal-fabrication', r3.changed ? 'updated' : r3.reason]);

  // 6. LIVE DATA section — strengthen the trailing fabrication sentence.
  let liveDataChanged = false;
  for (const pat of LIVE_DATA_PATTERNS) {
    const r4 = replaceOnce(text, pat.old, pat.next);
    if (r4.changed) { text = r4.text; liveDataChanged = true; break; }
    if (text.includes(pat.next)) { liveDataChanged = 'already-present'; break; }
  }
  log.push(['live-data-fabrication',
    liveDataChanged === true ? 'updated' : (liveDataChanged === 'already-present' ? 'already-present' : 'old-missing')]);

  data[variantKey] = text;
  console.log(`[${variantKey}]`);
  for (const [k, v] of log) console.log(`  ${k}: ${v}`);
}

applyEdits('conversationPrompt.A', /*hasReframes=*/true);
applyEdits('conversationPrompt.B', /*hasReframes=*/true);
applyEdits('conversationPrompt.C', /*hasReframes=*/false);

fs.writeFileSync(PROMPTS_PATH, JSON.stringify(data, null, 2) + '\n');
console.log('\nWrote', PROMPTS_PATH);

// Push each variant to the running server's admin endpoint so the DB
// (the actual source of truth, which overwrites the file on every restart)
// is updated too. Without this, restarting the workflow would re-hydrate
// the file from DB and silently undo our edits.
async function pushToServer() {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    console.warn('\n[!] ADMIN_KEY not set — skipped DB push. Edits will be lost on next restart.');
    return;
  }
  const base = process.env.PROMPT_PUSH_BASE || 'http://localhost:5000';
  const variants = ['conversationPrompt.A', 'conversationPrompt.B', 'conversationPrompt.C'];
  for (const name of variants) {
    const url = base + '/admin/prompts/' + encodeURIComponent(name) + '?key=' + encodeURIComponent(adminKey);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: data[name] })
    });
    const body = await res.text();
    console.log('  POST', name, '→', res.status, body.slice(0, 120));
  }
}

pushToServer().catch(err => {
  console.error('Push failed:', err.message);
  process.exit(1);
});
