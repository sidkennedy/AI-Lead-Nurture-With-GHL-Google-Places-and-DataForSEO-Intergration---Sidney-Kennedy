// Manual .env loader — avoids dotenvx v17 injection quirks
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
const { runResearch } = require('./research');
const { startScan } = require('./scanner');
const ghl = require('./ghl');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Session endpoints ────────────────────────────────────────────────────────

app.post('/api/start', (req, res) => {
  const sessionId = uuidv4();
  const session = {
    sessionId,
    conversationHistory: [],
    status: 'active',
    scanStatus: 'idle',
    researchStatus: 'idle',
    researchData: null,
    scanResults: null,
    currentStep: 'onboarding-1',
    name: null,
    phone: null,
    practiceName: null,
    city: null,
    contactId: null,
    createdAt: Date.now()
  };
  sessions.set(sessionId, session);
  res.json({ sessionId, createdAt: session.createdAt });
});

// ─── Places disambiguation endpoint ───────────────────────────────────────────

app.post('/api/places/search', async (req, res) => {
  const { practiceName, city } = req.body;
  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey || !practiceName || !city) return res.json({ results: [] });

  try {
    const query = encodeURIComponent(`${practiceName} ${city}`);
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const results = (data.results || []).slice(0, 5).map(p => ({
      placeId: p.place_id,
      name: p.name,
      address: p.formatted_address || '',
      rating: p.rating || null,
      userRatingsTotal: p.user_ratings_total || 0
    }));
    res.json({ results });
  } catch (err) {
    console.error('[Places Search] Error:', err.message);
    res.json({ results: [] });
  }
});

app.post('/api/session/update', async (req, res) => {
  const { sessionId, name, phone, practiceName, city, currentStep, confirmedPlaceId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (phone !== undefined) updates.phone = phone;
  if (practiceName !== undefined) updates.practiceName = practiceName;
  if (city !== undefined) updates.city = city;
  if (currentStep !== undefined) updates.currentStep = currentStep;
  if (confirmedPlaceId !== undefined) updates.confirmedPlaceId = confirmedPlaceId;

  const hadPractice = !!(session.practiceName && session.city);
  sessions.update(sessionId, updates);
  const updated = sessions.get(sessionId);

  // Trigger GHL contact creation when phone first collected
  if (phone && !session.phone) {
    ghl.createContact(updated.name || 'Unknown', phone, '').then(id => {
      if (id) sessions.update(sessionId, { contactId: id });
    }).catch(() => {});
  }

  // Trigger research + scan when both practiceName and city available for the first time
  if (!hadPractice && updated.practiceName && updated.city) {
    const snap = sessions.get(sessionId);
    runResearch(snap, updated.practiceName, updated.city, updated.confirmedPlaceId || null).catch(() => {});
    startScan(snap, updated.practiceName, updated.city, config.scanKeyword).catch(() => {});

    // Update GHL contact with practice details
    if (updated.contactId) {
      ghl.updateContact(updated.contactId, {
        customFields: [
          { id: 'practiceName', value: updated.practiceName },
          { id: 'city', value: updated.city }
        ]
      }).catch(() => {});
    }
  }

  res.json({ ok: true });
});

// ─── Chat endpoint (SSE streaming) ────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  // Append user message
  const history = session.conversationHistory || [];
  history.push({ role: 'user', content: message });

  // Build system prompt
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  let systemContent = config.systemPrompt.replace(/APP_URL/g, appUrl).replace(/SESSION_ID/g, sessionId);

  const fresh = sessions.get(sessionId);

  if (fresh.researchData) {
    const rd = fresh.researchData;
    systemContent += `\n\nLIVE RESEARCH DATA (use these real numbers in your responses instead of asking the prospect — this is their actual data):\n${JSON.stringify({
      theirReviews: rd.reviews,
      theirRating: rd.rating,
      theirPhotos: rd.photos,
      competitors: rd.competitors,
      competitorSummary: rd.competitorSummary,
      populationOver65: rd.populationOver65,
      estimatedHearingLoss: rd.estimatedHearingLoss,
      messagingEnabled: rd.messagingEnabled,
      hoursSet: rd.hoursSet,
      websiteListed: rd.websiteListed,
      profileScore: rd.profileScore
    }, null, 2)}`;
  }

  if (fresh.scanResults) {
    const sr = fresh.scanResults;
    systemContent += `\n\nGOOGLE MAPS VISIBILITY SCAN RESULTS:\n${JSON.stringify({
      visibleTop3: sr.visibleTop3,
      visibleTop10: sr.visibleTop10,
      invisible: sr.invisible,
      totalPoints: sr.totalPoints,
      percentInvisible: sr.percentInvisible,
      topCompetitor: sr.topCompetitor,
      averageRankWhereVisible: sr.averageRankWhereVisible,
      scanUrl: `${appUrl}/scan/${sessionId}`
    }, null, 2)}`;
  }

  let fullResponse = '';

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemContent,
      messages: history
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        const text = chunk.delta.text;
        fullResponse += text;
        sendEvent('token', { text });
      }
    }

    // Save assistant response to history
    history.push({ role: 'assistant', content: fullResponse });
    sessions.update(sessionId, { conversationHistory: history });

    // Detect current step from response
    const stepMatch = fullResponse.match(/\[STEP:([^\]]+)\]/);
    const detectedStep = stepMatch ? stepMatch[1] : null;
    if (detectedStep) {
      sessions.update(sessionId, { currentStep: detectedStep });
    }

    // Extract session data from response
    extractAndSaveSessionData(sessionId, message, fullResponse);

    // Trigger checks
    await handleTriggers(sessionId, fullResponse, appUrl);

    sendEvent('done', {
      currentStep: detectedStep || sessions.get(sessionId)?.currentStep,
      researchReady: !!(sessions.get(sessionId)?.researchData),
      scanReady: !!(sessions.get(sessionId)?.scanResults)
    });

  } catch (err) {
    console.error('[Chat] Error:', err.message);
    sendEvent('error', { message: 'Something went wrong. Please try again.' });
  }

  res.end();
});

