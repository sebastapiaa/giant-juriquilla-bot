# Giant Juriquilla WhatsApp Bot

FAQ bot on the shop's existing WhatsApp number (coexistence via Dualhook).
Staff keep answering from the WhatsApp Business app; the bot handles FAQs and
goes quiet the moment a human replies.

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
