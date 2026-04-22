const config = require('./config');

// 65+ population estimates by metro/county area (appropriate for audiology catchment)
const METRO_65_PLUS = {
  // Major metros
  "new york": 1450000, "los angeles": 1050000, "chicago": 610000,
  "houston": 390000, "phoenix": 450000, "philadelphia": 370000,
  "san antonio": 280000, "san diego": 340000, "dallas": 290000,
  "jacksonville": 220000, "austin": 190000, "san jose": 175000,
  "fort worth": 180000, "columbus": 185000, "charlotte": 200000,
  "indianapolis": 175000, "san francisco": 165000, "seattle": 195000,
  "denver": 200000, "nashville": 195000, "oklahoma city": 155000,
  "el paso": 110000, "washington": 240000, "boston": 210000,
  "las vegas": 295000, "memphis": 135000, "portland": 200000,
  "louisville": 130000, "baltimore": 185000, "milwaukee": 130000,
  "albuquerque": 110000, "tucson": 130000, "fresno": 95000,
  "mesa": 120000, "sacramento": 185000, "kansas city": 165000,
  "atlanta": 320000, "omaha": 90000, "colorado springs": 95000,
  "raleigh": 150000, "long beach": 95000, "virginia beach": 110000,
  "minneapolis": 190000, "tampa": 310000, "new orleans": 100000,
  "cleveland": 140000, "pittsburgh": 175000, "miami": 290000,
  "orlando": 240000, "cincinnati": 155000,
  // Florida markets (high senior concentration)
  "sarasota": 132000, "fort myers": 145000, "naples": 98000,
  "cape coral": 78000, "bonita springs": 52000, "venice": 38000,
  "bradenton": 88000, "clearwater": 72000, "st. petersburg": 95000,
  "st pete": 95000, "boca raton": 85000, "delray beach": 68000,
  "west palm beach": 145000, "palm beach": 145000, "fort lauderdale": 185000,
  "daytona beach": 72000, "ocala": 98000, "the villages": 85000,
  "pensacola": 65000, "tallahassee": 52000, "gainesville": 42000,
  // Other retirement-heavy markets
  "scottsdale": 105000, "sun city": 48000, "sedona": 12000,
  "myrtle beach": 75000, "hilton head": 35000, "asheville": 48000,
  "santa fe": 42000, "palm springs": 55000, "santa barbara": 42000
};

function get65PlusEstimate(city) {
  const key = city.toLowerCase().replace(/,.*$/, '').trim();
  for (const [metro, pop] of Object.entries(METRO_65_PLUS)) {
    if (key.includes(metro) || metro.includes(key)) return pop;
  }
  return 45000; // national average fallback
}

async function fetchPlaceDetails(placeId, apiKey) {
  const fields = 'name,rating,user_ratings_total,photos,website,opening_hours,geometry,formatted_address,reviews';
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.result || null;
}

