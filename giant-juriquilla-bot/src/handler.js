import Anthropic from '@anthropic-ai/sdk';
import { sendText, sendTyping, wasSentByBot, wasRecentlySentBody } from './whatsapp.js';
import { getHistory, appendTurn, getEscalation, setEscalated } from './store.js';
import { SYSTEM_PROMPT } from './knowledge.js';

// The SDK retries 429 / 5xx / connection errors by itself; three attempts
// instead of the default two covers short API hiccups without a long wait.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const TZ = process.env.TIMEZONE || 'America/Mexico_City';

// How long a thread stays muted after a human takes over. Set small (e.g.
// 120000) in Railway to test the resume. A non-numeric or negative value falls
// back to the default rather than muting forever / never.
const DEFAULT_ESCALATION_WINDOW_MS = 3_600_000; // 1h
const rawWindow = Number(process.env.ESCALATION_WINDOW_MS);
const ESCALATION_WINDOW_MS =
  Number.isFinite(rawWindow) && rawWindow >= 0 ? rawWindow : DEFAULT_ESCALATION_WINDOW_MS;

// Hold EVERY bot reply this long so staff can take the conversation first —
// if a human answers during the wait, the bot never speaks. Anything the
// customer sends meanwhile is folded into the single reply. Applies to first
// contact and ongoing conversations alike. Set 0 to answer immediately.
// FIRST_REPLY_DELAY_MS is the old name and still works.
const rawDelay = Number(process.env.REPLY_DELAY_MS ?? process.env.FIRST_REPLY_DELAY_MS);
const REPLY_DELAY_MS =
  Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 300_000; // 5 min

// Outside shop hours nobody is going to answer first, so the hold is skipped
// and the bot replies at once. The window is [start, end) in TZ hours, and it
// may wrap midnight: the default 20 → 10 means 8pm until 10am. Set both to the
// same value to disable the window (hold always applies).
const parseHour = (raw, fallback) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
};
const INSTANT_REPLY_START_HOUR = parseHour(process.env.INSTANT_REPLY_START_HOUR, 20);
const INSTANT_REPLY_END_HOUR = parseHour(process.env.INSTANT_REPLY_END_HOUR, 10);

console.log(`[handler] escalation window: ${ESCALATION_WINDOW_MS}ms, reply delay: ${REPLY_DELAY_MS}ms, instant replies ${INSTANT_REPLY_START_HOUR}:00–${INSTANT_REPLY_END_HOUR}:00 ${TZ}`);

// Pure check, so the wrap-around logic can be reasoned about on its own.
export function isInstantHour(hour, start = INSTANT_REPLY_START_HOUR, end = INSTANT_REPLY_END_HOUR) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// Current hour (0–23) in the shop's timezone. hourCycle h23 avoids the "24"
// that hour12:false can produce at midnight.
function currentHourMx() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  return Number(parts.find(p => p.type === 'hour')?.value);
}

// Numbers the bot never answers.
//
// Matching ignores the country code entirely: both Mexico and the US/Canada use
// 10-digit national numbers, so comparing the LAST 10 DIGITS blocks the same
// person whichever prefix WhatsApp delivers — +52, +521 (the Mexican mobile 1),
// +1, or none at all. Punctuation and spaces are stripped first.
//
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
    '55 4337 0809',
    '442 353 0492',
    '442 365 5645',
    '442 378 7614',
    '442 385 8531',
    '477 699 0168',
    '55 1801 9281',
    '55 2206 2955',
    '54 9 3515 19-3923',
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

// What the customer sees when the bot cannot produce an answer (model error,
// empty reply). It never mentions a technical problem: the customer gets the
// same warm handoff as any other escalation, and staff pick the thread up.
const FALLBACK = 'Gracias por tu mensaje 🙂 En un momento un miembro del staff se pondrá en contacto contigo.';

