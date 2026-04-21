const fetch = require('node-fetch');
const config = require('./config');

function generateGrid(lat, lng, radiusMiles, size) {
  const points = [];
  const latDeg = radiusMiles * 0.0145;
  const lngDeg = radiusMiles * 0.0145 / Math.cos(lat * Math.PI / 180);
  const step = size > 1 ? 2 / (size - 1) : 0;

  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const dLat = size > 1 ? (i * step - 1) * latDeg : 0;
      const dLng = size > 1 ? (j * step - 1) * lngDeg : 0;
      points.push({ lat: lat + dLat, lng: lng + dLng });
    }
  }
  return points;
}

function fuzzyMatch(haystack, needle) {
  const h = haystack.toLowerCase().trim();
  const n = needle.toLowerCase().trim();
  const words = n.split(/\s+/).filter(w => w.length > 3);
  return words.some(w => h.includes(w));
}

async function dfsRequest(method, path, body) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;

  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  try {
    const res = await fetch(`https://api.dataforseo.com${path}`, {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('[Scanner] DFS request error:', err.message);
    return null;
  }
}

async function startScan(sessionObj, practiceName, city, keyword) {
  const sessions = require('./sessions');
  const sessionId = sessionObj.sessionId;

  sessions.update(sessionId, { scanStatus: 'running' });

  const login = process.env.DATAFORSEO_LOGIN;
  if (!login) {
    console.log('[Scanner] No DataForSEO credentials — using mock scan data');
    await new Promise(r => setTimeout(r, 3000));
    const mockResults = generateMockResults(practiceName, sessionId);
    sessions.update(sessionId, { scanResults: mockResults, scanStatus: 'complete' });
    return;
  }

  // Get lat/lng from session research data (wait up to 30s)
  let lat, lng;
  for (let i = 0; i < 30; i++) {
    const s = sessions.get(sessionId);
    if (s?.researchData?.lat) {
      lat = s.researchData.lat;
      lng = s.researchData.lng;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!lat) {
    console.log('[Scanner] No lat/lng available, aborting scan');
    sessions.update(sessionId, { scanStatus: 'failed' });
    return;
  }

  const grid = generateGrid(lat, lng, config.scanRadius, config.gridSize);
  const scanKeyword = keyword || config.scanKeyword;

  try {
    // Post all 25 tasks
    const tasks = grid.map(point => ({
      keyword: scanKeyword,
      location_coordinate: `${point.lat.toFixed(6)},${point.lng.toFixed(6)},15z`,
      language_code: 'en',
      se_domain: 'google.com'
    }));

    const postRes = await dfsRequest('POST', '/v3/serp/google/maps/task_post', tasks);
    if (!postRes?.tasks) {
      sessions.update(sessionId, { scanStatus: 'failed' });
      return;
    }

    const taskIds = postRes.tasks.map(t => t.id).filter(Boolean);
    console.log(`[Scanner] Posted ${taskIds.length} tasks for session ${sessionId}`);

    // Poll for completion
    const startTime = Date.now();
    const completedResults = new Map();

    while (completedResults.size < taskIds.length && Date.now() - startTime < 180000) {
      await new Promise(r => setTimeout(r, 10000));

      const readyRes = await dfsRequest('GET', '/v3/serp/google/maps/tasks_ready');
      if (!readyRes?.tasks) continue;

      const readyIds = (readyRes.tasks[0]?.result || []).map(t => t.id);

      for (const id of readyIds) {
        if (!taskIds.includes(id) || completedResults.has(id)) continue;
        const result = await dfsRequest('GET', `/v3/serp/google/maps/task_get/regular/${id}`);
        if (result?.tasks?.[0]?.result) {
          completedResults.set(id, result.tasks[0].result[0]);
        }
      }

      console.log(`[Scanner] ${completedResults.size}/${taskIds.length} complete`);
    }

    // Analyze results
    const gridResults = grid.map((point, idx) => {
      const taskId = taskIds[idx];
      const result = completedResults.get(taskId);
      if (!result?.items) return { lat: point.lat, lng: point.lng, rank: null, topBusinesses: [] };

      const items = result.items;
      const prospectItem = items.find(item => fuzzyMatch(item.title || '', practiceName));
      const rank = prospectItem ? (items.indexOf(prospectItem) + 1) : null;

      const topBusinesses = items.slice(0, 3).map(item => ({
        name: item.title || 'Unknown',
        rank: items.indexOf(item) + 1,
        rating: item.rating?.value || null
      }));

      return { lat: point.lat, lng: point.lng, rank, topBusinesses };
    });

    const scanResults = computeScanStats(gridResults, practiceName, sessionId);
    sessions.update(sessionId, { scanResults, scanStatus: 'complete' });
    console.log(`[Scanner] Complete for ${practiceName}: ${scanResults.percentInvisible}% invisible`);
  } catch (err) {
    console.error('[Scanner] Error:', err.message);
    sessions.update(sessionId, { scanStatus: 'failed' });
  }
}

function computeScanStats(gridResults, practiceName, sessionId) {
  const visible3 = gridResults.filter(p => p.rank && p.rank <= 3).length;
  const visible10 = gridResults.filter(p => p.rank && p.rank <= 10).length;
  const invisible = gridResults.filter(p => !p.rank || p.rank > 20).length;
  const total = gridResults.length;

  const competitorCounts = {};
  for (const point of gridResults) {
    for (const biz of (point.topBusinesses || [])) {
      if (!fuzzyMatch(biz.name, practiceName)) {
        competitorCounts[biz.name] = (competitorCounts[biz.name] || 0) + 1;
      }
    }
  }

  const topCompetitorEntry = Object.entries(competitorCounts).sort((a, b) => b[1] - a[1])[0];
  const ranksWhereVisible = gridResults.filter(p => p.rank).map(p => p.rank);
  const avgRank = ranksWhereVisible.length
    ? Math.round(ranksWhereVisible.reduce((a, b) => a + b, 0) / ranksWhereVisible.length)
    : null;

  return {
    gridResults,
    visibleTop3: visible3,
    visibleTop10: visible10,
    invisible,
    totalPoints: total,
    percentInvisible: Math.round((invisible / total) * 100),
    topCompetitor: topCompetitorEntry ? { name: topCompetitorEntry[0], visibleIn: topCompetitorEntry[1] } : null,
    averageRankWhereVisible: avgRank,
    scanUrl: `${process.env.APP_URL || ''}/scan/${sessionId}`
  };
}

function generateMockResults(practiceName, sessionId) {
  const grid = Array.from({ length: 25 }, (_, i) => {
    const ranks = [null, null, 1, null, 8, null, null, 2, null, null, 14, null, null, 3, null, null, null, 5, null, null, null, null, 9, null, null];
    const rank = ranks[i];
    return {
      lat: 37.77 + (Math.floor(i / 5) - 2) * 0.02,
      lng: -122.42 + (i % 5 - 2) * 0.025,
      rank,
      topBusinesses: rank ? [
        { name: practiceName, rank, rating: 4.2 },
        { name: 'Clear Hearing Center', rank: rank === 1 ? 2 : 1, rating: 4.8 },
        { name: 'Bay Audiology', rank: 3, rating: 4.7 }
      ] : [
        { name: 'Clear Hearing Center', rank: 1, rating: 4.8 },
        { name: 'Bay Audiology', rank: 2, rating: 4.7 },
        { name: 'Advanced Hearing Solutions', rank: 3, rating: 4.5 }
      ]
    };
  });

  return computeScanStats(grid, practiceName, sessionId);
}

module.exports = { startScan };
