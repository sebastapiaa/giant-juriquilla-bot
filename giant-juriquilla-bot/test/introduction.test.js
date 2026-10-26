import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const testDir = await mkdtemp(path.join(tmpdir(), 'gilimo-introduction-'));
const storePath = path.join(testDir, 'conversations.json');
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'test-key',
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  WA_API_HOST: 'https://whatsapp.test',
  WHATSAPP_PHONE_NUMBER_ID: 'test-phone',
  WHATSAPP_TOKEN: 'test-token',
  CONVO_STORE_PATH: storePath,
  REPLY_DELAY_MS: '0',
  ESCALATION_WINDOW_MS: '3600000',
  INSTANT_REPLY_START_HOUR: '0',
  INSTANT_REPLY_END_HOUR: '0',
  BLOCKED_NUMBERS: '15550000009',
});

const INTRODUCTION = 'Hola soy GiLiMo 👋🏼, tu asistente virtual de WhatsApp 🤖.';
const ANSWER = 'El Servicio Básico cuesta $400 MXN.';
const sentMessages = [];
const modelRequests = [];
let modelReply = ANSWER;
let modelFailure = false;
let failNextTextSend = false;
let onModelRequest;
let onTextSend;
let messageId = 0;
let sendId = 0;
const originalFetch = globalThis.fetch;