// Sent when the customer explicitly asks for a person. Fixed text, no model
// call: a handoff must never depend on the API being up.
const HANDOFF_REPLY_ES = 'Con gusto 🙂 En seguida un miembro del staff se pondrá en contacto contigo.';
const HANDOFF_REPLY_EN = 'Of course 🙂 Someone from the team will be in touch shortly.';

// The customer explicitly asked for a person. Detected here, deterministically,
// so the handoff never depends on the model noticing. Over-matching is the safe
// failure (a human answers), so the list leans broad. Add phrases freely.
const HUMAN_REQUEST_ES = [
  'hablar con (alguien|una persona|un humano|un asesor|un agente|un vendedor|el staff|el equipo|un encargado|un humano)',
  'comunicar(me|se) con (alguien|una persona|un asesor|un humano|el staff|el equipo)',
  'quiero (una|a una) persona', 'persona real', 'un humano', 'ser humano',
  'no eres (una )?persona', 'no quiero (hablar con )?(un )?bot', 'atenci[oó]n humana', 'alguien del (equipo|staff|taller)',
  '\\b(asesor|agente|representante|encargado|gerente)\\b',
];
const HUMAN_REQUEST_EN = [
  'talk (to|with) (someone|a person|a human|a real person|an agent|staff|the team)',
  'speak (to|with) (someone|a person|a human|a real person|an agent|staff|the team)',
  'real person', 'human being', 'a human', 'not a bot', '\\boperator\\b', '\\brepresentative\\b',
];
const HUMAN_REQUEST_RE = new RegExp([...HUMAN_REQUEST_ES, ...HUMAN_REQUEST_EN].join('|'), 'i');
// Only the English phrases. Decides which handoff sentence to send; Spanish
// is the default when nothing English matched.
const HUMAN_REQUEST_EN_RE = new RegExp(HUMAN_REQUEST_EN.join('|'), 'i');

// The model was told to end every handoff with one of these sentences. If it
// wrote the sentence but dropped the [ESCALAR] tag, treat it as escalated
// anyway — the customer has been promised a person, so the bot must go quiet.
const HANDOFF_PHRASE_RE = /(miembro del (staff|equipo)|alguien del (equipo|staff)|se pondr[aá] en contacto|te conectar[eé]|te contacta|someone from the team|will be in touch|get back to you|connect you with)/i;

// The tag, tolerant of the model's formatting drift: [ESCALAR], ESCALAR, (ESCALAR).
const ESCALATE_TAG_RE = /[\[\(]?\s*ESCALAR\s*[\]\)]?/gi;

