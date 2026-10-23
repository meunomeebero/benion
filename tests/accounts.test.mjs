import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, chmod, symlink, rm, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHmac, randomUUID } from 'node:crypto';
import { AccountRegistry, createAccountRuntime } from '../accounts.mjs';
import { createBenionServer } from '../server.mjs';
import { runtimeConfig } from '../runtime.mjs';
import { loadOwnerConfig } from '../owner-config.mjs';

const PRIMARY = { id: '17841400000000100', username: 'example.owner' };
const LEGACY_REEL = { reelUrl: 'https://www.instagram.com/reel/EXAMPLEREEL1/', shortcode: 'EXAMPLEREEL1', mediaId: '17900000000000001', protectedCount: 11,
  requiredLinks: ['https://example.com/app', 'https://example.com/credits'] };
const HISTORICAL = Array.from({ length: 11 }, (_, i) => ({ commentId: String(1000 + i), username: `historical_${i}`, status: 'sent' }));
const LEGACY = { ...LEGACY_REEL, recovery: { schemaVersion: 1, account: PRIMARY.username, reel: LEGACY_REEL.reelUrl, comments: HISTORICAL, excludedReplies: [] } };
const SECOND = { id: '17841400000000200', username: 'second.example' };
const THIRD = { id: '17841400000000300', username: 'unknown.test' };
const ORIGINAL_TOKEN = 'test-only-original-token-123456';
const SECOND_TOKEN = 'test-only-second-token-123456';
const NOW = Date.parse('2026-10-02T18:00:00Z');
const ORIGIN = 'https://benion-accounts.example';
const ENV = { BENION_MODE: 'production', BENION_PUBLIC_ORIGIN: ORIGIN, BENION_ADMIN_PASSWORD: 'test-only-long-owner-password-1234',
  BENION_SESSION_SECRET: 'test-only-long-session-secret-5678', BENION_META_APP_SECRET: 'test-only-webhook-secret' };
const registration = () => ({ expectedUsername: SECOND.username, accessToken: SECOND_TOKEN, apiVersion: 'v26.0' });
const inbound = (account, mid = 'm_test') => ({ id: account.id, messaging: [{ sender: { id: '200' }, recipient: { id: account.id }, timestamp: NOW - 1000, message: { mid, text: 'Oi' } }] });

async function fixture(t, { inspectOverride, allowSend = false, modelProvider = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'benion-accounts-')); const webRoot = path.join(base, 'public'); const privateDirectory = path.join(base, 'private');
  await mkdir(webRoot); await mkdir(privateDirectory, { mode: 0o700 });
  let inspectionCalls = 0; const graphCalls = [];
  const inspectToken = async input => {
    inspectionCalls++;
    if (inspectOverride) return inspectOverride(input, inspectionCalls);
    const account = input.accessToken === ORIGINAL_TOKEN ? PRIMARY : input.accessToken === SECOND_TOKEN ? SECOND : THIRD;
    return { userId: account.id, username: account.username, permissionsVerified: false, secret: input.accessToken };
  };
  const fetchImpl = async (url, options) => {
    graphCalls.push({ url: new URL(url), method: options.method, authorization: options.headers.Authorization, ...(options.body ? { body: JSON.parse(options.body) } : {}) });
    if (allowSend && options.method === 'POST') return { ok: true, status: 200, json: async () => ({ recipient_id: '200', message_id: 'm_confirmed_send' }) };
    assert.equal(options.method, 'GET', 'registration/verification never sends a DM');
    const account = options.headers.Authorization === `Bearer ${ORIGINAL_TOKEN}` ? PRIMARY : SECOND;
    const data = new URL(url).pathname.endsWith('/media') ? [{ id: account.id === PRIMARY.id ? '1001' : '2001', shortcode: account.id === PRIMARY.id ? 'ORIGINAL' : 'SECOND', permalink: `https://www.instagram.com/reel/${account.id === PRIMARY.id ? 'ORIGINAL' : 'SECOND'}/`, media_type: 'REELS', comments_count: 0 }] : [];
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  const factory = ({ account, dataDir, legacy = null }) => createAccountRuntime({ account, dataDir, servedRoot: webRoot, inspectToken, fetchImpl, env: ENV, clock: () => NOW, modelProvider, legacy });
  const original = factory({ account: PRIMARY, dataDir: privateDirectory, legacy: LEGACY });
  await original.connection.connect({ accessToken: ORIGINAL_TOKEN, apiVersion: 'v26.0' });
  const registry = new AccountRegistry({ privateDirectory, servedRoot: webRoot, inspectToken, primaryAccount: PRIMARY, primaryRuntime: original, runtimeFactory: factory, clock: () => NOW });
  t.after(async () => { for (const runtime of await registry.runtimes().catch(() => [])) { await runtime.campaigns.shutdown(); await runtime.inbox.shutdown(); } await rm(base, { recursive: true, force: true }); });
  return { base, privateDirectory, webRoot, original, registry, factory, inspectToken, graphCalls, get inspectionCalls() { return inspectionCalls; } };
}