async function searchPlaces(query, apiKey, location, radius) {
  let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
  if (location) url += `&location=${location}&radius=${radius || config.competitorRadius}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.results || [];
}

async function getCensusData(city) {
  // First: check the lookup table (county/metro level — right scope for an audiology practice)
  const tablePop = get65PlusEstimate(city);
  if (tablePop !== 45000) return tablePop; // found a specific entry

  // Fallback: Census API county-level query (more meaningful than city-place data)
  try {
    const stateMatch = city.match(/,\s*([A-Z]{2})$/i);
    if (!stateMatch) return tablePop;

    const STATE_FIPS = {
      AL:'01',AK:'02',AZ:'04',AR:'05',CA:'06',CO:'08',CT:'09',DE:'10',FL:'12',GA:'13',
      HI:'15',ID:'16',IL:'17',IN:'18',IA:'19',KS:'20',KY:'21',LA:'22',ME:'23',MD:'24',
      MA:'25',MI:'26',MN:'27',MS:'28',MO:'29',MT:'30',NE:'31',NV:'32',NH:'33',NJ:'34',
      NM:'35',NY:'36',NC:'37',ND:'38',OH:'39',OK:'40',OR:'41',PA:'42',RI:'44',SC:'45',
      SD:'46',TN:'47',TX:'48',UT:'49',VT:'50',VA:'51',WA:'53',WV:'54',WI:'55',WY:'56',
      DC:'11'
    };
    const stateCode = STATE_FIPS[stateMatch[1].toUpperCase()];
    if (!stateCode) return tablePop;

    // Query all counties in the state — smaller dataset, reliable
    const vars = 'B01001_020E,B01001_021E,B01001_022E,B01001_023E,B01001_024E,B01001_025E,B01001_044E,B01001_045E,B01001_046E,B01001_047E,B01001_048E,B01001_049E,NAME';
    const censusUrl = `https://api.census.gov/data/2022/acs/acs5?get=${vars}&for=county:*&in=state:${stateCode}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(censusUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error('Census API error');
    const rows = await res.json();
    const header = rows[0];
    const nameIdx = header.indexOf('NAME');
    const cityClean = city.replace(/,.*$/, '').trim().toLowerCase();

    let bestPop = 0;
    for (const row of rows.slice(1)) {
      const name = (row[nameIdx] || '').toLowerCase();
      if (name.includes(cityClean)) {
        let pop65plus = 0;
        for (let i = 0; i < 12; i++) pop65plus += parseInt(row[i]) || 0;
        if (pop65plus > bestPop) bestPop = pop65plus;
      }
    }
    return bestPop > 1000 ? bestPop : tablePop;
  } catch (err) {
    console.log('[Research] Census fallback for', city, ':', err.message);
    return tablePop;
  }
}

// Distance between two lat/lng points in kilometres (Haversine formula)
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Extract the most recent 1–2 reviews from a Place Details result.
 * Sorts by review time (newest first) before selecting, so the returned
 * reviews are guaranteed to be the most recently posted.
 * Returns an array of { author, text } objects trimmed to ~100 chars.
 */
function extractRecentReviews(details) {
  if (!details || !Array.isArray(details.reviews) || details.reviews.length === 0) return [];
  const sorted = [...details.reviews].sort((a, b) => (b.time || 0) - (a.time || 0));
  return sorted
    .slice(0, 2)
    .map(r => ({
      author: r.author_name || 'A patient',
      text: (r.text || '').slice(0, 100).trim()
    }))
    .filter(r => r.text.length > 0);
}

/**
 * Return value: plain-English delta string if any competitor gained reviews,
 * or null if none did. Baseline counts in researchData.competitors are always
 * updated to the current counts (even when no positive delta exists) so future
 * calls measure correctly from this snapshot.
 */
async function fetchCompetitorVelocity(researchData, apiKey) {
  if (!apiKey) return null;
  const competitors = researchData?.competitors;
  if (!Array.isArray(competitors) || competitors.length === 0) return null;

  const deltas = [];
  let baselineUpdated = false;

  for (const comp of competitors) {
    if (!comp.placeId) continue;
    try {
      const fields = 'user_ratings_total,name';
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${comp.placeId}&fields=${fields}&key=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();
      const current = data.result?.user_ratings_total || 0;
      const baseline = comp.reviews || 0;
      const diff = current - baseline;

      if (diff > 0) {
        deltas.push({ name: comp.name, gained: diff });
      }

      // Always update baseline to current so the next call measures from here
      if (current !== baseline) {
        comp.reviews = current;
        baselineUpdated = true;
      }
    } catch (err) {
      console.log(`[Research] Competitor velocity fetch failed for ${comp.name}:`, err.message);
    }
  }

  // Signal to caller whether baseline was mutated (so caller can persist if needed)
  researchData._competitorBaselineUpdated = baselineUpdated || deltas.length > 0;

  if (deltas.length === 0) return null;

  // Sort by most gained
  deltas.sort((a, b) => b.gained - a.gained);
  const top = deltas[0];
  return `${top.name} gained ${top.gained} new review${top.gained === 1 ? '' : 's'} since we last checked`;
}

/**
 * Re-fetch the prospect's own recent reviews from Google Place Details.
 * Uses the stored placeId from researchData.
 * Returns an array of { author, text } objects, or an empty array on failure.
 */
