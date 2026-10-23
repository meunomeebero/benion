import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CatalogStore, AssistantConfigStore, SalesAssistant, SalesModelAdapter, createSalesModelFromEnv } from '../sales.mjs';

const products = [
  { id: 'example-app', name: 'Example App', description: 'App de anúncios.', url: 'https://example.com/app', facts: ['Você pode acessar o app pelo site.'] },
  { id: 'example-credits', name: 'Example Credits', description: 'Link para resgatar créditos de teste.', url: 'https://example.com/credits', facts: [] },
];
const eligibility = { faq: { eligible: true, reason: '' }, sales: { eligible: true, reason: '' }, story: { eligible: true, reason: '' } };
const context = { verifiedRecipient: true, inboundId: 'm_one', text: 'como funciona Example App?', messages: [], kind: 'message' };
const selection = () => ({ action: 'answer', productId: 'example-app', factIndexes: [0], includeDescription: false, includePrice: false, includeUrl: false, question: null });
async function fixture({ modelAdapter = null, catalog = products } = {}) {
  const catalogStore = new CatalogStore({ initialProducts: catalog }); const configStore = new AssistantConfigStore({ eligibilityProvider: () => eligibility });
  await configStore.set({ enabled: true, faqEnabled: true, salesEnabled: true, storyEnabled: true });
  return { catalogStore, configStore, assistant: new SalesAssistant({ catalogStore, configStore, modelAdapter }) };
}

test('configuration starts disabled with follower eligibility hard false and provider keys never become public', async () => {
  const provider = new SalesModelAdapter({ provider: 'openrouter', model: 'provider/model', apiKey: 'private-key', fetchImpl: async () => { throw new Error('must not run'); } });
  const store = new AssistantConfigStore({ provider, eligibilityProvider: () => ({ ...eligibility, follower: { eligible: true, reason: 'wrong' }, accessToken: 'leak' }) });
  const config = await store.get(); assert.equal(config.enabled, false); assert.equal(config.followerEnabled, false); assert.equal(config.eligibility.follower.eligible, false);
  assert.deepEqual(config.provider, { configured: true, name: 'openrouter', model: 'provider/model' }); assert.doesNotMatch(JSON.stringify(config), /private-key|leak|accessToken/);
  await assert.rejects(store.set({ followerEnabled: true }), { code: 'FOLLOWER_TRIGGER_UNAVAILABLE' });
  assert.equal(createSalesModelFromEnv({ env: {} }), null);
});

test('catalog validates known facts/prices/HTTPS without arbitrary executable fields and persists privately', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'benion-sales-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new CatalogStore({ dataDir: dir }); await store.set({ products });
  const restart = new CatalogStore({ dataDir: dir }); assert.deepEqual((await restart.get()).products, products.map(product => ({ ...product, url: new URL(product.url).href })));
  assert.equal((await stat(path.join(dir, 'assistant', 'catalog.json'))).mode & 0o777, 0o600);
  for (const product of [{ ...products[0], url: 'javascript:alert(1)' }, { ...products[0], url: 'https://user:pass@example.com' }, { ...products[0], price: 10 }, { ...products[0], tool: 'payment' }]) await assert.rejects(store.set({ products: [product] }));
});

test('only the model interprets intent: grounded replies follow its plan and no model means human handoff', async () => {
  const none = await fixture();
  for (const text of ['Oi', 'quanto custa?', 'quero o link', 'falar com atendente']) assert.deepEqual(await none.assistant.makeDecision({ ...context, text }), { action: 'handoff', reason: 'MODEL_REQUIRED' }, text);
  let next; const f = await fixture({ modelAdapter: { selectPlan: async () => next } });
  next = { ...selection(), action: 'qualify', productId: null, factIndexes: [], question: 'product' };
  const hello = await f.assistant.makeDecision({ ...context, text: 'Oi' }); assert.equal(hello.action, 'reply'); assert.match(hello.text, /Example App ou Example Credits/);
  next = { ...selection(), action: 'checkout', factIndexes: [] };
  const link = await f.assistant.makeDecision({ ...context, text: 'quero o link' });
  assert.equal(link.action, 'reply'); assert.match(link.text, /https:\/\/example\.com\/app/); assert.equal(link.feature, 'sales'); assert.doesNotMatch(link.text, /credits/);
  next = { ...selection(), factIndexes: [], includePrice: true };
  assert.deepEqual(await f.assistant.makeDecision({ ...context, text: 'quanto custa?' }), { action: 'handoff', reason: 'CATALOG_REFERENCE_INVALID' });
  next = { ...selection(), action: 'handoff' };
  assert.equal((await f.assistant.makeDecision({ ...context, text: 'falar com atendente' })).action, 'handoff');
  const priced = await fixture({ catalog: [{ ...products[0], price: 'R$ 39 por mês' }, products[1]], modelAdapter: { selectPlan: async () => ({ ...selection(), factIndexes: [], includePrice: true }) } });
  const answer = await priced.assistant.makeDecision({ ...context, text: 'qual o preço?' });
  assert.equal(answer.action, 'reply'); assert.match(answer.text, /R\$ 39 por mês/); assert.equal(answer.feature, 'sales');
});