test('registered accounts have private isolated runtimes, empty paused state, redacted identities and untouched original files', async t => {
  const f = await fixture(t);
  await f.original.catalog.set({ products: [{ id: 'original', name: 'Original', description: 'Catálogo original.', url: 'https://original.example', facts: [] }] });
  const originalToken = await readFile(path.join(f.privateDirectory, 'connection.json'));
  const originalCatalog = await readFile(path.join(f.privateDirectory, 'assistant', 'catalog.json'));
  const result = await f.registry.register(registration());
  assert.equal(result.account.id, SECOND.id); assert.equal(result.account.connected, true); assert.equal(result.defaultAccountId, PRIMARY.id);
  const second = await f.registry.resolve(SECOND.id);
  assert.notEqual(second, f.original); assert.equal(await f.registry.resolve(), f.original);
  assert.deepEqual((await second.catalog.get()).products, []);
  assert.deepEqual((await second.campaigns.list()).campaigns, []);
  assert.deepEqual((await second.inbox.list()).threads, []);
  assert.equal((await second.assistantConfig.get()).enabled, false);
  assert.equal((await second.assistantConfig.get()).faqEnabled, false);
  assert.equal((await second.assistantConfig.get()).salesEnabled, false);
  assert.equal((await second.assistantConfig.get()).storyEnabled, false);
  assert.deepEqual(await readFile(path.join(f.privateDirectory, 'connection.json')), originalToken);
  assert.deepEqual(await readFile(path.join(f.privateDirectory, 'assistant', 'catalog.json')), originalCatalog);
  const registryText = await readFile(path.join(f.privateDirectory, 'accounts.json'), 'utf8');
  assert.doesNotMatch(registryText + JSON.stringify(await f.registry.list()), new RegExp(`${SECOND_TOKEN}|${ORIGINAL_TOKEN}|accessToken|extraSecret`));
  assert.equal((await stat(path.join(f.privateDirectory, 'accounts.json'))).mode & 0o777, 0o600);
  const tokenPath = path.join(f.privateDirectory, 'accounts', SECOND.id, 'connection.json');
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(tokenPath))).mode & 0o777, 0o700);
  assert.equal(f.graphCalls.length, 0);
});

test('real account activation requires a verified model key and an official inbound for that account', async t => {
  let status = { configured: false, name: 'openrouter', model: 'openai/gpt-6-luna', verifiedAt: null };
  const provider = { publicStatus: () => status, selectPlan: async () => { throw Error('No model request in this test'); } };
  const f = await fixture(t, { modelProvider: provider });
  await f.original.assertAssistantActivation({ enabled: false, faqEnabled: true });
  await assert.rejects(f.original.assertAssistantActivation({ enabled: true, faqEnabled: true }), { code: 'MODEL_VERIFICATION_REQUIRED' });
  status = { ...status, configured: true, verifiedAt: new Date(NOW).toISOString() };
  await assert.rejects(f.original.assertAssistantActivation({ enabled: true, faqEnabled: true }), { code: 'ASSISTANT_ELIGIBILITY_REQUIRED' });
  await f.original.inbox.ingestWebhook({ object: 'instagram', entry: [inbound(PRIMARY)] }, { verifiedAccountId: PRIMARY.id, signatureVerified: true });
  await f.original.assertAssistantActivation({ enabled: true, faqEnabled: true });
  assert.equal((await f.original.assistantConfig.get()).enabled, false, 'a successful preflight never activates on its own');
  await assert.rejects(f.original.assertAssistantActivation({ enabled: true, storyEnabled: true }), { code: 'ASSISTANT_ELIGIBILITY_REQUIRED' });
  await f.registry.register(registration());
  const second = await f.registry.resolve(SECOND.id);
  await assert.rejects(second.assertAssistantActivation({ enabled: true, faqEnabled: true }), { code: 'ASSISTANT_ELIGIBILITY_REQUIRED' });
  status = { ...status, verifiedAt: null };
  await assert.rejects(f.original.assertAssistantActivation({ enabled: true, faqEnabled: true }), { code: 'MODEL_VERIFICATION_REQUIRED' });
  assert.equal((await f.original.assistantConfig.get()).eligibility.faq.eligible, false);
  assert.equal(f.graphCalls.length, 0);
});

