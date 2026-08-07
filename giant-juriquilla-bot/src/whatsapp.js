// Sends messages back through the Dualhook relay. If the relay gives you a
// different send endpoint/base URL, only this file changes.
const WA_API_HOST = process.env.WA_API_HOST || 'https://api.dualhook.com';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v25.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN; // Dualhook dh_live_ key (outbound relay credential)
const BASE = `${WA_API_HOST}/${GRAPH_VERSION}/${PHONE_NUMBER_ID}`;

// --- Outbound send tracking -------------------------------------------------
// Coexistence echoes (smb_message_echoes) replay the bot's OWN API sends back to
// the webhook. They can't be told apart from a human staff reply by phone number,
// because the bot and the WhatsApp Business app share the same business number.
// So we record what we send and let handler.js match incoming echoes against it.
const RECENT_TTL_MS = 600_000; // 10 min — echoes arrive within seconds
const sentIds = new Map();     // wamid -> timestamp, from the send API response
const sentBodies = new Map();  // `${to}|${text}` -> timestamp, recorded pre-send

function remember(map, key) {
  const now = Date.now();
  for (const [k, t] of map) if (now - t > RECENT_TTL_MS) map.delete(k);
  map.set(key, now);
}

function isRecent(map, key) {
  const t = map.get(key);
  if (t === undefined) return false;
  if (Date.now() - t > RECENT_TTL_MS) { map.delete(key); return false; }
  return true;
}

const bodyKey = (to, body) => `${to}|${(body || '').trim()}`;

// Exact identity check — the echo carries back the same wamid the send API
// assigned us, so a hit here is certain rather than a heuristic.
export function wasSentByBot(id) {
  return isRecent(sentIds, id);
}

// Race guard for when an echo beats our own send response back (see handler.js).
export function wasRecentlySentBody(to, body) {
  return isRecent(sentBodies, bodyKey(to, body));
}

async function post(body) {
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  for (const m of json?.messages || []) if (m?.id) remember(sentIds, m.id);
  return json;
}

export function sendText(to, body) {
  const safe = body.length > 4000 ? body.slice(0, 3990) + '…' : body; // 4096 cap
  // Recorded BEFORE the await so it is in place even if the echo webhook lands
  // before the send response does.
  remember(sentBodies, bodyKey(to, safe));
  return post({ to, type: 'text', text: { body: safe } });
}

export function sendTyping(messageId) {
  return post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
}