test('exact optout commands, human takeover and disabled/unverified features never reach a model', async () => {
  let calls = 0; const f = await fixture({ modelAdapter: { selectPlan: async () => { calls++; return selection(); } } });
  assert.equal((await f.assistant.makeDecision({ ...context, text: 'Parar.' })).action, 'optout');
  assert.equal((await f.assistant.makeDecision({ ...context, handoff: true })).action, 'handoff');
  await f.configStore.set({ enabled: false }); assert.equal((await f.assistant.makeDecision(context)).action, 'ignore');
  await f.configStore.set({ enabled: true, faqEnabled: false, salesEnabled: false }); assert.equal((await f.assistant.makeDecision(context)).action, 'ignore'); assert.equal(calls, 0);
  await f.configStore.set({ faqEnabled: true }); await f.assistant.makeDecision({ ...context, text: 'pare de enviar mensagens' });
  assert.equal(calls, 1, 'wording that is not an exact command is left to the model');
  const noVerification = new SalesAssistant({ catalogStore: f.catalogStore, configStore: { get: async () => ({ enabled: true, faqEnabled: true, eligibility: { faq: { eligible: false } } }) }, modelAdapter: { selectPlan: async () => { calls++; } } });
  assert.equal((await noVerification.makeDecision(context)).action, 'ignore'); assert.equal(calls, 1);
});

test('model reference plans cannot inject prose, new URL, price, missing facts or payment tool', async () => {
  const valid = await fixture({ modelAdapter: { selectPlan: async () => selection() } });
  const response = await valid.assistant.makeDecision({ ...context, text: 'onde funciona Example App?' }); assert.equal(response.action, 'reply'); assert.match(response.text, /Você pode acessar o app pelo site/);
  for (const malicious of [{ ...selection(), text: 'Preço R$ 1 https://evil.invalid' }, { ...selection(), productId: 'missing' }, { ...selection(), includePrice: true }, { ...selection(), factIndexes: [9] }, { ...selection(), action: 'charge_card' }]) {
    const f = await fixture({ modelAdapter: { selectPlan: async () => malicious } });
    const answer = await f.assistant.makeDecision({ ...context, text: 'dúvida sobre Example App' }); assert.equal(answer.action, 'handoff'); assert.equal(answer.text, undefined);
  }
  const huge = await fixture({ catalog: [{ ...products[0], description: '😊'.repeat(300) }], modelAdapter: { selectPlan: async () => ({ ...selection(), includeDescription: true }) } });
  assert.equal((await huge.assistant.makeDecision(context)).reason, 'ANSWER_EXCEEDS_MESSAGE_LIMIT');
});