async function refreshRecentReviews(placeId, apiKey) {
  if (!apiKey || placeId == null) return [];
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=reviews&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    return extractRecentReviews(data.result || null);
  } catch (err) {
    console.log(`[Research] Review refresh failed for placeId ${placeId}:`, err.message);
    return [];
  }
}

/**
 * Search Google Places for nearby referral sources: ENTs, audiologist referrals,
 * and health insurance offices within ~2km of the practice.
 * Gathers all candidates across keyword searches, deduplicates by place_id,
 * sorts ascending by distance, and returns the top 3 closest results.
 */
async function findReferralSources(lat, lng, apiKey) {
  if (!apiKey || lat == null || lng == null) return [];

  const REFERRAL_KEYWORDS = [
    'ear nose throat doctor',
    'audiologist referral',
    'health insurance'
  ];

  const location = `${lat},${lng}`;
  const RADIUS_M = 2000;
  const seen = new Set();
  const candidates = [];

  for (const keyword of REFERRAL_KEYWORDS) {
    try {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(keyword)}&location=${location}&radius=${RADIUS_M}&key=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();
      for (const place of (data.results || []).slice(0, 5)) {
        if (seen.has(place.place_id)) continue;
        seen.add(place.place_id);
        const pLat = place.geometry?.location?.lat || lat;
        const pLng = place.geometry?.location?.lng || lng;
        const distKm = Math.round(haversineKm(lat, lng, pLat, pLng) * 10) / 10;
        candidates.push({ name: place.name, distKm });
      }
    } catch (err) {
      console.log(`[Research] Referral source search failed for "${keyword}":`, err.message);
    }
  }

  // Sort by proximity ascending, return top 3 closest
  return candidates
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, 3);
}

