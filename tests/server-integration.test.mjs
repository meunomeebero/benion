import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createBenionServer } from '../server.mjs';
import { runtimeConfig } from '../runtime.mjs';
import { GraphClient, SendLedger } from '../integrations/meta.mjs';
import { InboxService } from '../inbox.mjs';
import { CatalogStore, AssistantConfigStore, SalesAssistant } from '../sales.mjs';

const ACCOUNT = '17841400000000100'; const RECIPIENT = '200';
const OWNER = { primaryAccount: { id: ACCOUNT, username: 'example.owner' }, legacy: null };
const NOW = Date.parse('2026-10-02T15:00:00Z');
const ORIGIN = 'https://benion-integration.example';
const SECRET = 'test-only-webhook-secret'; const PASSWORD = 'test-only-password-long-enough';
const ENV = { BENION_MODE: 'production', BENION_PUBLIC_ORIGIN: ORIGIN, BENION_ADMIN_PASSWORD: PASSWORD,
  BENION_SESSION_SECRET: 'test-only-session-secret-long-enough-32-characters', BENION_META_APP_SECRET: SECRET };
const eligible = { faq: { eligible: true, reason: '' }, sales: { eligible: true, reason: '' }, story: { eligible: true, reason: '' } };
const body = () => JSON.stringify({ object: 'instagram', entry: [{ id: ACCOUNT, messaging: [{ sender: { id: RECIPIENT }, recipient: { id: ACCOUNT }, timestamp: NOW - 1000, message: { mid: 'm_ingress', text: 'Oi' } }] }] });