test('provider adapter uses fixed documented endpoints, strict schema, no tool execution and server-only authorization', async () => {
  for (const provider of ['openai', 'openrouter']) {
    let called = 0;
    const adapter = new SalesModelAdapter({ provider, model: 'explicit-model', apiKey: 'secret-credential', fetchImpl: async (url, options) => {
      called++; assert.equal(url, provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer secret-credential');
      const body = JSON.parse(options.body); assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.response_format.json_schema.strict, true); assert.equal(body.tools, undefined); assert.doesNotMatch(options.body, /secret-credential|recipientId|accessToken/);
      return { ok: true, json: async () => ({ model: 'explicit-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(selection()) } }] }) };
    } });
    assert.deepEqual(await adapter.selectPlan({ text: 'Como acesso?', catalog: products }), selection()); assert.equal(called, 1); assert.doesNotMatch(JSON.stringify(adapter), /secret-credential/);
  }
});

test('provider failures, invalid schema, refusal and timeout are redacted, bounded and never automatically retried', async () => {
  for (const response of [
    { ok: false, json: async () => ({ error: { message: 'secret-credential' } }) },
    { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify(selection()) } }] }) },
    { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'secret-credential', tool_calls: [{ function: 'payment' }] } }] }) },
  ]) {
    let calls = 0; const adapter = new SalesModelAdapter({ provider: 'openai', model: 'm', apiKey: 'secret-credential', fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(adapter.selectPlan({ text: 'pedido', catalog: products }), error => { assert.doesNotMatch(JSON.stringify(error) + error.message, /secret-credential/); return true; }); assert.equal(calls, 1);
  }
  const timeout = new SalesModelAdapter({ provider: 'openrouter', model: 'm', apiKey: 'secret-credential', timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(timeout.selectPlan({ text: 'pedido', catalog: products }), { code: 'MODEL_TIMEOUT' });
});

test('empty story mention can acknowledge verified eligibility while empty DM and unverified identity hand off', async () => {
  const { assistant } = await fixture();
  const mention = await assistant.makeDecision({ ...context, kind: 'story_mention', text: '' });
  assert.equal(mention.action, 'reply'); assert.equal(mention.feature, 'story'); assert.match(mention.text, /Valeu pela menção/);
  assert.deepEqual(await assistant.makeDecision({ ...context, kind: 'message', text: '' }), { action: 'handoff', reason: 'VERIFIED_INBOUND_REQUIRED' });
  assert.deepEqual(await assistant.makeDecision({ ...context, kind: 'story_mention', text: '', verifiedRecipient: false }), { action: 'handoff', reason: 'VERIFIED_INBOUND_REQUIRED' });
});

test('Luna OpenRouter requests no reasoning/fallback and rejects a missing or different returned model', async () => {
  for (const returnedModel of ['openai/gpt-6-luna', 'openai/different-model', undefined]) {
    let calls = 0;
    const adapter = new SalesModelAdapter({ provider: 'openrouter', model: 'openai/gpt-6-luna', apiKey: 'fake-private-key', fetchImpl: async (_url, options) => {
      calls++; const body = JSON.parse(options.body);
      assert.equal(body.model, 'openai/gpt-6-luna'); assert.deepEqual(body.reasoning, { effort: 'none' });
      assert.equal(body.max_tokens, 512); assert.equal(body.provider.allow_fallbacks, false); assert.equal(body.provider.require_parameters, true);
      return { ok: true, json: async () => ({ model: returnedModel, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(selection()) } }] }) };
    } });
    const result = adapter.selectPlan({ text: 'Como funciona?', catalog: products });
    if (returnedModel === 'openai/gpt-6-luna') assert.deepEqual(await result, selection());
    else await assert.rejects(result, { code: 'MODEL_RESPONSE_INVALID' });
    assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(adapter.publicStatus()), /fake-private-key/);
  }
});

test('cancellation aborts one model request promptly even when transport ignores abort; pre-cancelled work never fetches', async () => {
  const controller = new AbortController(); let signal; let calls = 0; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const adapter = new SalesModelAdapter({ provider: 'openrouter', model: 'openai/gpt-6-luna', apiKey: 'fake-private-key', fetchImpl: (_url, options) => {
    calls++; signal = options.signal; entered(); return new Promise(() => {});
  } });
  const result = adapter.selectPlan({ text: 'Pergunta', catalog: products, signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(result, { code: 'MODEL_CANCELLED' }); assert.equal(signal.aborted, true); assert.equal(calls, 1);
  await assert.rejects(adapter.selectPlan({ text: 'Pergunta', catalog: products, signal: controller.signal }), { code: 'MODEL_CANCELLED' }); assert.equal(calls, 1);
});

test('config generations persist across restart and change on pause/resume even at an identical clock', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'benion-sales-epoch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = () => Date.parse('2026-10-02T15:00:00Z'); const store = new AssistantConfigStore({ dataDir: dir, clock });
  const first = await store.set({ enabled: true, faqEnabled: true });
  await store.set({ enabled: false }); const second = await store.set({ enabled: true });
  assert.notEqual(first.activationEpoch, second.activationEpoch); assert.equal(first.updatedAt, second.updatedAt);
  assert.equal(store.isCurrent(first.activationEpoch), false); assert.equal(store.isCurrent(second.activationEpoch), true);
  const restart = await new AssistantConfigStore({ dataDir: dir, clock }).get(); assert.equal(restart.activationEpoch, second.activationEpoch);
  const unchanged = await store.set({ enabled: true }); assert.equal(unchanged.activationEpoch, second.activationEpoch);
});

test('verified provider timestamp is public while arbitrary provider fields and credentials remain private', async () => {
  const store = new AssistantConfigStore({ providerRequired: true, provider: { publicStatus: () => ({ configured: true, name: 'openrouter', model: 'openai/gpt-6-luna', verifiedAt: '2026-10-05T16:00:00Z', apiKey: 'private-secret', response: { user: 'private' } }) } });
  const config = await store.get(); assert.deepEqual(config.provider, { configured: true, name: 'openrouter', model: 'openai/gpt-6-luna', verifiedAt: '2026-10-05T16:00:00.000Z' });
  assert.equal(config.providerRequired, true); assert.doesNotMatch(JSON.stringify(config), /private-secret|response|apiKey/);
});
