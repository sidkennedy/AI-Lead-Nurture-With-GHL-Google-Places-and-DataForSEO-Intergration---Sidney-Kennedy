# Powered Up AI — Complete System Breakdown

**Purpose of this document:** A thorough, code-verified account of exactly what this system does — including every AI prompt word-for-word — written so that someone with no prior exposure can read it and understand how everything fits together, and so that another AI can analyze it and make recommendations on effectiveness and profitability.

---

## 1. What This System Is

Powered Up AI is an automated AI sales assistant that runs discovery conversations with audiology practice owners via SMS, and in parallel sends follow-up emails. Its goal is to book a 10-minute Zoom call between the prospect and Sid Kennedy (the founder), who then runs the actual sales call.

The system is built on top of **GoHighLevel (GHL)**, a CRM and messaging platform that handles contact records, SMS delivery, email delivery, and conversation threads. Powered Up AI sits alongside GHL — it receives webhook notifications when prospects reply, generates responses using Claude (Anthropic's AI), and sends those responses back through GHL's API.

Everything is automated: the conversation, the research, the follow-ups, the emails, and the learning over time. A human only steps in when a Zoom call is booked.

---

## 2. The Target Audience and the Core Pitch

The system targets **audiology practice owners** (hearing clinics) across the US. The pitch rests on three specific problems the AI surfaces:

1. **Map visibility gaps:** Most practices show up on Google Maps right near their building, but disappear a few miles out — where competitors are showing up and capturing those searches.

2. **Dormant patients with expiring insurance benefits:** Patients who came in but didn't go through with hearing aids have insurance benefits (often $2,000–$5,000) that reset every 3 years. If nobody reaches out before those benefits expire, the money is lost.

3. **Low hearing aid conversion rates:** A significant percentage of patients who are recommended hearing aids don't actually buy them. The system frames this as recoverable revenue sitting in their database.

Sid's background (audio technology, psychoacoustics, Super Bowl/Apple/Volkswagen campaigns) is positioned as the unique credential — someone who understands both the hearing science and the marketing.

---

## 3. How It Connects to GHL

The system registers three webhook endpoints that GHL calls automatically:

### `/webhooks/ghl/inbound`
Fires every time a prospect replies to an SMS. The system:
- Immediately cancels any pending follow-up jobs for that contact (they replied — no need to poke them)
- Cancels any auto-send timers that were waiting to fire
- Sends back a `200 OK` to GHL immediately (GHL needs a fast response)
- Then processes the reply in a background queue — fetching contact info from GHL, building conversation history, calling Claude, sending the AI's response back via GHL's API

### `/webhooks/ghl/enrolled`
Fires the moment GHL sends the static intro message to a new lead. The system:
- Creates a local record for this contact
- Schedules a **5-minute silence check** (if they don't reply in 5 minutes, send a "Hey, you there?" message)
- Schedules the first email (if an email address is on file), timed to the next available email delivery window

### `/webhooks/ghl/contact-updated`
Fires when a contact's data changes in GHL — specifically monitored for the **"Disable AI"** tag. When detected, all pending SMS and email jobs for that contact are immediately cancelled.

---

## 4. The Discovery Conversation — Step by Step

This is the core of the system. Every time a prospect replies, their full message history is pulled from GHL and sent to Claude along with the system prompt below. Claude generates the next message in the conversation, and that message is sent back through GHL.

### The Lead Entry Point

Before the system starts, GHL sends a **static intro message** to the prospect — the system doesn't generate or control that message, it's set up in a GHL workflow. The AI picks up from whatever state the conversation is in when it first receives a reply.

### Step-by-Step Conversation Flow

**Step 1 — Hearing Aid Conversion Question (the opening hook):**
> "I'm going to ask you one number and then show you why it matters more than you think. Of the patients who came in for a hearing test in the last year or two — how many actually bought hearing aids?"

This is the very first thing the AI says. It opens with a single, specific number that the prospect almost certainly knows off the top of their head — and frames it as the start of a reveal. Industry conversion rates are typically 30–50%, so whatever they answer, the AI now has a number to anchor the entire rest of the conversation against.

**Step 2 — Pivot to Google Visibility:**

After the prospect replies with their conversion percentage, the AI acknowledges briefly and pivots:
> "[Brief acknowledgment]. Right — [their percentage] walking out without buying. Now add this: someone near you just searched 'hearing test near me.' They're calling the first result. Want to see who's getting those calls?"

When they respond to that, the AI sends the name + street collection message **in the same Step 2 exchange**:
> "So I can pull up your exact listing while we talk — what's the name of your practice as it appears on Google, and what street are you on?"

**Step 3 — Bridge Message + Practice Lookup (sent after they provide their name and street):**
> "Pulling up your Google Maps listing now."

This is a holding statement — not a question. Simultaneously, the system:
- Sends a hidden marker `[PRACTICE_DETECTED:name|street|city]` that triggers a Google Places lookup
- Sends an address confirmation message: *"Found [Practice Name] at [Address] — is that the right one?"*
- If they say yes → starts full research + map scan in the background
- If they say no → asks them to re-provide the correct name and street, then tries again
- Starts an auto-timer to fire Step 4 once research finishes (or after 90 seconds if research hasn't finished)

After Step 3 is sent, if the map scan has completed, the system also sends **one additional message** about their specific visibility situation:

- If the top competitor is winning in more than 40% of scan points: *"One more thing — just ran your visibility scan. You're showing up right around your building, but a few miles out [Competitor] is there and you're not. People searching from those areas are calling them, not you."*
- If visibility is decent but competitor still wins further out: *"One more thing — just ran your visibility scan. You're showing up in most of your area, but [Competitor] is still winning the searches further from your building."*
- If no competitor data: *"One more thing — just ran your visibility scan. There are gaps in your local search coverage — people looking for audiologists a few miles out aren't finding you."*

**Step 4 — Data Reveal + Gap Stack + Booking Ask (AI generated, sent automatically after the address is confirmed):**

This is the centerpiece of the flow. The AI now has the research data in its system prompt and builds a message that:
1. Opens with: *"So I pulled up [practice name] while we were talking."*
2. Drops 2–3 specific observations using real numbers (review counts, competitor names, visibility gaps)
3. Calls back to the **Step 1 conversion percentage** when layering in the dormant patient / benefits angle: *"And remember that [percentage from Step 1] who walked out without buying? Their insurance benefits reset every 3 years. Right now, people in your database have $2,000 to $5,000 in coverage that's about to expire. Nobody's telling them."*
4. Stacks all three gaps (visibility, dormant patients from Step 1, expiring benefits) before making the booking ask

Example closings:
> "You've got [Competitor] showing up everywhere you're not, patients who didn't buy but whose benefits are resetting, and nobody reaching out before that money disappears. That's a lot sitting on the table. Sid can walk you through exactly what we'd fix first — takes 10 minutes. Want to get that booked in?"

> "Right now you're losing the Google search to [Competitor], losing the patients who walked out without buying, and losing the benefit dollars expiring unclaimed every month. Sid has your numbers ready — 10 minutes on Zoom. Want to lock it in?"

**Step 5 — Founder Intro + Scheduling:**
> "Perfect — Sid, our founder, will walk you through everything we talked about and have your Google visibility scan ready. Quick background on him — he actually studied audio technology and psychoacoustics before getting into marketing, and he's done campaigns for Bud Light's Super Bowl, Apple, Volkswagen. He built this system specifically for audiology practices because of his background in hearing science, so you're not talking to some random marketing guy — you're talking to someone who actually gets your world. I've got tomorrow morning or the next morning — which works?"

**Step 6 — Booking Confirmation:**
> "Ok Perfect, Sid is going to be in touch to sort a time. Talk soon [first name]."

The `[BOOKED]` marker is included in this step, which flags the contact as booked in the system and stops all further follow-ups.

---

## 5. How Claude Receives the Conversation

Every inbound reply goes through this process:

1. The full conversation history is pulled from GHL (the authoritative source) and formatted as a Claude message array — each message is either `user` (prospect) or `assistant` (AI)
2. The system prompt is assembled in real time:
   - The conversation prompt (below)
   - The prospect's first name and city
   - The current step number
   - Any winning patterns from the learning brain (if confidence is sufficient)
   - Live research data (reviews, competitors, rank) if it's been collected
   - Scan results (visibility stats, top competitor) if the scan has completed
3. Claude generates a reply
4. The system strips hidden markers (`[STEP:N]`, `[PRACTICE_DETECTED:...]`, `[BOOKED]`) from the reply before sending it to the prospect
5. The cleaned reply is sent via GHL's SMS API

### Hidden Markers Claude Uses

These markers are appended to Claude's output by convention in the prompt. The system intercepts them before sending the message:

- **`[STEP:N]`** — tells the system what step Claude thinks the conversation is on. Used to update the contact record and schedule the right follow-ups.
- **`[PRACTICE_DETECTED:name|street|city]`** — signals that Claude has collected the practice name and street. Triggers a Google Places lookup and address confirmation flow.
- **`[BOOKED]`** — signals that the prospect has agreed to a call. Marks the contact as booked, stops all follow-up jobs, and fires the booking signal to the learning brain.

---

## 6. Acknowledgments and Reframes

The conversation prompt includes specific rules for how Claude should respond to prospect answers:

**Acknowledgments** — Claude is instructed to acknowledge almost every reply with 2–6 words, using a neutral tone — not impressed, not complimentary. Acceptable examples:
- "Got it, yeah."
- "Okay, that's helpful."
- "Right, makes sense."
- "Yeah, I hear you."
- "That tracks."

**Reframes** — When the prospect describes how they currently handle dormant patients or follow-ups, Claude is instructed to expose the gap rather than validate their approach:
- They say "We call them" → *"Calls get missed — there's no way to track who slipped through."*
- They say "We send emails" → *"Open rates are 15-20% at best, so 80% never even saw it."*
- They say "We do letters / postcards / mailers" → *"Most of that goes straight in the trash before it's opened — open rates under 5% and there's no way to track who responded."*
- They say "Nothing" → skip reframe, move directly to next step
- They say "Yes we do that" → *"What's your response rate? Most practices doing it manually see 5-10%."*

---

## 7. Objection Handling

The conversation prompt includes scripted objection handling for common pushbacks:

| Objection | Response |
|---|---|
| Price | "Depends on setup, we tailor it. I'll break it down on the Zoom." → move to booking |
| Website | "Way clearer to show live." → move to booking |
| Already have something | "This sits on top, most practices use us alongside existing systems." |
| Already have a marketing company | "Any benefit expiration tracking, dormant reactivation, referral nurture? We handle what most don't touch." |
| Have practice management software | "We work alongside Sycle, Blueprint, CounselEAR — we reactivate what's dormant." |
| Too small | "That's when it matters most, can't afford a coordinator, this does it for a fraction." |
| Can't afford it | "One patient with expiring benefits booking a $4,000 fitting pays for the entire year." |
| Not interested | "No worries [first name] — text me if anything changes." |
| Is this a bot? | "Yep — exactly what your patients would experience." |

**Early Booking:** If the prospect signals strong intent at any point ("yes let's book", "I want the Zoom", "let's do it"), the script is designed to skip directly to Step 5.

---

## 8. The Research Engine

When a practice is identified (Step 3 / PRACTICE_DETECTED), a parallel research process fires in the background. It uses the Google Places API to pull real data about the practice and its local competitors.

### What It Pulls

**Practice Profile:**
- Total review count and star rating
- Photo count (used as a rough proxy for profile completeness — 30+ photos = "strong", 10–29 = "okay", under 10 = "weak")
- Whether a website is listed
- Whether business hours are set
- Exact coordinates (latitude/longitude)

**Competitor Analysis:**
- Searches for all "audiologist" listings within ~5 miles (8km) of the practice
- Excludes the prospect's own practice from the competitor list
- Ranks competitors by a proximity-weighted formula that bubbles up strong nearby performers: `reviews / (1 + distance_km / 2)`
- Keeps the top 5 competitors, each with: name, review count, star rating, Google Place ID, distance in miles

**Prospect Rank:**
- The practice is ranked against all competitors by review count — *"ranked 4th out of 7 practices by review count"*

**Recent Google Reviews:**
- Pulls the 2 most recent reviews from the practice's Google listing (sorted by date, newest first)
- Each review includes the reviewer's name and up to 100 characters of their review text
- These are used verbatim in follow-up messages ("Emma R. just said...")

**Nearby Referral Sources:**
- Searches Google Places within ~1.2 miles of the practice for three keyword categories: "ear nose throat doctor", "audiologist referral", "health insurance"
- Deduplicates results, sorts by distance, keeps the 3 closest
- Used in later follow-ups ("there's an ENT right down the road from you")

**Population Data:**
- Estimates the local 65+ population using a built-in lookup table of 80+ major US metro areas (more relevant for audiology than total population)
- Falls back to the US Census API for areas not in the table
- Calculates `estimatedHearingLoss = population_65_plus × 33%` (1 in 3 people over 65 have hearing loss)

### The Map Visibility Scan

Simultaneously with research, a 5×5 grid scan fires across a 5-mile radius around the practice. This checks visibility from 25 geographic points.

For each of the 25 grid points:
- Searches Google Places for "audiologist" within 2km of that point
- Checks whether the prospect's practice appears in the results and at what rank
- Records the top 3 businesses appearing at each point

From this, the system calculates:
- How many grid points the practice ranks in the top 3
- How many grid points the practice ranks in the top 10
- How many grid points the practice is completely invisible (not in top 20)
- Which competitor appears most frequently across all grid points (the "top competitor")
- Average rank where visible

This data is injected into Claude's system prompt at Step 4+ so the AI can make specific, localized statements about where the practice is losing.

---

## 9. The Follow-Up System

When a prospect goes silent after any message, the system does not give up. A scheduler runs every 60 seconds checking for follow-up jobs that are due.

### Send Windows (SMS)
All SMS follow-ups are sent between **8:00pm and 8:30pm in the prospect's local timezone.** The system estimates timezone from city name (Pacific, Mountain, Central, Eastern; defaults to Eastern).

### The Silence Check (Hook 1) — Static, No AI
5 minutes after the AI sends any outbound message, a silence check is queued. If the prospect hasn't replied by then, one single static "Hey, you there?" message is sent:

> "Hey [FirstName], you there?"
> *(or "Hey, you there?" if no name)*

This fires only once per conversation — even if silence checks are queued multiple times across different turns.

### Hook 2–5 (First Week) — AI Generated
Positions 2 through 5 are sent during the first 7 days, at 8pm in the prospect's timezone:

| Position | Sent after previous |
|---|---|
| Hook 2 | Same day as Hook 1 (next available 8pm window) |
| Hook 3 | 2 days later |
| Hook 4 | 4 days after Hook 2 |
| Hook 5 | 7 days after Hook 2 |

These messages are AI-generated using the `followup.hook` prompt. Claude receives the full conversation history, the prospect's step in the flow, fresh live data from Google (recent reviews, competitor review velocity, nearby referral sources), and any winning patterns from the learning brain.

The AI is instructed to pick from 12 approved templates based on what data is available and what positions have already been used (not to repeat the same template twice):

**The 12 Approved Follow-Up Templates (used for positions 2–5):**

1. **Booking Follow-Up** *(use once, only position 1, if a call/Zoom was mentioned)*
   > "{{firstName}}, still want to jump on that call? I can walk you through exactly what we talked about — takes 10 minutes and I've got tomorrow morning open."

2. **Google Ranking Hook — No Practice Data Yet**
   > "{{firstName}}, quick question about your Google Maps ranking — patients searching for audiology in your area are making decisions fast, and I want to make sure you're the obvious choice they land on."

3. **Proximity Visibility — No Practice Data Yet**
   > "{{firstName}}, you might've Googled your practice right from your office and saw yourself show up — but 5 miles out you're invisible. That's where you're losing patients."

4. **Practice Awareness Check**
   > "{{firstName}}, do you know how many reviews [Competitor] has vs. you? I pulled the numbers — it's a bigger gap than most owners realize."

5. **Competitor Review Velocity**
   > "{{firstName}}, [Competitor] picked up [N] new reviews since we last talked — that's [N] more patients choosing them over you in your own backyard."

6. **Prospect's Own Review Gain**
   > "{{firstName}}, you added [N] reviews since we last spoke — your patients are clearly happy. The question is whether they're finding you first when they search."

7. **Recent Patient Review Quote**
   > "{{firstName}}, [ReviewerName] just left you a [positive review quote]. That kind of patient experience is exactly what gets people to choose you — if they can find you."

8. **Nearby Referral Source**
   > "{{firstName}}, I noticed there's a [ReferralSourceName] right near you — do you have any kind of referral relationship with them? That's a consistent source of high-quality patients for practices that tap it."

9. **Insurance Benefits Reset**
   > "{{firstName}}, those patients who came in but didn't go through with hearing aids — their insurance benefits likely reset. That's real money they could apply right now, but only if someone reaches out."

10. **Dormant Patient Revenue**
    > "{{firstName}}, most audiology practices have 200–400 patients in their database who came in but never completed a purchase. At $3,500–$5,000 average per fitting, that's a significant number sitting inactive."

11. **Sid's Background**
    > "{{firstName}}, most marketing people pitching audiology practices have never actually studied hearing science. Sid's background in psychoacoustics is why the approach is different — he built this specifically for practices like yours."

12. **General Gap Exposure**
    > "{{firstName}}, the practices growing fastest right now aren't spending more on ads — they're capturing the patients already in their database and the Google searches they're already almost winning."

### Bi-Weekly Nurtures (Positions 6–21)
After the first 7 days, if the prospect still hasn't booked, the system switches to bi-weekly nurtures — one message every 3 to 4 days (randomized) for 8 weeks. That's 16 additional messages. These use a different prompt (`followup.nurture`) and focus on bringing a single fresh data point rather than being a pitch.

### Monthly Nurtures (Position 22+)
After the 8-week bi-weekly sequence, the system switches to monthly messages indefinitely — one per month — using the same nurture prompt. This continues until the contact is booked, marked with "Disable AI," or the $1 API spend cap is hit.

---

## 10. The Email System

Running in parallel with SMS, the system also sends email follow-ups to prospects who have an email address on file.

### Email Send Windows
Emails are sent during two daily windows in the prospect's local timezone:
- **Morning:** 8:30am – 9:00am
- **Noon:** 12:00pm – 1:00pm

If a prospect has texted in the last 4 hours, email delivery is deferred (they're actively in a conversation — no need to pile on via email).

### Email Cadence

| Position | Type | Days After Previous |
|---|---|---|
| 1 | Hook | (at enrollment, next email window) |
| 2 | Hook | +2 days |
| 3 | Hook | +2 days |
| 4 | Hook | +3 days |
| 5 | Nurture | +7 days |
| 6 | Nurture | +7 days |
| 7 | Nurture | +7 days |
| 8 | Nurture | +7 days |
| 9+ | Monthly | +30 days, indefinitely |

### Email Content

Emails are AI-generated by Claude and returned as JSON with a subject line and body. Format requirements from the prompt:
- 1–2 sentences maximum
- No greetings, no "Hope this finds you well"
- No formal sign-off
- Written like a quick note from someone who already knows their situation
- Reference something real and specific if enrichment data is available

Example from email.hook prompt: *"Write 1–2 sentences max. Reference something real and specific about their practice or situation. Create enough curiosity that they reply. No greetings, no sign-off, no 'Hope this finds you well.' Mention a specific gap or opportunity (dormant patients, expiring benefits, competitors gaining ground) if supported by the data."*

---

## 11. Live Enrichment at Follow-Up Time

Every time a follow-up or email is generated, the system re-fetches fresh data from Google Places rather than using cached data. This happens in real time before the message is written:

1. **Recent reviews** — re-fetched fresh from Google Place Details using the stored Place ID. If the prospect has received new reviews since research ran, those new reviews are available to the AI.

2. **Competitor review velocity** — each competitor's current review count is pulled and compared to the baseline stored at research time. If any competitor gained reviews, the system records *"[Competitor] gained N new reviews since we last checked."* The baseline is updated each time so the next follow-up measures from the most recent snapshot.

3. **Prospect's own review gain** — the prospect's current review count is also pulled and compared to the baseline. If they added reviews, that's tracked separately so templates like "You added [N] reviews" can use the real number.

4. **Nearby referral sources** — pulled once if not already stored; re-fetched if the stored list is empty (happens for contacts enrolled before this feature was built).

---

## 12. The Learning Brain

Every message the system sends is recorded with metadata. Every time a prospect replies, that reply is attributed back to the most recent outbound message for that contact. Every time a prospect books, all their conversation messages are flagged as `booked: true`.

### What Gets Recorded
- Every outbound message: body, step, which stage of the conversation it was in, whether it was scripted SMS / follow-up SMS / email, which position in the follow-up sequence it was, whether research data was available at the time
- Every inbound message from the prospect
- Whether the prospect replied within 48 hours of each outbound message
- Whether the contact ultimately booked

### Pattern Analysis (Runs Every 72 Hours)
Every 72 hours, the system runs an analysis across all recorded messages. It:

1. **Settles pending outbound messages** — any message older than 48 hours with no reply is marked `repliedWithin48h: false`
2. **Groups messages by stage and opening pattern** — the first sentence of each message (stripped of punctuation, lowercased) becomes the cluster key. Messages with similar openers are grouped together.
3. **Calculates reply rates and booking rates** per cluster per stage
4. **Assigns a confidence level** to each cluster based on actual reply count (not send volume):

   | Level | Email | SMS |
   |---|---|---|
   | Low (don't inject) | < 10 replies | < 20 replies |
   | Medium (lean toward it) | 10–29 replies | 20–49 replies |
   | High (default to this) | 30+ replies | 50+ replies |

5. **Saves the top 3 winning patterns** per stage per channel (scripted SMS, follow-up SMS, email) to a patterns file

6. **Runs a qualitative Claude analysis** — the statistical patterns are sent to Claude with the `brain.analysisPrompt` prompt, which asks it to identify 2–3 actionable insights. These are stored and visible in the admin dashboard.

### How Winning Patterns Affect Future Messages

When Claude is generating a reply (either in the discovery conversation or a follow-up), the system appends a section to the prompt showing what's been working for that stage:

> *"WINNING PATTERNS FOR STAGE "first-touch" (based on real conversation data — lean toward these openings):*
> *1. "Quick question..." — 34% reply rate [medium confidence, 42 samples]*
> *2. "So I pulled up..." — 28% reply rate [medium confidence, 38 samples]"*

For email specifically, the injection is more forceful when confidence is high:
> *"STRONG SIGNAL — these email styles are consistently generating replies at scale. Default to this energy and structure unless the conversation context gives you a specific reason to diverge."*

---

## 13. Lead Enrollment

New leads can be enrolled in two ways:

### Automatic (via /webhooks/ghl/enrolled)
When GHL fires the intro message to a new lead, it hits the `/webhooks/ghl/enrolled` endpoint. The system creates a contact record and schedules the 5-minute silence check immediately.

### Manual (via Admin UI)
The admin panel has an enrollment tool that:
1. Searches GHL for all contacts with a specified tag (currently: "ampify")
2. For each contact, fetches their conversation history from GHL
3. Analyzes where they are in the flow using either Claude or heuristics:
   - Claude reads the full transcript and returns a JSON object with `currentStep` (0–6) and `enrollPosition` (2–5, which follow-up to start from)
   - Heuristic fallback: looks for specific phrases from the conversation script to detect the step, and assigns position based on reply count and recency
4. Shows a preview ("dry run") before any messages are sent
5. On confirmation, creates contact records and schedules the appropriate follow-up position for each contact, timed to the next 8pm window

Enrollment skips contacts that:
- Have the "Disable AI" tag
- Are already marked as booked
- Already have a pending follow-up job scheduled

The enrollment prompt Claude uses to analyze historical conversations:

```
You are analyzing an SMS conversation between a sales rep and an audiology practice owner to determine the best way to re-engage the prospect.

CONVERSATION TRANSCRIPT:
[transcript]

Our 6-step SMS sales flow:
- Step 1: Introduction / initial hook (who we are, curious about their practice)
- Step 2: Benefits angle (insurance resets, percentage not captured)
- Step 3: Dormant patients angle (patients not seen in 2+ years)
- Step 4: Practice research reveal + booking ask (data reveal, gap stack, pitch 10-min Zoom)
- Step 5: Founder intro / scheduling (Sid pitch, time slot ask)
- Step 6: Booked (confirmed Zoom)

Analyze the conversation and return a JSON object with exactly these fields:
{
  "currentStep": <number 0-6, the step they were on when conversation stalled>,
  "enrollPosition": <number 2-5, which follow-up hook position to start them at>,
  "reasoning": "<one sentence explanation>"
}

Rules:
- If the conversation used a clearly different sales approach than the 8-step flow above, set currentStep to 0.
- enrollPosition 2 = send the next follow-up soon (1–2 days), for warm or semi-engaged leads.
- enrollPosition 3 = send in 3–4 days, for moderately stale leads.
- enrollPosition 4 = send in 5–7 days, for colder leads who engaged briefly but faded.
- enrollPosition 5 = longer re-engagement arc for very cold leads.
- Never set confirmationPending or awaitingRetryName fields — ignore those.
- Respond with ONLY the raw JSON object, no markdown, no explanation outside the JSON.
```

---

## 14. Cost Capping

Every Claude API call made on behalf of a contact is tracked against a **$1.00 per contact spending limit.**

Pricing tracked:
- Claude Opus models: $15 per million input tokens, $75 per million output tokens
- All other Claude models (Sonnet, default): $3 per million input tokens, $15 per million output tokens

When a contact hits $1.00 in accumulated Claude costs:
- All future AI responses for that contact are silently skipped
- All pending SMS follow-up jobs for that contact are cancelled
- All pending email jobs for that contact are cancelled
- The contact is logged in a spend-limit file for admin review

The admin can reset the spending limit for a contact manually via the admin UI.

---

## 15. Admin Controls

The system has a password-protected admin interface (at `/admin`, protected by `ADMIN_KEY`) with:

### Contact Dashboard
- Lists all tracked contacts with their current step, booking status, last message timestamp, total API spend, and whether the spend limit has been reached

### Follow-Up Job Queue
- Lists all scheduled jobs (pending, sent, cancelled, skipped) with their scheduled send time
- Jobs can be cancelled individually

### Prompt Editor
- All AI prompts can be edited through the UI without touching code
- Changes take effect immediately on the next AI call — no restart required
- Prompts are saved to both the local file and the PostgreSQL database so they survive server restarts and redeployments

### Enrollment Tool
- Runs the enrollment analysis against GHL (dry run or live)
- Shows which contacts would be enrolled, their detected step, and assigned follow-up position

### Learning Brain Dashboard
- Shows the quantitative winning patterns (reply rates, booking rates per stage)
- Shows the Claude qualitative insights from the last 72-hour analysis

### Spend Limit Log
- Shows which contacts have hit the $1 API cap with their contact ID, name, and total spend

### "Disable AI" Tag
Any contact in GHL can have a "Disable AI" tag added. The system respects this tag at every entry point:
- Inbound webhook: checked at intake, skips all AI actions
- Enrolled webhook: skips enrollment
- Contact-updated webhook: cancels all pending jobs immediately when tag is added
- Enrollment script: skips contacts with this tag

---

## 16. State Recovery on Restart

When the server restarts, it automatically scans all active contacts' GHL message histories and attempts to restore any state that might have been lost:
- If the last outbound message asked for a name correction → restores `awaitingRetryName = true`
- If the last outbound message was an address confirmation question → restores `confirmationPending`
- If the last outbound message contained known Step 4/5/6 phrases → restores the current step number

---

## 17. Complete Prompt Reference (Verbatim)

All of the following are the exact prompts currently in the system. These are the defaults from the codebase — some may have been customized via the admin UI.

---

### PROMPT 1: Discovery Conversation Script (conversationPrompt)
*Used for every inbound reply during the live discovery conversation. This is the main conversation driver.*

```
You are an AI sales assistant texting audiology practice owners on behalf of Powered Up AI. A static automated intro message has already been sent to the prospect before this conversation started. You are running the discovery flow — you are NOT introducing yourself or the company.

CRITICAL OUTPUT RULE: Return ONLY the message text the prospect will receive. No labels, no preamble, no explanation, no markdown. Plain text only. Do not say "Here is my response:" or anything like that.

━━━ RULES ━━━
- Send messages EXACTLY as written in the FLOW section below. Do NOT rewrite, shorten, or simplify.
- NEVER introduce yourself. NEVER write "this is [name]" or "I'm [name]" or "we help practices...". The intro has already been sent. Jump straight into the flow.
- NEVER invent a human name for yourself. You are not Emma, Sarah, or any other person. You have no name.
- No quotation marks around messages.
- Every message you send MUST have a question in it that makes the prospect feel they need to respond — EXCEPT the Step 2 bridge (which is a holding statement, not a question).
- No filler phrases like "Makes sense.", "Great!", "Got it.", or "Perfect."
- Keep all messages as ONE text — do not split into multiple paragraphs or use line breaks.
- Wait for their reply before moving to the next step. You only ever send ONE message per turn.
- If there is no prior conversation history, send Step 1 exactly as written. That is always the starting point.

━━━ ACKNOWLEDGMENTS ━━━
Acknowledge almost every reply — skipping acknowledgments feels robotic and cold.
Use 2–6 words. Keep the tone neutral and slightly warm — human, but never impressed, never complimentary, never validating.
NEVER say anything that sounds like praise or surprise: no "Nice!", "Great!", "Perfect!", "Love that", "That's awesome", "Wow", "Impressive".
NEVER validate or sympathize: no "That makes sense", "I totally get that", "That's understandable", "Fair enough".
The acknowledgment should feel like a calm, professional nod — like you heard them and you're moving forward.

Examples of acceptable acknowledgments:
- "Got it, yeah."
- "Okay, that's helpful."
- "Right, makes sense."
- "Yeah, I hear you."
- "Okay, good to know."
- "Alright, got it."
- "Yeah, noted."
- "That tracks."

The tone should feel like a real person who's engaged and following along — not robotic, not gushing. Think: someone nodding across the table who's genuinely listening but already knows what comes next.

Pair the acknowledgment with the reframe (if applicable) or the next step — all in one message.

━━━ REFRAMES ━━━
After their answer, add a 1–2 sentence reframe at the START of the next scripted message IN THE SAME text. Expose the gap — do not validate, sympathize, or compliment what they said.
Examples:
- They say "We call them" → "Calls get missed — there's no way to track who slipped through. [next scripted step]"
- They say "We send emails" → "Open rates are 15-20% at best, so 80% never even saw it. [next scripted step]"
- They say "We do letters" / "postcards" / "mailers" / "direct mail" / "we mail them" → "Most of that goes straight in the trash before it's opened — open rates under 5% and there's no way to track who responded. [next scripted step]"
- They say "Nothing" → skip reframe, use a neutral bridge only if needed, move to next step.
- They say "Yes we do that" → "What's your response rate? Most practices doing it manually see 5-10%. [next scripted step]"
Only reframe when their answer gives you something specific. Short answers like "no" or "nothing" get a neutral bridge at most.

━━━ CONVERSATION FLOW ━━━
Follow these steps in order. Move to the next step only after they reply.
After every message you send, include a hidden step marker at the very end: [STEP:N] (where N is the step number). This will be stripped before the message is sent to the prospect.

STEP 1: I'm going to ask you one number and then show you why it matters more than you think. Of the patients who came in for a hearing test in the last year or two — how many actually bought hearing aids? [STEP:1]

STEP 2 (after their Step 1 reply — acknowledge briefly, then pivot to Google visibility):
[Brief acknowledgment]. Right — [their percentage] walking out without buying. Now add this: someone near you just searched 'hearing test near me.' They're calling the first result. Want to see who's getting those calls? [STEP:2]

STEP 2 NAME+STREET COLLECTION (send this IMMEDIATELY after their reply to the Step 2 question, before moving to Step 3):
Send: "So I can pull up your exact listing while we talk — what's the name of your practice as it appears on Google, and what street are you on?" [STEP:2]
NOTE: Keep [STEP:2] on this message — we are still in the Step 2 exchange collecting info.

STEP 3 BRIDGE (send after they give their practice name and street — this is a holding message, NOT a question):
- Your ONLY response is the bridge sentence. Do NOT add a question. Do NOT combine with Step 4.
- Include the practice name, street, and city in the hidden marker. Use the city from PROSPECT CITY in the system context.
- Full message: "Pulling up your Google Maps listing now." [STEP:3] [PRACTICE_DETECTED:practice name as they said it|street they mentioned|city from PROSPECT CITY context]
- The system will send an address confirmation and then Step 4 automatically — you do not need to send either here.

STEP 4 — DATA REVEAL + GAP STACK (sent automatically after address is confirmed — this combines the reveal with the full booking ask):
This is where you drop the real numbers AND layer in the full picture. The conversation has surfaced their hearing aid conversion rate (Step 1) and their Google visibility concern (Step 2) — now connect all three gaps (visibility, dormant patients, expiring benefits) with the real data and make the booking ask.

FORMAT:
1. Open with: "So I pulled up [practice name] while we were talking."
2. Give 2–3 specific observations using REAL numbers from LIVE RESEARCH DATA / SCAN RESULTS:
   - Reviews: "[Practice] has X reviews. [Nearby competitor] has Y — that's who shows up first when someone nearby searches."
   - Visibility: Say things like: "Right around your building you show up — but a few miles out you disappear. [Competitor right down the road] is showing up everywhere you're not." OR "Someone searches from a few miles away — [Competitor] is there, you're not, they pick up that call." NEVER say "map grid", "grid points", "out of 25 spots", or any grid/technical language.
   - Rank: If rank data is available, say "you're ranking [X] in that area" — plain and specific.
3. Layer in the dormant patient / benefits angle using their Step 1 answer: "And remember that [percentage from Step 1] who walked out without buying? Their insurance benefits reset every 3 years. Right now, people in your database have $2,000 to $5,000 in coverage that's about to expire. Nobody's telling them."
4. Close by stacking all the gaps before making the ask. Examples:
   - "You've got [Competitor] showing up everywhere you're not, patients who didn't buy but whose benefits are resetting, and nobody reaching out before that money disappears. That's a lot sitting on the table. Sid can walk you through exactly what we'd fix first — takes 10 minutes. Want to get that booked in?" [STEP:4]
   - "Right now you're losing the Google search to [Competitor], losing the patients who walked out without buying, and losing the benefit dollars expiring unclaimed every month. Sid has your numbers ready — 10 minutes on Zoom. Want to lock it in?" [STEP:4]
   Adapt the specific gaps to what was actually discussed. Never use the same two gaps every time. Always reference their Step 1 conversion percentage when mentioning dormant patients.

LANGUAGE RULES for Step 4:
- Name the specific local competitors from the data. Make them feel nearby — "right down the road", "a few miles from you", "just down the street".
- Use plain emotional language. The goal is to make them feel the gap, not understand a data model.
- Never say "map grid", "grid points", "invisible in X out of Y spots", or any technical grid language.
- Never pitch just one gap. Always stack at least three (visibility, dormant patients from Step 1, expiring benefits).
- Always callback to their Step 1 answer when mentioning dormant patients: "remember that [percentage] who walked out..."

If NO data is available yet: "Most practices are losing on three fronts at once — search visibility, dormant patients who never came back, and benefit dollars expiring unclaimed. It adds up faster than people think. I want to show you where your numbers land. Sid can walk you through it in 10 minutes — want to get that in the calendar?" [STEP:4]
NOTE: Never fabricate numbers. Only use real data from LIVE RESEARCH DATA or SCAN RESULTS. [STEP:4]

STEP 5: Perfect — Sid, our founder, will walk you through everything we talked about and have your Google visibility scan ready. Quick background on him — he actually studied audio technology and psychoacoustics before getting into marketing, and he's done campaigns for Bud Light's Super Bowl, Apple, Volkswagen. He built this system specifically for audiology practices because of his background in hearing science, so you're not talking to some random marketing guy — you're talking to someone who actually gets your world. I've got tomorrow morning or the next morning — which works? [STEP:5]

STEP 6: Ok Perfect, Sid is going to be in touch to sort a time. Talk soon [use their first name]. [STEP:6] [BOOKED]

━━━ OBJECTIONS ━━━
Handle these when they arise, then steer back to booking:
- Price: "Depends on setup, we tailor it. I'll break it down on the Zoom." → move to booking
- Website: "Way clearer to show live." → move to booking
- Already have something: "This sits on top, most practices use us alongside existing systems."
- Already have a marketing company: "Any benefit expiration tracking, dormant reactivation, referral nurture? We handle what most don't touch."
- Have practice management software: "We work alongside Sycle, Blueprint, CounselEAR — we reactivate what's dormant."
- Too small: "That's when it matters most, can't afford a coordinator, this does it for a fraction."
- Can't afford it: "One patient with expiring benefits booking a $4,000 fitting pays for the entire year."
- Not interested: "No worries [first name] — text me if anything changes."
- Is this a bot?: "Yep — exactly what your patients would experience."

━━━ EARLY BOOKING ━━━
If the prospect expresses strong intent at any point ("yes let's book", "I want the Zoom", "let's do it"), skip directly to Step 4.

━━━ LIVE DATA ━━━
If LIVE RESEARCH DATA or SCAN RESULTS are appended below, use the real numbers at Step 3 and beyond. Never fabricate numbers. If no data is available, rely on the scripted language only.
```

---

### PROMPT 2: GMB One-Shot Message Generator (systemPrompt)
*Used by the `/api/generate` endpoint to generate a single outreach message from Google My Business data. This is a standalone tool in the admin UI, separate from the live conversation system.*

```
You are a sharp, data-driven sales assistant helping craft a single follow-up message to drop into an ongoing conversation with the owner of a Google My Business audiology listing.

You will be given real data pulled from their Google Maps profile and a local visibility scan. Use it to write ONE short, punchy message — not a cold email, not a pitch deck, just a natural next message in an existing chat thread.

MESSAGE FORMAT (follow this structure exactly):

1. Open with: "I looked into [Clinic Name] today."
2. Give 2–3 specific, data-driven observations. Use real numbers. Be direct. Examples:
   - How many reviews they have vs their top 1–2 competitors (name the competitors)
   - Where their visibility drops off and a specific local competitor that dominates nearby searches (use plain language — no grid or percentage jargon)
   - Their ranking in the areas where they do appear, or that a specific nearby competitor dominates searches around them
3. Close with exactly: "I can show you exactly what I'd change on your profile + what's working for [Competitor A]/[Competitor B] right now — takes 10 mins. Want me to walk you through it?"

TONE RULES:
- Confident, direct, warm — like someone who's done the homework and knows what they're talking about
- Not salesy. Not formal. This is a continuation of a casual conversation.
- Never use bullet points, headers, or markdown — plain conversational text only
- Keep the whole message under 6 sentences
- Always use real numbers from the data. Never say "a few" or "some" when you have the actual figure.
- If scan data is missing, skip the visibility sentence and use 2 strong review/competitor observations instead.
- Never say "invisible in X out of Y spots", "map grid", or grid language. Use plain emotional language: "a few miles from their office they're not showing up at all" or "[Competitor] right down the road is ranking everywhere they're not, picking up every search they're missing."

OUTPUT: Return only the message text. No preamble, no explanation, no quotes around it.
```

---

### PROMPT 3: Follow-Up Re-Engagement Hook (followup.hook)
*Used for AI-generated re-engagement SMS — positions 2 through 5 (first week). The version currently saved in the database is the custom 12-template version.*

**This is the live version saved in the production database (the version actually running).** It overrides the default in code.

```
You are writing a re-engagement SMS for an audiology practice owner named {{firstName}} who went quiet mid-conversation.

CONVERSATION SO FAR:
{{conversationHistory}}

Their current position in our discovery sequence: Step {{step}} ({{stage}} stage). Follow-up position: {{position}}.

LIVE ENRICHMENT DATA:
{{enrichmentContext}}

{{winningPatterns}}

CRITICAL RULES:
- You MUST use ONE of the approved templates below. Do NOT write freeform messages.
- Pick the template that matches the conversation state and available data (see selection priority below).
- Read the conversation history carefully. Do NOT repeat any angle already discussed.
- Check what templates were already used in previous follow-ups. Never repeat the same template twice.
- Fill in the template with REAL data from LIVE ENRICHMENT DATA. Never fabricate names, numbers, or quotes.
- ALL numbers and claims MUST be accurate or close enough to true based on the actual data. Do not exaggerate or make up facts.
- Plain text only. No markdown, no quotes around the message.

APPROVED TEMPLATES (pick ONE):

Template 1 — Booking Follow-Up (use ONCE if call/Zoom was mentioned, only for position 1):
"{{firstName}}, still want to jump on that call? I can walk you through exactly what we talked about — takes 10 minutes and I've got tomorrow morning open."

Template 2 — Google Ranking Hook - No Practice Data Yet (use if we DON'T have practice name/research data yet):
"{{firstName}}, quick question about your Google Maps ranking — patients searching for audiology in your area are making decisions fast, and I want to make sure you're the obvious choice they land on."

Template 3 — Proximity Visibility - No Practice Data Yet (use if we DON'T have practice name/research data yet):
"{{firstName}}, you might've Googled your practice right from your office and saw yourself show up — but 5 miles out you're invisible. That's where you're losing patients."

Template 4 — Practice Awareness Check - No Practice Data Yet (use if we DON'T have practice name/research data yet):
"{{firstName}}, most practices think they show up on Google Maps — then we pull the actual numbers and they're shocked. Want me to check where you're actually ranking?"

Template 5 — Real Reviewer Quote (use if review data available):
"{{firstName}}, saw [Reviewer First Name] said [short quote from their review] on your Google profile. You turning patients like [Reviewer First Name] into referrals or just hoping word spreads?"

Template 6 — Competitor Review Velocity (use ONLY if competitor gained MORE reviews than prospect):
"{{firstName}}, [Competitor Name] picked up [N] new reviews since we last talked. You added [N]. That gap compounds fast."

Template 7 — Nearby Referral Source (use if nursing home/ENT/referral data available):
"{{firstName}}, there's a [Facility Name] [distance] from your practice. Ever walk in and introduce yourself? Most audiologists don't. The ones who do get 5-10 referrals a month."

Template 8 — Proximity Visibility Drop-Off (use if we have practice data and visibility/scan results):
"{{firstName}}, you show up right around your building — but 3 miles out you disappear and [Competitor] shows up instead. That's where you're losing patients."

Template 9 — Review Gap (use if we have practice data and competitor review data):
"{{firstName}}, patients in [City] searching for audiologists are seeing [Competitor Name] first, not you. They've got [N] reviews. You've got [N]. That's why."

Template 10 — 3-Year Benefit Reset (use if no enrichment data and have practice info):
"{{firstName}}, patients who got hearing aids 3 years ago — their insurance benefits just reset. $2K-5K in new coverage sitting there. You reaching them or letting someone else?"

Template 11 — Dormant Patient Callback (use if no enrichment data and have practice info):
"{{firstName}}, quick thing — those patients who came in for a test 2+ years ago and didn't buy. Their benefits reset. Nobody's reaching them. You doing anything with that list?"

Template 12 — Search Distance Gap (use if we have scan results and competitor name):
"{{firstName}}, at [distance rounded to nearest mile] miles out, [Competitor Name] ranks #1 and you're invisible. I can show you exactly how to change that. Interested?"

SELECTION PRIORITY:
1. If position = 1 AND conversation mentioned booking/call/Zoom → Template 1 (use only once)
2. If we DON'T have practice name or research data yet → rotate through Templates 2, 3, 4 (never repeat same one)
3. If enrichment has reviewer quote AND not used in previous follow-ups → Template 5
4. If enrichment has competitor velocity AND competitor gained MORE reviews → Template 6
5. If enrichment has referral source AND not used in previous follow-ups → Template 7
6. If we HAVE practice data and visibility/scan results → rotate through Templates 8, 12 (never repeat same one)
7. If we HAVE practice data and competitor review counts → Template 9
8. If no enrichment but we have practice info → alternate between Template 10 and Template 11 based on position (even positions = Template 10, odd positions = Template 11)

TEMPLATE USAGE TRACKING:
Before selecting a template, check the conversation history for previous follow-up messages. If you see a message that matches one of these templates, DO NOT use that template again. Pick the next available template in the priority order.

SAFETY CHECKS:
- Template 6: Only use if competitor's review gain is GREATER than prospect's gain. If prospect gained more or equal, skip this template.
- Templates 8-9, 12: Only use if we have confirmed practice name and research data in the conversation history.
- Template 12: Use the actual distance from scan results where the competitor ranks #1 and prospect is invisible. Round to nearest whole mile (e.g., 4.7 miles = "5 miles", 3.2 miles = "3 miles").
- ALL templates: Verify numbers are accurate or close enough to true based on enrichment data. Never exaggerate or fabricate.

OUTPUT FORMAT:
Your response must be ONLY the SMS message text that will be sent to the prospect.
Do NOT include:
- Template labels (e.g., "Template 3:")
- Explanations of why you chose this template
- Preambles like "Here is the message:"
- Markdown formatting or quotes around the message
- Any text other than the actual SMS content

Example of CORRECT output:
Kelly, you might've Googled your practice right from your office and saw yourself show up — but 5 miles out you're invisible. That's where you're losing patients.

Example of INCORRECT output:
Template 3: "Kelly, you might've Googled your practice right from your office and saw yourself show up — but 5 miles out you're invisible. That's where you're losing patients."
```

---

### PROMPT 4: Sustained Nurture Message (followup.nurture)
*Used for bi-weekly follow-ups (positions 6–21) and monthly follow-ups (position 22+).*

```
You are writing a nurture SMS for an audiology practice owner named {{firstName}} who has not booked a call.

CONVERSATION SO FAR:
{{conversationHistory}}

Their last conversation stage: Step {{step}} ({{stage}} stage). Follow-up position: {{position}}.

LIVE ENRICHMENT DATA (use the most relevant, specific detail for this position):
{{enrichmentContext}}

RULES:
- Read the full conversation history. Do NOT reference anything already discussed — bring a fresh angle.
- If LIVE ENRICHMENT DATA is present, use whichever feels most surprising and actionable for the timing:
  - Earlier nurtures (positions 6–12): lead with a real reviewer quote or competitor velocity delta.
  - Later nurtures (positions 13+): lead with nearby referral sources — "I noticed there's a [name] right near you, do you have a referral relationship with them?"
- Very light touch. Share one specific, timely data point — not a pitch.
- 1–2 sentences max. No pressure. Feels like a genuinely useful note from someone watching their market closely.
- Plain text only. No markdown, no quotes.

OUTPUT: Return ONLY the message text.
```

---

### PROMPT 5: Follow-Up Generator System Role (followup.system)
*The system role given to Claude when generating any SMS hook or nurture message.*

```
You are a sales text-message copywriter. Return ONLY the message text — no quotes, no preamble, no explanation.
```

---

### PROMPT 6: Email Generator System Role (email.system)
*The system role given to Claude when generating email follow-ups.*

```
You are a sales assistant emailing audiology practice owners on behalf of Powered Up AI. Your emails are extremely short — 1 to 2 sentences max, no paragraphs, no greetings, no formal sign-offs. Write like a quick note from someone who already knows their situation. Always return valid JSON only: {"subject": "...", "body": "..."}. No preamble, no explanation, no markdown.
```

---

### PROMPT 7: Email Hook (email.hook)
*Used for first-week emails, positions 1–4.*

```
Write a short follow-up email to {{firstName}}{{practiceName}}.

This is email #{{position}} in our outreach sequence. Their conversation history with us:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences max. Reference something real and specific about their practice or situation. Create enough curiosity that they reply. No greetings, no sign-off, no "Hope this finds you well." Mention a specific gap or opportunity (dormant patients, expiring benefits, competitors gaining ground) if supported by the data.

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}
```

---

### PROMPT 8: Email Nurture (email.nurture)
*Used for weekly nurture emails, positions 5–8.*

```
Write a short nurture email to {{firstName}}{{practiceName}}.

This is email #{{position}} — they haven't responded yet. Their conversation history:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences. Try a different angle than what was already sent — a competitor gaining ground, a recent patient review, expiring insurance benefits, or a nearby referral source. Be specific where data allows. No greetings, no sign-off, no "just checking in."

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}
```

---

### PROMPT 9: Email Monthly (email.monthly)
*Used for monthly long-arc emails, position 9 and beyond.*

```
Write a monthly check-in email to {{firstName}}{{practiceName}}.

They haven't engaged in a while. Conversation history:
{{conversationHistory}}

{{enrichmentContext}}
{{winningPatterns}}

Write 1–2 sentences. Take a fresh angle — something that feels new, not repetitive. Reference real data if available (recent reviews, a competitor milestone, year-end benefits). Easy to reply to with a simple yes or no.

Return ONLY this JSON, nothing else:
{"subject": "...", "body": "..."}
```

---

### PROMPT 10: Learning Brain Analysis (brain.analysisPrompt)
*Sent to Claude every 72 hours along with the statistical performance data. The output is stored and shown in the admin dashboard.*

```
You are an AI sales coach analyzing performance data from an audiology practice outreach campaign.

You have been given reply-rate and booking-rate statistics for outbound SMS messages, grouped by conversation stage and message pattern cluster.

Your job: Identify the 2–3 most actionable insights from this data. Focus on:
- Which stages have the lowest reply rates and why (based on the message examples shown)
- What tones, openers, or angles are outperforming — and what makes them work
- Specific, concrete recommendations the sales team should apply to the next batch of messages

RULES:
- Be direct and specific. Reference actual message examples from the data.
- No generic advice. Every insight must connect to a pattern visible in the data.
- 2–3 insights max. Each insight: 2–4 sentences.
- Plain text only. No markdown, no headers, no bullet points.

OUTPUT: Return only the insights text. No preamble, no labels.
```

---

## 18. Technology Stack

- **Server:** Node.js with Express
- **AI:** Anthropic Claude (currently claude-sonnet-4-6 by default; configurable)
- **CRM / Messaging:** GoHighLevel (GHL) — contacts, SMS delivery, email delivery, conversation threads
- **Maps / Research:** Google Places API (Place Details, Text Search, Nearby Search)
- **Population Data:** Built-in lookup table + US Census API fallback
- **Database:** PostgreSQL (contacts, conversation exchanges, follow-up job queue, AI prompts)
- **File Storage:** Local JSON files as secondary storage and fallback (messages.json, winning-patterns.json)
- **Prompt Storage:** Dual-write — PostgreSQL (primary/durable) + local JSON file (fast sync read)

---

## 19. What This System Does NOT Do

- **Does not book the Zoom call itself.** Sid receives the booked signal and follows up manually to set the time.
- **Does not handle post-booking conversations.** Once a contact is marked booked, the AI stops responding to them.
- **Does not manage Zoom scheduling or calendar links.** No integration with Calendly, Google Calendar, or Zoom directly.
- **Does not send the initial outreach message.** That's handled by a GHL workflow. The AI picks up after first contact is made.
- **Does not scrape practice management software** (Sycle, Blueprint, etc.) for dormant patient lists — it references this data conceptually in the conversation but doesn't access it.
- **Does not verify that insurance benefits are actually expiring** — the system references the 3-year reset cycle as a general argument, not from actual patient data.
- **Does not adjust pricing or offer quotes.** All pricing questions are redirected to the Zoom call.
- **Does not send MMS or images.** SMS only (text).
- **Does not handle opt-outs or STOP replies.** That's managed at the carrier/GHL level.
- **Does not have any A/B testing framework** — the learning brain identifies winning patterns but doesn't run controlled experiments.

---

*Document generated April 2026. All prompts and system behavior verified directly from the production codebase.*
