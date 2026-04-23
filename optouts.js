const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'optouts.json');

const OPT_OUT_KEYWORDS = /\b(stop|unsubscribe|quit|cancel|end|optout|opt[ -]out)\b/i;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function isOptedOut(contactId) {
  const id = String(contactId);
  return load().includes(id);
}

function add(contactId) {
  const id = String(contactId);
  const list = load();
  if (!list.includes(id)) {
    list.push(id);
    save(list);
    return true;
  }
  return false;
}

function getAll() {
  return load();
}

function isOptOutKeyword(text) {
  return OPT_OUT_KEYWORDS.test((text || '').trim());
}

module.exports = { isOptedOut, add, getAll, isOptOutKeyword };
