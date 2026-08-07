import Anthropic from '@anthropic-ai/sdk';
import { sendText, sendTyping, wasSentByBot, wasRecentlySentBody } from './whatsapp.js';
import { getHistory, appendTurn, getEscalation, setEscalated } from './store.js';
import { SYSTEM_PROMPT } from './knowledge.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const TZ = process.env.TIMEZONE || 'America/Mexico_City';

// How long a thread stays muted after a human takes over. Set small (e.g.
// 120000) in Railway to test the resume, then back to 2h. A non-numeric or
// negative value falls back to the default rather than muting forever / never.
const DEFAULT_ESCALATION_WINDOW_MS = 7_200_000; // 2h
const rawWindow = Number(process.env.ESCALATION_WINDOW_MS);
const ESCALATION_WINDOW_MS =
  Number.isFinite(rawWindow) && rawWindow >= 0 ? rawWindow : DEFAULT_ESCALATION_WINDOW_MS;
console.log(`[handler] escalation window: ${ESCALATION_WINDOW_MS}ms`);

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

  // A human is handling this thread — stay quiet, but only for the escalation
  // window. Once it lapses the bot picks the conversation back up by itself,
  // instead of the thread staying muted until the 24h TTL.
  const { escalated, escalatedAt } = await getEscalation(from);
  if (escalated) {
    const mutedFor = Date.now() - escalatedAt;
    if (mutedFor < ESCALATION_WINDOW_MS) return;
    await setEscalated(from, false);
    console.log(`[handler] escalation window lapsed for ${from} after ${Math.round(mutedFor / 1000)}s — bot resuming`);
  }

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

// Fields that might carry the message's origin. Logged only — see the note in
// handleStaffEcho about why nothing branches on them yet.
const SOURCE_KEYS = [
  'source', 'origin', 'sent_by', 'sender_type', 'message_origin',
  'from_me', 'is_echo', 'is_from_business', 'channel', 'device',
];

// COEXISTENCE: an echo means *someone* sent from the business number — either a
// human in the WhatsApp Business app, or the bot itself via the API. Only the
// human case should mute the bot on that thread.
//
// The business number is SHARED between the app and the API, so `from` is the
// same either way and cannot distinguish them. What can: the send API returns
// the wamid it assigned, and the echo replays that same wamid back, so an id
// match against our own recent sends is an exact identity check.
export async function handleStaffEcho(echo) {
  // TEMPORARY — remove once we've seen a real payload in the Railway logs.
  console.log(JSON.stringify(echo));

  const id = echo.id || echo.message_id;
  const customer = echo.to || echo.recipient_id || echo.recipient?.wa_id;

  // 1. Our own send, identified exactly by wamid. This is the bug fix: without
  //    it the bot escalated on the echo of every reply it made and muted itself.
  if (id && wasSentByBot(id)) {
    console.log(`[echo] ${id} is our own API send — ignoring, no escalation`);
    return;
  }

  // 2. Race guard: the echo webhook can arrive before the send response has been
  //    parsed, so the wamid may not be recorded yet. Fall back to matching the
  //    recipient + exact body against what we just sent.
  const body = echo.text?.body;
  if (customer && body && wasRecentlySentBody(customer, body)) {
    console.log(`[echo] body matches a recent bot send to ${customer} — ignoring, no escalation`);
    return;
  }

  // 3. Surface any origin-ish fields that actually exist, so one can be promoted
  //    to the primary signal on the next pass. Deliberately NOT branched on yet:
  //    these key names are guesses, and if a wrong guess classified a human reply
  //    as bot-sent the bot would talk over staff — a worse failure than the one
  //    being fixed. Paste a real echo from the logs and this becomes step 0.
  const origin = {};
  for (const k of SOURCE_KEYS) if (echo[k] !== undefined) origin[k] = echo[k];
  if (Object.keys(origin).length) console.log('[echo] origin-ish fields present:', JSON.stringify(origin));

  if (!customer) { console.warn('[echo] no recipient found', JSON.stringify(echo)); return; }
  await setEscalated(customer, true);
  console.log(`[echo] human staff replied to ${customer} — bot muted on that thread`);
}
