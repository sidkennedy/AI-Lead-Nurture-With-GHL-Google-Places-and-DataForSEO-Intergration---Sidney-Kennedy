#!/usr/bin/env node
// Task #65: remove the server-side auto-sent hearing-aid question and move it
// into Variant B's prompt as a normal scripted Step 5. Also update Variant A
// and Variant C with bridge clarifications now that the auto-send is gone.
//
// Idempotent — re-running detects the new content and skips if already applied.
// POSTs each updated variant to the running server so the ai_prompts DB table
// (the source of truth) is also updated.

const fs = require('fs');
const path = require('path');
const PROMPTS_PATH = path.join(__dirname, '..', 'data', 'prompts.json');

const data = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'));
const originals = {
  A: data['conversationPrompt.A'],
  B: data['conversationPrompt.B'],
  C: data['conversationPrompt.C']
};

// ─── Variant B ────────────────────────────────────────────────────────────────
let b = originals.B;

// 1. STEP 4 BRIDGE: remove the "follow-up question automatically" claim — the
//    server no longer auto-sends anything after the address confirmation.
b = b.replace(
  '- The system will send an address confirmation and then a follow-up question automatically — you do NOT need to send either. Wait until LIVE RESEARCH DATA / SCAN RESULTS appear before generating anything.',
  '- The system will send an address confirmation automatically — wait until the prospect replies "yes" to that confirmation, then generate Step 5 (the hearing-aid percentage question).'
);

// 2. MAPS CONFIRMATION LOOP: today the section forbids generating ANYTHING
//    until LIVE RESEARCH DATA appears. Now that Step 5 (the percentage Q)
//    fires AFTER the prospect confirms the address, loosen the rule so Claude
//    knows it should generate Step 5 once the YES is in.
b = b.replace(
  'Never write \'while I\'m pulling that up…\', \'one more thing while we wait…\', or any bridge filler. The system owns all bridge messages between the practice-name reply and the data-reveal step. You only resume once LIVE RESEARCH DATA / SCAN RESULTS appear in the system context.',
  'Never write \'while I\'m pulling that up…\', \'one more thing while we wait…\', or any bridge filler in between. The system owns the bridge and the address confirmation. You resume the moment the prospect replies to the confirmation: an affirmative reply (yes / yep / correct / that\'s it) means generate Step 5 (the hearing-aid percentage question) immediately.'
);

b = b.replace(
  'When in doubt, default to silence. If the most recent assistant message is ambiguous, or LIVE RESEARCH DATA / SCAN RESULTS are not clearly present in the system context yet, DO NOT send anything — wait for the system or the prospect to move first. Silence is always safer than a misplaced bridge.',
  'When in doubt, default to silence. If the most recent assistant message is the bridge or the system\'s "Found … is that the right one?" confirmation and the prospect has NOT replied yet, DO NOT send anything — wait for them to confirm first. Silence is always safer than a misplaced bridge.'
);

// 3. Replace the AUTO-SENT QUESTION block with a real scripted STEP 5. The
//    question text is byte-for-byte identical to the old hardcoded STEP3_TEXT
//    so prospects see the exact same wording.
b = b.replace(
  'AUTO-SENT QUESTION (sent automatically by the system after address is confirmed — you will receive the prospect\'s reply. Do NOT generate this message yourself):\n"And one more thing while I\'m pulling that up — of the patients you\'ve recommended hearing aids to in the last couple years, what percentage actually went through with it?"',
  'STEP 5 — HEARING AID CONVERSION QUESTION (send this immediately after the prospect confirms the address with "yes" / "yep" / "correct" / etc. to the system\'s "Found … is that the right one?" message):\nSend EXACTLY this — no acknowledgment, no preamble, no rewording:\n"And one more thing while I\'m pulling that up — of the patients you\'ve recommended hearing aids to in the last couple years, what percentage actually went through with it?" [STEP:5]'
);