function extractAndSaveSessionData(sessionId, userMessage, aiResponse) {
  // The frontend handles most extraction via /api/session/update
  // This is a backup pass for common patterns
  const session = sessions.get(sessionId);
  if (!session) return;

  const updates = {};

  // If we detect a phone number in the user message and haven't saved one yet
  if (!session.phone && /^\+?[\d\s\-\(\)]{10,}$/.test(userMessage.trim())) {
    updates.phone = userMessage.trim();
  }

  if (Object.keys(updates).length) {
    sessions.update(sessionId, updates);
  }
}

async function handleTriggers(sessionId, responseText, appUrl) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const lower = responseText.toLowerCase();
  const isBooked = /locked in|calendar invite|talk soon|zoom is confirmed|see you|you're all set/i.test(responseText);
  const isNotInterested = /not a good fit|no worries|totally understand|maybe another time/i.test(responseText);

  if (isBooked && session.contactId) {
    ghl.addTag(session.contactId, 'zoom-booked').catch(() => {});
    const topComp = session.researchData?.competitors?.[0];
    const scanUrl = `${appUrl}/scan/${sessionId}`;
    ghl.sendNotification(
      `New Zoom lead! ${session.name || 'Unknown'} from ${session.practiceName || 'Unknown Practice'} in ${session.city || 'Unknown City'}. ` +
      `They have ${session.researchData?.reviews || '?'} reviews vs ${topComp?.name || 'top competitor'} with ${topComp?.reviews || '?'}. ` +
      `Scan: ${scanUrl}`
    ).catch(() => {});
  }

  if (isNotInterested && session.contactId) {
    ghl.addTag(session.contactId, 'not-interested').catch(() => {});
  }
}

// ─── History & Status endpoints ───────────────────────────────────────────────

app.get('/api/history/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json({ history: session.conversationHistory, currentStep: session.currentStep });
});

app.get('/api/scan/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json({ status: session.scanStatus, results: session.scanResults });
});

app.get('/api/research/status/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Not found' });
  res.json({ status: session.researchStatus, data: session.researchData });
});

// ─── Scan visualization page ───────────────────────────────────────────────────

app.get('/scan/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  const practiceName = session?.practiceName || 'Your Practice';
  const city = session?.city || '';
  const lat = session?.researchData?.lat || 37.7749;
  const lng = session?.researchData?.lng || -122.4194;
  const scanResults = session?.scanResults;
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  res.send(buildScanPage(req.params.sessionId, practiceName, city, lat, lng, scanResults, appUrl));
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
    populationOver65: rd.populationOver65 || 45000,
    competitorSummary: rd.competitorSummary || '',
    topCompetitorResearch: topComp ? { name: topComp.name, rating: topComp.rating, reviews: topComp.reviews } : null,
    scanResults: session.scanResults,
    scanStatus: session.scanStatus
  });
});

