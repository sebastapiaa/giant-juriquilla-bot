import express from 'express';
import crypto from 'crypto';
import { handleInboundMessage, handleStaffEcho } from './handler.js';

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const { PORT = 3000, META_VERIFY_TOKEN, META_APP_SECRET } = process.env;

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
      const contact = value.contacts?.find(c => c.wa_id === msg.from);
      handleInboundMessage(msg, contact).catch(err => console.error('[handler]', msg.id, err));
    }
  } catch (err) {
    console.error('[webhook] parse error', err);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`[server] listening on ${PORT}`));
