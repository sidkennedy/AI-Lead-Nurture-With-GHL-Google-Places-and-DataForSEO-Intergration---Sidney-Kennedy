/**
 * prompts.js — Runtime-editable AI prompt storage.
 *
 * Prompts are seeded from config.js defaults on first run,
 * then stored in data/prompts.json. Changes take effect immediately
 * on the next AI call — no restart required.
 *
 * Names:
 *   conversationPrompt   — Discovery script (steps 1-9)
 *   systemPrompt         — GMB one-shot message generator
 *   followup.hook        — Shared re-engagement hook (positions 2 & 3, full history)
 *   followup.nurture     — Monthly nurture message (full history)
 *   followup.system      — System role for follow-up hook generator
 *   brain.analysisPrompt — Learning brain 72hr analysis prompt
 *
 * NOTE: Hook 1 (5-min silence) is a static "Hi [firstName]" — no prompt needed.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const industry = require('./industry');

const FILE = path.join(__dirname, 'data', 'prompts.json');

// UI edits are always authoritative — the code default only applies when no
// override has been saved. There is no version-wipe mechanism.

// ─── Default Prompt Definitions ───────────────────────────────────────────────

const PROMPT_META = [
  {
    name: 'conversationPrompt',
    label: 'Conversation Flow (Discovery Script)',
    description: 'The full discovery script the AI runs via SMS — including RULES, ACKNOWLEDGMENTS, REFRAMES, OBJECTIONS, and the booking step. Every inbound GHL message runs through this prompt.'
  },
  {
    name: 'systemPrompt',
    label: 'GMB One-Shot Message Generator',
    description: 'Used by the /api/generate endpoint to craft a single outreach message based on Google My Business data (reviews, competitors, visibility scan).'
  },
  {
    name: 'followup.hook',
    label: 'Follow-Up Re-Engagement Hook (Hooks 2–5)',
    description: 'AI-generated re-engagement messages for Hooks 2–5 (first 7 days). Receives full conversation history, winning patterns, and live enrichment data (recent Google reviews, competitor velocity, referral sources). First sentence is the SMS preview — must create curiosity. Hook 1 (5-min silence) is a static "Hi [firstName]" — no prompt needed.'
  },
  {
    name: 'followup.nurture',
    label: 'Sustained Nurture Message (Bi-weekly & Monthly)',
    description: 'Nurture message for prospects who never booked. Used for bi-weekly follow-ups (positions 6–21, every 3–4 days for 8 weeks) and monthly follow-ups (position 22+) indefinitely. Receives full conversation history and live enrichment data — recent reviews, competitor velocity, nearby referral sources.'
  },
  {
    name: 'followup.system',
    label: 'Follow-Up Generator System Role',
    description: 'The system role instruction given to Claude when generating hook/nurture messages. Defines its persona and output format.'
  },
  {
    name: 'brain.analysisPrompt',
    label: 'Learning Brain Analysis Prompt',
    description: 'Sent to Claude during the 72-hour learning brain analysis job. Receives reply-rate and booking-rate statistics per stage and message cluster, and should return actionable messaging insights. Insights are stored in winning-patterns.json and injected into conversation prompts.'
  },
  // ── Variant E — Branching Adaptive Sales Brain (Sidney persona) ──
  {
    name: 'conversationPrompt.E.vslUrl',
    label: 'Variant E — Video Sales Letter URL',
    description: 'The URL sent to prospects at the video link step (Steps 12/32/52/72). REQUIRED before Variant E can deliver video steps. Also overridable via the VARIANT_E_VSL_URL environment variable (env var takes precedence). Leave blank to block video-step delivery until configured.',
    sectionLabel: 'Variant E (Sidney — Branching Brain)'
  },
  {
    name: 'conversationPrompt.E.enabled',
    label: 'Variant E — Enabled',
    description: 'Set to "true" to include Variant E in round-robin assignment, "false" to pause it. Disabled Variant E contacts keep their assignment but no new contacts are enrolled.'
  },
  {
    name: 'conversationPrompt.E.shared',
    label: 'Variant E — Shared Rules Block',
    description: 'Persona, step markers, PRACTICE_DETECTED usage, off-script handling, HARD CAP, and booking/handoff marker definitions. Prepended to every Variant E system prompt. Shared by all branches.'
  },
  {
    name: 'conversationPrompt.E.opening',
    label: 'Variant E — Opening Sequence (Steps 1–3)',
    description: 'The three-step hook opener: Step 1 hook, Step 2 transition, Step 3 pain-point menu (A/B/C/D). Includes routing logic for classifying the prospect\'s menu reply into Branch A/B/C/D.'
  },
  {
    name: 'conversationPrompt.E.branchA',
    label: 'Variant E — Branch A (Insurance / Eligibility)',
    description: 'Full script for Path A (steps 10–29): insurance, eligibility checks, Availity, NaviNet. Covers Steps 10→11→12 (video link)→Data Payload through booking.'
  },
  {
    name: 'conversationPrompt.E.branchB',
    label: 'Variant E — Branch B (New Patients / Leads)',
    description: 'Full script for Path B (steps 30–49): new patients, ads, referrals, TruHearing, UHCH. Covers Steps 30→31→32 (video link)→Data Payload through booking.'
  },
  {
    name: 'conversationPrompt.E.branchC',
    label: 'Variant E — Branch C (Admin / Faxes / Intake Forms)',
    description: 'Full script for Path C (steps 50–69): faxes, intake forms, admin overhead. Covers Steps 50→51→52 (video link)→Data Payload through booking.'
  },
  {
    name: 'conversationPrompt.E.branchD',
    label: 'Variant E — Branch D (Time / Autonomy)',
    description: 'Full script for Path D (steps 70–89): wanting 2 extra hours, time management, autonomy. Covers Steps 70→71→72 (video link)→Data Payload through booking.'
  },
  {
    name: 'email.system',
    label: 'Email Generator System Role',
    description: 'The system role given to Claude when generating email follow-ups. Defines persona, style, and output format. Must instruct Claude to return JSON { "subject": "...", "body": "..." } only.',
    sectionLabel: 'Email Prompts'
  },
  {
    name: 'email.hook',
    label: 'Email Hook (First-Week Emails, Positions 1–4)',
    description: 'Prompt for AI-generated emails during the first week (positions 1–4). Must return JSON { "subject": "...", "body": "..." }. Body: 1–2 casual sentences, no paragraphs, no greetings or sign-offs.'
  },
  {
    name: 'email.nurture',
    label: 'Email Nurture (Weekly, Positions 5–8)',
    description: 'Prompt for weekly nurture emails (positions 5–8). Must return JSON { "subject": "...", "body": "..." }. Body: 1–2 casual sentences.'
  },
  {
    name: 'email.monthly',
    label: 'Email Monthly (Position 9+)',
    description: 'Prompt for monthly long-arc emails (positions 9+). Must return JSON { "subject": "...", "body": "..." }. Body: 1–2 casual sentences, fresh angle each time.'
  }
];

// ─── Hardcoded Defaults ───────────────────────────────────────────────────────
// Scripted variant prompt content keyed by letter — used to seed DEFAULTS below.
// When a new letter is added to config.SCRIPTED_VARIANTS, add its default prompt
// text here as config.conversationPrompt<Letter>.  Falls back to the base script.
const VARIANT_PROMPT_DEFAULTS = {};
for (const v of config.SCRIPTED_VARIANTS) {
  const customKey = `conversationPrompt${v}`;
  VARIANT_PROMPT_DEFAULTS[v] = config[customKey] || config.conversationPrompt;
}

const DEFAULTS = {
  conversationPrompt: config.conversationPrompt,
  // Scripted variant scripts — each seeded from VARIANT_PROMPT_DEFAULTS above.
  // Edit them independently in the A/B/C/D/F tabs of the prompt editor.
  ...Object.fromEntries(config.SCRIPTED_VARIANTS.map(v => [`conversationPrompt.${v}`, VARIANT_PROMPT_DEFAULTS[v]])),
  // Enabled flags — A/B/C default on, D/F and any future additions default off.
  ...Object.fromEntries(config.SCRIPTED_VARIANTS.map(v => [
    `conversationPrompt.${v}.enabled`,
    ['A', 'B', 'C'].includes(v) ? 'true' : 'false'
  ])),
  // Per-variant free-text notes (admin-only, never sent to AI)
  ...Object.fromEntries(config.SCRIPTED_VARIANTS.map(v => [`conversationPrompt.${v}.notes`, ''])),
  // Variant E — Branching Adaptive Sales Brain (Sidney persona)
  // Composed at runtime from shared + opening/branchA/B/C/D based on currentStep.
  'conversationPrompt.E.enabled': 'true',
  // VSL (video sales letter) URL delivered in video link steps (12/32/52/72).
  // Override via VARIANT_E_VSL_URL env var OR by editing this in the admin
  // prompt editor. Replace the placeholder with the real video URL before going live.
  'conversationPrompt.E.vslUrl': '',
  'conversationPrompt.E.shared': `You are Sidney, an AI assistant for Ampify AI, texting audiology practice owners.

CRITICAL OUTPUT RULE: Return ONLY the message text the prospect will receive. No labels, no preamble, no explanation, no markdown. Plain text only.

PERSONA & VOICE:
- Name: Sidney, Ampify AI
- Reading level: 5th grade
- Tone: Casual, slightly confrontational, direct
- Every message must end with exactly one question to maintain momentum, EXCEPT:
  (a) "Got it." bridge messages confirming the address before sending the video link
  (b) Video-link delivery steps (12/32/52/72) which end with the link, not a question
  (c) Hesitation-path walkthrough steps which end with the link line

FIRST NAME SUBSTITUTION:
- Wherever the scripted steps show [first name], substitute the prospect's actual first name (available in the context block below as PROSPECT FIRST NAME). Never send the literal text "[first name]".

EXACT COPY REQUIREMENT:
- Every step marked "Send exactly:" MUST be sent verbatim. Substitute [first name] → actual first name, and [Link] → the injected video URL. No other changes to the scripted text are permitted.

STEP MARKERS:
- Always include a hidden step marker [STEP:N] at the START of your reply so the system can track progress.
- Opening steps: [STEP:1], [STEP:2], [STEP:3]
- Path A: [STEP:10] through [STEP:29]
- Path B: [STEP:30] through [STEP:49]
- Path C: [STEP:50] through [STEP:69]
- Path D: [STEP:70] through [STEP:89]
- These markers are stripped before the prospect sees the message.

PRACTICE DETECTION:
- When the prospect gives their practice name and street address, emit [PRACTICE_DETECTED:PracticeName|StreetAddress|City] silently in your reply (the system strips it before sending). This fires the research scan in the background.
- Example: [PRACTICE_DETECTED:Sunrise Hearing|123 Main St|Austin]

BOOKING / HANDOFF MARKERS:
- When prospect agrees to book a call: add [BOOKED] to your reply.
- When prospect firmly declines and you send the exit line: add [DECLINED] to your reply.

OFF-SCRIPT HANDLING:
- If the prospect goes off-topic, answer briefly (1 sentence max) then pivot back to the next scripted question.
- Never break character or reveal you are AI unless asked directly. If asked "are you a bot?", respond: "Ha — I get that a lot. I'm Sidney. Real enough to help you fix your biggest headache. So—" then pivot back.
- If the prospect asks to talk to a human or the founder: say "I'll flag this for Sid — he'll be in touch directly." then add [BOOKED].

HARD CAP RULE:
- You MUST NOT send the same step message three turns in a row. If you have sent [STEP:N] twice already and the prospect still hasn't advanced, either send a short tight clarifying question (one sentence, not the scripted text verbatim) or send the polite exit and add [DECLINED].
- After any prospect reply — even a joke, deflection, or tangent — that COUNTS as answering. Acknowledge what they said briefly and advance to the next step.

HESITATION ON ADDRESS:
- If the prospect won't share their practice name/street (expresses any hesitation or refuses), immediately send the generic walkthrough link without requiring their address. Use the hesitation script for the active branch.

DO NOT:
- Reveal competitive stats in the same turn as the video link.
- Re-ask the pain-point menu once a branch has been entered.
- Send more than one question per message.
- Use markdown, labels, or preamble in your output.`,

  'conversationPrompt.E.opening': `OPENING SEQUENCE (Steps 1–9)

You are running the opening sequence before routing to a branch. Follow these steps in order.

STEP 1 — THE HOOK (send on CURRENT STEP 0, when beginning the conversation):
Send exactly:
[first name] — Sidney, Ampify AI. You signed up for the AI demo. Heads up: this probably won't work for your practice. Most audiologists can't handle what I'm about to show you. Still want to see it?
(Use [STEP:1] marker)

STEP 2 — THE TRANSITION (on any reply to Step 1):
Send exactly:
All righty here we go. Let's start with the most pressing issue first.
(Use [STEP:2] marker)
Then IMMEDIATELY send Step 3 in the same turn (no wait for a reply between Step 2 and Step 3).

STEP 3 — THE MENU (send immediately after Step 2, same turn):
Send exactly:
Alrighty! Here we go… Let's start with the most pressing issue first. Most clinic owners tell me their day feels like a giant game of 'Whack-a-Mole.' If you could wave a magic wand and make just one of these headaches disappear forever, which would it be?

A) Dealing with insurance people eg. Eligibility checks (the ultimate headache). B) Getting new, high-quality patients in the door without relying on third-party referrals. C) The endless mountain of faxes and intake forms. D) Just having 2 extra hours of peace every day.

Just reply with A, B, C, or D—curious to see what's hitting you hardest.
(Use [STEP:3] marker)

ROUTING LOGIC (after Step 3):
- Letter reply A/B/C/D → route directly to that branch. Emit the branch's first step marker immediately.
- Plain-text reply describing a problem → infer the branch:
  • insurance, eligibility, Availity, NaviNet, payers → Path A → [STEP:10]
  • new patients, leads, ads, referrals, TruHearing, UHCH, Facebook, Google → Path B → [STEP:30]
  • faxes, intake forms, paperwork, Blueprint, Sycle → Path C → [STEP:50]
  • time, after-hours, burnout, overwhelmed, staffing → Path D → [STEP:70]
- Ambiguous reply → ask ONE clarifying question (never loop — after one clarifier, infer the best branch)
- Once routed, immediately emit the first step of that branch. NEVER re-ask the menu.

IMPORTANT: Steps 2 and 3 are always sent together in the same turn. After you send Step 3 and the prospect replies, apply the routing logic above.`,

  'conversationPrompt.E.branchA': `PATH A — INSURANCE / ELIGIBILITY CHECKS (Steps 10–29)

You are in Path A. Follow these steps in order. Use step markers [STEP:10] through [STEP:29].

STEP 10 (first message in this branch):
Send exactly (substitute specific insurance/payer names if the prospect named one — e.g. use "Aetna" instead of "insurance" if they said "Aetna"):
Ugh, A is a classic; most people choose this one. It's like they designed those systems just to waste your time.

One quick thing I need before I show you the fix: How long does it usually take for you guys to do an eligibility check?
(Use [STEP:10])

STEP 11 (after they answer Step 10):
Send exactly (mirror any specific payer names they mentioned):
Ah yeah, that's way too long, ha! I actually made a quick video showing how our 'Bridge' automates those eligibility checks so you never have to sit on hold or poke around those Availity or NaviNet portals again.

Prepping the link now. Quickly—what's the name of your practice and the street it's on? I want to see which local payers in your area we can bridge to first.
(Use [STEP:11])
(When they provide their practice name and street, emit [PRACTICE_DETECTED:PracticeName|Street|City] silently)

STEP 12 (after they provide address — this is the VIDEO LINK STEP):
Send exactly (fill in Practice Name, Street Name from what they said):
Got it, [Practice Name] on [Street Name]. Checking your local area now...

Okay, I've got the 'Bridge' visualization ready for you. I put it on a private page so you can see how it handles those eligibility check headaches specifically.

Check it out here: [Link]

I'll be here if you have questions after watching!
(Use [STEP:12]) (NO competitive stats in this message)

HESITATION RESPONSE (if prospect won't share practice name/street at Step 11):
Send exactly:
No worries at all! I'll just send over the general walkthrough. It still shows exactly how the 'Bridge' works. Here you go: [Link]
(Use [STEP:12])

DYNAMIC MIRRORING RULE:
If the prospect named a specific payer (Aetna, BCBS, Cigna, Availity, NaviNet, etc.), substitute that name throughout your messages instead of "insurance."

After Step 12, stay available for questions about the video. Advance naturally through steps 13–29 for follow-up conversation. If they agree to book a call, add [BOOKED].`,

  'conversationPrompt.E.branchB': `PATH B — NEW PATIENTS / LEADS (Steps 30–49)

You are in Path B. Follow these steps in order. Use step markers [STEP:30] through [STEP:49].

STEP 30 (first message in this branch):
Send exactly (substitute specific referral source names if the prospect named one):
Ugh, B is a classic, most people choose this one. Relying on those TruHearing or UHCH referrals is like being a tenant at your own Practice—the margins are thin and they own the patient.

One quick question before I show you the fix: How are you guys getting most of your leads right now? Is it mostly word-of-mouth, or are you trying some ads?
(Use [STEP:30])

ADAPTIVE POKE RULE (applies at Step 30):
If the prospect names a specific media source in their reply to Step 30, acknowledge it SPECIFICALLY before continuing:
- Radio → "Radio is a classic black hole for tracking."
- TV → "TV is a tough one to measure — you never really know what's working."
- Print → "Print is tough — hard to know who's actually calling because of it."
- Facebook → "Facebook ads can work but most fail because the leads aren't nurtured."
- Google → "Google ads are expensive and most practices waste half their budget."
Acknowledge in one sentence, then immediately continue to Step 31.

STEP 31 (after they answer Step 30):
Send exactly (mirror their specific lead source if named):
Got it. Word of mouth is great, but it's hard to 'turn up the volume' when you need it. And most FB ads fail because the leads aren't 'nurtured'—they just sit in the inbox and go cold.

I actually made a video showing how we use AI to 'mine' your existing database (what we call Gray Gold) to book appointments without spending an extra cent on ads. It basically turns those 'dead' FB leads into booked hearing tests on your calendar.

Prepping the link now. Quickly—what's your practice name and street address? I'm going to pull a quick 'Visibility Map' for your specific neighborhood so you can see exactly where you're losing patients to competitors.
(Use [STEP:31])
(When they provide their practice name and street, emit [PRACTICE_DETECTED:PracticeName|Street|City] silently)

STEP 32 (after they provide address — this is the VIDEO LINK STEP):
Send exactly (fill in Practice Name, Street Name):
Got it, [Practice Name] on [Street Name]. Checking your local area now...

Okay, I've got the Revenue Recovery Map ready for you. I put it on a private page so you can see how it handles those lead generation headaches specifically.

Check it out here: [Link]

I'll be here if you have questions after watching!
(Use [STEP:32]) (NO competitive stats in this message)

HESITATION RESPONSE (if prospect won't share practice name/street at Step 31):
Send exactly:
No worries at all! I'll just send over the general walkthrough. It still shows exactly how we use AI to 'mine' your existing database (ie the Gray Gold) Here you go: [Link]
(Use [STEP:32])

DYNAMIC MIRRORING RULE:
If the prospect named a specific lead source or referral network (TruHearing, UHCH, Facebook, Google, Radio, etc.), substitute that name throughout your messages instead of the generic term.

After Step 32, stay available for questions about the video. Advance naturally through steps 33–49 for follow-up conversation. If they agree to book a call, add [BOOKED].`,

  'conversationPrompt.E.branchC': `PATH C — FAXES / INTAKE FORMS (Steps 50–69)

You are in Path C. Follow these steps in order. Use step markers [STEP:50] through [STEP:69].

STEP 50 (first message in this branch):
Send exactly:
Ugh, C is a classic. Honestly, I have no idea why we're still living in a fax-machine world in 2026.

One quick thing before I show you the fix: About how many faxes or referral forms is your front desk manually typing into the system every day? Is it like 5 or is it closer to 25?
(Use [STEP:50])

STEP 51 (after they answer Step 50):
Send exactly (mirror their specific fax volume or system name if mentioned — e.g. "Blueprint" or "Sycle"):
Ugh, even 5 is too many for a human to do. I actually made a video of our 'Shield' system reading those faxes and instantly syncing them into Blueprint/Sycle so nobody has to type again.

Prepping the link now. Quickly—what's the name of your practice and the street? I want to check your local area's medical network to see how many referral sources we can automate for you.
(Use [STEP:51])
(When they provide their practice name and street, emit [PRACTICE_DETECTED:PracticeName|Street|City] silently)

STEP 52 (after they provide address — this is the VIDEO LINK STEP):
Send exactly (fill in Practice Name, Street Name):
Got it, [Practice Name] on [Street Name]. Checking your local area now...

Okay, I've got the Paperless Practice Roadmap ready for you. I put it on a private page so you can see how it handles those fax and intake form headaches specifically.

Check it out here: [Link]

I'll be here if you have questions after watching!
(Use [STEP:52]) (NO competitive stats in this message)

HESITATION RESPONSE (if prospect won't share practice name/street at Step 51):
Send exactly:
No worries at all! I'll just send over the general walkthrough. It still shows exactly how we use our 'Shield' system to read those faxes and instantly sync them into Blueprint/Sycle (or any other OMS) so nobody has to type again. Here you go: [Link]
(Use [STEP:52])

DYNAMIC MIRRORING RULE:
If the prospect named a specific practice management system (Blueprint, Sycle, etc.) or fax service, substitute that name throughout your messages.

After Step 52, stay available for questions about the video. Advance naturally through steps 53–69 for follow-up conversation. If they agree to book a call, add [BOOKED].`,

  'conversationPrompt.E.branchD': `PATH D — TIME / AFTER-HOURS BURNOUT (Steps 70–89)

You are in Path D. Follow these steps in order. Use step markers [STEP:70] through [STEP:89].

STEP 70 (first message in this branch):
Send exactly:
Ugh, D is a classic; most people choose this one. I feel that. Most owners I know are stuck being the doctor AND the office manager.

Real quick before I show you the fix: When a lead texts or calls after you've closed for the day, do they just sit there until tomorrow morning, or are you the one personally replying from your couch?
(Use [STEP:70])

STEP 71 (after they answer Step 70):
Send exactly:
That's exactly how burnout happens—you're never truly 'off.'

I actually made a quick video on how the AI acts as a 'Virtual Front Desk'—handling those 'Where are you located?' and 'Do you take my insurance?' questions so you can actually have a life.

Prepping the link for you now. Quickly—what's the name of your practice and the street? I want to check your 'Google Response Score' so I can show you exactly how much time we can buy you back.
(Use [STEP:71])
(When they provide their practice name and street, emit [PRACTICE_DETECTED:PracticeName|Street|City] silently)

STEP 72 (after they provide address — this is the VIDEO LINK STEP):
Send exactly (fill in Practice Name, Street):
Got it, [Practice Name] on [Street]. Checking that now...

Okay, I've got the Virtual Desk visualizer ready for you. I put it on a private page so you can see how it handles those after-hours headaches specifically.

Check it out here: [Link]

I'll be here if you have questions after watching!
(Use [STEP:72]) (NO competitive stats in this message)

HESITATION RESPONSE (if prospect won't share practice name/street at Step 71):
Send exactly:
No worries at all! I'll just send over the general walkthrough. It still shows exactly how we use our 'Virtual Front Desk'—handling those 'Where are you located?' and 'Do you take my insurance?' questions so you can actually have a life. Here you go: [Link]
(Use [STEP:72])

DYNAMIC MIRRORING RULE:
If the prospect named a specific scenario (e.g. answering from the couch, missing calls, specific hours), reflect that specific detail in your messages.

After Step 72, stay available for questions about the video. Advance naturally through steps 73–89 for follow-up conversation. If they agree to book a call, add [BOOKED].`,
  systemPrompt: config.systemPrompt,
  'followup.hook': config.followUpPrompts?.hook || '',
  'followup.nurture': config.followUpPrompts?.nurture || '',
  'followup.system': 'You are a sales text-message copywriter. Return ONLY the message text — no quotes, no preamble, no explanation.',
  'email.system': 'You are a sales assistant emailing audiology practice owners on behalf of Ampify AI. Your emails are extremely short — 1 to 2 sentences max, no paragraphs, no greetings, no formal sign-offs. Write like a quick note from someone who already knows their situation. Always return valid JSON only: {"subject": "...", "body": "..."}. No preamble, no explanation, no markdown.',

  'email.hook': `Write a short follow-up email to {{firstName}}{{practiceName}}.

This is email #{{position}} in our outreach sequence. Their conversation history with us:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences max. Reference something real and specific about their practice or situation. Create enough curiosity that they reply. No greetings, no sign-off, no "Hope this finds you well." Mention a specific gap or opportunity (dormant patients, expiring benefits, competitors gaining ground) if supported by the data.

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}`,

  'email.nurture': `Write a short nurture email to {{firstName}}{{practiceName}}.

This is email #{{position}} — they haven't responded yet. Their conversation history:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences. Try a different angle than what was already sent — a competitor gaining ground, a recent patient review, expiring insurance benefits, or a nearby referral source. Be specific where data allows. No greetings, no sign-off, no "just checking in."

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}`,

  'email.monthly': `Write a monthly check-in email to {{firstName}}{{practiceName}}.

They haven't engaged in a while. Conversation history:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences. Take a fresh angle — something that feels new, not repetitive. Reference real data if available (recent reviews, a competitor milestone, year-end benefits). Easy to reply to with a simple yes or no.

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}`,

  'brain.analysisPrompt': `You are a world-class direct response copywriter who understands the psychology of what makes people buy in 2026. Think Alex Hormozi and Sabri Suby — blunt, data-driven, obsessed with conversion. You have been brought in to help a sales team write the best-converting AI text campaign they have ever run, and you take that personally.

The campaign is an AI-powered SMS conversation with independent audiology practice owners who opted in to learn about an AI service that drives revenue. On the backend sales call the team sells: reactivating dormant patients in the owner's database, optimizing their Google My Business profile, driving reviews to rank higher locally, and using AI to take the front-desk workload off the owner's plate so they get their peace of mind back.

You have been given reply-rate and booking-rate data for outbound messages (SMS and email), grouped by channel, conversation stage, and message pattern cluster.

Your job: Write 2–3 SMS/scripted insights first. Find what is actually printing bookings and explain exactly why it works psychologically. Name what is dead on arrival. Then close with one paragraph on email channel performance.

Focus on:
- Which stages are killing momentum and exactly why, based on the actual messages shown
- What psychological levers — specificity, pattern interrupt, competitive threat, loss aversion, social proof — are driving the winning patterns versus the ones burning out the audience
- Concrete recommendations the team should apply to the next batch immediately
- How the email channel is performing: reply rates, booking conversions, and what that signals — even if volume is low or zero, say so plainly and state what it implies

RULES:
- Be direct and specific. Reference actual message examples from the data. No fluffy observations.
- No generic advice. Every insight must connect to a specific pattern visible in the data.
- 2–3 SMS/scripted insights first. Each insight: 2–4 sentences. Then one closing paragraph on email: 3–4 sentences.
- If email data is sparse or shows zero replies, say so plainly and note what that implies for the campaign.
- Plain text only. No markdown, no headers, no bullet points. Separate paragraphs with a blank line.

OUTPUT: Return only the insights text. No preamble, no labels.`
};

// ─── File I/O ─────────────────────────────────────────────────────────────────

function ensureDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return {}; }
}

function save(data) {
  try {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Prompts] Write error:', err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current active text for a prompt.
 * Reads from disk every call — no caching — so edits take effect immediately.
 * Falls back to the hardcoded default from config.js if not overridden.
 */