test('registration rejects mismatched identity, duplicate originals, invalid fields and a token whose identity changes before persistence', async t => {
  const f = await fixture(t); const original = await readFile(path.join(f.privateDirectory, 'connection.json'));
  await assert.rejects(f.registry.register({ ...registration(), expectedUsername: 'wrong.account' }), { code: 'WRONG_ACCOUNT' });
  await assert.rejects(f.registry.register({ expectedUsername: PRIMARY.username, accessToken: ORIGINAL_TOKEN, apiVersion: 'v26.0' }), { code: 'ACCOUNT_ALREADY_REGISTERED' });
  for (const input of [{ ...registration(), expectedUsername: '../escape' }, { ...registration(), accountId: SECOND.id }, { ...registration(), apiVersion: 'latest' }]) await assert.rejects(f.registry.register(input), { code: 'INVALID_ACCOUNT_REGISTRATION' });
  assert.deepEqual(await readFile(path.join(f.privateDirectory, 'connection.json')), original);
  assert.equal((await f.registry.list()).accounts.length, 1);
  const racing = await fixture(t, { inspectOverride: (input, call) => input.accessToken === ORIGINAL_TOKEN ? { userId: PRIMARY.id, username: PRIMARY.username } : { userId: call === 2 ? SECOND.id : THIRD.id, username: SECOND.username } });
  await assert.rejects(racing.registry.register(registration()), { code: 'WRONG_ACCOUNT' });
  assert.equal((await racing.registry.list()).accounts.length, 1);
});

test('registered webhook entries go only to exact account inboxes and unknown identities never create state or sends', async t => {
  const f = await fixture(t); await f.registry.register(registration()); const second = await f.registry.resolve(SECOND.id);
  await f.registry.ingestWebhook({ object: 'instagram', entry: [inbound(PRIMARY), inbound(SECOND), inbound(THIRD)] });
  const originalThreads = (await f.original.inbox.list()).threads; const secondThreads = (await second.inbox.list()).threads;
  assert.equal(originalThreads.length, 1); assert.equal(secondThreads.length, 1); assert.notEqual(originalThreads[0].id, secondThreads[0].id);
  await assert.rejects(f.registry.resolve(THIRD.id), { code: 'ACCOUNT_NOT_FOUND' });
  await assert.rejects(second.inbox.detail(originalThreads[0].id), { code: 'THREAD_NOT_FOUND' });
  await assert.rejects(second.inbox.reply(originalThreads[0].id, { text: 'Wrong recipient', requestId: randomUUID() }), { code: 'THREAD_NOT_FOUND' });
  await f.original.inbox.processPending(); await second.inbox.processPending(); assert.equal(f.graphCalls.length, 0);
  assert.equal((await f.registry.list()).accounts.length, 2);
  const before = await f.original.inbox.status(); const malformed = inbound(SECOND, 'm_invalid'); malformed.messaging[0].recipient.id = PRIMARY.id;
  await assert.rejects(f.registry.ingestWebhook({ object: 'instagram', entry: [inbound(PRIMARY, 'm_new'), malformed] }), { code: 'INVALID_MESSAGE_EVENT' });
  assert.deepEqual(await f.original.inbox.status(), before, 'all recognized account events are validated before any account is persisted');
});

