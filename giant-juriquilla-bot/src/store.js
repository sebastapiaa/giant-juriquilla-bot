import fs from 'fs/promises';
import path from 'path';

// Persist to a Railway VOLUME, never the working dir (wiped on redeploy) —
// same lesson as the Lightspeed token.
const STORE_PATH = process.env.CONVO_STORE_PATH || '/data/conversations.json';
const TTL_MS = 24 * 60 * 60 * 1000; // WhatsApp's 24h service window
const MAX_TURNS = 12;

let cache = null;
let writeQueue = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
    console.log(`[store] loaded ${Object.keys(cache).length} conversations`);
  } catch { cache = {}; console.log('[store] starting fresh'); }
  return cache;
}

function persist() {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(cache), 'utf8');
  }).catch(err => console.error('[store] write failed', err));
  return writeQueue;
}

export async function getHistory(waId) {
  const db = await load();
  const c = db[waId];
  if (!c) return [];
  if (Date.now() - c.updatedAt > TTL_MS) {
    // Only the conversation expires. Keep the introduction flag for this number.
    c.messages = [];
    await persist();
    return [];
  }
  return c.messages;
}

export async function hasIntroduced(waId) {
  const db = await load();
  return Boolean(db[waId]?.introducedAt);
}

// Called only after WhatsApp accepts the first reply. This survives history
// expiry, admin resets, and redeploys because it lives on the same volume.
export async function markIntroduced(waId) {
  const db = await load();
  db[waId] = db[waId] ?? { messages: [], updatedAt: Date.now() };
  db[waId].introducedAt = Date.now();
  await persist();
}

export async function appendTurn(waId, userText, assistantText) {
  const db = await load();
  const c = db[waId] ?? { messages: [], updatedAt: 0 };
  c.messages.push({ role: 'user', content: userText }, { role: 'assistant', content: assistantText });
  if (c.messages.length > MAX_TURNS * 2) c.messages = c.messages.slice(-MAX_TURNS * 2);
  c.updatedAt = Date.now();
  db[waId] = c;
  await persist();
}

// Wipes the stored turns for one number, keeping escalation and introduction
// state intact. Returns whether there was anything to clear.
export async function clearHistory(waId) {
  const db = await load();
  const c = db[waId];
  if (!c || c.messages.length === 0) return false;
  c.messages = [];
  c.updatedAt = Date.now();
  await persist();
  return true;
}

export async function isEscalated(waId) {
  const db = await load();
  return Boolean(db[waId]?.escalated);
}

// Escalation state plus WHEN it started, so handler.js can auto-resume once the
// escalation window lapses. escalatedAt is re-stamped on every escalation, so a
// second staff reply restarts the clock from the human's latest message.
export async function getEscalation(waId) {
  const db = await load();
  const c = db[waId];
  if (!c?.escalated) return { escalated: false, escalatedAt: null };
  // Threads escalated before escalatedAt existed fall back to updatedAt, which
  // for an escalated record was stamped at escalation time.
  return { escalated: true, escalatedAt: c.escalatedAt ?? c.updatedAt ?? 0 };
}

export async function setEscalated(waId, value) {
  const db = await load();
  db[waId] = db[waId] ?? { messages: [], updatedAt: Date.now() };
  db[waId].escalated = value;
  db[waId].escalatedAt = value ? Date.now() : null;
  db[waId].updatedAt = Date.now();
  await persist();
}
