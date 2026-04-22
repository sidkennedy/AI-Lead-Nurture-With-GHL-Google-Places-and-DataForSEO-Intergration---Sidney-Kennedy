const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'conversations.json');

function load() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return {}; }
}

function save(data) {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Conversations] Write error:', err.message);
  }
}

function get(contactId) {
  return load()[contactId] || null;
}

function set(contactId, record) {
  const all = load();
  all[contactId] = record;
  save(all);
}

function update(contactId, updates) {
  const all = load();
  if (!all[contactId]) return;
  all[contactId] = { ...all[contactId], ...updates };
  save(all);
  return all[contactId];
}

function getAll() {
  return load();
}

function ensureContact(contactId, defaults = {}) {
  const all = load();
  if (!all[contactId]) {
    all[contactId] = {
      contactId,
      firstName: null,
      city: null,
      phone: null,
      practiceName: null,
      researchData: null,
      scanResults: null,
      booked: false,
      currentStep: 0,
      lastMessageAt: null,
      createdAt: Date.now(),
      exchanges: [],
      ...defaults
    };
    save(all);
  }
  return all[contactId];
}

function addExchange(contactId, exchange) {
  const all = load();
  if (!all[contactId]) return;
  all[contactId].exchanges = all[contactId].exchanges || [];
  const ts = exchange.timestamp && typeof exchange.timestamp === 'number' && exchange.timestamp > 0
    ? exchange.timestamp
    : Date.now();
  all[contactId].exchanges.push({
    direction: exchange.direction,
    body: exchange.body,
    step: exchange.step || null,
    conversationId: exchange.conversationId || null,
    timestamp: ts
  });
  all[contactId].lastMessageAt = Date.now();
  save(all);
}

module.exports = { get, set, update, getAll, ensureContact, addExchange };
