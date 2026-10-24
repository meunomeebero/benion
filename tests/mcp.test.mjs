import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createBenionServer } from '../server.mjs';
import { runtimeConfig } from '../runtime.mjs';
import { CampaignService } from '../campaigns.mjs';
import { PublishingService } from '../publishing.mjs';
import { ContentWorkflow } from '../content-workflow.mjs';

const ACCOUNT = '17840000000000001', OTHER = '17840000000000002';
const TOKEN = 'synthetic-mcp-owner-token-not-real-123456789012345';
const ORIGIN = 'https://mcp.example.com';
const NOW = Date.parse('2026-10-24T12:00:00Z');
async function fixture(t, { enabled = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benion-mcp-')); let now = NOW;
  const webRoot = path.join(root, 'public'); await mkdir(webRoot);
  const runtimes = new Map(); const transitions = []; let replyCalls = 0;
  for (const accountId of [ACCOUNT, OTHER]) {
    const dataDir = path.join(root, accountId); await mkdir(dataDir, { mode: 0o700 });
    const client = { listMedia: async () => ({ media: [{ id: '123', shortcode: 'Example', permalink: 'https://www.instagram.com/reel/Example/' }], truncated: false }),
      listComments: async () => ({ comments: [], truncated: false }), sendPrivateReply: () => assert.fail('Unexpected send'), publishReel: () => assert.fail('Unexpected publication') };
    const provider = async () => ({ client, ledger: { get: async () => null }, identity: { userId: accountId, username: 'example.owner' } });
    const campaigns = new CampaignService({ dataDir, accountId, accountUsername: 'example.owner', clientProvider: provider, clock: () => NOW });
    const publishing = new PublishingService({ dataDir, accountId, clientProvider: provider, campaigns, clock: () => NOW, origin: ORIGIN });
    const runtime = { campaigns, publishing, contentWorkflow: new ContentWorkflow({ dataDir, accountId, publishing, clock: () => NOW }),
      connection: { status: () => ({ connected: true }), stopAutomationAndDrain: async () => transitions.push('drained') },
      inbox: { reply: async (threadId, body) => { replyCalls++; return { threadId, ...body }; } },
      assertAssistantActivation: async () => { throw new Error('ASSISTANT_NOT_ELIGIBLE'); }, assistantConfig: { set: () => assert.fail('Activation bypass') } };
    runtimes.set(accountId, runtime);
  }
  const accounts = { list: async () => ({ accounts: [...runtimes.keys()].map(id => ({ id, username: 'example.owner' })) }),
    resolve: async id => runtimes.get(id) ?? Promise.reject(new Error('ACCOUNT_NOT_FOUND')), runtimes: async () => [...runtimes.values()] };
  const env = { BENION_MODE: 'production', BENION_PUBLIC_ORIGIN: ORIGIN, BENION_ADMIN_PASSWORD: 'test-admin-password-123456789',
    BENION_SESSION_SECRET: 'test-session-secret-1234567890123456789', BENION_MCP_TOKEN: enabled ? TOKEN : undefined };
  const app = createBenionServer({ env, config: runtimeConfig(env), webRoot, privateDirectory: path.join(root, 'private'), accounts, clock: () => now });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const runtime of runtimes.values()) { await runtime.campaigns.shutdown(); await runtime.publishing.shutdown(); }
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = (body, { pathname = '/mcp', method = 'POST', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.server.address().port, path: pathname, method,
      headers: { Host: 'mcp.example.com', Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, data: text ? JSON.parse(text) : null }); });
    }); req.on('error', reject); if (body !== undefined) req.write(Buffer.isBuffer(body) ? body : JSON.stringify(body)); req.end();
  });
  const rpc = (method, params = {}, options) => request({ jsonrpc: '2.0', id: 1, method, params }, options);
  const call = async (name, args = {}, options) => (await rpc('tools/call', { name, arguments: args }, options)).data;
  return { request, rpc, call, runtimes, transitions, advance: milliseconds => { now += milliseconds; }, get replyCalls() { return replyCalls; } };
}