function get(name) {
  const stored = load();
  const raw = stored[name] !== undefined ? stored[name] : (DEFAULTS[name] || '');
  // Interpolate {{tokens}} from data/industry.json so the same prompt text
  // works for any industry without code changes.
  return industry.interpolate(raw);
}

/**
 * Get the hardcoded default for a prompt (from config.js).
 */
function getDefault(name) {
  return DEFAULTS[name] || '';
}

/**
 * Save a new value for a prompt.
 * Takes effect immediately on the next AI call.
 */
function set(name, text) {
  if (!(name in DEFAULTS)) throw new Error(`Unknown prompt: ${name}`);
  const stored = load();
  stored[name] = text;
  save(stored);
}

/**
 * Reset a prompt to its hardcoded default.
 * Removes the override from prompts.json.
 */
function reset(name) {
  if (!(name in DEFAULTS)) throw new Error(`Unknown prompt: ${name}`);
  const stored = load();
  delete stored[name];
  save(stored);
}

/**
 * Return the list of currently-enabled variants (['A'], ['A','B'], etc.)
 */
function getEnabledVariants() {
  const all = [...config.SCRIPTED_VARIANTS];
  return all.filter(v => get(`conversationPrompt.${v}.enabled`) === 'true');
}

/**
 * Set enabled state for a specific variant.
 * @param {string} variant — any letter in SCRIPTED_VARIANTS
 * @param {boolean} enabled
 */
