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

export async function isEscalated(waId) {
  const db = await load();
  return Boolean(db[waId]?.escalated);
}

export async function setEscalated(waId, value) {
  const db = await load();
  db[waId] = db[waId] ?? { messages: [], updatedAt: Date.now() };
  db[waId].escalated = value;
  db[waId].updatedAt = Date.now();
  await persist();
}