async function runResearch(session, practiceName, practiceStreet, city, confirmedPlaceId = null) {
  const sessions = require('./sessions');
  const apiKey = process.env.GOOGLE_PLACES_KEY;

  sessions.update(session.sessionId, { researchStatus: 'running' });

  if (!apiKey) {
    console.log('[Research] No GOOGLE_PLACES_KEY — using mock data');
    const mockData = {
      name: practiceName,
      rating: 4.2,
      reviews: 28,
      photos: 4,
      websiteListed: true,
      hoursSet: true,
      address: [practiceStreet, city].filter(Boolean).join(', ') || city,
      lat: 37.7749,
      lng: -122.4194,
      placeId: null,
      competitors: [
        { name: 'Clear Hearing Center', reviews: 187, rating: 4.8, placeId: null, distKm: 0.8 },
        { name: 'Bay Audiology', reviews: 92, rating: 4.7, placeId: null, distKm: 1.4 },
        { name: 'Advanced Hearing Solutions', reviews: 71, rating: 4.5, placeId: null, distKm: 2.1 }
      ],
      competitorSummary: `${practiceName} is ranked 4th out of 7 practices by review count`,
      prospectRank: 4,
      populationOver65: get65PlusEstimate(city),
      estimatedHearingLoss: Math.round(get65PlusEstimate(city) * 0.33),
      messagingEnabled: false,
      profileScore: 'weak',
      recentReviews: [
        { author: 'Emma R.', text: 'This practice completely changed my quality of life — I can hear my grandkids again!', isMock: true },
        { author: 'James T.', text: 'Professional and thorough. Highly recommend to anyone with hearing concerns.', isMock: true }
      ],
      nearbyReferralSources: []
    };
    sessions.update(session.sessionId, { researchData: mockData, researchStatus: 'complete' });
    return;
  }

  try {
    let place, details, pop65, usedPlaceId;

    if (confirmedPlaceId) {
      // User confirmed exact listing — skip fuzzy search, go straight to Place Details
      console.log(`[Research] Using confirmed placeId: ${confirmedPlaceId}`);
      [details, pop65] = await Promise.all([
        fetchPlaceDetails(confirmedPlaceId, apiKey),
        getCensusData(city)
      ]);
      if (!details) {
        sessions.update(session.sessionId, { researchStatus: 'failed' });
        return;
      }
      usedPlaceId = confirmedPlaceId;
      place = {
        place_id: confirmedPlaceId,
        name: details.name,
        rating: details.rating || 0,
        user_ratings_total: details.user_ratings_total || 0,
        formatted_address: details.formatted_address || city,
        geometry: details.geometry
      };
    } else {
      // Text search — include street when available for more precise matching
      const searchQuery = [practiceName, practiceStreet, city].filter(Boolean).join(' ');
      const [placeResults, pop65_] = await Promise.all([
        searchPlaces(searchQuery, apiKey),
        getCensusData(city)
      ]);
      pop65 = pop65_;

      if (!placeResults.length) {
        sessions.update(session.sessionId, { researchStatus: 'failed' });
        return;
      }

      place = placeResults[0];
      usedPlaceId = place.place_id;
      details = await fetchPlaceDetails(place.place_id, apiKey);
    }

    const lat = place.geometry?.location?.lat;
    const lng = place.geometry?.location?.lng;

    // Competitor search — radius stays at ~5 miles but closest strong performers surface first
    const compResults = await searchPlaces(
      config.competitorKeyword,
      apiKey,
      `${lat},${lng}`,
      config.competitorRadius
    );

    const competitors = compResults
      .filter(p => !p.name.toLowerCase().includes(practiceName.toLowerCase().split(' ')[0].toLowerCase()))
      .map(p => {
        const cLat = p.geometry?.location?.lat || lat;
        const cLng = p.geometry?.location?.lng || lng;
        const distKm = haversineKm(lat, lng, cLat, cLng);
        return {
          name: p.name,
          reviews: p.user_ratings_total || 0,
          rating: p.rating || 0,
          placeId: p.place_id,
          distKm: Math.round(distKm * 10) / 10
        };
      })
      .sort((a, b) => {
        // Proximity-weighted score: closest strong performers bubble to the top
        const scoreA = a.reviews / (1 + a.distKm / 2);
        const scoreB = b.reviews / (1 + b.distKm / 2);
        return scoreB - scoreA;
      })
      .slice(0, 5);

    const allByReviews = [
      { name: practiceName, reviews: place.user_ratings_total || 0 },
      ...competitors
    ].sort((a, b) => b.reviews - a.reviews);
    const prospectRank = allByReviews.findIndex(p => p.name === practiceName) + 1;

    const photoCount = details?.photos?.length || 0;
    const profileScore = photoCount >= 30 ? 'strong' : photoCount >= 10 ? 'okay' : 'weak';

    // Extract recent reviews from Place Details response
    const recentReviews = extractRecentReviews(details);

    // Find nearby referral sources (ENTs, insurance offices)
    const nearbyReferralSources = await findReferralSources(lat, lng, apiKey);

    const researchData = {
      name: details?.name || place.name,
      rating: place.rating || 0,
      reviews: place.user_ratings_total || 0,
      photos: photoCount,
      websiteListed: !!(details?.website),
      hoursSet: !!(details?.opening_hours),
      address: place.formatted_address || '',
      lat,
      lng,
      placeId: usedPlaceId,
      competitors,
      competitorSummary: `${practiceName} is ranked ${prospectRank}${ordinal(prospectRank)} out of ${allByReviews.length} practices by review count`,
      prospectRank,
      populationOver65: pop65,
      estimatedHearingLoss: Math.round(pop65 * 0.33),
      messagingEnabled: false,
      profileScore,
      recentReviews,
      nearbyReferralSources
    };

    sessions.update(session.sessionId, { researchData, researchStatus: 'complete' });
    console.log(`[Research] Complete for ${practiceName} in ${city}${confirmedPlaceId ? ' (confirmed placeId)' : ''} — ${recentReviews.length} recent reviews, ${nearbyReferralSources.length} referral sources`);
  } catch (err) {
    console.error('[Research] Error:', err.message);
    sessions.update(session.sessionId, { researchStatus: 'failed' });
  }
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

module.exports = { runResearch, fetchCompetitorVelocity, findReferralSources, refreshRecentReviews };
