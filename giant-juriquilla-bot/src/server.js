import express from 'express';
import crypto from 'crypto';
import { handleInboundMessage, handleStaffEcho } from './handler.js';
import { setEscalated, clearHistory } from './store.js';

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const { PORT = 3000, META_VERIFY_TOKEN, META_APP_SECRET, ADMIN_KEY, BUSINESS_WA_NUMBER } = process.env;

if (!ADMIN_KEY) console.warn('[admin] ADMIN_KEY unset — /admin/reset is disabled (404s)');
if (!BUSINESS_WA_NUMBER) console.warn('[webhook] BUSINESS_WA_NUMBER unset — staff replies are only recognised via echoes or webhook metadata');

const last10 = n => String(n ?? '').replace(/\D/g, '').slice(-10);

// A message whose SENDER is the business number itself is a staff member
// writing from the WhatsApp Business app — the same party as the bot — not a
// customer. Some relays deliver those inside `messages` rather than as echoes,
// and without this check the bot would treat the shop as a customer and reply
// to its own number. The business number comes from the webhook metadata when
// present, or BUSINESS_WA_NUMBER as a fallback.
function isFromBusiness(msg, value) {
  if (msg.from_me === true) return true;
  const sender = last10(msg.from);
  if (sender.length !== 10) return false;
  const known = [value.metadata?.display_phone_number, BUSINESS_WA_NUMBER].map(last10).filter(n => n.length === 10);
  return known.includes(sender);
}

// 1. Webhook verification — Meta/Dualhook calls this once when you save the URL
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('[webhook] verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. Verify the payload is really from Meta (skip if no app secret set yet)
function verifySignature(req) {
  if (!META_APP_SECRET) return true; // allow during early testing; set it for prod
  const sig = req.get('X-Hub-Signature-256');
  if (!sig) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
}

// 3. Inbound messages
app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);

  // ACK IMMEDIATELY — Meta retries anything slow, and a retry = duplicate reply.
  res.sendStatus(200);

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    // Staff replied from their phone (coexistence echo) → bot goes quiet.
    if (value.message_echoes || value.messages_echoes || value.smb_message_echoes) {
      const echoes = value.message_echoes || value.messages_echoes || value.smb_message_echoes;
      for (const e of echoes) handleStaffEcho(e).catch(err => console.error('[echo]', err));
      return;
    }

    // Normal customer message
    if (!value.messages) return; // status callbacks (delivered/read) land here too
    for (const msg of value.messages) {
      if (isFromBusiness(msg, value)) {
        // Staff reply delivered as a plain message. Route it through the echo
        // handler so the thread is muted (unless it was the bot's own send).
        const customer = msg.to || msg.recipient_id || msg.recipient?.wa_id
          || value.contacts?.find(c => last10(c.wa_id) !== last10(msg.from))?.wa_id;
        handleStaffEcho({ ...msg, to: customer }).catch(err => console.error('[echo]', msg.id, err));
        continue;
      }
      const contact = value.contacts?.find(c => c.wa_id === msg.from);
      handleInboundMessage(msg, contact).catch(err => console.error('[handler]', msg.id, err));
    }
  } catch (err) {
    console.error('[webhook] parse error', err);
  }
});

// ---- TEMPORARY TEST ENDPOINT — DELETE BEFORE LEAVING THIS RUNNING ----------
// Un-mutes the bot on a thread and wipes that number's stored turns.
// SET ADMIN_KEY IN RAILWAY. Without it this is fully open, and because it is a
// GET anything that merely *follows a link* can fire it — crawler, browser
// prefetch, link unfurl, CSRF from any page — on guessable wa_ids.
// Remove it (and clearHistory in store.js, if unused) once testing is done.
app.get('/admin/reset/:waid', async (req, res) => {
  // 404 rather than 401: an unauthenticated caller learns nothing about whether
  // this route exists.
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(404);

  const waid = String(req.params.waid).replace(/^\+/, '');
  // Keeps a stray URL from writing junk keys into the store — setEscalated
  // creates a record for whatever string it is handed.
  if (!/^\d{6,20}$/.test(waid)) {
    return res.status(400).json({ ok: false, error: 'waid must be 6-20 digits' });
  }
  try {
    await setEscalated(waid, false);
    const historyCleared = await clearHistory(waid);
    console.log(`[admin] reset ${waid} — unmuted, history ${historyCleared ? 'cleared' : 'already empty'}`);
    res.json({ ok: true, waid, escalated: false, historyCleared });
  } catch (err) {
    console.error('[admin] reset failed', waid, err);
    res.status(500).json({ ok: false, waid, error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