// 4. Renumber data-reveal STEP 5 → STEP 6.
b = b.replace(
  'STEP 5 — DATA REVEAL + GAP STACK (after the prospect answers the auto-sent question):',
  'STEP 6 — DATA REVEAL + GAP STACK (after the prospect answers the Step 5 percentage question):'
);
b = b.replace('LANGUAGE RULES for Step 5:', 'LANGUAGE RULES for Step 6:');
b = b.replace(
  'takes 10 minutes. Want to get that booked in?" [STEP:5]',
  'takes 10 minutes. Want to get that booked in?" [STEP:6]'
);
b = b.replace(
  '10 minutes on Zoom. Want to lock it in?" [STEP:5]',
  '10 minutes on Zoom. Want to lock it in?" [STEP:6]'
);
b = b.replace(
  'want to get that in the calendar?" [STEP:5]\nNOTE:',
  'want to get that in the calendar?" [STEP:6]\nNOTE:'
);
b = b.replace(
  'Vague language is always better than a fabricated number. [STEP:5]\n\nSTEP 6:',
  'Vague language is always better than a fabricated number. [STEP:6]\n\nSTEP 7:'
);

// 5. Renumber booking STEP 6 → STEP 7 (handled above for the leading "STEP 6:"),
//    plus the trailing [STEP:6] marker on the booking line.
b = b.replace(
  'I\'ve got tomorrow morning or the next morning — which works? [STEP:6]',
  'I\'ve got tomorrow morning or the next morning — which works? [STEP:7]'
);

// 6. Renumber close STEP 7 → STEP 8 + trailing [STEP:7] [BOOKED] marker.
b = b.replace(
  'STEP 7: Locked in — Sid will be in touch to sort a time. Talk soon [use their first name]. [STEP:7] [BOOKED]',
  'STEP 8: Locked in — Sid will be in touch to sort a time. Talk soon [use their first name]. [STEP:8] [BOOKED]'
);

// 7. EARLY BOOKING reference: Step 6 (the booking step) → Step 7 (the booking step).
b = b.replace(
  'skip directly to Step 6 (the booking step).',
  'skip directly to Step 7 (the booking step).'
);

// 8. LIVE DATA reference: data reveal moved from Step 5 to Step 6.
b = b.replace(
  'use the real numbers at Step 5 (Data Reveal) and beyond.',
  'use the real numbers at Step 6 (Data Reveal) and beyond.'
);

// ─── Variant A ────────────────────────────────────────────────────────────────
let a = originals.A;

// Update STEP 6 BRIDGE post-confirmation explanation.
a = a.replace(
  '- Full message: "Pulling up your Google Maps listing now." [STEP:6] [PRACTICE_DETECTED:practice name as they said it|street they mentioned|city from PROSPECT CITY context]\n- The system will send an address confirmation automatically — you do not need to send either here.',
  '- Full message: "Pulling up your Google Maps listing now." [STEP:6] [PRACTICE_DETECTED:practice name as they said it|street they mentioned|city from PROSPECT CITY context]\n- The system will send an address confirmation automatically. Once the prospect replies "yes" / "yep" / "correct" to that confirmation, your next message is Step 7 (the data reveal). Do NOT re-ask the percentage question from Step 2 — it has already been answered. Do NOT add any "while I pull that up…" filler. Go straight to Step 7.'
);

// ─── Variant C ────────────────────────────────────────────────────────────────
let c = originals.C;

// Update STEP 6 BRIDGE post-confirmation explanation.
c = c.replace(
  '- Full message: "Got it, pulling that up now." [STEP:6] [PRACTICE_DETECTED:practice name as they said it|city they mentioned]\n- The system will send an address confirmation and competitor data automatically — you do not need to send either here.',
  '- Full message: "Got it, pulling that up now." [STEP:6] [PRACTICE_DETECTED:practice name as they said it|city they mentioned]\n- The system will send an address confirmation automatically. Once the prospect replies "yes" / "yep" / "correct" to that confirmation, your next message is Step 7 (the booking step). Do NOT add any "one more thing while I pull that up" filler — go straight to Step 7.'
);