// ─── Admin endpoints ───────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) return res.status(401).send('Unauthorized');
  next();
}

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  const all = sessions.getAll();
  const list = Object.values(all)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(s => ({
      sessionId: s.sessionId,
      name: s.name,
      phone: s.phone,
      practiceName: s.practiceName,
      city: s.city,
      status: s.status,
      currentStep: s.currentStep,
      scanStatus: s.scanStatus,
      researchStatus: s.researchStatus,
      createdAt: s.createdAt,
      messageCount: s.conversationHistory?.length || 0,
      researchData: s.researchData,
      scanResults: s.scanResults,
      conversationHistory: s.conversationHistory
    }));
  res.json(list);
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Config endpoint (public) ─────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({
    calendarWidgetUrl: config.calendarWidgetUrl,
    brandName: config.brandName,
    headline: config.headline,
    socialProofLines: config.socialProofLines,
    mapsKey: process.env.GOOGLE_PLACES_KEY || ''
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Powered Up Lead Magnet running on port ${PORT}`);
});

// ─── Scan page HTML builder ────────────────────────────────────────────────────

function buildScanPage(sessionId, practiceName, city, lat, lng, scanResults, appUrl) {
  const calendarUrl = require('./config').calendarWidgetUrl;
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
.dot-green{background:#22c55e}
.dot-yellow{background:#f59e0b}
.dot-red{background:#ef4444}
.stat-label{flex:1;color:#ccc}
.stat-value{font-weight:600;color:#fff}
.cta{padding:16px;text-align:center}
.cta a{display:block;background:#f59e0b;color:#000;text-decoration:none;font-weight:700;font-size:16px;padding:16px;border-radius:12px}
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
<div class="cta">
  <a href="${calendarUrl}" target="_blank">Book a 10-minute Zoom to fix this</a>
</div>
<div class="footer">Powered by Powered Up AI</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const grid = ${gridJson};
const stats = ${statsJson};
const centerLat = ${lat};
const centerLng = ${lng};

const map = L.map('map').setView([centerLat, centerLng], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap',
  maxZoom: 18
}).addTo(map);

function rankColor(rank) {
  if (!rank || rank > 20) return { bg: '#ef4444', text: '#fff' };
  if (rank <= 3) return { bg: '#22c55e', text: '#fff' };
  return { bg: '#f59e0b', text: '#111' };
}

grid.forEach(point => {
  const { bg, text } = rankColor(point.rank);
  const label = point.rank ? String(point.rank) : '—';
  const icon = L.divIcon({
    className: '',
    html: \`<div style="width:30px;height:30px;border-radius:50%;background:\${bg};color:\${text};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid rgba(255,255,255,0.3)">\${label}</div>\`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

  const topBiz = (point.topBusinesses || []).map(b => \`<div style="padding:3px 0;font-size:13px;">#\${b.rank} \${b.name}</div>\`).join('');
  L.marker([point.lat, point.lng], { icon })
    .addTo(map)
    .bindPopup(\`<div style="min-width:160px">\${topBiz || 'No data'}</div>\`);
});

// Render stats
if (stats.totalPoints > 0) {
  const container = document.getElementById('stats-container');
  const comp = stats.topCompetitor;
  container.innerHTML = \`<div class="stats">
    <div class="stat-row"><span class="dot dot-green"></span><span class="stat-label">Visible (top 3)</span><span class="stat-value">\${stats.visibleTop3}/\${stats.totalPoints} locations</span></div>
    <div class="stat-row"><span class="dot dot-yellow"></span><span class="stat-label">Partially visible (4–10)</span><span class="stat-value">\${stats.visibleTop10 - stats.visibleTop3}/\${stats.totalPoints}</span></div>
    <div class="stat-row"><span class="dot dot-red"></span><span class="stat-label">Invisible</span><span class="stat-value">\${stats.invisible}/\${stats.totalPoints}</span></div>
    \${comp ? \`<div class="stat-row"><span class="dot" style="background:#888"></span><span class="stat-label">Top competitor: \${comp.name}</span><span class="stat-value">visible in \${comp.visibleIn}/\${stats.totalPoints}</span></div>\` : ''}
    \${stats.averageRankWhereVisible ? \`<div class="stat-row"><span class="dot" style="background:#888"></span><span class="stat-label">Your avg rank where visible</span><span class="stat-value">#\${stats.averageRankWhereVisible}</span></div>\` : ''}
  </div>\`;
}
</script>
</body>
</html>`;
}
