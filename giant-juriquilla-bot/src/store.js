import fs from 'fs/promises';
import path from 'path';

// Persist to a Railway VOLUME, never the working dir (wiped on redeploy) —
// same lesson as the Lightspeed token.
const STORE_PATH = process.env.CONVO_STORE_PATH || '/data/conversations.json';
const TTL_MS = 24 * 60 * 60 * 1000; // WhatsApp's 24h service window
const MAX_TURNS = 12;

// INVARIANT: `updatedAt` means "when this thread last had a conversational
// turn", and only appendTurn/clearHistory may write it. It is what TTL expiry
// and handler.js's first-contact check both read, so anything else that
// re-stamps it keeps dead threads alive. Escalation has its own `escalatedAt`.

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
  if (Date.now() - c.updatedAt > TTL_MS) { delete db[waId]; persist(); return []; }
  return c.messages;
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

// Wipes the stored turns for one number, keeping the record (and its escalated
// flag) intact. Returns whether there was anything to clear.
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
  // NOTE: updatedAt is deliberately NOT touched here — see the invariant above.
  // Stamping it made escalation resurrect expired history: handler.js reads the
  // escalation first, and clearing a lapsed one re-dated the record, so
  // day-old turns survived the TTL and the thread no longer looked like first
  // contact — which silently skipped the 5-minute hold.
  await persist();
}
