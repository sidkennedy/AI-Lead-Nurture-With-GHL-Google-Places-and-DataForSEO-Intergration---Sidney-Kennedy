const fetch = require('node-fetch');
const config = require('./config');

// Fallback 65+ population estimates for top metro areas
const METRO_65_PLUS = {
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
  "orlando": 240000, "cincinnati": 155000
};

function get65PlusEstimate(city) {
  const key = city.toLowerCase().replace(/,.*$/, '').trim();
  for (const [metro, pop] of Object.entries(METRO_65_PLUS)) {
    if (key.includes(metro) || metro.includes(key)) return pop;
  }
  return 45000; // national average fallback
}

async function fetchPlaceDetails(placeId, apiKey) {
  const fields = 'name,rating,user_ratings_total,photos,website,opening_hours,geometry,formatted_address';
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
  try {
    const cityClean = city.replace(/,.*$/, '').trim();
    const stateMatch = city.match(/,\s*([A-Z]{2})$/i);
    const stateAbbr = stateMatch ? stateMatch[1].toUpperCase() : null;

    // Census API: get 65+ population by place name
    const censusUrl = `https://api.census.gov/data/2022/acs/acs5?get=B01001_020E,B01001_021E,B01001_022E,B01001_023E,B01001_024E,B01001_025E,B01001_044E,B01001_045E,B01001_046E,B01001_047E,B01001_048E,B01001_049E,NAME&for=place:*&in=state:*`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(censusUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error('Census API error');
    const rows = await res.json();
    const header = rows[0];

    const nameIdx = header.indexOf('NAME');
    const dataStart = 0;
    const dataEnd = 12;

    for (const row of rows.slice(1)) {
      const name = (row[nameIdx] || '').toLowerCase();
      if (name.includes(cityClean.toLowerCase())) {
        let pop65plus = 0;
        for (let i = dataStart; i < dataEnd; i++) {
          pop65plus += parseInt(row[i]) || 0;
        }
        if (pop65plus > 0) return pop65plus;
      }
    }
    return get65PlusEstimate(city);
  } catch (err) {
    console.log('[Research] Census fallback for', city, ':', err.message);
    return get65PlusEstimate(city);
  }
}

async function runResearch(session, practiceName, city) {
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
      address: `${city}`,
      lat: 37.7749,
      lng: -122.4194,
      placeId: null,
      competitors: [
        { name: 'Clear Hearing Center', reviews: 187, rating: 4.8, placeId: null },
        { name: 'Bay Audiology', reviews: 92, rating: 4.7, placeId: null },
        { name: 'Advanced Hearing Solutions', reviews: 71, rating: 4.5, placeId: null }
      ],
      competitorSummary: `${practiceName} is ranked 4th out of 7 practices by review count`,
      prospectRank: 4,
      populationOver65: get65PlusEstimate(city),
      estimatedHearingLoss: Math.round(get65PlusEstimate(city) * 0.33),
      messagingEnabled: false,
      profileScore: 'weak'
    };
    sessions.update(session.sessionId, { researchData: mockData, researchStatus: 'complete' });
    return;
  }

  try {
    // Run Places search + census in parallel
    const [placeResults, pop65] = await Promise.all([
      searchPlaces(`${practiceName} ${city}`, apiKey),
      getCensusData(city)
    ]);

    if (!placeResults.length) {
      sessions.update(session.sessionId, { researchStatus: 'failed' });
      return;
    }

    const place = placeResults[0];
    const details = await fetchPlaceDetails(place.place_id, apiKey);
    const lat = place.geometry?.location?.lat;
    const lng = place.geometry?.location?.lng;

    // Competitor search
    const compResults = await searchPlaces(
      config.competitorKeyword,
      apiKey,
      `${lat},${lng}`,
      config.competitorRadius
    );

    const competitors = compResults
      .filter(p => !p.name.toLowerCase().includes(practiceName.toLowerCase().split(' ')[0].toLowerCase()))
      .map(p => ({ name: p.name, reviews: p.user_ratings_total || 0, rating: p.rating || 0, placeId: p.place_id }))
      .sort((a, b) => b.reviews - a.reviews)
      .slice(0, 5);

    const allByReviews = [
      { name: practiceName, reviews: place.user_ratings_total || 0 },
      ...competitors
    ].sort((a, b) => b.reviews - a.reviews);
    const prospectRank = allByReviews.findIndex(p => p.name === practiceName) + 1;

    const photoCount = details?.photos?.length || 0;
    const profileScore = photoCount >= 30 ? 'strong' : photoCount >= 10 ? 'okay' : 'weak';

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
      placeId: place.place_id,
      competitors,
      competitorSummary: `${practiceName} is ranked ${prospectRank}${ordinal(prospectRank)} out of ${allByReviews.length} practices by review count`,
      prospectRank,
      populationOver65: pop65,
      estimatedHearingLoss: Math.round(pop65 * 0.33),
      messagingEnabled: false,
      profileScore
    };

    sessions.update(session.sessionId, { researchData, researchStatus: 'complete' });
    console.log(`[Research] Complete for ${practiceName} in ${city}`);
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

module.exports = { runResearch };
