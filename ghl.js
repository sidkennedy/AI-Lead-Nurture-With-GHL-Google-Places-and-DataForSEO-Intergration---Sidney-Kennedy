const BASE = 'https://services.leadconnectorhq.com';

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

async function fetchContactsByTag(tag, maxResults = Infinity) {
  const contacts = [];
  let page = 1;
  const limit = 100;

  try {
    while (contacts.length < maxResults) {
      const params = new URLSearchParams({
        locationId: process.env.GHL_LOCATION_ID || '',
        limit: String(limit),
        page: String(page)
      });
      params.append('tags[]', tag);

      const res = await fetch(`${BASE}/contacts/?${params.toString()}`, { headers: headers() });
      if (!res.ok) throw new Error(`GHL contacts fetch ${res.status}`);
      const data = await res.json();

      const batch = data.contacts || [];
      contacts.push(...batch);

      // Stop if we got fewer than a full page (last page)
      if (batch.length < limit) break;
      page++;
    }
    console.log(`[GHL] fetchContactsByTag("${tag}"): found ${contacts.length} contact(s)`);
    return contacts;
  } catch (err) {
    console.error('[GHL] fetchContactsByTag error:', err.message);
    return [];
  }
}

module.exports = { fetchContact, fetchMessages, sendMessage, getOrCreateConversation, fetchContactsByTag };