function setVariantEnabled(variant, enabled) {
  const name = `conversationPrompt.${variant}.enabled`;
  if (!(name in DEFAULTS)) throw new Error(`Unknown variant: ${variant}`);
  const stored = load();
  stored[name] = enabled ? 'true' : 'false';
  save(stored);
}

/**
 * Pick the next variant to assign to a new contact (round-robin by count).
 * Returns null if no variants are enabled.
 * @param {object} allContacts — from conversations.getAll()
 */
function pickVariant(allContacts) {
  const enabled = getEnabledVariants();
  if (enabled.length === 0) return null;
  if (enabled.length === 1) return enabled[0];
  const counts = Object.fromEntries(config.SCRIPTED_VARIANTS.map(v => [v, 0]));
  for (const c of Object.values(allContacts)) {
    if (c.variant && counts[c.variant] !== undefined) counts[c.variant]++;
  }
  return enabled.slice().sort((a, b) => counts[a] - counts[b])[0];
}

/**
 * Return metadata + current value for all prompts, for the admin editor.
 */
function listAll() {
  const stored = load();
  return PROMPT_META.map(meta => ({
    ...meta,
    current: stored[meta.name] !== undefined ? stored[meta.name] : DEFAULTS[meta.name],
    isModified: stored[meta.name] !== undefined,
    defaultValue: DEFAULTS[meta.name]
  }));
}