test('MCP authenticated stateless lifecycle rejects origin/host/token/schema bypasses without exposing credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).data.result.serverInfo.name, 'benion');
  assert.equal((await f.request({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer ' + 'x'.repeat(43) }, { Authorization: '', Cookie: 'benion_admin=fake' }]) assert.equal((await f.rpc('tools/list', {}, { headers })).status, 401);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Host: 'evil.example' }]) assert.equal((await f.rpc('tools/list', {}, { headers })).status, 403);
  assert.equal((await f.rpc('tools/list', {}, { headers: { 'MCP-Protocol-Version': '1900-01-01' } })).status, 400);
  assert.equal((await f.rpc('tools/list', {}, { headers: { Accept: 'text/plain' } })).status, 406);
  assert.equal((await f.request(undefined, { method: 'GET' })).status, 405);
  assert.equal((await f.rpc('tools/list', {}, { pathname: '/mcp?token=forbidden' })).status, 400);
  assert.equal((await f.request([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])).status, 400);
  const list = await f.rpc('tools/list'); assert.ok(list.data.result.tools.length >= 30); assert.ok(!list.text.includes(TOKEN));
  assert.equal((await f.call('list_campaigns')).error.code, -32602, 'no default account fallback');
  assert.equal((await f.call('list_campaigns', { accountId: '999' })).result.isError, true);
  assert.equal((await f.call('__proto__', { accountId: ACCOUNT })).error.code, -32602);
  assert.equal((await f.call('replace_account_token', { accountId: ACCOUNT, secretRef: 'OTHER_ENV', apiVersion: 'v26.0', accessToken: 'secret' })).error.code, -32602);
  assert.equal((await f.call('replace_account_token', { accountId: ACCOUNT, secretRef: 'PRIMARY', apiVersion: 'v26.0' })).result.content[0].text, 'MCP_SECRET_NOT_STAGED');
  assert.equal((await f.call('configure_assistant', { accountId: ACCOUNT, enabled: true })).result.content[0].text, 'ASSISTANT_NOT_ELIGIBLE');
  const reply = { accountId: ACCOUNT, threadId: 't1', requestId: randomUUID(), text: 'Hello' };
  assert.equal((await f.call('reply_to_conversation', { ...reply, automatic: true })).error.code, -32602);
  await f.request({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'reply_to_conversation', arguments: reply } });
  assert.equal(f.replyCalls, 0, 'notifications must not dispatch sends');
  assert.equal((await f.call('reply_to_conversation', reply)).result.structuredContent.text, 'Hello'); assert.equal(f.replyCalls, 1);
});

test('MCP campaign and publication intent survive retries and uploads require account-bound single-use tickets', async t => {
  const f = await fixture(t);
  const body = { accountId: ACCOUNT, id: randomUUID(), name: 'Example', scope: 'reel', mediaId: '123', messageText: 'Hello https://example.com', keywords: [], publicReplies: [] };
  const first = await f.call('create_campaign', body); assert.equal(first.result.structuredContent.enabled, false);
  assert.deepEqual((await f.call('create_campaign', body)).result, first.result);
  assert.equal((await f.call('create_campaign', { ...body, messageText: 'Changed https://example.com' })).result.content[0].text, 'CAMPAIGN_CONFLICT');
  assert.equal((await f.call('list_campaigns', { accountId: ACCOUNT })).result.structuredContent.total, 1);
  assert.equal((await f.call('list_campaigns', { accountId: OTHER })).result.structuredContent.total, 0);
  assert.equal((await f.call('stop_campaign', { accountId: OTHER, id: body.id })).result.isError, true);
  const originalStart = f.runtimes.get(ACCOUNT).campaigns.start;
  f.runtimes.get(ACCOUNT).campaigns.start = async () => { assert.deepEqual(f.transitions, ['drained']); return { enabled: true }; };
  assert.equal((await f.call('start_campaign', { accountId: ACCOUNT, id: body.id })).result.structuredContent.enabled, true);
  f.runtimes.get(ACCOUNT).campaigns.start = originalStart;
  const groupId = randomUUID(); await f.call('create_publication_group', { accountId: ACCOUNT, id: groupId, name: 'Example group' });
  const job = { accountId: ACCOUNT, id: randomUUID(), groupId, title: 'Example Reel', videoUrl: 'https://media.example/video.mp4', caption: 'Example',
    scheduledAt: new Date(NOW + 3600000).toISOString(), dmText: 'Hello', dmLink: 'https://example.com' };
  const scheduled = await f.call('schedule_reel', job); assert.equal(scheduled.result.isError, undefined, JSON.stringify(scheduled.result)); assert.equal(scheduled.result.structuredContent.state, 'scheduled');
  assert.deepEqual((await f.call('schedule_reel', job)).result, scheduled.result);
  assert.equal((await f.call('schedule_reel', { ...job, dmText: 'Changed' })).result.content[0].text, 'SCHEDULE_CONFLICT');
  assert.equal((await f.call('cancel_publication', { accountId: OTHER, id: job.id })).result.isError, true);
  assert.equal((await f.call('list_publications', { accountId: ACCOUNT })).result.structuredContent.total, 1);
  assert.equal((await f.call('list_publications', { accountId: OTHER })).result.structuredContent.total, 0);
  assert.equal((await f.call('cancel_publication', { accountId: ACCOUNT, id: job.id })).result.structuredContent.state, 'cancelled');
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
  const ticket = (await f.call('prepare_video_upload', { accountId: ACCOUNT })).result.structuredContent;
  const upload = { pathname: new URL(ticket.uploadUrl).pathname, headers: { Authorization: '', 'Content-Type': 'video/mp4', 'Content-Length': bytes.length } };
  assert.equal((await f.request(bytes, { ...upload, pathname: upload.pathname.replace(ACCOUNT, OTHER) })).status, 400);
  assert.equal((await f.request(bytes, { ...upload, headers: { ...upload.headers, Origin: 'https://evil.example' } })).status, 403);
  const uploaded = await f.request(bytes, upload); assert.equal(uploaded.status, 200); assert.equal(uploaded.data.bytes, bytes.length);
  assert.ok(uploaded.data.videoUrl.startsWith(`${ORIGIN}/videos/${ACCOUNT}/`));
  assert.equal((await f.request(bytes, upload)).status, 400, 'ticket cannot be reused');
  const expiring = (await f.call('prepare_video_upload', { accountId: ACCOUNT })).result.structuredContent;
  f.advance(16 * 60000);
  assert.equal((await f.request(bytes, { ...upload, pathname: new URL(expiring.uploadUrl).pathname })).data.error, 'MCP_UPLOAD_TICKET_INVALID');
});

test('MCP is disabled when no separate strong token is configured', async t => {
  const f = await fixture(t, { enabled: false }); assert.equal((await f.rpc('tools/list')).status, 503);
});
