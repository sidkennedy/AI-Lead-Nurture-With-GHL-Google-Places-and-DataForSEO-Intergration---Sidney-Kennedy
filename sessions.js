const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'sessions.json');

function load() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { return {}; }
}

function save(data) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Sessions] Write error:', err.message);
  }
}

function get(sessionId) {
  return load()[sessionId] || null;
}

function set(sessionId, session) {
  const all = load();
  all[sessionId] = session;
  save(all);
}

function update(sessionId, updates) {
  const all = load();
  if (!all[sessionId]) return;
  all[sessionId] = { ...all[sessionId], ...updates };
  save(all);
  return all[sessionId];
}

function getAll() {
  return load();
}

module.exports = { get, set, update, getAll };