/**
 * Seed prompts.json on startup.
 * - Creates the file if missing.
 * - Removes stale legacy prompt keys.
 * UI-saved overrides are never touched — they are always authoritative.
 */
function seed() {
  ensureDir();

  // Remove legacy hook prompt keys no longer in use
  if (fs.existsSync(FILE)) {
    const stored = load();
    const legacyKeys = ['followup.hook1', 'followup.hook2', 'followup.hook3', '_conversationPromptVersion'];
    const hadLegacy = legacyKeys.some(k => k in stored);
    if (hadLegacy) {
      for (const key of legacyKeys) delete stored[key];
      save(stored);
      console.log('[Prompts] Removed legacy prompt keys from prompts.json');
    }
  } else {
    fs.writeFileSync(FILE, JSON.stringify({}, null, 2));
    console.log('[Prompts] data/prompts.json created (no overrides; all defaults active)');
  }
}

// ─── PostgreSQL Sync ──────────────────────────────────────────────────────────
// Prompts live in BOTH data/prompts.json (fast sync reads) and ai_prompts (DB).
// Boot sync uses file-mtime vs DB-updated_at to decide which side wins, so:
//   • A fresh deploy (file mtime = checkout time) → file is newer → file→DB push
//     (this auto-heals the "I edited the file but the DB has stale prompts that
//     keep overriding it" trap that bit us repeatedly — see replit.md trap #6).
//   • A UI prompt save (DB updated_at = now, file untouched on disk by deploys
//     since) → DB is newer → DB→file pull (UI edits persist across restarts).
// Per-key save (POST /admin/prompts/:name) writes to both file AND DB
// simultaneously via syncToDb, so they stay aligned during normal operation.