// ─── Verify & write ───────────────────────────────────────────────────────────
const checks = {
  B: [
    ['B: AUTO-SENT block removed',          !b.includes('AUTO-SENT QUESTION')],
    ['B: Step 5 percentage Q present',       b.includes('STEP 5 — HEARING AID CONVERSION QUESTION') && b.includes('what percentage actually went through with it?" [STEP:5]')],
    ['B: Data reveal renumbered to Step 6',  b.includes('STEP 6 — DATA REVEAL + GAP STACK')],
    ['B: Data reveal closes [STEP:6]',       b.includes('Want to get that booked in?" [STEP:6]') && b.includes('Want to lock it in?" [STEP:6]')],
    ['B: Booking is STEP 7',                 b.includes('which works? [STEP:7]')],
    ['B: Close is STEP 8 + [BOOKED]',        b.includes('STEP 8: Locked in') && b.includes('[STEP:8] [BOOKED]')],
    ['B: EARLY BOOKING refs Step 7',         b.includes('skip directly to Step 7 (the booking step)')],
    ['B: LIVE DATA refs Step 6 (Data Reveal)', b.includes('use the real numbers at Step 6 (Data Reveal) and beyond.')],
    ['B: Bridge no longer claims auto Q',    !b.includes('and then a follow-up question automatically')],
    ['B: Maps loop knows YES → Step 5',      b.includes('an affirmative reply (yes / yep / correct / that\'s it) means generate Step 5')],
  ],
  A: [
    ['A: Bridge clarifies post-YES → Step 7', a.includes('Once the prospect replies "yes" / "yep" / "correct" to that confirmation, your next message is Step 7 (the data reveal)')],
    ['A: Bridge bans re-asking percentage Q', a.includes('Do NOT re-ask the percentage question from Step 2')],
  ],
  C: [
    ['C: Bridge clarifies post-YES → Step 7', c.includes('Once the prospect replies "yes" / "yep" / "correct" to that confirmation, your next message is Step 7 (the booking step)')],
    ['C: Bridge bans filler',                 c.includes('Do NOT add any "one more thing while I pull that up" filler')],
  ]
};

let allOk = true;
for (const variant of ['B', 'A', 'C']) {
  console.log(`\nVariant ${variant} verification:`);
  checks[variant].forEach(([label, ok]) => {
    if (!ok) allOk = false;
    console.log(`  ${ok ? 'YES' : 'NO '} ${label}`);
  });
}

const updated = { A: a, B: b, C: c };
const changed = ['A', 'B', 'C'].filter(v => updated[v] !== originals[v]);

if (changed.length === 0) {
  console.log('\nNo changes needed (already applied).');
} else {
  data['conversationPrompt.A'] = a;
  data['conversationPrompt.B'] = b;
  data['conversationPrompt.C'] = c;
  fs.writeFileSync(PROMPTS_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nWrote prompts.json. Changed: ${changed.join(', ')}.`);
  console.log(`  A length: ${a.length}`);
  console.log(`  B length: ${b.length}`);
  console.log(`  C length: ${c.length}`);
}

if (!allOk) {
  console.error('\nOne or more verification checks failed — aborting DB push.');
  process.exit(1);
}

async function push() {
  const key = process.env.ADMIN_KEY;
  if (!key) { console.warn('\n[!] ADMIN_KEY not set — DB not updated.'); return; }
  for (const variant of ['A', 'B', 'C']) {
    const url = `http://localhost:5000/admin/prompts/conversationPrompt.${variant}?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: updated[variant] })
    });
    const body = await res.text();
    console.log(`POST conversationPrompt.${variant} → ${res.status} ${body.slice(0, 120)}`);
  }
}

push().catch(e => { console.error('Push failed:', e.message); process.exit(1); });