test('catalogs and campaigns verify their own account, preserve the original review state and start new campaigns disabled', async t => {
  const f = await fixture(t); const originalCampaign = await f.original.campaigns.create({ name: 'Original', mediaId: '1001', messageText: 'Original DM https://original.example', keywords: [] });
  const savedPath = path.join(f.privateDirectory, 'campaigns.json'); const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  Object.assign(saved.campaigns[0].status, { state: 'review', reviewReason: 'GRAPH_REJECTED' });
  await writeFile(savedPath, JSON.stringify(saved), { mode: 0o600 }); const before = await readFile(savedPath);
  await f.registry.register(registration()); const second = await f.registry.resolve(SECOND.id);
  await second.catalog.set({ products: [{ id: 'second', name: 'Second', description: 'Outro produto.', url: 'https://second.example', facts: [] }] });
  assert.equal((await f.original.catalog.get()).products.length, 0);
  const media = await second.campaigns.listMedia(); assert.equal(media.available, true); assert.equal(media.account.userId, SECOND.id); assert.equal(media.media[0].id, '2001');
  assert.match(f.graphCalls.at(-1).url.pathname, new RegExp(`/${SECOND.id}/media$`)); assert.equal(f.graphCalls.at(-1).authorization, `Bearer ${SECOND_TOKEN}`);
  const campaign = await second.campaigns.create({ name: 'Second', mediaId: '2001', messageText: 'Second DM https://second.example', keywords: ['quero'] });
  assert.equal(campaign.running, false); assert.equal(campaign.requiresRecovery, false);
  await assert.rejects(second.campaigns.status(originalCampaign.id), { code: 'CAMPAIGN_NOT_FOUND' });
  await assert.rejects(second.campaigns.create({ name: 'Foreign', mediaId: '1001', messageText: 'Wrong DM https://wrong.example', keywords: [] }), { code: 'OWNERSHIP_UNVERIFIED' });
  assert.deepEqual(await readFile(savedPath), before); assert.equal((await f.original.campaigns.status(originalCampaign.id)).reviewReason, 'GRAPH_REJECTED');
  await second.connection.verifyAccess({}); assert.equal(second.connection.status().capabilities.legacyRecovery, false);
  assert.equal(second.connection.status().capabilities.recovery.expected, 0);
  assert.throws(() => second.connection.assertAutomationStart({ messageText: 'any' }), { code: 'AUTOMATION_UNAVAILABLE' });
  assert.equal(f.graphCalls.some(call => call.method === 'POST'), false);
});

test('manual DM to a registered inbox uses only its account token, endpoint and ledger', async t => {
  const f = await fixture(t, { allowSend: true }); await f.registry.register(registration()); const second = await f.registry.resolve(SECOND.id);
  await f.registry.ingestWebhook({ object: 'instagram', entry: [inbound(PRIMARY), inbound(SECOND)] });
  const originalBefore = await readFile(path.join(f.privateDirectory, 'inbox', 'inbox-state.json'));
  const threadId = (await second.inbox.list()).threads[0].id; const requestId = randomUUID();
  const result = await second.inbox.reply(threadId, { text: 'Resposta de teste.', requestId });
  assert.equal(result.outcome, 'accepted'); assert.equal(f.graphCalls.length, 1);
  const call = f.graphCalls[0]; assert.equal(call.method, 'POST'); assert.match(call.url.pathname, new RegExp(`/${SECOND.id}/messages$`));
  assert.equal(call.authorization, `Bearer ${SECOND_TOKEN}`); assert.equal(call.body.recipient.id, '200');
  assert.equal((await second.inbox.reply(threadId, { text: 'Resposta de teste.', requestId })).duplicate, true); assert.equal(f.graphCalls.length, 1);
  assert.deepEqual(await readFile(path.join(f.privateDirectory, 'inbox', 'inbox-state.json')), originalBefore);
  const secondState = JSON.parse(await readFile(path.join(f.privateDirectory, 'accounts', SECOND.id, 'inbox', 'inbox-state.json'), 'utf8'));
  assert.equal(Object.values(secondState.attempts)[0].accountId, SECOND.id);
});

