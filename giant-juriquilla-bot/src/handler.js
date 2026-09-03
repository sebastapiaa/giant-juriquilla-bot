import Anthropic from '@anthropic-ai/sdk';
import { sendText, sendTyping, wasSentByBot, wasRecentlySentBody } from './whatsapp.js';
import { getHistory, appendTurn, getEscalation, setEscalated } from './store.js';
import { SYSTEM_PROMPT } from './knowledge.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const TZ = process.env.TIMEZONE || 'America/Mexico_City';

// How long a thread stays muted after a human takes over. Set small (e.g.
// 120000) in Railway to test the resume. A non-numeric or negative value falls
// back to the default rather than muting forever / never.
const DEFAULT_ESCALATION_WINDOW_MS = 3_600_000; // 1h
const rawWindow = Number(process.env.ESCALATION_WINDOW_MS);
const ESCALATION_WINDOW_MS =
  Number.isFinite(rawWindow) && rawWindow >= 0 ? rawWindow : DEFAULT_ESCALATION_WINDOW_MS;

// On a thread with no history, hold the bot's first reply this long so staff
// can take the conversation first — if a human answers during the wait, the bot
// never speaks at all. Anything the customer sends meanwhile is folded into the
// single reply. Set 0 to answer immediately.
const rawDelay = Number(process.env.FIRST_REPLY_DELAY_MS);
const FIRST_REPLY_DELAY_MS =
  Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 300_000; // 5 min

console.log(`[handler] escalation window: ${ESCALATION_WINDOW_MS}ms, first-reply delay: ${FIRST_REPLY_DELAY_MS}ms`);

// Numbers the bot never answers. Matched on the last 10 digits, so it does not
// matter whether WhatsApp delivers a Mexican number as 52... or 521... .
// Add more below, or via BLOCKED_NUMBERS in Railway (comma-separated) — that
// one needs a redeploy to take effect, like the other env vars here.
const BLOCKED_NUMBERS = new Set(
  [
    '442 896 5926',
    '55 4443 9349',
    '442 394 0442',
    '462 402 7576',
    '442 386 9454',
    '442 468 3742',
    ...(process.env.BLOCKED_NUMBERS || '').split(','),
  ]
    .map(n => n.replace(/\D/g, '').slice(-10))
    .filter(n => n.length === 10)
);
console.log(`[handler] blocked numbers: ${BLOCKED_NUMBERS.size}`);

function isBlocked(waId) {
  return BLOCKED_NUMBERS.has(String(waId).replace(/\D/g, '').slice(-10));
}

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

// The customer explicitly asked for a person. Detected here, deterministically,
// so the handoff never depends on the model noticing. Over-matching is the safe
// failure (a human answers), so the list leans broad. Add phrases freely.
const HUMAN_REQUEST_RE = new RegExp(
  [
    // Spanish
    'hablar con (alguien|una persona|un humano|un asesor|un agente|un vendedor|el staff|el equipo|un encargado|un humano)',
    'comunicar(me|se) con (alguien|una persona|un asesor|un humano|el staff|el equipo)',
    'quiero (una|a una) persona', 'persona real', 'un humano', 'ser humano',
    'no eres (una )?persona', 'no quiero (hablar con )?(un )?bot', 'atenci[oó]n humana', 'alguien del (equipo|staff|taller)',
    '\\b(asesor|agente|representante|encargado|gerente)\\b',
    // English
    'talk (to|with) (someone|a person|a human|a real person|an agent|staff|the team)',
    'speak (to|with) (someone|a person|a human|a real person|an agent|staff|the team)',
    'real person', 'human being', 'a human', 'not a bot', '\\boperator\\b', '\\brepresentative\\b',
  ].join('|'),
  'i'
);

// The model was told to end every handoff with one of these sentences. If it
// wrote the sentence but dropped the [ESCALAR] tag, treat it as escalated
// anyway — the customer has been promised a person, so the bot must go quiet.
const HANDOFF_PHRASE_RE = /(miembro del (staff|equipo)|alguien del (equipo|staff)|se pondr[aá] en contacto|te conectar[eé]|te contacta|someone from the team|will be in touch|get back to you|connect you with)/i;

// The tag, tolerant of the model's formatting drift: [ESCALAR], ESCALAR, (ESCALAR).
const ESCALATE_TAG_RE = /[\[\(]?\s*ESCALAR\s*[\]\)]?/gi;

// Threads whose first reply is waiting out FIRST_REPLY_DELAY_MS.
// waId -> { texts: [...everything they said while we waited], msgId }
const held = new Map();

// One customer's messages must never process concurrently. WhatsApp delivers
// several in a single webhook batch (a photo plus a PDF, say) and server.js
// fires them off in parallel — so without this both read "not escalated"
// before either writes it, and the customer gets two identical replies.
// Each waId gets a promise chain; jobs queue behind the previous one.
const chains = new Map(); // waId -> tail promise

function serialize(waId, job) {
  const prev = chains.get(waId) || Promise.resolve();
  const run = prev.then(job, job); // run even if the previous job rejected
  const tail = run.catch(() => {});
  chains.set(waId, tail);
  // Drop the entry once this is the last job, so the map cannot grow forever.
  tail.then(() => { if (chains.get(waId) === tail) chains.delete(waId); });
  return run;
}

export function handleInboundMessage(msg, contact) {
  return serialize(msg.from, () => processInbound(msg, contact));
}

