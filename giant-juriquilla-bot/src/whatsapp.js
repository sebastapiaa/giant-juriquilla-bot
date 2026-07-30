// Sends messages back through the Graph API. If Dualhook gives you a different
// send endpoint/base URL, only this file changes.
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN; // permanent System User token
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}`;

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