test('restart loads only registered identity metadata, leaves accounts paused and rejects unsafe registry/account paths', async t => {
  const f = await fixture(t); await f.registry.register(registration());
  const before = f.inspectionCalls;
  const restarted = new AccountRegistry({ privateDirectory: f.privateDirectory, servedRoot: f.webRoot, inspectToken: f.inspectToken, primaryAccount: PRIMARY, primaryRuntime: f.original, runtimeFactory: f.factory, clock: () => NOW });
  const list = await restarted.list(); assert.equal(list.accounts.length, 2); assert.equal(list.accounts[1].connected, false); assert.equal(f.inspectionCalls, before);
  const runtime = await restarted.resolve(SECOND.id); assert.equal((await runtime.campaigns.list()).runningCampaignId, null); assert.equal((await runtime.assistantConfig.get()).enabled, false);
  await assert.rejects(restarted.resolve(''), { code: 'ACCOUNT_NOT_FOUND' }); await assert.rejects(restarted.resolve('../escape'), { code: 'ACCOUNT_NOT_FOUND' });
  await chmod(path.join(f.privateDirectory, 'accounts.json'), 0o644);
  const unsafe = new AccountRegistry({ privateDirectory: f.privateDirectory, servedRoot: f.webRoot, inspectToken: f.inspectToken, primaryAccount: PRIMARY, primaryRuntime: f.original, runtimeFactory: f.factory });
  await assert.rejects(unsafe.list(), { code: 'ACCOUNT_STORE_INVALID' });
  const linked = await fixture(t); const outside = path.join(linked.base, 'outside'); await mkdir(outside, { mode: 0o700 }); await symlink(outside, path.join(linked.privateDirectory, 'accounts'));
  await assert.rejects(linked.registry.register(registration()), { code: 'ACCOUNT_STORE_INVALID' });
});

test('child-account symlinks cannot expose or ingest into original state after restart or after a running account changes path', async t => {
  const f = await fixture(t); await f.registry.register(registration());
  await f.original.catalog.set({ products: [{ id: 'private-original', name: 'Original', description: '', url: 'https://original.example', facts: [] }] });
  const directory = path.join(f.privateDirectory, 'accounts', SECOND.id);
  await rename(directory, `${directory}-old`); await symlink(f.privateDirectory, directory);
  await assert.rejects(f.registry.resolve(SECOND.id), { code: 'ACCOUNT_STORE_INVALID' });
  await assert.rejects(f.registry.runtimes(), { code: 'ACCOUNT_STORE_INVALID' });
  await assert.rejects(f.registry.ingestWebhook({ object: 'instagram', entry: [inbound(PRIMARY), inbound(SECOND)] }), { code: 'ACCOUNT_STORE_INVALID' });
  assert.equal((await f.original.inbox.list()).threads.length, 0);
  const restarted = new AccountRegistry({ privateDirectory: f.privateDirectory, servedRoot: f.webRoot, inspectToken: f.inspectToken, primaryAccount: PRIMARY, primaryRuntime: f.original, runtimeFactory: f.factory });
  await assert.rejects(restarted.list(), { code: 'ACCOUNT_STORE_INVALID' });
});

test('nested assistant directories and catalog files refuse symlinks into another account', async t => {
  const f = await fixture(t); await f.registry.register(registration());
  const second = await f.registry.resolve(SECOND.id);
  await f.original.catalog.set({ products: [{ id: 'private-original', name: 'Original', description: '', url: 'https://original.example', facts: [] }] });
  const original = await readFile(path.join(f.privateDirectory, 'assistant', 'catalog.json'));
  const assistantDirectory = path.join(f.privateDirectory, 'accounts', SECOND.id, 'assistant');
  await symlink(path.join(f.privateDirectory, 'assistant'), assistantDirectory);
  await assert.rejects(second.catalog.get(), { code: 'PRIVATE_STATE_INVALID' });
  await assert.rejects(second.catalog.set({ products: [] }), { code: 'PRIVATE_STATE_INVALID' });
  await rm(assistantDirectory); await mkdir(assistantDirectory, { mode: 0o700 });
  await symlink(path.join(f.privateDirectory, 'assistant', 'catalog.json'), path.join(assistantDirectory, 'catalog.json'));
  await assert.rejects(second.catalog.get(), { code: 'PRIVATE_STATE_UNREADABLE' });
  await assert.rejects(second.catalog.set({ products: [] }), { code: 'PRIVATE_STATE_UNREADABLE' });
  assert.deepEqual(await readFile(path.join(f.privateDirectory, 'assistant', 'catalog.json')), original);
});

