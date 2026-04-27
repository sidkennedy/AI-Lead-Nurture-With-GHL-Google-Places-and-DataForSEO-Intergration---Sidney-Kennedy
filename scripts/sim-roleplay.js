require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const prompts = require('../prompts');
const fs = require('fs');
const path = require('path');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_TURNS = 14;

const FAKE_RESEARCH = {
  practiceName: 'Sound Hearing Care',
  reviews: 47,
  rating: 4.6,
  competitors: [
    { name: 'Beltone Hearing Center', reviews: 312, rating: 4.8 },
    { name: 'Miracle-Ear Austin', reviews: 198, rating: 4.7 },
    { name: 'Costco Hearing Aid Center', reviews: 154, rating: 4.5 }
  ],
  competitorSummary: 'Top 3 competitors average 221 reviews; you have 47',
  prospectRank: 7
};

const FAKE_SCAN = {
  visibleTop3: 3,
  invisible: 12,
  totalPoints: 75,
  topCompetitor: 'Beltone Hearing Center',
  averageRankWhereVisible: 4.2
};

const PERSONAS = {
  'happy-path': {
    description: 'Engaged, polite, answers questions, follows AI lead naturally',
    system: `You are roleplaying an audiology practice owner named Mark in Austin, TX. Your practice is "Sound Hearing Care". You filled out a Facebook form and now an AI is texting you. You are GENUINELY interested in hearing how to grow your practice. Keep replies short and casual — 1-2 sentences max, like real SMS. Answer questions directly. When the AI offers to send a video walkthrough, say yes. Never ask for a call yourself. NEVER use square brackets in your replies. Just text like a real person.`
  },
  'wants-call': {
    description: 'Polite but keeps trying to redirect to a phone/zoom call',
    system: `You are roleplaying an audiology practice owner named Linda in Austin, TX. Your practice is "Sound Hearing Care". An AI is texting you about growing your practice. You ARE interested but you HATE watching videos and you keep asking "can we just hop on a 5 min call instead?" or "can you call me?" or "let's do zoom". Push back politely 2-3 times if the AI tries to redirect you to a video. Eventually if the AI is firm about the video, accept the video. Keep replies short SMS-style. Never use square brackets.`
  },
  'strong-decliner': {
    description: 'Hard no, wants to be left alone, may use stop language',
    system: `You are roleplaying an audiology practice owner named Brad. An AI is texting you about something you didn't want. You are annoyed. After the first message you reply curtly: "not interested" or "stop messaging me" or "remove me". Stay firm. Keep replies under 6 words. Never use square brackets.`
  },
  'vague-loop': {
    description: 'Disengaged — only short non-answers like "ok", "maybe", "idk"',
    system: `You are roleplaying an audiology practice owner who is half-distracted on their phone. You barely engage. Every reply is something like "ok", "hmm", "maybe", "idk", "k", "yeah". Never elaborate. Never use square brackets. Replies must be ONE word, occasionally two.`
  },
  'eager-grab': {
    description: 'Tries to skip the discovery flow — wants the link/info immediately',
    system: `You are roleplaying an audiology practice owner named Priya. An AI is texting you. From the very first reply you say something like "yes send me the video", "fire it over", "send the link now", "I want to watch it". You don't want to answer questions — you just want the asset. Push 2-3 times for the link. If the AI insists on asking a question first to personalize it, eventually answer the question (give your practice name as "Sound Hearing Care" if asked, address as "1234 Lamar Blvd, Austin TX"). Keep replies short SMS-style. Never use square brackets.`
  },
  'price-objection': {
    description: 'Asks "how much?" or "what does this cost?" early',
    system: `You are roleplaying an audiology practice owner named Tom in Austin, TX. Your practice is "Sound Hearing Care". An AI is texting you. After the AI's second message you reply "how much does this cost?" or "what's the price?" or "what is this even". Be skeptical but engage. If the AI redirects you to a video that explains it, eventually accept the video. Keep replies short SMS-style. Never use square brackets.`
  }
};

const VARIANTS = ['A', 'B', 'C', 'D'];

