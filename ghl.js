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

async function fetchContactsByTag(tag) {
  const tagLower = tag.toLowerCase();
  const matched = [];
  const limit = 100;
  let startAfterId = null;

  try {
    // GHL doesn't support server-side tag filtering on the contacts list endpoint.
    // We paginate through all contacts using cursor-based pagination and filter locally.
    while (true) {
      const params = new URLSearchParams({
        locationId: process.env.GHL_LOCATION_ID || '',
        limit: String(limit)
      });
      if (startAfterId) params.set('startAfterId', startAfterId);

      const res = await fetch(`${BASE}/contacts/?${params.toString()}`, { headers: headers() });
      if (!res.ok) throw new Error(`GHL contacts fetch ${res.status}`);
      const data = await res.json();

      const batch = data.contacts || [];

      for (const c of batch) {
        const contactTags = (c.tags || []).map(t =>
          (typeof t === 'string' ? t : (t.name || t.tag || '')).toLowerCase()
        );
        if (contactTags.includes(tagLower)) matched.push(c);
      }

      // GHL cursor: use the last contact's id as startAfterId for the next page
      if (batch.length < limit) break;
      startAfterId = batch[batch.length - 1].id;
    }

    console.log(`[GHL] fetchContactsByTag("${tag}"): found ${matched.length} matching contact(s)`);
    return matched;
  } catch (err) {
    console.error('[GHL] fetchContactsByTag error:', err.message);
    return [];
  }
}

async function sendEmail(contactId, subject, body) {
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
    console.log(`[GHL] Email sent to contact ${contactId}: "${subject}"`);
    return data;
  } catch (err) {
    console.error('[GHL] sendEmail error:', err.message);
    return null;
  }
}

module.exports = { fetchContact, fetchMessages, sendMessage, sendEmail, getOrCreateConversation, fetchContactsByTag };
