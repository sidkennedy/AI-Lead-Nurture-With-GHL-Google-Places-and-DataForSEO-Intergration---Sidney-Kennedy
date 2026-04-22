try {
  const _fs = require('fs'), _p = require('path');
  const _env = _fs.readFileSync(_p.join(__dirname, '.env'), 'utf8');
  for (const line of _env.split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m && process.env[m[1].trim()] === undefined) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const config = require('./config');
const sessions = require('./sessions');
const conversations = require('./conversations');
const ghl = require('./ghl');
const { runResearch } = require('./research');
const { startScan } = require('./scanner');
const brain = require('./brain');
const followups = require('./followups');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Simple In-Memory Job Queue ───────────────────────────────────────────────
// Ensures one webhook job processes at a time; prevents race conditions on
// concurrent webhooks for the same contact.

const jobQueue = [];
let processing = false;

function enqueueJob(job) {
  jobQueue.push(job);
  if (!processing) drainQueue();
}

async function drainQueue() {
  if (processing || jobQueue.length === 0) return;
  processing = true;
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    try {
      await handleInbound(job);
    } catch (err) {
      console.error('[Queue] Job error:', err.message);
    }
  }
  processing = false;
}

// ─── GHL Webhook Auth ─────────────────────────────────────────────────────────

function verifyGhlWebhook(req, res) {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) {
    // Fail-closed: if no secret is configured the endpoint is not ready for production
    console.error('[Webhook] GHL_WEBHOOK_SECRET is not set — rejecting request');
    res.status(503).json({ error: 'Webhook not configured — set GHL_WEBHOOK_SECRET' });
    return false;
  }
  // GHL can be configured to send the secret in several headers; support all common forms
  const provided =
    req.headers['x-ghl-signature'] ||
    req.headers['x-api-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    '';
  if (provided === secret) return true;
  console.warn('[Webhook] Auth failed — received key does not match GHL_WEBHOOK_SECRET');
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

// ─── GHL Inbound Webhook ──────────────────────────────────────────────────────

app.post('/webhooks/ghl/inbound', async (req, res) => {
  // Verify the request is from GHL (fail-closed — 401/503 sent by verifyGhlWebhook)
  if (!verifyGhlWebhook(req, res)) return;

  const payload = req.body;

  // ── Direction / event-type guard ──────────────────────────────────────────────
  // Only process true inbound messages from prospects.
  // GHL may also fire webhooks for outbound messages or other events; skip those
  // to prevent loops and double-processing.
  const direction =
    payload.direction ||
    payload.messageDirection ||
    payload.type; // some versions send type: 1 (outbound) / 2 (inbound)

  const isOutbound =
    direction === 'outbound' ||
    direction === 'sent' ||
    direction === 1 ||
    direction === '1';

  if (isOutbound) {
    console.log('[Webhook] Skipping outbound message to prevent loop');
    return res.json({ received: true, skipped: 'outbound' });
  }

  // Acknowledge immediately — GHL expects a fast 200
  res.json({ received: true });

  // ── Parse payload (multiple GHL webhook shapes) ───────────────────────────────
  const contactId =
    payload.contactId ||
    payload.contact_id ||
    payload.contact?.id;

  const conversationId =
    payload.conversationId ||
    payload.conversation_id ||
    payload.conversation?.id ||
    null;

  const messageBody = (
    payload.body ||
    payload.message?.body ||
    payload.messageBody ||
    payload.text ||
    ''
  ).trim();

  const firstName =
    payload.contact?.firstName ||
    payload.firstName ||
    payload.first_name ||
    '';

  const city =
    payload.contact?.city ||
    payload.city ||
    '';

  const phone =
    payload.contact?.phone ||
    payload.phone ||
    '';

  if (!contactId || !messageBody) {
    console.log('[Webhook] Skipping — missing contactId or body');
    return;
  }

  console.log(`[Webhook] Queuing job for contact ${contactId}: "${messageBody.slice(0, 60)}"`);

  enqueueJob({ contactId, conversationId, messageBody, firstName, city, phone });
});

// ─── Webhook Handler ──────────────────────────────────────────────────────────

async function handleInbound({ contactId, conversationId, messageBody, firstName, city, phone }) {
  // ── 1. Fetch authoritative contact info from GHL ─────────────────────────────
  const ghlContact = await ghl.fetchContact(contactId);

  const resolvedFirstName = ghlContact?.firstName || firstName || '';
  const resolvedCity = ghlContact?.city || ghlContact?.address?.city || city || '';
  const resolvedPhone = ghlContact?.phone || phone || '';

  // ── 2. Load / create local contact record ────────────────────────────────────
  conversations.ensureContact(contactId, {
    firstName: resolvedFirstName,
    city: resolvedCity,
    phone: resolvedPhone
  });

  // Sync any updated contact info
  const infoUpdates = {};
  if (resolvedFirstName) infoUpdates.firstName = resolvedFirstName;
  if (resolvedCity) infoUpdates.city = resolvedCity;
  if (resolvedPhone) infoUpdates.phone = resolvedPhone;
  if (Object.keys(infoUpdates).length) conversations.update(contactId, infoUpdates);

  // ── 3. Record this inbound message ───────────────────────────────────────────
  conversations.addExchange(contactId, {
    direction: 'inbound',
    body: messageBody,
    step: conversations.get(contactId)?.currentStep || 0,
    conversationId
  });

  // Cancel any pending follow-up jobs before processing the reply (they replied — no hooks needed)
  followups.cancelContactJobs(contactId);

  // Store inbound in brain (for stats and contact history) then mark previous outbound replied
  const stepAtInbound = conversations.get(contactId)?.currentStep ?? null;
  brain.recordInbound(contactId, messageBody, stepAtInbound);
  brain.recordReply(contactId);

  // Reload fresh state after recording
  const fresh = conversations.get(contactId);

  if (fresh?.booked) {
    console.log(`[Webhook] Contact ${contactId} already booked — skipping`);
    return;
  }

  // ── 4. Build message history from GHL + local ─────────────────────────────────
  // Resolve conversationId if not present in webhook payload (e.g. some GHL event types)
  let resolvedConvId = conversationId;
  if (!resolvedConvId && contactId) {
    try {
      resolvedConvId = await ghl.getOrCreateConversation(contactId);
      console.log(`[Webhook] Resolved conversationId ${resolvedConvId} for contact ${contactId}`);
    } catch (err) {
      console.warn('[Webhook] Could not resolve conversationId:', err.message);
    }
  }

  // Fetch full conversation from GHL (authoritative source)
  let messages = [];
  if (resolvedConvId) {
    const ghlMessages = await ghl.fetchMessages(resolvedConvId);
    messages = buildMessagesFromGhl(ghlMessages);
  }

  // If GHL messages are empty or unavailable, fall back to local exchanges
  if (messages.length === 0) {
    messages = buildMessagesFromLocal(fresh?.exchanges || []);
  }

  if (messages.length === 0) {
    console.log(`[Webhook] No message history for ${contactId}`);
    return;
  }

  // ── 5. Build system prompt with live data + winning patterns ─────────────────
  let systemContent = config.conversationPrompt;

  if (resolvedFirstName || fresh?.firstName) {
    systemContent += `\n\nPROSPECT FIRST NAME: ${resolvedFirstName || fresh?.firstName}`;
  }

  if (fresh?.currentStep !== undefined) {
    systemContent += `\n\nCURRENT STEP: ${fresh.currentStep} (continue from here)`;
  }

  // Inject winning patterns for the current conversation stage (learning brain)
  const currentStage = brain.classifyStage(fresh?.currentStep ?? null);
  const winningPromptSnippet = brain.buildWinningPatternsPrompt(currentStage);
  if (winningPromptSnippet) systemContent += winningPromptSnippet;

  if (fresh?.researchData) {
    const rd = fresh.researchData;
    systemContent += `\n\nLIVE RESEARCH DATA:\n${JSON.stringify({
      practiceName: fresh.practiceName,
      reviews: rd.reviews,
      rating: rd.rating,
      competitors: rd.competitors?.slice(0, 3),
      competitorSummary: rd.competitorSummary,
      prospectRank: rd.prospectRank
    }, null, 2)}`;
  }

  if (fresh?.scanResults) {
    const sr = fresh.scanResults;
    systemContent += `\n\nSCAN RESULTS:\n${JSON.stringify({
      visibleTop3: sr.visibleTop3,
      invisible: sr.invisible,
      totalPoints: sr.totalPoints,
      topCompetitor: sr.topCompetitor,
      averageRankWhereVisible: sr.averageRankWhereVisible
    }, null, 2)}`;
  }

  // ── 6. Call Claude ────────────────────────────────────────────────────────────
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: systemContent,
    messages
  });

  let reply = response.content[0]?.text?.trim() || '';

  // ── 7. Extract hidden markers ─────────────────────────────────────────────────

  // [STEP:N] — track current step
  const stepMatch = reply.match(/\[STEP:(\d+)\]/i);
  const detectedStep = stepMatch ? parseInt(stepMatch[1], 10) : null;
  reply = reply.replace(/\[STEP:\d+\]\s*/gi, '').trim();

  // [PRACTICE_DETECTED:name] — trigger GMB research
  const practiceMatch = reply.match(/\[PRACTICE_DETECTED:([^\]]+)\]/i);
  if (practiceMatch) {
    const practiceName = practiceMatch[1].trim();
    reply = reply.replace(/\[PRACTICE_DETECTED:[^\]]+\]\s*/i, '').trim();
    const contactCity = resolvedCity || fresh?.city || '';
    conversations.update(contactId, { practiceName });
    console.log(`[Webhook] Practice detected: "${practiceName}" in "${contactCity}"`);

    if (practiceName && contactCity) {
      const sessionObj = { sessionId: contactId };
      sessions.set(contactId, {
        sessionId: contactId,
        practiceName,
        city: contactCity,
        researchStatus: 'idle',
        scanStatus: 'idle',
        researchData: null,
        scanResults: null,
        createdAt: Date.now()
      });
      runResearch(sessionObj, practiceName, contactCity, null).then(() => {
        const s = sessions.get(contactId);
        if (s?.researchData) {
          conversations.update(contactId, { researchData: s.researchData });
          console.log(`[Webhook] Research stored for ${contactId}`);
        }
      }).catch(() => {});
      startScan(sessionObj, practiceName, contactCity, config.scanKeyword).then(() => {
        const s = sessions.get(contactId);
        if (s?.scanResults) {
          conversations.update(contactId, { scanResults: s.scanResults });
          console.log(`[Webhook] Scan stored for ${contactId}`);
        }
      }).catch(() => {});
    }
  }

  // [BOOKED] — mark contact as booked
  if (reply.includes('[BOOKED]')) {
    reply = reply.replace(/\[BOOKED\]\s*/gi, '').trim();
    conversations.update(contactId, { booked: true });
    brain.recordBooking(contactId);
    console.log(`[Webhook] Contact ${contactId} booked!`);
  }

  // Update step
  if (detectedStep !== null) {
    conversations.update(contactId, { currentStep: detectedStep });
  }

  // ── 8. Send reply via GHL and persist ─────────────────────────────────────────
  if (reply) {
    await ghl.sendMessage(contactId, reply);
    conversations.addExchange(contactId, {
      direction: 'outbound',
      body: reply,
      step: detectedStep,
      conversationId: resolvedConvId || null
    });
    // Record in learning brain (stage derived from detectedStep)
    brain.recordOutbound(contactId, reply, detectedStep);
    // Schedule a 5-min silence check — if they don't reply, Hook 1 fires automatically
    followups.scheduleSilenceCheck(contactId, detectedStep, reply);
    console.log(`[Webhook] Sent to ${contactId} (step ${detectedStep}): "${reply.slice(0, 80)}"`);
  }
}

