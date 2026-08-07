// Sends messages back through the Dualhook relay. If the relay gives you a
// different send endpoint/base URL, only this file changes.
const WA_API_HOST = process.env.WA_API_HOST || 'https://api.dualhook.com';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v25.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN; // Dualhook dh_live_ key (outbound relay credential)
const BASE = `${WA_API_HOST}/${GRAPH_VERSION}/${PHONE_NUMBER_ID}`;

async function post(body) {
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  return res.json();
}

export function sendText(to, body) {
  const safe = body.length > 4000 ? body.slice(0, 3990) + '…' : body; // 4096 cap
  return post({ to, type: 'text', text: { body: safe } });
}

export function sendTyping(messageId) {
  return post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
}