async function fixture(t, { failSend = false, preview = false, modelProvider = null } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'benion-http-inbox-')); const webRoot = path.join(dataDir, 'public'); await mkdir(webRoot);
  const catalog = new CatalogStore({ dataDir, initialProducts: [{ id: 'example-app', name: 'Example App', description: 'App de anúncios.', facts: ['Pode ser acessado pelo site.'], url: 'https://example.com/app' }] });
  const configStore = new AssistantConfigStore({ dataDir, eligibilityProvider: () => eligible });
  let modelCalls = 0; let graphCalls = 0;
  const client = new GraphClient({ accessToken: 'test-only-fake-token', accountId: ACCOUNT, apiVersion: 'v26.0', clock: () => NOW, ledger: new SendLedger({ directory: path.join(dataDir, 'sends') }), fetchImpl: async (url, options) => {
    graphCalls++; assert.equal(options.method, 'POST');
    const state = JSON.parse(await readFile(path.join(dataDir, 'inbox', 'inbox-state.json'), 'utf8'));
    assert.equal(Object.values(state.attempts).some(attempt => attempt.status === 'inflight'), true, 'durable attempt precedes Graph request');
    if (failSend) throw new Error('test-only-fake-token upstream secret');
    return { ok: true, json: async () => ({ recipient_id: RECIPIENT, message_id: 'm_http_ack' }) };
  } });
  const connection = { status: () => ({ connected: true }), stopAutomation: () => ({}), messagingContext: async () => ({ client, identity: { userId: ACCOUNT } }) };
  const assistant = new SalesAssistant({ catalogStore: catalog, configStore });
  const inbox = new InboxService({ dataDir, assistant, clock: () => NOW, clientProvider: () => connection.messagingContext() });
  const previewAssistant = preview ? new SalesAssistant({ catalogStore: catalog, configStore: { get: async () => ({ ...await configStore.get(), enabled: true, faqEnabled: true, salesEnabled: true, storyEnabled: true, eligibility: eligible }) },
    modelAdapter: { respond: async () => { modelCalls++; return { action: 'answer', productId: 'example-app', factIndexes: [0], includeDescription: false, includePrice: false, includeUrl: false, question: null, replyText: 'Pode ser acessado pelo site.' }; } } }) : null;
  const app = createBenionServer({ env: ENV, config: runtimeConfig(ENV), privateDirectory: dataDir, webRoot, owner: OWNER, connection, inbox, catalog, assistantConfig: configStore, previewAssistant, modelProvider, clock: () => NOW });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => { await inbox.shutdown(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const request = (pathname, { method = 'GET', headers = {}, body: text } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: 'benion-integration.example', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
    }); req.on('error', reject); if (text) req.write(text); req.end();
  });
  const login = await request('/admin/login', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: PASSWORD }).toString() });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const apiHeaders = { Cookie: cookie, 'X-Benion-Request': '1', 'Sec-Fetch-Site': 'same-origin' };
  const api = (pathname, options = {}) => request(pathname, { ...options, headers: { ...apiHeaders, ...options.headers } });
  const post = async (pathname, data) => {
    const csrf = (await api('/api/csrf')).json().nonce;
    return api(pathname, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Benion-CSRF': csrf }, body: JSON.stringify(data) });
  };
  const ingest = async (raw = body(), altered = false) => request('/webhooks/instagram', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` }, body: altered ? raw + ' ' : raw });
  return { api, post, ingest, inbox, dataDir, get graphCalls() { return graphCalls; }, get modelCalls() { return modelCalls; } };
}

test('HTTP signed ingress stores a private inbox event before ACK, dedupes, rejects changed bytes and cannot send while default off', async t => {
  const f = await fixture(t); assert.equal((await f.ingest(body(), true)).status, 403); assert.equal((await f.inbox.list()).threads.length, 0);
  assert.equal((await f.ingest()).status, 200);
  const state = JSON.parse(await readFile(path.join(f.dataDir, 'inbox', 'inbox-state.json'), 'utf8'));
  assert.equal(Object.keys(state.events).length, 1); assert.equal(Object.values(state.jobs)[0].status, 'ignored');
  assert.equal((await f.ingest()).status, 200); await f.inbox.processPending(); assert.equal(f.graphCalls, 0);
  const threads = (await f.api('/api/inbox')).json().threads; assert.equal(threads.length, 1); assert.match(threads[0].username, /^Contato /);
  const detail = (await f.api(`/api/inbox/threads/${threads[0].id}`)).json(); assert.equal(detail.messages.length, 1); assert.equal(detail.permissions.canReply, true);
  assert.doesNotMatch(JSON.stringify(detail), /test-only-fake-token|recipientId|accountId/);
});

test('HTTP manual response reserves durable state before Graph and reusing UUID across new HTTP requests does not resend', async t => {
  const f = await fixture(t); await f.ingest(); const id = (await f.api('/api/inbox')).json().threads[0].id; const requestId = randomUUID();
  const first = await f.post(`/api/inbox/threads/${id}/reply`, { text: 'Resposta humana.', requestId }); assert.equal(first.status, 200); assert.equal(first.json().outcome, 'accepted');
  const duplicate = await f.post(`/api/inbox/threads/${id}/reply`, { text: 'Resposta humana.', requestId }); assert.equal(duplicate.status, 200); assert.equal(duplicate.json().duplicate, true); assert.equal(f.graphCalls, 1);
  const detail = (await f.api(`/api/inbox/threads/${id}`)).json(); assert.equal(detail.thread.handoff, true); assert.equal(detail.messages.at(-1).status, 'accepted');
});

test('HTTP uncertain send quarantines thread and another draft cannot retry the recipient', async t => {
  const f = await fixture(t, { failSend: true }); await f.ingest(); const id = (await f.api('/api/inbox')).json().threads[0].id; const requestId = randomUUID();
  const attempt = await f.post(`/api/inbox/threads/${id}/reply`, { text: 'Resposta humana.', requestId }); assert.equal(attempt.json().outcome, 'unknown');
  assert.equal((await f.post(`/api/inbox/threads/${id}/reply`, { text: 'Resposta humana.', requestId })).json().duplicate, true);
  const newDraft = await f.post(`/api/inbox/threads/${id}/reply`, { text: 'Não repetir.', requestId: randomUUID() }); assert.equal(newDraft.status, 400); assert.equal(newDraft.json().error, 'OUTCOME_REQUIRES_REVIEW'); assert.equal(f.graphCalls, 1);
  assert.doesNotMatch(attempt.text + newDraft.text, /test-only-fake-token|upstream/);
});

test('HTTP preview forced eligibility produces only a decision, never an inbox job or Graph mutation', async t => {
  const f = await fixture(t, { preview: true });
  const before = await f.inbox.status(); const response = await f.post('/api/assistant/preview', { text: 'onde funciona Example App?', history: [], kind: 'message' });
  assert.equal(response.status, 200); assert.equal(response.json().mode, 'simulation'); assert.match(response.json().text, /Pode ser acessado pelo site/);
  assert.equal(f.modelCalls, 1, 'a selected provider can be called by preview; this is not a Graph send'); assert.equal(f.graphCalls, 0);
  assert.deepEqual(await f.inbox.status(), before);
});

test('global provider setup requires CSRF, clears the request secret and cannot activate the bot', async t => {
  const dto = { configured: false, name: 'openrouter', model: 'openai/gpt-6-luna', verifiedAt: null };
  let captured; let calls = 0;
  const modelProvider = { publicStatus: () => dto, set: async body => { calls++; captured = body; return { ...dto, configured: true }; } };
  const f = await fixture(t, { modelProvider });
  assert.deepEqual((await f.api('/api/assistant/provider')).json(), dto);
  assert.equal((await f.api('/api/assistant/provider', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'test-only-key-no-csrf' }) })).status, 403);
  assert.equal(calls, 0);
  const saved = await f.post('/api/assistant/provider', { apiKey: 'test-only-provider-private-key' });
  assert.equal(saved.status, 200); assert.equal(saved.json().configured, true); assert.equal(calls, 1); assert.equal(captured.apiKey, undefined);
  assert.doesNotMatch(saved.text, /private-key|apiKey/);
  assert.equal((await f.api('/api/assistant/config')).json().enabled, false); assert.equal(f.graphCalls, 0);
  assert.equal((await f.api('/api/assistant/provider', { headers: { 'X-Benion-Account': '999' } })).status, 200, 'the provider is global, not account-scoped');
});

test('public manual reply body rejects injected automatic, inboundId and feature before any send or reservation', async t => {
  const f = await fixture(t); await f.ingest(); const id = (await f.api('/api/inbox')).json().threads[0].id;
  for (const injected of [{ automatic: true }, { inboundId: 'm_ingress' }, { feature: 'sales' }, { automatic: true, inboundId: 'm_ingress', feature: 'faq' }]) {
    const response = await f.post(`/api/inbox/threads/${id}/reply`, { text: 'Tentativa de alterar o contrato público.', requestId: randomUUID(), ...injected });
    assert.equal(response.status, 400); assert.equal(response.json().error, 'INVALID_THREAD_ACTION');
  }
  assert.equal(f.graphCalls, 0);
  const state = JSON.parse(await readFile(path.join(f.dataDir, 'inbox', 'inbox-state.json'), 'utf8'));
  assert.equal(Object.keys(state.attempts).length, 0); assert.equal((await f.inbox.detail(id)).thread.handoff, false);
});
