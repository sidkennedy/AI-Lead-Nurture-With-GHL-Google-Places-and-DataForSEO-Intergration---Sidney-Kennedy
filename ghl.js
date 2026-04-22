const BASE = 'https://services.leadconnectorhq.com';
const conversations = require('./conversations');

function headers() {
  return {
    'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
    'Version': '2021-04-15',
    'Content-Type': 'application/json'
  };
}

async function fetchContact(contactId) {
  try {
    const res = await fetch(`${BASE}/contacts/${contactId}`, { headers: headers() });
    if (!res.ok) throw new Error(`GHL contact fetch ${res.status}`);
    const data = await res.json();
    return data.contact || data || null;
  } catch (err) {
    console.error('[GHL] fetchContact error:', err.message);
    return null;
  }
}

async function fetchMessages(conversationId, limit = 100) {
  try {
    const res = await fetch(
      `${BASE}/conversations/${conversationId}/messages?limit=${limit}`,
      { headers: headers() }
    );
    if (!res.ok) throw new Error(`GHL messages fetch ${res.status}`);
    const data = await res.json();
    // GHL API can return messages as a direct array OR nested inside an object
    let msgs = data.messages;
    if (msgs && !Array.isArray(msgs)) {
      // e.g. { messages: { messages: [...], lastMessageId: '...' } }
      msgs = msgs.messages || msgs.data || [];
    }
    return Array.isArray(msgs) ? msgs : [];
  } catch (err) {
    console.error('[GHL] fetchMessages error:', err.message);
    return [];
  }
}

async function sendMessage(contactId, body) {
  try {
    const payload = {
      type: 'SMS',
      contactId,
      message: body
    };
    const res = await fetch(`${BASE}/conversations/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL send ${res.status}: ${text}`);
    }
    const data = await res.json();
    console.log(`[GHL] Message sent to contact ${contactId}`);
    return data;
  } catch (err) {
    console.error('[GHL] sendMessage error:', err.message);
    return null;
  }
}

async function getOrCreateConversation(contactId) {
  try {
    const res = await fetch(`${BASE}/conversations/search?contactId=${contactId}`, {
      headers: headers()
    });
    if (!res.ok) throw new Error(`GHL conversation search ${res.status}`);
    const data = await res.json();
    const convos = data.conversations || [];
    if (convos.length > 0) return convos[0].id;

    const createRes = await fetch(`${BASE}/conversations/`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ contactId, locationId: process.env.GHL_LOCATION_ID })
    });
    if (!createRes.ok) throw new Error(`GHL conversation create ${createRes.status}`);
    const created = await createRes.json();
    return created.conversation?.id || null;
  } catch (err) {
    console.error('[GHL] getOrCreateConversation error:', err.message);
    return null;
  }
}

// Helper: format a GHL error response into a user-friendly message
function formatGhlError(status) {
  if (status === 429) return 'GHL is rate-limiting us (429 Too Many Requests). Wait 60 seconds and try again.';
  if (status === 401) return 'GHL authentication failed (401). Your GHL_API_KEY is invalid or expired.';
  if (status === 403) return 'GHL permission denied (403). Your API key does not have access to this location.';
  if (status === 404) return 'GHL location not found (404). Check your GHL_LOCATION_ID.';
  return `GHL API error ${status}. Check GHL_API_KEY and GHL_LOCATION_ID, or try again in a moment.`;
}

async function fetchContactsByTag(tag, signal) {
  const tagLower = tag.toLowerCase();
  const matched = [];
  let totalScanned = 0;
  const locationId = process.env.GHL_LOCATION_ID || '';

  // Try GHL's server-side tag search first (POST /contacts/search).
  // This is much faster than paginating all contacts — only returns matching ones.
  try {
    const searchRes = await fetch(`${BASE}/contacts/search?locationId=${encodeURIComponent(locationId)}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        filters: [{ field: 'tags', operator: 'CONTAINS_ANY', value: [tag] }],
        limit: 200,
        locationId
      }),
      signal
    });
    if (searchRes.ok) {
      const data = await searchRes.json();
      const contacts = data.contacts || data.data || [];
      console.log(`[GHL] fetchContactsByTag("${tag}"): search API returned ${contacts.length} contacts`);
      return { contacts, totalScanned: contacts.length };
    }
    console.warn(`[GHL] Tag search API returned ${searchRes.status} — falling back to full scan`);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn(`[GHL] Tag search API failed (${err.message}) — falling back to full scan`);
  }

  // Fallback: paginate all contacts and filter locally.
  // 429s are retried once (2s wait) before failing so we don't exceed the request timeout.
  const limit = 100;
  let startAfterId = null;
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('AbortError'), { name: 'AbortError' });
    const params = new URLSearchParams({ locationId, limit: String(limit) });
    if (startAfterId) params.set('startAfterId', startAfterId);

    let res = await fetch(`${BASE}/contacts/?${params.toString()}`, { headers: headers(), signal });
    if (res.status === 429) {
      console.warn('[GHL] 429 on full scan — backing off 2s');
      await new Promise(r => setTimeout(r, 2000));
      res = await fetch(`${BASE}/contacts/?${params.toString()}`, { headers: headers(), signal });
    }
    if (!res.ok) throw new Error(formatGhlError(res.status));
    const data = await res.json();

    const batch = data.contacts || [];
    totalScanned += batch.length;
    for (const c of batch) {
      const contactTags = (c.tags || []).map(t =>
        (typeof t === 'string' ? t : (t.name || t.tag || '')).toLowerCase()
      );
      if (contactTags.includes(tagLower)) matched.push(c);
    }
    if (batch.length < limit) break;
    startAfterId = batch[batch.length - 1].id;
  }

  console.log(`[GHL] fetchContactsByTag("${tag}"): scanned ${totalScanned} contacts, found ${matched.length} with tag`);
  return { contacts: matched, totalScanned };
}

/**
 * Send an email to a contact via GHL.
 * Reads the contact's email address from the local record; returns null with a
 * skip log if none is on file (check is centralized here so callers don't need
 * to duplicate it).
 *
 * Auth for /webhooks/ghl/enrolled accepts either GHL_WEBHOOK_SECRET (for GHL
 * calls) or ADMIN_KEY (as a fallback), and fails closed when neither matches.
 */
async function sendEmail(contactId, subject, body) {
  // Guard: local email must be on file
  const contact = conversations.get(contactId);
  if (!contact?.email) {
    console.log(`[GHL] sendEmail skipped for ${contactId} — no email on local record`);
    return null;
  }

  try {
    const payload = {
      type: 'Email',
      contactId,
      subject,
      body
    };
    const res = await fetch(`${BASE}/conversations/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GHL email send ${res.status}: ${text}`);
    }
    const data = await res.json();
    console.log(`[GHL] Email sent to contact ${contactId} (${contact.email}): "${subject}"`);
    return data;
  } catch (err) {
    console.error('[GHL] sendEmail error:', err.message);
    return null;
  }
}

module.exports = { fetchContact, fetchMessages, sendMessage, sendEmail, getOrCreateConversation, fetchContactsByTag };