async function httpFixture(t) {
  const f = await fixture(t);
  const app = createBenionServer({ env: ENV, config: runtimeConfig(ENV), webRoot: f.webRoot, privateDirectory: f.privateDirectory, ...f.original, accounts: f.registry, clock: () => NOW });
  return { ...f, ...await serve(t, app) };
}
async function serve(t, app) {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const port = app.server.address().port;
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const request = (pathname, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: 'benion-accounts.example', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
    }); req.on('error', reject); if (body) req.write(body); req.end();
  });
  const login = await request('/admin/login', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: ENV.BENION_ADMIN_PASSWORD }).toString() });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const api = (pathname, { account, ...options } = {}) => request(pathname, { ...options, headers: { Cookie: cookie, 'X-Benion-Request': '1', 'Sec-Fetch-Site': 'same-origin', ...(account !== undefined ? { 'X-Benion-Account': account } : {}), ...options.headers } });
  const post = async (pathname, body, account) => {
    const csrf = (await api('/api/csrf')).json().nonce;
    return api(pathname, { account, method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Benion-CSRF': csrf }, body: JSON.stringify(body) });
  };
  const close = async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  return { request, api, post, close };
}

test('a fresh install bootstraps its first account over HTTP, rejects a wrong identity and keeps the account after restart without sends', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'benion-bootstrap-')); const webRoot = path.join(base, 'public'); const privateDirectory = path.join(base, 'private');
  await mkdir(webRoot); t.after(() => rm(base, { recursive: true, force: true }));
  let fetches = 0; t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('bootstrap never calls Meta or a model'); });
  let inspections = 0;
  const inspectToken = async input => { inspections++; assert.equal(input.accessToken, SECOND_TOKEN); return { userId: SECOND.id, username: SECOND.username }; };
  const start = async () => serve(t, createBenionServer({ env: ENV, config: runtimeConfig(ENV), webRoot, privateDirectory, owner: await loadOwnerConfig(privateDirectory), inspectToken, clock: () => NOW }));
  assert.equal(await loadOwnerConfig(privateDirectory), null);
  let app = await start();
  assert.deepEqual((await app.api('/api/accounts')).json(), { defaultAccountId: null, accounts: [] });
  assert.equal((await app.api('/api/assistant/provider')).status, 200);
  assert.equal((await app.api('/api/catalog')).json().error, 'ACCOUNT_NOT_FOUND');
  const wrong = await app.post('/api/accounts', { ...registration(), expectedUsername: 'someone.else' });
  assert.equal(wrong.json().error, 'WRONG_ACCOUNT'); assert.deepEqual((await app.api('/api/accounts')).json().accounts, []);
  const first = await app.post('/api/accounts', registration());
  assert.equal(first.status, 200); assert.equal(first.json().defaultAccountId, SECOND.id); assert.equal(first.json().account.legacyRecovery, false);
  assert.doesNotMatch(first.text, new RegExp(SECOND_TOKEN));
  assert.equal((await stat(path.join(privateDirectory, 'accounts', SECOND.id, 'connection.json'))).mode & 0o777, 0o600);
  assert.equal((await app.api('/api/connection/recovery')).status, 404);
  await app.close(); const inspectedBeforeRestart = inspections;
  assert.equal(await loadOwnerConfig(privateDirectory), null, 'registered accounts never require owner.json');
  app = await start();
  const list = (await app.api('/api/accounts')).json();
  assert.equal(list.defaultAccountId, SECOND.id);
  assert.deepEqual(list.accounts.map(row => [row.id, row.username, row.legacyRecovery, row.connected]), [[SECOND.id, SECOND.username, false, false]]);
  assert.deepEqual((await app.api('/api/campaigns')).json().campaigns, []);
  assert.equal(inspections, inspectedBeforeRestart, 'restart never revalidates the token by itself'); assert.equal(fetches, 0);
  // Original root-layout state without owner.json must stop startup, not orphan its campaigns.
  await writeFile(path.join(privateDirectory, 'campaigns.json'), '{}', { mode: 0o600 });
  await assert.rejects(loadOwnerConfig(privateDirectory), { code: 'OWNER_CONFIG_REQUIRED' });
});

