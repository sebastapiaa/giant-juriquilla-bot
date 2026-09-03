# Giant Juriquilla WhatsApp Bot

FAQ bot on the shop's existing WhatsApp number (coexistence via Dualhook).
Staff keep answering from the WhatsApp Business app; the bot handles FAQs and
goes quiet the moment a human replies.

## When the bot stays quiet
The bot mutes a thread for `ESCALATION_WINDOW_MS` (default 1h, clock restarts on
every staff message) whenever any of these happen:
- **Staff replied** — a message sent from the shop's own number, either as a
  coexistence echo or as a plain message whose sender is `BUSINESS_WA_NUMBER`.
  The bot's own API sends are recognised and do not count.
- **Customer asked for a person** — matched deterministically in `handler.js`
  (`HUMAN_REQUEST_RE`), so it never depends on the model noticing.
- **Bot could not answer** — the model tags its reply `[ESCALAR]`, or writes a
  handoff sentence ("un miembro del staff se pondrá en contacto…") without the tag.
If staff answer while the bot is still generating, the bot's reply is dropped.

## Response timing
Every reply — FAQ answer, photo/audio handoff, or "talk to a person" handoff —
waits `REPLY_DELAY_MS` (default 5 min) before the bot sends it, on first contact
and on ongoing conversations alike. Messages the customer sends during the wait
are folded into one reply. If staff answer during the wait, the bot says nothing.
Set `REPLY_DELAY_MS=0` in Railway to make replies instant. (The old name
`FIRST_REPLY_DELAY_MS` is still honoured if `REPLY_DELAY_MS` is not set.)

## Edit this
- `src/knowledge.js` — the system prompt + FAQ. THE file you change. Fill every TODO.

## Run locally
    npm install
    cp .env.example .env    # fill in at least ANTHROPIC_API_KEY + META_VERIFY_TOKEN
    npm run dev
    # health check: http://localhost:3000/health

## Deploy (Railway)
1. Push this repo to GitHub.
2. New Railway service → point at the repo.
3. Add a VOLUME mounted at /data.
4. Set env vars from .env.example.
5. Railway gives a public URL → your webhook is <url>/webhook
6. In Dualhook, set webhook URL = <url>/webhook and verify token = META_VERIFY_TOKEN.

## Files
- src/server.js    webhook receive + verify + route
- src/handler.js   Claude call, dedup, escalation, staff-echo handoff
- src/whatsapp.js  send messages back
- src/store.js     conversation memory on the /data volume
- src/knowledge.js system prompt + FAQ  ← edit this
