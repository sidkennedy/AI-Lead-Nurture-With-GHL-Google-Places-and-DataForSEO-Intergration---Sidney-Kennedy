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

// Search one grid point via Google Places Nearby Search (fallback path)
async function searchPoint(lat, lng, keyword, radiusMeters, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
    `?location=${lat},${lng}&radius=${radiusMeters}&keyword=${encodeURIComponent(keyword)}&key=${apiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch {
    return [];
  }
}

// Search one grid point via DataForSEO Google Maps Live API (primary path)
// Returns an array of { name, rating } objects matching the shape Google Places returns.
async function searchPointDataForSEO(lat, lng, keyword) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    throw new Error('DataForSEO credentials not configured');
  }

  const host = process.env.DATAFORSEO_SANDBOX === '1'
    ? 'sandbox.dataforseo.com'
    : 'api.dataforseo.com';

  const credentials = Buffer.from(`${login}:${password}`).toString('base64');
  // zoom 14z corresponds to ~2km view, matching pointRadiusMeters used for Google Places
  const body = JSON.stringify([{
    keyword,
    location_coordinate: `${lat},${lng},14z`,
    language_code: 'en',
    depth: 20
  }]);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`https://${host}/v3/serp/google/maps/live/advanced`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      body,
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`DataForSEO returned HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!data || data.status_code !== 20000) {
      throw new Error(`DataForSEO top-level error ${data?.status_code}: ${data?.status_message}`);
    }

    const tasks = data.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('DataForSEO returned no tasks');
    }

    const task = tasks[0];
    if (!task || task.status_code !== 20000) {
      throw new Error(`DataForSEO task error ${task?.status_code}: ${task?.status_message}`);
    }

    const result = task.result;
    if (!Array.isArray(result) || result.length === 0) {
      return [];
    }

    const items = result[0]?.items || [];

    // Sort by rank_absolute so array index matches visual rank position
    const sorted = items
      .filter(item => typeof item.rank_absolute === 'number')
      .sort((a, b) => a.rank_absolute - b.rank_absolute);

    return sorted.slice(0, 20).map(item => ({
      name: item.title || 'Unknown',
      rating: item.rating?.value ?? null
    }));
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Search one grid point — DataForSEO primary, Google Places fallback
async function searchPointWithFallback(lat, lng, keyword, radiusMeters, apiKey) {
  const dfsLogin = process.env.DATAFORSEO_LOGIN;
  const dfsPassword = process.env.DATAFORSEO_PASSWORD;
  const pointLabel = `${lat.toFixed(4)},${lng.toFixed(4)}`;

  if (dfsLogin && dfsPassword) {
    try {
      const results = await searchPointDataForSEO(lat, lng, keyword);
      const host = process.env.DATAFORSEO_SANDBOX === '1' ? 'DataForSEO sandbox' : 'DataForSEO live';
      console.log(`[Scanner] Point ${pointLabel} — ${host} (${results.length} results)`);
      return results;
    } catch (err) {
      console.log(`[Scanner] Point ${pointLabel} — DataForSEO failed (${err.message}), falling back to Google Places`);
      if (apiKey) {
        const results = await searchPoint(lat, lng, keyword, radiusMeters, apiKey);
        console.log(`[Scanner] Point ${pointLabel} — Google Places fallback (${results.length} results)`);
        return results;
      }
      console.log(`[Scanner] Point ${pointLabel} — no Google Places key, returning empty`);
      return [];
    }
  }

  if (apiKey) {
    const results = await searchPoint(lat, lng, keyword, radiusMeters, apiKey);
    console.log(`[Scanner] Point ${pointLabel} — Google Places (${results.length} results)`);
    return results;
  }

  return [];
}

async function startScan(sessionObj, practiceName, city, keyword) {
  const sessions = require('./sessions');
  const sessionId = sessionObj.sessionId;

  sessions.update(sessionId, { scanStatus: 'running' });

  const dfsLogin = process.env.DATAFORSEO_LOGIN;
  const dfsPassword = process.env.DATAFORSEO_PASSWORD;
  const dfsConfigured = !!(dfsLogin && dfsPassword);
  const apiKey = process.env.GOOGLE_PLACES_KEY;

  if (!dfsConfigured && !apiKey) {
    console.log('[Scanner] No DataForSEO or Google Places credentials — using mock scan data');
    await new Promise(r => setTimeout(r, 3000));
    const mockResults = generateMockResults(practiceName, sessionId);
    sessions.update(sessionId, { scanResults: mockResults, scanStatus: 'complete' });
    return;
  }

  const primarySource = dfsConfigured
    ? (process.env.DATAFORSEO_SANDBOX === '1' ? 'DataForSEO sandbox' : 'DataForSEO live')
    : 'Google Places';
  console.log(`[Scanner] Primary source: ${primarySource}${apiKey ? ' (Google Places fallback available)' : ''}`);

  // Wait up to 30s for lat/lng from research
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
    console.log('[Scanner] No lat/lng available after 30s, aborting scan');
    sessions.update(sessionId, { scanStatus: 'failed' });
    return;
  }

  console.log(`[Scanner] Got lat/lng ${lat},${lng} — firing ${config.gridSize}x${config.gridSize} grid`);

  const grid = generateGrid(lat, lng, config.scanRadius, config.gridSize);
  const scanKeyword = keyword || config.scanKeyword;

  // Search radius per grid point: ~2km covers local pack results well
  const pointRadiusMeters = 2000;

  try {
    // Fire all grid-point searches in parallel — DataForSEO primary, Google Places fallback per point
    const start = Date.now();
    const searchResults = await Promise.all(
      grid.map(point => searchPointWithFallback(point.lat, point.lng, scanKeyword, pointRadiusMeters, apiKey))
    );
    console.log(`[Scanner] All ${grid.length} points returned in ${Date.now() - start}ms`);

    const gridResults = grid.map((point, idx) => {
      const places = searchResults[idx];
      if (!places || places.length === 0) {
        return { lat: point.lat, lng: point.lng, rank: null, topBusinesses: [] };
      }

      const prospectIdx = places.findIndex(p => fuzzyMatch(p.name || '', practiceName));
      const rank = prospectIdx >= 0 ? prospectIdx + 1 : null;

      const topBusinesses = places.slice(0, 3).map((p, i) => ({
        name: p.name || 'Unknown',
        rank: i + 1,
        rating: p.rating || null
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