// ─── Message History Builders ─────────────────────────────────────────────────

function buildMessagesFromGhl(ghlMessages) {
  if (!ghlMessages || ghlMessages.length === 0) return [];

  const mapped = ghlMessages
    .filter(m => m.body || m.message)
    .map(m => {
      // GHL direction: 1 = outbound (AI), 2 = inbound (prospect)
      // Some versions use 'direction' field as 'inbound'/'outbound'
      const isInbound =
        m.direction === 'inbound' ||
        m.direction === 2 ||
        m.messageType === 'inbound' ||
        m.type === 2;
      return {
        role: isInbound ? 'user' : 'assistant',
        content: (m.body || m.message || '').trim()
      };
    })
    .filter(m => m.content.length > 0);

  return mergeAndNormalise(mapped);
}

function buildMessagesFromLocal(exchanges) {
  const mapped = exchanges.map(ex => ({
    role: ex.direction === 'inbound' ? 'user' : 'assistant',
    content: ex.body
  }));
  return mergeAndNormalise(mapped);
}

function mergeAndNormalise(messages) {
  // Merge consecutive same-role messages
  const merged = [];
  for (const m of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === m.role) {
      merged[merged.length - 1].content += ' ' + m.content;
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  // Claude requires messages to start with 'user'
  while (merged.length > 0 && merged[0].role !== 'user') merged.shift();
  return merged;
}

// ─── GMB Listing Search ───────────────────────────────────────────────────────

app.post('/api/places/search', async (req, res) => {
  const { practiceName, city } = req.body;
  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey || !practiceName || !city) return res.json({ results: [] });

  try {
    const query = encodeURIComponent(`${practiceName} ${city}`);
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const results = (data.results || []).slice(0, 5).map(p => {
      const photoRef = p.photos?.[0]?.photo_reference || null;
      const photoUrl = photoRef
        ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${photoRef}&key=${apiKey}`
        : null;
      const skipTypes = new Set(['point_of_interest', 'establishment', 'health', 'doctor', 'store', 'food', 'lodging']);
      const category = (p.types || []).find(t => !skipTypes.has(t));
      return {
        placeId: p.place_id,
        name: p.name,
        address: p.formatted_address || '',
        rating: p.rating || null,
        userRatingsTotal: p.user_ratings_total || 0,
        photoUrl,
        category: category ? category.replace(/_/g, ' ') : null
      };
    });
    res.json({ results });
  } catch (err) {
    console.error('[Places Search] Error:', err.message);
    res.json({ results: [] });
  }
});

// ─── GMB Message Generator ────────────────────────────────────────────────────

app.post('/api/generate', async (req, res) => {
  const { practiceName, city, confirmedPlaceId } = req.body;
  if (!practiceName || !city) {
    return res.status(400).json({ error: 'practiceName and city are required' });
  }

  const sessionId = uuidv4();
  const session = {
    sessionId,
    practiceName,
    city,
    confirmedPlaceId: confirmedPlaceId || null,
    researchStatus: 'idle',
    scanStatus: 'idle',
    researchData: null,
    scanResults: null,
    createdAt: Date.now()
  };
  sessions.set(sessionId, session);

  runResearch(session, practiceName, city, confirmedPlaceId || null).catch(() => {});
  startScan(session, practiceName, city, config.scanKeyword).catch(() => {});

  const TIMEOUT = 90000;
  const start = Date.now();

  await new Promise(resolve => {
    const check = setInterval(() => {
      const s = sessions.get(sessionId);
      const researchDone = s?.researchStatus === 'complete' || s?.researchStatus === 'failed';
      const scanDone = s?.scanStatus === 'complete' || s?.scanStatus === 'failed';
      if ((researchDone && scanDone) || Date.now() - start > TIMEOUT) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });

  const final = sessions.get(sessionId);
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  let userMessage = `Generate a message for this prospect's audiology practice.\n\nPractice name: ${practiceName}\nCity: ${city}`;

  if (final?.researchData) {
    const rd = final.researchData;
    userMessage += `\n\nGOOGLE MAPS PROFILE DATA:\n${JSON.stringify({
      reviews: rd.reviews,
      rating: rd.rating,
      photos: rd.photos,
      websiteListed: rd.websiteListed,
      hoursSet: rd.hoursSet,
      profileScore: rd.profileScore,
      competitors: rd.competitors,
      competitorSummary: rd.competitorSummary,
      prospectRank: rd.prospectRank
    }, null, 2)}`;
  }

  if (final?.scanResults) {
    const sr = final.scanResults;
    userMessage += `\n\nGOOGLE MAPS VISIBILITY SCAN:\n${JSON.stringify({
      visibleTop3: sr.visibleTop3,
      visibleTop10: sr.visibleTop10,
      invisible: sr.invisible,
      totalPoints: sr.totalPoints,
      percentInvisible: sr.percentInvisible,
      topCompetitor: sr.topCompetitor,
      averageRankWhereVisible: sr.averageRankWhereVisible
    }, null, 2)}`;
  }

  try {
    const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5';
    const response = await anthropic.messages.create({
      model,
      max_tokens: 512,
      system: config.systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    const message = response.content[0]?.text?.trim() || '';
    const scanUrl = `${appUrl}/scan/${sessionId}`;

    res.json({
      message,
      sessionId,
      scanUrl,
      hasResearch: !!(final?.researchData),
      hasScan: !!(final?.scanResults)
    });
  } catch (err) {
    console.error('[Generate] Claude error:', err.message);
    res.status(500).json({ error: 'Failed to generate message. Please try again.' });
  }
});

// ─── Scan Visualization ───────────────────────────────────────────────────────

app.get('/scan/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  const practiceName = session?.practiceName || 'Your Practice';
  const city = session?.city || '';
  const lat = session?.researchData?.lat || 37.7749;
  const lng = session?.researchData?.lng || -122.4194;
  const scanResults = session?.scanResults;
  res.send(buildScanPage(req.params.sessionId, practiceName, city, lat, lng, scanResults));
});

app.get('/api/scan/data/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const rd = session.researchData || {};
  const topComp = (rd.competitors || [])[0] || null;
  res.json({
    practiceName: session.practiceName,
    city: session.city,
    lat: rd.lat,
    lng: rd.lng,
    rating: rd.rating || 0,
    reviews: rd.reviews || 0,
    competitorSummary: rd.competitorSummary || '',
    topCompetitorResearch: topComp ? { name: topComp.name, rating: topComp.rating, reviews: topComp.reviews } : null,
    scanResults: session.scanResults,
    scanStatus: session.scanStatus
  });
});

// ─── Admin: Contact Monitoring ────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) return res.status(401).send('Unauthorized');
  next();
}

app.get('/api/contacts', requireAdmin, (req, res) => {
  const all = conversations.getAll();
  const list = Object.values(all)
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    .map(c => ({
      contactId: c.contactId,
      firstName: c.firstName,
      city: c.city,
      practiceName: c.practiceName,
      booked: c.booked,
      currentStep: c.currentStep,
      exchangeCount: (c.exchanges || []).length,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt
    }));
  res.json(list);
});

app.get('/api/contacts/:contactId', requireAdmin, (req, res) => {
  const c = conversations.get(req.params.contactId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

// ─── Admin: Learning Brain ────────────────────────────────────────────────────

app.get('/api/brain/stats', requireAdmin, (req, res) => {
  res.json(brain.getStats());
});

app.post('/api/brain/analyze', requireAdmin, (req, res) => {
  const result = brain.runAnalysis();
  res.json({ ok: true, patterns: result });
});

// ─── Admin: Follow-Up Job Monitoring ─────────────────────────────────────────

app.get('/api/followups', requireAdmin, (req, res) => {
  const { status, contactId } = req.query;
  let jobs = followups.getAllJobs(status || null);
  if (contactId) jobs = jobs.filter(j => j.contactId === contactId);
  jobs = jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  res.json(jobs);
});

app.get('/api/followups/:contactId', requireAdmin, (req, res) => {
  const jobs = followups.getContactJobs(req.params.contactId);
  res.json(jobs.sort((a, b) => b.createdAt - a.createdAt));
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Powered Up AI — GMB Message Generator running on port ${PORT}`);
  brain.startScheduledAnalysis();
  followups.startScheduler();
});

// ─── Scan Page Builder ────────────────────────────────────────────────────────

function buildScanPage(sessionId, practiceName, city, lat, lng, scanResults) {
  const sr = scanResults || {};
  const gridJson = JSON.stringify(sr.gridResults || []);
  const statsJson = JSON.stringify({
    visibleTop3: sr.visibleTop3 || 0,
    visibleTop10: sr.visibleTop10 || 0,
    invisible: sr.invisible || 0,
    totalPoints: sr.totalPoints || 25,
    percentInvisible: sr.percentInvisible || 0,
    topCompetitor: sr.topCompetitor || null,
    averageRankWhereVisible: sr.averageRankWhereVisible || null
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${practiceName} — Google Maps Visibility</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh}
.header{padding:20px 16px 12px;text-align:center}
.header h1{font-size:20px;font-weight:700;color:#fff;line-height:1.3}
.header p{font-size:13px;color:#888;margin-top:6px}
#map{width:100%;height:380px;background:#222}
.stats{padding:16px}
.stat-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #2a2a2a;font-size:14px}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot-green{background:#22c55e}.dot-yellow{background:#f59e0b}.dot-red{background:#ef4444}
.stat-label{flex:1;color:#ccc}
.stat-value{font-weight:600;color:#fff}
.footer{text-align:center;padding:20px;font-size:11px;color:#555}
.loading-msg{text-align:center;padding:40px 20px;color:#888;font-size:14px}
</style>
</head>
<body>
<div class="header">
  <h1>${practiceName} — Google Maps Visibility</h1>
  <p>Keyword: ${config.scanKeyword} near me &bull; ${city} &bull; ${config.scanRadius}-mile radius</p>
</div>
<div id="map"></div>
<div id="stats-container">
  ${!scanResults ? '<div class="loading-msg">Scan in progress — check back in a moment.</div>' : ''}
</div>
<div class="footer">Powered by Powered Up AI</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const grid=${gridJson},stats=${statsJson},centerLat=${lat},centerLng=${lng};
const map=L.map('map').setView([centerLat,centerLng],12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:18}).addTo(map);
function rankColor(r){if(!r||r>20)return{bg:'#ef4444',text:'#fff'};if(r<=3)return{bg:'#22c55e',text:'#fff'};return{bg:'#f59e0b',text:'#111'}}
grid.forEach(point=>{
  const{bg,text}=rankColor(point.rank),label=point.rank?String(point.rank):'—';
  const icon=L.divIcon({className:'',html:\`<div style="width:30px;height:30px;border-radius:50%;background:\${bg};color:\${text};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid rgba(255,255,255,0.3)">\${label}</div>\`,iconSize:[30,30],iconAnchor:[15,15]});
  const topBiz=(point.topBusinesses||[]).map(b=>\`<div style="padding:3px 0;font-size:13px;">#\${b.rank} \${b.name}</div>\`).join('');
  L.marker([point.lat,point.lng],{icon}).addTo(map).bindPopup(\`<div style="min-width:160px">\${topBiz||'No data'}</div>\`);
});
if(stats.totalPoints>0){
  const container=document.getElementById('stats-container'),comp=stats.topCompetitor;
  container.innerHTML=\`<div class="stats">
    <div class="stat-row"><span class="dot dot-green"></span><span class="stat-label">Visible (top 3)</span><span class="stat-value">\${stats.visibleTop3}/\${stats.totalPoints} locations</span></div>
    <div class="stat-row"><span class="dot dot-yellow"></span><span class="stat-label">Partially visible (4–10)</span><span class="stat-value">\${stats.visibleTop10-stats.visibleTop3}/\${stats.totalPoints}</span></div>
    <div class="stat-row"><span class="dot dot-red"></span><span class="stat-label">Invisible</span><span class="stat-value">\${stats.invisible}/\${stats.totalPoints}</span></div>
    \${comp?\`<div class="stat-row"><span class="dot" style="background:#888"></span><span class="stat-label">Top competitor: \${comp.name}</span><span class="stat-value">visible in \${comp.visibleIn}/\${stats.totalPoints} locations</span></div>\`:''}
    \${stats.averageRankWhereVisible?\`<div class="stat-row"><span class="dot" style="background:#888"></span><span class="stat-label">Avg rank where visible</span><span class="stat-value">#\${stats.averageRankWhereVisible}</span></div>\`:''}
  </div>\`;
}
</script>
</body>
</html>`;
}