// Threads whose reply is waiting out REPLY_DELAY_MS.
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

  // A reaction is an emoji stuck on an earlier message, not a question. Ignore
  // it completely — no reply, no escalation, no thread state touched. Without
  // this it fell through to the non-text branch below and both answered the
  // customer and muted the bot.
  if (msg.type === 'reaction') {
    console.log(`[handler] reaction from ${from} — ignoring`);
    return;
  }

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

  // Classify the message. 'media' = anything that is not text (goes to a
  // person), 'handoff' = the customer asked for a person, 'text' = a question
  // the bot may answer.
  const userText = msg.type === 'text' ? msg.text.body : null;
  const kind = userText === null ? 'media'
    : HUMAN_REQUEST_RE.test(userText) ? 'handoff'
    : 'text';
  if (kind === 'handoff') console.log(`[handler] ${from} asked for a human`);

  // EVERY kind of reply, on every message, waits out REPLY_DELAY_MS so a
  // human can take the conversation first — except outside shop hours, when
  // no human is coming and the customer gets the answer at once.
  if (REPLY_DELAY_MS > 0) {
    const hour = currentHourMx();
    if (isInstantHour(hour)) {
      console.log(`[handler] ${hour}:xx ${TZ} is outside shop hours — replying to ${from} immediately`);
    } else {
      hold(from, kind, userText, msg.id);
      return;
    }
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
  console.log(`[handler] holding reply (${kind}) to ${from} for ${REPLY_DELAY_MS}ms`);
  setTimeout(() => {
    serialize(from, () => deliverHeld(from))
      .catch(err => console.error('[handler] held reply failed', from, err));
  }, REPLY_DELAY_MS);
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

// Sin diminutivos: era "en un momentito".
const MEDIA_REPLY = 'Gracias por tu mensaje. Con gusto un miembro del equipo lo revisa y te responde en un momento.';

// Shared by the immediate and held paths.
async function respond(from, kind, texts, msgId) {
  if (kind === 'media') {
    await sendText(from, MEDIA_REPLY);
    await setEscalated(from, true);
    console.log(`[handler] non-text message from ${from} — handed to staff, muted for ${ESCALATION_WINDOW_MS}ms`);
    return;
  }
  const userText = texts.join('\n');
  if (kind === 'handoff') {
    // Deterministic: the customer asked for a person, so promise one and go
    // quiet. No model call, so an API outage cannot turn this into an apology.
    const reply = HUMAN_REQUEST_EN_RE.test(userText) ? HANDOFF_REPLY_EN : HANDOFF_REPLY_ES;
    await sendTyping(msgId).catch(() => {});
    await sendText(from, reply);
    await appendTurn(from, userText, reply);
    await setEscalated(from, true);
    console.log(`[handler] escalated ${from} (customer asked for a human) — muted for ${ESCALATION_WINDOW_MS}ms`);
    return;
  }
  await generateAndSend(from, userText, msgId);
}

async function generateAndSend(from, userText, msgId) {
  try {
    await sendTyping(msgId).catch(() => {});
    const history = await getHistory(from);
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: `${SYSTEM_PROMPT}\n\n## Fecha y hora\n${currentDateTimeMx()}`,
      messages: [...history, { role: 'user', content: userText }],
    });

    let reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    // Escalate when the model tagged the reply, promised a person without
    // tagging, or produced nothing usable (the customer then gets the handoff
    // text, so the bot must go quiet either way).
    const tagged = ESCALATE_TAG_RE.test(reply);
    ESCALATE_TAG_RE.lastIndex = 0; // global regex: reset after .test()
    reply = reply.replace(ESCALATE_TAG_RE, '').trim();
    const escalate = tagged || !reply || HANDOFF_PHRASE_RE.test(reply);
    if (!reply) reply = FALLBACK;

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
      console.log(`[handler] escalated ${from} (bot could not answer) — muted for ${ESCALATION_WINDOW_MS}ms`);
    }
  } catch (err) {
    logModelError(from, err);
    // The customer never learns there was an error: they get the standard
    // warm handoff and staff take the thread. If staff already answered while
    // we were failing, say nothing at all.
    const { escalated } = await getEscalation(from).catch(() => ({ escalated: false }));
    if (!escalated) await sendText(from, FALLBACK).catch(e => console.error('[handler] fallback send failed', from, e.message));
    await setEscalated(from, true).catch(() => {});
  }
}

// One line per failure, naming the cause, instead of the SDK's full error
// object with every response header. Most specific class first.
function logModelError(from, err) {
  let cause = 'unknown';
  if (err instanceof Anthropic.AuthenticationError) cause = 'auth: ANTHROPIC_API_KEY is invalid or revoked';
  else if (err instanceof Anthropic.NotFoundError) cause = `not found: CLAUDE_MODEL "${MODEL}" may be wrong or retired`;
  else if (err instanceof Anthropic.RateLimitError) cause = 'rate limited (429) after retries';
  else if (err instanceof Anthropic.APIConnectionError) cause = 'network: could not reach the API after retries';
  else if (err instanceof Anthropic.APIError) cause = `API ${err.status}`;
  console.error(`[handler] model call failed for ${from} — ${cause} — ${err?.constructor?.name}: ${err?.message}`);
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