// Exercise the real handler, SDK, store and outbound code without network calls.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body = JSON.parse(init?.body ?? await input.clone().text());
  if (url.hostname === 'api.anthropic.com') {
    modelRequests.push(body);
    if (onModelRequest) await onModelRequest();
    if (modelFailure) {
      return Response.json({ error: { type: 'invalid_request_error', message: 'Mock model failure' } }, { status: 400 });
    }
    return Response.json({
      id: 'test-response', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: modelReply }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  if (url.hostname === 'whatsapp.test') {
    if (body.type === 'text') {
      if (failNextTextSend) {
        failNextTextSend = false;
        return Response.json({ error: 'Mock send failure' }, { status: 500 });
      }
      sentMessages.push(body);
      if (onTextSend) onTextSend(body);
      return Response.json({ messages: [{ id: `bot-${++sendId}` }] });
    }
    return Response.json({ success: true });
  }
  throw new Error(`Unexpected network request: ${url.origin}`);
};

// This SDK version defaults to node-fetch. Select its supported web shim so
// both the SDK and WhatsApp sends use the offline fetch stub above.
await import('@anthropic-ai/sdk/shims/web');

const storeUrl = new URL('../src/store.js', import.meta.url);
const store = await import(storeUrl);
const handler = await import('../src/handler.js');
process.env.REPLY_DELAY_MS = '30';
const heldHandler = await import('../src/handler.js?held-test');
process.env.REPLY_DELAY_MS = '0';

function message(from, text, type = 'text') {
  return { from, id: `customer-${++messageId}`, type, ...(type === 'text' ? { text: { body: text } } : {}) };
}

beforeEach(() => {
  sentMessages.length = 0;
  modelRequests.length = 0;
  modelReply = ANSWER;
  modelFailure = false;
  failNextTextSend = false;
  onModelRequest = undefined;
  onTextSend = undefined;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(storePath, { force: true });
  await rmdir(testDir);
});

test('a direct question gets the exact introduction, a blank line and the answer only once per number', async () => {
  const from = '15550000001';
  await handler.handleInboundMessage(message(from, '¿Cuánto cuesta el servicio básico?'));
  assert.equal(sentMessages[0].text.body, `${INTRODUCTION}\n\n${ANSWER}`);
  assert.equal((await store.getHistory(from))[1].content, sentMessages[0].text.body);

  await handler.handleInboundMessage(message(from, '¿Y qué incluye?'));
  assert.equal(sentMessages[1].text.body, ANSWER);

  await handler.handleInboundMessage(message('15550000002', '¿A qué hora abren?'));
  assert.equal(sentMessages[2].text.body, `${INTRODUCTION}\n\n${ANSWER}`);
});

test('simultaneous messages on one thread introduce the bot once', async () => {
  const from = '15550000003';
  await Promise.all([
    handler.handleInboundMessage(message(from, '¿Cuánto cuesta el básico?')),
    handler.handleInboundMessage(message(from, '¿Y el general?')),
  ]);
  assert.deepEqual(sentMessages.map(m => m.text.body), [`${INTRODUCTION}\n\n${ANSWER}`, ANSWER]);
});

test('attachment handoffs introduce the bot and later replies skip the introduction', async () => {
  const from = '15550000004';
  await handler.handleInboundMessage(message(from, null, 'image'));
  assert.equal(sentMessages[0].text.body, `${INTRODUCTION}\n\nGracias por tu mensaje. Con gusto un miembro del equipo lo revisa y te responde en un momento.`);
  assert.equal(modelRequests.length, 0);
  assert.equal((await store.getEscalation(from)).escalated, true);

  await store.setEscalated(from, false);
  await handler.handleInboundMessage(message(from, '¿Cuánto cuesta el básico?'));
  assert.equal(sentMessages[1].text.body, ANSWER);
});

test('a request for a person gets the fixed introduction and handoff without a model call', async () => {
  const from = '15550000005';
  await handler.handleInboundMessage(message(from, 'I want to talk to a person'));
  assert.equal(sentMessages[0].text.body, `${INTRODUCTION}\n\nOf course 🙂 Someone from the team will be in touch shortly.`);
  assert.equal(modelRequests.length, 0);
  assert.equal((await store.getEscalation(from)).escalated, true);
});

test('model failures and empty answers include the introduction with the fallback', async () => {
  for (const [from, fail] of [['15550000006', true], ['15550000007', false]]) {
    modelFailure = fail;
    modelReply = '';
    await handler.handleInboundMessage(message(from, '¿Cuánto cuesta el básico?'));
    assert.equal(sentMessages.at(-1).text.body, `${INTRODUCTION}\n\nGracias por tu mensaje 🙂 En un momento un miembro del staff se pondrá en contacto contigo.`);
    assert.equal(await store.hasIntroduced(from), true);
    assert.equal((await store.getEscalation(from)).escalated, true);
  }
});

test('model escalations keep the introduction and hide the escalation tag', async () => {
  const from = '15550000008';
  modelReply = 'Un miembro del staff confirmará la disponibilidad. [ESCALAR]';
  await handler.handleInboundMessage(message(from, '¿Tienen esta bicicleta?'));
  assert.equal(sentMessages[0].text.body, `${INTRODUCTION}\n\nUn miembro del staff confirmará la disponibilidad.`);
  assert.equal((await store.getEscalation(from)).escalated, true);
});

test('blocked numbers, reactions and muted threads do not send or consume an introduction', async () => {
  await handler.handleInboundMessage(message('15550000009', 'Hola'));
  await handler.handleInboundMessage(message('15550000010', null, 'reaction'));
  await store.setEscalated('15550000011', true);
  await handler.handleInboundMessage(message('15550000011', 'Hola'));
  assert.equal(sentMessages.length, 0);
  assert.equal(modelRequests.length, 0);
  for (const from of ['15550000009', '15550000010', '15550000011']) {
    assert.equal(await store.hasIntroduced(from), false);
  }
});

test('a failed WhatsApp send leaves the introduction available for the next successful reply', async () => {
  const from = '15550000012';
  failNextTextSend = true;
  await assert.rejects(handler.handleInboundMessage(message(from, null, 'image')), /WhatsApp API 500/);
  assert.equal(await store.hasIntroduced(from), false);
  assert.equal(sentMessages.length, 0);

  await handler.handleInboundMessage(message(from, null, 'image'));
  assert.ok(sentMessages[0].text.body.startsWith(`${INTRODUCTION}\n\n`));
  assert.equal(await store.hasIntroduced(from), true);
});

test('the introduction survives history expiry, history resets and a fresh store load', async t => {
  const from = '15550000013';
  await handler.handleInboundMessage(message(from, '¿Cuánto cuesta el básico?'));
  const future = Date.now() + 25 * 60 * 60 * 1000;
  t.mock.method(Date, 'now', () => future);

  assert.deepEqual(await store.getHistory(from), []);
  assert.equal(await store.hasIntroduced(from), true);
  await handler.handleInboundMessage(message(from, '¿Y el general?'));
  assert.equal(sentMessages[1].text.body, ANSWER);

  await store.clearHistory(from);
  const restartedStore = await import(`${storeUrl.href}?restart-test`);
  assert.equal(await restartedStore.hasIntroduced(from), true);
  assert.deepEqual(await restartedStore.getHistory(from), []);
  const saved = JSON.parse(await readFile(storePath, 'utf8'));
  assert.ok(saved[from].introducedAt);
});

test('a held batch gets one introduction and answers all questions together', { timeout: 5000 }, async () => {
  const from = '15550000014';
  const sent = new Promise(resolve => { onTextSend = resolve; });
  await Promise.all([
    heldHandler.handleInboundMessage(message(from, '¿Cuánto cuesta el básico?')),
    heldHandler.handleInboundMessage(message(from, '¿Y qué incluye?')),
  ]);
  assert.equal(sentMessages.length, 0);
  await sent;
  // Queue behind the held reply so its history and introduction writes finish.
  await heldHandler.handleInboundMessage(message(from, null, 'reaction'));
  assert.deepEqual(sentMessages.map(m => m.text.body), [`${INTRODUCTION}\n\n${ANSWER}`]);
  assert.equal(modelRequests[0].messages.at(-1).content, '¿Cuánto cuesta el básico?\n¿Y qué incluye?');
  assert.equal(await store.hasIntroduced(from), true);
});

test('staff taking over during the hold cancels the introduction along with the reply', async () => {
  const from = '15550000015';
  await heldHandler.handleInboundMessage(message(from, '¿Cuánto cuesta el básico?'));
  await heldHandler.handleStaffEcho({ id: 'staff-held', to: from, text: { body: 'Con gusto te ayudo.' } });
  await delay(60);
  assert.equal(sentMessages.length, 0);
  assert.equal(await store.hasIntroduced(from), false);

  await store.setEscalated(from, false);
  await handler.handleInboundMessage(message(from, '¿Cuánto cuesta el básico?'));
  assert.equal(sentMessages[0].text.body, `${INTRODUCTION}\n\n${ANSWER}`);
});

test('staff taking over during generation leaves the introduction available', async () => {
  const from = '15550000016';
  onModelRequest = () => handler.handleStaffEcho({ id: 'staff-generating', to: from, text: { body: 'Con gusto te ayudo.' } });
  await handler.handleInboundMessage(message(from, '¿Cuánto cuesta el básico?'));
  assert.equal(sentMessages.length, 0);
  assert.equal(await store.hasIntroduced(from), false);
});

test('duplicate webhooks do not send the first reply twice', async () => {
  const inbound = message('15550000017', '¿Cuánto cuesta el básico?');
  await handler.handleInboundMessage(inbound);
  await handler.handleInboundMessage(inbound);
  assert.deepEqual(sentMessages.map(m => m.text.body), [`${INTRODUCTION}\n\n${ANSWER}`]);
});
