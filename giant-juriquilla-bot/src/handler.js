import Anthropic from '@anthropic-ai/sdk';
import { sendText, sendTyping } from './whatsapp.js';
import { getHistory, appendTurn, isEscalated, setEscalated } from './store.js';
import { SYSTEM_PROMPT } from './knowledge.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const TZ = process.env.TIMEZONE || 'America/Mexico_City';

// The model has NO clock. Compute the real date/time ourselves, in Querétaro's
// timezone (the server runs in UTC), and inject it every message. Without this
// Gigo invents dates or thinks it's ~6h later than it is and says "ya cerramos"
// while the store is open.
function currentDateTimeMx() {
  const now = new Date();
  const fecha = new Intl.DateTimeFormat('es-MX', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).format(now);
  const hora = new Intl.DateTimeFormat('es-MX', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(now);
  return `Fecha y hora actual en Juriquilla, Querétaro: ${fecha}, ${hora}. Usa SIEMPRE esta fecha y hora para responder sobre horarios, si la tienda está abierta ahora, o cualquier pregunta de tiempo. Nunca inventes ni supongas la fecha.`;
}

// Dedup — Meta retries webhooks; same id twice = same reply twice.
const seen = new Map();
function alreadyHandled(id) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 600_000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

const FALLBACK = 'Perdón, tuve un problema técnico. Un miembro del equipo te contacta en un momento.';

export async function handleInboundMessage(msg, contact) {
  const from = msg.from;
  if (alreadyHandled(msg.id)) return;

  // A human is handling this thread — stay quiet.
  if (await isEscalated(from)) return;

  // Only text for now; anything else goes to a person.
  if (msg.type !== 'text') {
    await sendText(from, 'Gracias por tu mensaje. Con gusto un miembro del equipo lo revisa y te responde en un momentito.');
    await setEscalated(from, true);
    return;
  }

  const userText = msg.text.body;
  try {
    await sendTyping(msg.id).catch(() => {});
    const history = await getHistory(from);
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: `${SYSTEM_PROMPT}\n\n## Fecha y hora\n${currentDateTimeMx()}`,
      messages: [...history, { role: 'user', content: userText }],
    });

    let reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const escalate = reply.includes('[ESCALAR]');
    reply = reply.replace(/\[ESCALAR\]/g, '').trim() || FALLBACK;

    await sendText(from, reply);
    await appendTurn(from, userText, reply);
    if (escalate) await setEscalated(from, true);
  } catch (err) {
    console.error('[handler] error', err);
    await sendText(from, FALLBACK).catch(() => {});
    await setEscalated(from, true).catch(() => {});
  }
}

// COEXISTENCE: staff replied from their phone. Flip the flag so the bot stops
// talking on that thread. NOTE: verify the echo's recipient field against
// Dualhook's actual payload — the customer's number may be `to`, `recipient_id`,
// or nested. Log one real echo and adjust this line if needed.
export async function handleStaffEcho(echo) {
  const customer = echo.to || echo.recipient_id || echo.recipient?.wa_id;
  if (!customer) { console.warn('[echo] no recipient found', JSON.stringify(echo)); return; }
  await setEscalated(customer, true);
  console.log(`[echo] staff replied to ${customer} — bot muted on that thread`);
}