test('protected account registration needs owner+CSRF, scoped APIs isolate catalogs and invalid selections never fall back', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/api/accounts')).status, 401);
  assert.equal((await f.api('/api/accounts', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(registration()) })).status, 403);
  const registered = await f.post('/api/accounts', registration(), THIRD.id); assert.equal(registered.status, 200); assert.equal(registered.json().account.id, SECOND.id);
  const list = await f.api('/api/accounts'); assert.equal(list.json().accounts.length, 2); assert.doesNotMatch(list.text + registered.text, new RegExp(`${SECOND_TOKEN}|${ORIGINAL_TOKEN}|accessToken`));
  const product = { id: 'second', name: 'Second', description: '', facts: [], url: 'https://second.example' };
  assert.equal((await f.post('/api/catalog', { products: [product] }, SECOND.id)).status, 200);
  assert.equal((await f.api('/api/catalog')).json().products.length, 0);
  assert.equal((await f.api('/api/catalog', { account: SECOND.id })).json().products[0].id, 'second');
  for (const pathname of ['/api/catalog', '/api/inbox', '/api/campaigns', '/api/assistant/config', '/api/connection/status']) {
    const unknown = await f.api(pathname, { account: THIRD.id }); assert.equal(unknown.status, 400); assert.equal(unknown.json().error, 'ACCOUNT_NOT_FOUND');
  }
  const accounts = list.json().accounts; assert.deepEqual(accounts.map(account => account.legacyRecovery), [true, false]);
  assert.equal((await f.api('/api/connection/recovery', { account: SECOND.id })).status, 404);
  assert.deepEqual((await f.api('/api/connection/recovery')).json(), LEGACY.recovery);
  assert.equal((await f.request('/api/connection/recovery')).status, 401);
  assert.equal((await f.api('/data/recovery.json')).status, 404, 'recovery records are never a static file');
});