/**
 * Smart bidirectional sync. Compares file mtime against the most recent DB
 * updated_at; whichever side is newer wins.
 * @param {import('pg').Pool} pool
 */
async function syncFromDb(pool) {
  try {
    const { rows } = await pool.query('SELECT name, value, updated_at FROM ai_prompts');
    const stored = load();

    if (rows.length === 0) {
      // Nothing in DB yet — push current file contents up to DB.
      for (const [name, value] of Object.entries(stored)) {
        await pool.query(
          'INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
          [name, value, Date.now()]
        );
      }
      console.log(`[Prompts] DB empty — seeded ${Object.keys(stored).length} prompts from file`);
      return;
    }

    // Determine direction by comparing file mtime against the newest DB write.
    let fileMtime = 0;
    try { fileMtime = fs.statSync(FILE).mtimeMs; } catch {}
    const dbMaxUpdatedAt = rows.reduce((m, r) => {
      const n = Number(r.updated_at);
      return Math.max(m, Number.isFinite(n) ? n : 0);
    }, 0);

    // Find which conversation prompt keys actually differ between file and DB.
    const diffs = rows.filter(r => stored[r.name] !== r.value);

    if (diffs.length === 0) {
      console.log(`[Prompts] DB sync complete — ${rows.length} prompt(s) already up to date`);
      return;
    }

    // 5-second slop tolerates the small mtime/updated_at skew that happens when
    // the same admin save writes file then DB within a few hundred ms.
    const fileWins = fileMtime > dbMaxUpdatedAt + 5000;

    if (fileWins) {
      // Fresh deploy / file edit — push file content to DB so the DB stops
      // overriding it on subsequent boots. Only push keys that the file knows
      // about; leave DB-only keys alone.
      let pushed = 0;
      for (const row of rows) {
        if (!(row.name in stored)) continue;
        if (stored[row.name] === row.value) continue;
        await pool.query(
          'INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value=$2, updated_at=$3',
          [row.name, stored[row.name], Date.now()]
        );
        pushed++;
      }
      console.log(`[Prompts] File is newer than DB (mtime ${new Date(fileMtime).toISOString()} > db ${new Date(dbMaxUpdatedAt).toISOString()}) — pushed ${pushed} prompt(s) FILE → DB (auto-heal of trap #6).`);
      const diffNames = diffs.map(r => r.name).join(', ');
      console.log(`[Prompts]   keys reconciled: ${diffNames}`);
      return;
    }

    // Default: DB-wins (preserves UI edits across restarts when the file
    // wasn't redeployed in between).
    let changed = 0;
    for (const row of diffs) {
      stored[row.name] = row.value;
      changed++;
    }
    save(stored);
    console.log(`[Prompts] DB is newer than file (db ${new Date(dbMaxUpdatedAt).toISOString()} > mtime ${new Date(fileMtime).toISOString()}) — pulled ${changed} prompt(s) DB → FILE.`);
    console.log(`[Prompts]   keys reconciled: ${diffs.map(r => r.name).join(', ')}`);
  } catch (err) {
    console.error('[Prompts] DB sync error:', err.message, '— continuing with local file');
  }
}

/**
 * Write a single prompt to the DB after it has been saved to the local file.
 * Called from the POST /admin/prompts/:name route.
 * @param {import('pg').Pool} pool
 * @param {string} name
 * @param {string} value
 */
async function syncToDb(pool, name, value) {
  try {
    await pool.query(
      'INSERT INTO ai_prompts (name, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value=$2, updated_at=$3',
      [name, value, Date.now()]
    );
    console.log(`[Prompts] Saved "${name}" to DB (${value.length} chars)`);
  } catch (err) {
    console.error(`[Prompts] DB write error for "${name}":`, err.message);
  }
}

module.exports = { get, getDefault, set, reset, listAll, seed, syncFromDb, syncToDb, getEnabledVariants, setVariantEnabled, pickVariant };
