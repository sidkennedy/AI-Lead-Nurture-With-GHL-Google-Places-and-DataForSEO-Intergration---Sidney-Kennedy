const fetch = require('node-fetch');

const GHL_BASE = 'https://services.leadconnectorhq.com';

async function ghlRequest(method, path, body) {
  const key = process.env.GHL_API_KEY;
  if (!key) {
    console.log('[GHL] No API key configured, skipping:', path);
    return null;
  }
  try {
    const res = await fetch(`${GHL_BASE}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[GHL] ${method} ${path} failed ${res.status}:`, text);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('[GHL] Request error:', err.message);
    return null;
  }
}

async function createContact(name, phone, email) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return null;
  const data = await ghlRequest('POST', '/contacts/', {
    locationId,
    firstName: name || 'Unknown',
    phone: phone || '',
    email: email || ''
  });
  return data?.contact?.id || null;
}

async function updateContact(contactId, data) {
  if (!contactId) return null;
  return ghlRequest('PUT', `/contacts/${contactId}`, data);
}

async function addTag(contactId, tag) {
  if (!contactId) return null;
  return ghlRequest('POST', `/contacts/${contactId}/tags`, { tags: [tag] });
}

async function sendNotification(message) {
  const phone = process.env.SIDNEY_PHONE;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!phone || !locationId) {
    console.log('[GHL] Notification (no phone/location configured):', message);
    return null;
  }
  return ghlRequest('POST', '/conversations/messages', {
    type: 'SMS',
    contactId: null,
    locationId,
    message,
    toNumber: phone
  });
}

module.exports = { createContact, updateContact, addTag, sendNotification };