test('connection nonces stay bound to selected account and signed HTTP batches cannot cross or create account inboxes', async t => {
  const f = await httpFixture(t); await f.registry.register(registration());
  const csrf = await f.api('/api/connection/csrf'); const nonce = csrf.json().nonce; const extraCookie = csrf.headers['set-cookie'][0].split(';')[0];
  const login = await f.request('/admin/login', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: ENV.BENION_ADMIN_PASSWORD }).toString() });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const wrongScope = await f.api('/api/connection', { account: SECOND.id, method: 'POST', headers: { Cookie: `${cookie}; ${extraCookie}`, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Benion-CSRF': nonce }, body: JSON.stringify({ accessToken: SECOND_TOKEN, apiVersion: 'v26.0' }) });
  assert.equal(wrongScope.status, 403); assert.equal(wrongScope.json().error, 'CSRF_INVALID');
  const raw = JSON.stringify({ object: 'instagram', entry: [inbound(PRIMARY), inbound(SECOND), inbound(THIRD)] });
  const signature = `sha256=${createHmac('sha256', ENV.BENION_META_APP_SECRET).update(raw).digest('hex')}`;
  assert.equal((await f.request('/webhooks/instagram', { method: 'POST', headers: { 'X-Hub-Signature-256': signature }, body: raw + ' ' })).status, 403);
  assert.equal((await f.request('/webhooks/instagram', { method: 'POST', headers: { 'X-Hub-Signature-256': signature }, body: raw })).status, 200);
  assert.equal((await f.api('/api/inbox')).json().threads.length, 1);
  assert.equal((await f.api('/api/inbox', { account: SECOND.id })).json().threads.length, 1);
  const originalThread = (await f.api('/api/inbox')).json().threads[0].id;
  assert.equal((await f.api(`/api/inbox/threads/${originalThread}`, { account: SECOND.id })).status, 400);
  assert.equal(f.graphCalls.length, 0);
});

test('legacy campaign restarts with fresh recovery checks, the original cutoff and no duplicate DMs', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'benion-legacy-resume-'));
  const webRoot = path.join(base, 'public'), dataDir = path.join(base, 'private');
  await mkdir(webRoot, { recursive: true });
  const historical = HISTORICAL;
  let now = NOW;
  const comment = (id, username, author, at) => ({ id, username, from: { id: author, username }, timestamp: new Date(at).toISOString() });
  // One historical comment is no longer visible, as in the production account.
  const rows = historical.slice(0, 10).map((r, i) => comment(r.commentId, r.username, String(8000 + i), NOW - 60000));
  const privateSends = [], publicSends = [], runtimes = [];
  const fetchImpl = async (url, options) => {
    const edge = new URL(url).pathname;
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (edge.endsWith('/messages')) {
        privateSends.push(body.recipient.comment_id);
        return Response.json({ recipient_id: '9000', message_id: `message-${body.recipient.comment_id}` });
      }
      assert.ok(edge.endsWith('/replies'));
      publicSends.push(edge.split('/').at(-2));
      return Response.json({ id: `99${edge.split('/').at(-2)}` });
    }
    assert.equal(options.method, 'GET');
    if (edge.endsWith('/media')) return Response.json({ data: [{ id: LEGACY.mediaId, shortcode: LEGACY.shortcode,
      permalink: LEGACY.reelUrl, media_type: 'REELS', comments_count: rows.length }] });
    if (edge.endsWith('/comments')) return Response.json({ data: rows });
    assert.ok(edge.endsWith('/conversations'));
    return Response.json({ data: [] });
  };
  const create = () => {
    const runtime = createAccountRuntime({ account: PRIMARY, legacy: LEGACY, dataDir, servedRoot: webRoot, env: ENV, clock: () => now, fetchImpl,
      inspectToken: async () => ({ userId: PRIMARY.id, username: PRIMARY.username }) });
    runtimes.push(runtime); return runtime;
  };
  t.after(async () => { for (const runtime of runtimes) { await runtime.campaigns.shutdown(); await runtime.inbox.shutdown(); } await rm(base, { recursive: true, force: true }); });
  const first = create();
  await first.connection.connect({ accessToken: ORIGINAL_TOKEN, apiVersion: 'v26.0' });
  const campaign = await first.campaigns.create({ name: 'Legacy', scope: 'reel', mediaId: LEGACY.mediaId, keywords: [],
    messageText: 'Links: https://example.com/app https://example.com/credits', publicReplies: ['Link sent.'] });
  assert.equal(campaign.requiresRecovery, true);
  assert.equal((await first.campaigns.start(campaign.id)).running, true);
  const cutoff = (await first.campaigns.status(campaign.id)).status.activatedAt;
  rows.push(comment('2000', 'new_person', '9000', NOW + 1000));
  now += 61000; await first.campaigns.pollOnce(campaign.id);
  assert.deepEqual(privateSends, ['2000']);
  await first.campaigns.shutdown();
  rows.push(comment('2001', 'new_person_renamed', '9000', now + 1000),
    comment('2002', 'historical_10', '8010', now + 1000), comment('2003', 'another_person', '9003', now + 1000));
  now += 17 * 60000;
  const restarted = create();
  await restarted.campaigns.restoreRunning();
  const restored = await restarted.campaigns.status(campaign.id);
  assert.equal(restored.enabled, true); assert.equal(restored.running, true);
  assert.equal(restored.status.activatedAt, cutoff);
  assert.equal(restarted.connection.status().capabilities.recovery.protected, 11);
  assert.deepEqual(privateSends, ['2000'], 'restart does not send before the scheduled poll');
  now += 61000; await restarted.campaigns.pollOnce(campaign.id);
  assert.deepEqual(privateSends, ['2000', '2003']);
  assert.deepEqual(publicSends, ['2000', '2003']);
  await restarted.campaigns.stop(campaign.id);
  await restarted.campaigns.restoreRunning();
  assert.equal((await restarted.campaigns.status(campaign.id)).enabled, false, 'manual pause remains paused');
});