async function processInbound(msg, contact) {
  const from = msg.from;

  // Blocked: no reply, no model call, no escalation. The thread is left alone
  // entirely so staff can still see and answer it from the WhatsApp app.
  if (isBlocked(from)) {
    console.log(`[handler] ${from} is blocked — ignoring`);
    return;
  }

  if (alreadyHandled(msg.id)) return;

  // A human is handling this thread — stay quiet, but only for the escalation
  // window. Once it lapses the bot picks the conversation back up by itself,
  // instead of the thread staying muted until the 24h TTL.
  const { escalated, escalatedAt } = await getEscalation(from);
  let resumed = false;
  if (escalated) {
    const mutedFor = Date.now() - escalatedAt;
    if (mutedFor < ESCALATION_WINDOW_MS) return;
    await setEscalated(from, false);
    resumed = true;
    console.log(`[handler] escalation window lapsed for ${from} after ${Math.round(mutedFor / 1000)}s — bot resuming`);
  }

  // Classify the message. 'media' = anything that is not text (goes to a
  // person), 'handoff' = the customer asked for a person, 'text' = a question
  // the bot may answer.
  const userText = msg.type === 'text' ? msg.text.body : null;
  const kind = userText === null ? 'media'
    : HUMAN_REQUEST_RE.test(userText) ? 'handoff'
    : 'text';
  if (kind === 'handoff') console.log(`[handler] ${from} asked for a human`);

  // First contact on a quiet thread — EVERY kind of reply waits out
  // FIRST_REPLY_DELAY_MS so a human can take the conversation first. Ongoing
  // conversations (any stored turn in the last 24h) are answered immediately.
  //
  // `resumed` counts as first contact too: a human owned this thread until the
  // escalation window lapsed, so give staff the same head start before the bot
  // speaks on it again. getHistory still runs either way, so an expired thread
  // is evicted on schedule.
  const history = await getHistory(from);
  if (FIRST_REPLY_DELAY_MS > 0 && (history.length === 0 || resumed)) {
    hold(from, kind, userText, msg.id);
    return;
  }

  await respond(from, kind, userText === null ? [] : [userText], msg.id);
}

// media > handoff > text: a held batch takes the "strongest" kind it has seen,
// so a photo followed by a question still goes to a person.
const KIND_RANK = { text: 0, handoff: 1, media: 2 };

function hold(from, kind, userText, msgId) {
  const waiting = held.get(from);
  if (waiting) {
    // Folded into the pending reply.
    if (userText !== null) waiting.texts.push(userText);
    if (KIND_RANK[kind] > KIND_RANK[waiting.kind]) waiting.kind = kind;
    return;
  }

  held.set(from, { kind, texts: userText === null ? [] : [userText], msgId });
  console.log(`[handler] holding first reply (${kind}) to ${from} for ${FIRST_REPLY_DELAY_MS}ms`);
  setTimeout(() => {
    serialize(from, () => deliverHeld(from))
      .catch(err => console.error('[handler] held reply failed', from, err));
  }, FIRST_REPLY_DELAY_MS);
}

// Fires once the hold lapses. Staff answering in the meantime cancels the bot
// entirely — the thread is theirs and the bot never speaks on it.
async function deliverHeld(from) {
  const job = held.get(from);
  held.delete(from);
  if (!job) return;

  const { escalated } = await getEscalation(from);
  if (escalated) {
    console.log(`[handler] staff answered ${from} during the hold — bot staying silent`);
    return;
  }
  await respond(from, job.kind, job.texts, job.msgId);
}

const MEDIA_REPLY = 'Gracias por tu mensaje. Con gusto un miembro del equipo lo revisa y te responde en un momentito.';

// Shared by the immediate and held paths.
async function respond(from, kind, texts, msgId) {
  if (kind === 'media') {
    await sendText(from, MEDIA_REPLY);
    await setEscalated(from, true);
    console.log(`[handler] non-text message from ${from} — handed to staff, muted for ${ESCALATION_WINDOW_MS}ms`);
    return;
  }
  await generateAndSend(from, texts.join('\n'), msgId, { handoff: kind === 'handoff' });
}

// Appended to the system prompt when the customer explicitly asked for a person:
// the model only phrases the handoff (in the customer's language); it does not
// decide whether to hand off.
const HANDOFF_INSTRUCTION = `

## Instrucción para ESTE mensaje
El cliente pidió hablar con una persona. NO respondas su duda ni hagas preguntas. Responde ÚNICAMENTE con una frase cálida y terminal avisando que en seguida un miembro del staff se pondrá en contacto (en el idioma del cliente), y termina con la etiqueta [ESCALAR].`;

async function generateAndSend(from, userText, msgId, { handoff = false } = {}) {
  try {
    await sendTyping(msgId).catch(() => {});
    const history = await getHistory(from);
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: `${SYSTEM_PROMPT}\n\n## Fecha y hora\n${currentDateTimeMx()}${handoff ? HANDOFF_INSTRUCTION : ''}`,
      messages: [...history, { role: 'user', content: userText }],
    });

    let reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    // Escalate when: the customer asked for a person, the model tagged the
    // reply, or the model promised a person without tagging. Any of the three
    // means the bot must not answer the customer's next message.
    const escalate = handoff || ESCALATE_TAG_RE.test(reply) || HANDOFF_PHRASE_RE.test(reply);
    ESCALATE_TAG_RE.lastIndex = 0; // global regex: reset after .test()
    reply = reply.replace(ESCALATE_TAG_RE, '').trim() || FALLBACK;

    // Staff may have answered while the model was thinking. Their message
    // stands; the bot's reply is dropped rather than talking over them.
    const { escalated } = await getEscalation(from);
    if (escalated && !escalate) {
      console.log(`[handler] staff replied to ${from} while generating — dropping bot reply`);
      return;
    }

    await sendText(from, reply);
    await appendTurn(from, userText, reply);
    if (escalate) {
      await setEscalated(from, true);
      console.log(`[handler] escalated ${from} (${handoff ? 'customer asked for a human' : 'bot could not answer'}) — muted for ${ESCALATION_WINDOW_MS}ms`);
    }
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
