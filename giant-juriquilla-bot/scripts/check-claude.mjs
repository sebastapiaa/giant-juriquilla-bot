// Verifies the Claude credentials and model the bot will use, and says in one
// line why a call would fail. Run it with the same env vars as the bot:
//   node scripts/check-claude.mjs             (locally, with .env values exported)
//   railway run node scripts/check-claude.mjs (against the Railway service's vars)
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const key = process.env.ANTHROPIC_API_KEY;

if (!key) {
  console.error('FAIL — ANTHROPIC_API_KEY is not set. In Railway: service → Variables.');
  process.exit(1);
}
console.log(`key: ${key.slice(0, 10)}…${key.slice(-4)} (${key.length} chars)`);
console.log(`model: ${MODEL}`);

const client = new Anthropic({ apiKey: key, maxRetries: 0 });
try {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 20,
    messages: [{ role: 'user', content: 'Responde solo: ok' }],
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  console.log(`OK — model answered "${text}" (${res.usage.input_tokens} in / ${res.usage.output_tokens} out)`);
} catch (err) {
  let cause;
  if (err instanceof Anthropic.AuthenticationError) cause = 'the API key is invalid or revoked. Create a new one at console.anthropic.com and update ANTHROPIC_API_KEY in Railway.';
  else if (err instanceof Anthropic.NotFoundError) cause = `the model "${MODEL}" does not exist for this key. Fix CLAUDE_MODEL in Railway.`;
  else if (err instanceof Anthropic.PermissionDeniedError) cause = 'the key is not allowed to use this model or endpoint (workspace or key permissions).';
  else if (err instanceof Anthropic.BadRequestError) cause = /credit|billing/i.test(err.message)
    ? 'the Anthropic account has no credit. Add funds at console.anthropic.com → Billing.'
    : `the request was rejected: ${err.message}`;
  else if (err instanceof Anthropic.RateLimitError) cause = 'rate limited (429). Check usage limits at console.anthropic.com.';
  else if (err instanceof Anthropic.APIConnectionError) cause = 'could not reach api.anthropic.com (network / DNS from this machine).';
  else if (err instanceof Anthropic.APIError) cause = `API error ${err.status}: ${err.message}`;
  else cause = err?.message || String(err);
  console.error(`FAIL — ${cause}`);
  process.exit(1);
}