function buildSystem({ variant, currentStep, firstName, city, hasResearch, hasScan }) {
  const key = `conversationPrompt.${variant}`;
  let s = prompts.get(key) || prompts.get('conversationPrompt');
  if (firstName) s += `\n\nPROSPECT FIRST NAME: ${firstName}`;
  if (city) s += `\n\nPROSPECT CITY: ${city}`;
  s += `\n\nCURRENT STEP: ${currentStep} (continue from here)`;
  if (hasResearch) {
    s += `\n\nLIVE RESEARCH DATA:\n${JSON.stringify({
      practiceName: FAKE_RESEARCH.practiceName,
      reviews: FAKE_RESEARCH.reviews,
      rating: FAKE_RESEARCH.rating,
      competitors: FAKE_RESEARCH.competitors.slice(0, 3),
      competitorSummary: FAKE_RESEARCH.competitorSummary,
      prospectRank: FAKE_RESEARCH.prospectRank
    }, null, 2)}`;
  }
  if (hasScan) {
    s += `\n\nSCAN RESULTS:\n${JSON.stringify(FAKE_SCAN, null, 2)}`;
  }
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
      console.log(`[Sim]   429 ${label}, waiting ${waitMs/1000}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

async function aiTurn(systemContent, history) {
  const r = await callClaudeWithRetry({
    model: MODEL,
    max_tokens: 512,
    system: [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }],
    messages: history
  }, 'aiTurn');
  return r.content[0]?.text?.trim() || '';
}

async function prospectTurn(personaSystem, history) {
  const flipped = history.map(m => ({
    role: m.role === 'user' ? 'assistant' : 'user',
    content: m.role === 'assistant'
      ? m.content.replace(/\[(STEP:\d+|BOOKED|DECLINED|PRACTICE_DETECTED:[^\]]+)\]\s*/gi, '').trim()
      : m.content
  }));
  if (flipped.length === 0 || flipped[flipped.length - 1].role !== 'user') {
    flipped.push({ role: 'user', content: '(go ahead, reply to my last message — keep it short and SMS-style)' });
  }
  const r = await callClaudeWithRetry({
    model: MODEL,
    max_tokens: 120,
    system: personaSystem,
    messages: flipped
  }, 'prospectTurn');
  return r.content[0]?.text?.trim() || '';
}

const FIRST_NAMES = {
  'happy-path': 'Mark',
  'wants-call': 'Linda',
  'strong-decliner': 'Brad',
  'vague-loop': 'Sam',
  'eager-grab': 'Priya',
  'price-objection': 'Tom'
};

async function runSim(variant, personaName) {
  const persona = PERSONAS[personaName];
  const firstName = FIRST_NAMES[personaName];
  const city = 'Austin';
  const log = [];
  const history = [];
  let currentStep = 0;
  let booked = false;
  let declined = false;
  let practiceDetected = false;
  let hasResearch = false;
  let hasScan = false;
  let bookedTurn = null;
  let declinedTurn = null;

  history.push({ role: 'user', content: 'Begin the conversation now.' });

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const sys = buildSystem({ variant, currentStep, firstName, city, hasResearch, hasScan });
    let aiRaw;
    try {
      aiRaw = await aiTurn(sys, history);
    } catch (err) {
      log.push({ turn, role: 'AI', error: err.message });
      break;
    }

    const stepMatch = aiRaw.match(/\[STEP:(\d+)\]/i);
    const newStep = stepMatch ? parseInt(stepMatch[1], 10) : null;
    if (newStep !== null) currentStep = newStep;
    const isBooked = /\[BOOKED\]/i.test(aiRaw);
    const isDeclined = /\[DECLINED\]/i.test(aiRaw);
    const practMatch = aiRaw.match(/\[PRACTICE_DETECTED:([^\]]+)\]/i);
    if (practMatch) {
      practiceDetected = true;
      hasResearch = true;
      hasScan = true;
    }

    const aiClean = aiRaw
      .replace(/\[(STEP:\d+|BOOKED|DECLINED|PRACTICE_DETECTED:[^\]]+)\]\s*/gi, '')
      .trim();

    log.push({
      turn, role: 'AI', step: newStep, currentStep,
      booked: isBooked, declined: isDeclined,
      practiceDetected: !!practMatch,
      raw: aiRaw, clean: aiClean
    });

    history.push({ role: 'assistant', content: aiRaw });

    if (isBooked) { booked = true; bookedTurn = turn; break; }
    if (isDeclined) { declined = true; declinedTurn = turn; break; }

    let prospect;
    try {
      prospect = await prospectTurn(persona.system, history);
    } catch (err) {
      log.push({ turn, role: 'PROSPECT', error: err.message });
      break;
    }
    log.push({ turn, role: 'PROSPECT', text: prospect });
    history.push({ role: 'user', content: prospect });
  }

  return {
    variant, persona: personaName,
    booked, declined, bookedTurn, declinedTurn,
    finalStep: currentStep, practiceDetected, log
  };
}

function analyze(sim) {
  const issues = [];
  const aiTurns = sim.log.filter(e => e.role === 'AI' && e.clean);
  const cleans = aiTurns.map(e => e.clean);

  // Banned phrases (call/zoom/calendar language that should be gone)
  const BANNED = [
    /\bzoom\b/i,
    /\bcalendly\b/i,
    /book(ing)?\s+(a\s+)?(call|chat|meeting|spot|time)/i,
    /(jump|hop|get)\s+on\s+(a\s+)?(call|chat|zoom)/i,
    /15[\s-]?(min|minute)\s+(call|chat)/i,
    /schedule\s+(a\s+)?(call|chat|meeting)/i,
    /calendar\s+link/i
  ];
  for (const turn of aiTurns) {
    for (const re of BANNED) {
      if (re.test(turn.clean)) {
        issues.push({ severity: 'CRITICAL', code: 'BANNED_LANG', turn: turn.turn,
          msg: `matched ${re}`, snippet: turn.clean.slice(0, 120) });
      }
    }
  }

  // Verbatim duplicates
  const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const seen = new Map();
  for (const turn of aiTurns) {
    const n = norm(turn.clean);
    if (n && seen.has(n)) {
      issues.push({ severity: 'CRITICAL', code: 'DUPLICATE', turn: turn.turn,
        msg: `verbatim duplicate of turn ${seen.get(n)}`, snippet: turn.clean.slice(0, 120) });
    } else if (n) {
      seen.set(n, turn.turn);
    }
  }

  // HARD CAP: 3+ outbounds with same [STEP:N]
  const stepRun = [];
  for (const turn of aiTurns) {
    if (turn.step != null) stepRun.push({ turn: turn.turn, step: turn.step });
  }
  for (let i = 2; i < stepRun.length; i++) {
    if (stepRun[i].step === stepRun[i-1].step && stepRun[i].step === stepRun[i-2].step) {
      issues.push({ severity: 'CRITICAL', code: 'HARD_CAP_VIOLATION', turn: stepRun[i].turn,
        msg: `3 consecutive [STEP:${stepRun[i].step}] markers` });
    }
  }

  // Step regression
  let prevStep = 0;
  for (const turn of aiTurns) {
    if (turn.step != null) {
      if (turn.step < prevStep) {
        issues.push({ severity: 'WARNING', code: 'STEP_REGRESSION', turn: turn.turn,
          msg: `step ${turn.step} < previous ${prevStep}` });
      }
      prevStep = Math.max(prevStep, turn.step);
    }
  }

  // VSL link sanity — when [BOOKED] fires it should be on the same message that contains the VSL link
  const bookedTurn = aiTurns.find(t => t.booked);
  if (bookedTurn && !/vsl-audit|ampifyai\.com/i.test(bookedTurn.clean)) {
    issues.push({ severity: 'CRITICAL', code: 'BOOKED_WITHOUT_VSL', turn: bookedTurn.turn,
      msg: '[BOOKED] emitted without VSL link in same message',
      snippet: bookedTurn.clean.slice(0, 200) });
  }

  // Persona-specific checks
  if (sim.persona === 'wants-call' || sim.persona === 'happy-path' ||
      sim.persona === 'eager-grab' || sim.persona === 'price-objection') {
    // Should EITHER reach BOOKED with VSL OR still be progressing — not declined
    if (sim.declined) {
      issues.push({ severity: 'WARNING', code: 'PREMATURE_DECLINE', turn: sim.declinedTurn,
        msg: `persona ${sim.persona} should not result in [DECLINED]` });
    }
  }
  if (sim.persona === 'strong-decliner') {
    if (!sim.declined) {
      issues.push({ severity: 'WARNING', code: 'NO_DECLINE_EXIT', turn: null,
        msg: 'strong-decliner did not trigger [DECLINED] within max turns' });
    } else if (sim.declinedTurn > 4) {
      issues.push({ severity: 'INFO', code: 'SLOW_DECLINE', turn: sim.declinedTurn,
        msg: `[DECLINED] took ${sim.declinedTurn} turns (expected ≤4)` });
    }
  }
  if (sim.persona === 'vague-loop') {
    // Should escape via [DECLINED] eventually rather than loop
    if (!sim.declined && !sim.booked) {
      issues.push({ severity: 'WARNING', code: 'NO_VAGUE_EXIT', turn: null,
        msg: 'vague-loop never escaped via [DECLINED] or [BOOKED]' });
    }
  }

  return issues;
}

async function runAll() {
  const allSims = [];
  for (const variant of VARIANTS) {
    for (const personaName of Object.keys(PERSONAS)) {
      allSims.push({ variant, personaName });
    }
  }
  console.log(`[Sim] Running ${allSims.length} simulations (${VARIANTS.length} variants × ${Object.keys(PERSONAS).length} personas)`);
  console.log(`[Sim] Model: ${MODEL}, max turns: ${MAX_TURNS}\n`);

  const outDir = path.join(__dirname, '..', '.local', 'sim-out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const partialDir = path.join(outDir, 'partial');
  if (!fs.existsSync(partialDir)) fs.mkdirSync(partialDir, { recursive: true });

  const BATCH = parseInt(process.env.SIM_BATCH || '4', 10);
  const FILTER_VARIANT = process.env.SIM_VARIANT || null;
  const FILTER_PERSONA = process.env.SIM_PERSONA || null;
  const filteredSims = allSims.filter(s =>
    (!FILTER_VARIANT || s.variant === FILTER_VARIANT) &&
    (!FILTER_PERSONA || s.personaName === FILTER_PERSONA)
  );
  console.log(`[Sim] After filters: ${filteredSims.length} sims, batch=${BATCH}\n`);

  const SKIP_DONE = process.env.SIM_SKIP_DONE !== '0';
  const RESUME_ONLY = process.env.SIM_RESUME_ONLY === '1';

  const results = [];
  // Load existing partials first so the final report includes them
  const existingTags = new Set();
  if (SKIP_DONE) {
    for (const { variant, personaName } of filteredSims) {
      const tag = `${variant}_${personaName}`;
      const p = path.join(partialDir, `${tag}.json`);
      if (fs.existsSync(p)) {
        try {
          results.push(JSON.parse(fs.readFileSync(p, 'utf8')));
          existingTags.add(tag);
        } catch {}
      }
    }
    console.log(`[Sim] Resuming: ${existingTags.size}/${filteredSims.length} already done\n`);
  }

  const todoSims = filteredSims.filter(s => !existingTags.has(`${s.variant}_${s.personaName}`));
  if (RESUME_ONLY && todoSims.length === filteredSims.length) {
    console.log('[Sim] RESUME_ONLY=1: nothing to resume, exiting');
  }

  // Time-aware: stop launching new batches when we're close to bash timeout
  const TIME_BUDGET_S = parseInt(process.env.SIM_TIME_BUDGET_S || '105', 10);
  const startTime = Date.now();

  for (let i = 0; i < todoSims.length; i += BATCH) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed > TIME_BUDGET_S) {
      console.log(`[Sim] Time budget (${TIME_BUDGET_S}s) reached at ${Math.round(elapsed)}s; stopping. ${todoSims.length - i} sims remain — re-run to resume.`);
      break;
    }
    const batch = todoSims.slice(i, i + BATCH);
    console.log(`[Sim] Batch ${Math.floor(i/BATCH)+1}/${Math.ceil(todoSims.length/BATCH)} starting: ${batch.map(b => b.variant+'/'+b.personaName).join(', ')}`);
    const batchResults = await Promise.all(batch.map(async ({ variant, personaName }) => {
      const t0 = Date.now();
      const tag = `${variant}_${personaName}`;
      try {
        const sim = await runSim(variant, personaName);
        const issues = analyze(sim);
        const result = { ...sim, issues };
        fs.writeFileSync(path.join(partialDir, `${tag}.json`), JSON.stringify(result, null, 2));
        console.log(`[Sim]   DONE ${variant}/${personaName} in ${Math.round((Date.now()-t0)/1000)}s — ${sim.booked?'BOOKED':sim.declined?'DECLINED':'INCOMPLETE'} step ${sim.finalStep}, ${issues.length} issues`);
        return result;
      } catch (err) {
        const result = { variant, persona: personaName, error: err.message, stack: err.stack, issues: [{ severity: 'CRITICAL', code: 'SIM_ERROR', msg: err.message }] };
        fs.writeFileSync(path.join(partialDir, `${tag}.json`), JSON.stringify(result, null, 2));
        console.error(`[Sim]   ERROR ${variant}/${personaName}: ${err.message}`);
        return result;
      }
    }));
    results.push(...batchResults);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  fs.writeFileSync(path.join(outDir, `sim-${ts}.json`), JSON.stringify(results, null, 2));

  const lines = [];
  lines.push(`# Roleplay Simulation Report — ${new Date().toISOString()}`);
  lines.push(`Model: ${MODEL}    Sims: ${results.length}    MaxTurns: ${MAX_TURNS}\n`);

  let totalCritical = 0, totalWarning = 0, totalInfo = 0;
  const byVariant = {};
  for (const r of results) {
    byVariant[r.variant] ??= { critical: 0, warning: 0, info: 0, sims: 0 };
    byVariant[r.variant].sims++;
    for (const iss of r.issues || []) {
      if (iss.severity === 'CRITICAL') { totalCritical++; byVariant[r.variant].critical++; }
      else if (iss.severity === 'WARNING') { totalWarning++; byVariant[r.variant].warning++; }
      else { totalInfo++; byVariant[r.variant].info++; }
    }
  }
  lines.push(`## Summary`);
  lines.push(`- CRITICAL: ${totalCritical}`);
  lines.push(`- WARNING:  ${totalWarning}`);
  lines.push(`- INFO:     ${totalInfo}\n`);
  lines.push(`### Per variant`);
  for (const v of VARIANTS) {
    const b = byVariant[v] || { critical:0, warning:0, info:0, sims:0 };
    lines.push(`- **${v}** (${b.sims} sims): CRITICAL=${b.critical}  WARNING=${b.warning}  INFO=${b.info}`);
  }
  lines.push('');

  lines.push(`## Per-sim outcomes`);
  for (const r of results) {
    const status = r.error ? 'ERROR' : (r.booked ? `BOOKED@${r.bookedTurn}` : (r.declined ? `DECLINED@${r.declinedTurn}` : `INCOMPLETE@step${r.finalStep}`));
    const c = (r.issues || []).filter(i => i.severity === 'CRITICAL').length;
    const w = (r.issues || []).filter(i => i.severity === 'WARNING').length;
    lines.push(`- ${r.variant} / ${r.persona}: ${status}  (C:${c} W:${w})`);
  }
  lines.push('');

  if (totalCritical || totalWarning) {
    lines.push(`## Issues detail`);
    for (const r of results) {
      const flags = (r.issues || []).filter(i => i.severity !== 'INFO');
      if (flags.length === 0) continue;
      lines.push(`\n### ${r.variant} / ${r.persona}`);
      for (const iss of flags) {
        lines.push(`- [${iss.severity}] ${iss.code} (turn ${iss.turn}): ${iss.msg}`);
        if (iss.snippet) lines.push(`  > "${iss.snippet}"`);
      }
    }
  }

  fs.writeFileSync(path.join(outDir, `sim-${ts}.md`), lines.join('\n'));

  // Per-sim transcripts
  for (const r of results) {
    const lines = [];
    lines.push(`# ${r.variant} / ${r.persona}`);
    lines.push(`Result: ${r.booked ? 'BOOKED' : r.declined ? 'DECLINED' : 'INCOMPLETE'}    Final step: ${r.finalStep}`);
    if (r.error) lines.push(`ERROR: ${r.error}`);
    lines.push('');
    for (const e of r.log || []) {
      if (e.role === 'AI') {
        const m = [];
        if (e.step != null) m.push(`STEP:${e.step}`);
        if (e.booked) m.push('BOOKED');
        if (e.declined) m.push('DECLINED');
        if (e.practiceDetected) m.push('PRACTICE_DETECTED');
        const tag = m.length ? ` [${m.join(' ')}]` : '';
        lines.push(`AI t${e.turn}${tag}:  ${e.clean || (e.error ? 'ERROR: ' + e.error : '')}`);
      } else {
        lines.push(`PROSPECT t${e.turn}:   ${e.text || (e.error ? 'ERROR: ' + e.error : '')}`);
      }
    }
    lines.push('');
    lines.push('## Issues');
    if (!(r.issues || []).length) lines.push('(none)');
    for (const iss of r.issues || []) {
      lines.push(`- [${iss.severity}] ${iss.code} (t${iss.turn}): ${iss.msg}`);
      if (iss.snippet) lines.push(`  > ${iss.snippet}`);
    }
    fs.writeFileSync(path.join(outDir, `sim-${ts}__${r.variant}_${r.persona}.txt`), lines.join('\n'));
  }

  console.log('\n' + lines.slice(0, 80).join('\n'));
  console.log(`\n[Sim] Full report: .local/sim-out/sim-${ts}.md`);
  console.log(`[Sim] Transcripts: .local/sim-out/sim-${ts}__*.txt`);
  console.log(`[Sim] Raw JSON:    .local/sim-out/sim-${ts}.json`);

  process.exit(totalCritical > 0 ? 1 : 0);
}

process.on('unhandledRejection', (err) => {
  console.error('[Sim] UNHANDLED REJECTION:', err && err.stack || err);
  process.exit(3);
});
process.on('uncaughtException', (err) => {
  console.error('[Sim] UNCAUGHT EXCEPTION:', err && err.stack || err);
  process.exit(4);
});

prompts.seed();
runAll().catch(err => {
  console.error('[Sim] Fatal:', err && err.stack || err);
  process.exit(2);
});
