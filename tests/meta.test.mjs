import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MetaError, GraphClient, SendLedger, loadMetaConfig, createMetaClientFromEnv, validateWebhookSignature, verifyWebhookQuery, inspectInstagramToken } from '../integrations/meta.mjs';

const NOW = Date.UTC(2026, 9, 1, 16);
const DAY = 86400000;
const ACCOUNT = '123456';
const COMMENT = '789012';
const RECIPIENT = '345678';
const TOKEN = 'test-only-private-token';
const acceptance = { message_id: 'message-opaque-id', recipient_id: RECIPIENT };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function fixture(fetchImpl = async () => response(acceptance), options = {}) {
  const ledger = options.ledger || new SendLedger({ clock: () => NOW });
  const requests = [];
  const client = new GraphClient({
    accessToken: TOKEN, apiVersion: 'v26.0', accountId: ACCOUNT,
    clock: () => NOW, ledger,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return fetchImpl(url, init); },
    ...options,
  });
  return { client, ledger, requests };
}

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benion-meta-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('webhook verification uses untouched bytes and rejects malformed, missing or altered signatures', () => {
  const body = Buffer.from('{ "texto": "olá", "id": "123" }');
  const signature = `sha256=${createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;
  assert.equal(validateWebhookSignature(body, signature, 'test-app-secret'), true);
  assert.equal(validateWebhookSignature(JSON.stringify(JSON.parse(body)), signature, 'test-app-secret'), false);
  for (const malformed of [undefined, '', 'sha1=abc', 'sha256=abc', `sha256=${'z'.repeat(64)}`, `${signature}extra`]) {
    assert.equal(validateWebhookSignature(body, malformed, 'test-app-secret'), false);
  }
  assert.equal(validateWebhookSignature(body, signature, 'wrong-secret'), false);
  assert.equal(validateWebhookSignature({}, signature, 'test-app-secret'), false);
  assert.throws(() => validateWebhookSignature(body, signature, ''), { code: 'CONFIG_REQUIRED' });
});

test('webhook handshake echoes challenge only for one matching token and subscribe mode', () => {
  const query = new URLSearchParams('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=00123');
  assert.deepEqual(verifyWebhookQuery(query, 'verify-me'), { status: 200, body: '00123' });
  assert.equal(verifyWebhookQuery(query, 'different').status, 403);
  query.append('hub.verify_token', 'verify-me');
  assert.equal(verifyWebhookQuery(query, 'verify-me').status, 403);
  assert.equal(verifyWebhookQuery({ 'hub.mode': 'other', 'hub.verify_token': 'verify-me', 'hub.challenge': '123' }, 'verify-me').status, 403);
  assert.equal(verifyWebhookQuery({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '<script>' }, 'verify-me').status, 403);
  assert.throws(() => verifyWebhookQuery(query, ''), { code: 'CONFIG_REQUIRED' });
});

test('real client configuration fails closed without explicit version, account, secrets and durable ledger', () => {
  assert.throws(() => loadMetaConfig({}), { code: 'CONFIG_REQUIRED' });
  const env = {
    BENION_META_ACCESS_TOKEN: TOKEN, BENION_META_APP_SECRET: 'test-secret',
    BENION_META_VERIFY_TOKEN: 'test-verify', BENION_META_ACCOUNT_ID: ACCOUNT,
    BENION_META_API_VERSION: 'v26.0',
  };
  assert.equal(loadMetaConfig(env).apiVersion, 'v26.0');
  assert.throws(() => loadMetaConfig({ ...env, BENION_META_API_VERSION: 'latest' }), { code: 'INVALID_VERSION' });
  assert.throws(() => loadMetaConfig({ ...env, BENION_META_LEDGER_DIR: 'public/ledger' }), { code: 'INVALID_LEDGER_PATH' });
  assert.throws(() => createMetaClientFromEnv({ env }), { code: 'LEDGER_REQUIRED' });
  assert.ok(createMetaClientFromEnv({ env, ledger: new SendLedger(), fetchImpl: async () => assert.fail('no network') }) instanceof GraphClient);
});

test('constructing a file ledger does not create files or directories', async () => withDirectory(async directory => {
  const target = path.join(directory, 'private-ledger');
  new SendLedger({ directory: target });
  await assert.rejects(access(target), { code: 'ENOENT' });
}));

test('private reply sends documented comment recipient and records acknowledgement without delivery claim', async () => {
  const { client, ledger, requests } = fixture();
  const result = await client.sendPrivateReply(ACCOUNT, COMMENT, 'Aqui está seu link.', { commentCreatedAt: NOW });
  assert.deepEqual(result, { outcome: 'accepted', messageId: acceptance.message_id, recipientId: RECIPIENT });
  assert.equal(requests[0].url.origin, 'https://graph.instagram.com');
  assert.equal(requests[0].url.pathname, `/v26.0/${ACCOUNT}/messages`);
  assert.equal(requests[0].url.searchParams.has('access_token'), false);
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].init.body), { recipient: { comment_id: COMMENT }, message: { text: 'Aqui está seu link.' } });
  assert.equal((await ledger.get(ACCOUNT, 'private', COMMENT)).outcome, 'accepted');
  assert.equal(Object.hasOwn(result, 'delivered'), false);
  assert.equal(JSON.stringify(client).includes(TOKEN), false);
});

test('comment eligibility and account validation block before any reservation or request', async () => {
  const { client, requests, ledger } = fixture();
  for (const createdAt of [undefined, NOW + 1, NOW - 7 * DAY - 1, 'invalid date']) {
    await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: createdAt }), { code: 'PRIVATE_REPLY_WINDOW_CLOSED' });
  }
  await assert.rejects(client.sendPrivateReply('987', COMMENT, 'Link', { commentCreatedAt: NOW }), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(client.sendPrivateReply(ACCOUNT, 'username', 'Link', { commentCreatedAt: NOW }), { code: 'INVALID_ID' });
  assert.equal(requests.length, 0);
  assert.equal(await ledger.get(ACCOUNT, 'private', COMMENT), null);
  assert.equal((await client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW - 7 * DAY })).outcome, 'accepted');
});

test('text limit counts UTF-8 bytes, including accents and emoji, before sending', async () => {
  const { client, requests } = fixture();
  for (const oversized of ['a'.repeat(1001), 'á'.repeat(501), '🙂'.repeat(251)]) {
    await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, oversized, { commentCreatedAt: NOW }), { code: 'INVALID_MESSAGE' });
  }
  assert.equal(requests.length, 0);
  assert.equal((await client.sendPrivateReply(ACCOUNT, COMMENT, '🙂'.repeat(250), { commentCreatedAt: NOW })).outcome, 'accepted');
});

test('sent and concurrent inflight comment duplicates cannot initiate another request', async () => {
  let release;
  const { client, requests } = fixture(() => new Promise(resolve => { release = () => resolve(response(acceptance)); }));
  const first = client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), { code: 'DUPLICATE_SEND', status: 'inflight' });
  release();
  await first;
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), { code: 'DUPLICATE_SEND', status: 'sent' });
  assert.equal(requests.length, 1);
});

test('timeout persists unknown and prevents replay even when transport ignores abort', async () => {
  const { client, ledger, requests } = fixture(() => new Promise(() => {}), { timeoutMs: 8 });
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), { code: 'NETWORK_TIMEOUT', outcome: 'unknown' });
  assert.equal((await ledger.get(ACCOUNT, 'private', COMMENT)).status, 'unknown');
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), { code: 'DUPLICATE_SEND', status: 'unknown' });
  assert.equal(requests.length, 1);
});

test('network errors are redacted and unknown; no credentials leak through error causes', async () => {
  const { client, ledger } = fixture(async () => { throw new Error(`transport failed: ${TOKEN}`); });
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), error => {
    assert.ok(error instanceof MetaError);
    assert.equal(error.outcome, 'unknown');
    assert.equal(String(error).includes(TOKEN), false);
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal((await ledger.get(ACCOUNT, 'private', COMMENT)).status, 'unknown');
});

test('HTTP 200 without both IDs is unknown instead of successful, and blocks public reply', async () => {
  for (const result of [{ success: true }, { message_id: 'message' }, { recipient_id: RECIPIENT }, { message_id: '', recipient_id: RECIPIENT }]) {
    const { client, ledger, requests } = fixture(async () => response(result));
    await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), { code: 'INVALID_GRAPH_RESPONSE', outcome: 'unknown' });
    assert.equal((await ledger.get(ACCOUNT, 'private', COMMENT)).status, 'unknown');
    await assert.rejects(client.sendPublicReply(ACCOUNT, COMMENT, 'Enviei.'), { code: 'PRIVATE_ACCEPTANCE_REQUIRED' });
    assert.equal(requests.length, 1);
  }
});

test('Graph rejections expose safe codes, never provider error message, and are not retried', async () => {
  const { client, ledger, requests } = fixture(async () => response({ error: {
    message: `secret detail ${TOKEN}`, code: 190, error_subcode: 463, is_transient: false,
  } }, 400));
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), error => {
    assert.equal(error.code, 'GRAPH_REJECTED');
    assert.equal(error.outcome, 'rejected');
    assert.equal(error.graphCode, 190);
    assert.equal(error.graphSubcode, 463);
    assert.equal(error.isTransient, false);
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    return true;
  });
  assert.equal((await ledger.get(ACCOUNT, 'private', COMMENT)).status, 'rejected');
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), { code: 'DUPLICATE_SEND' });
  assert.equal(requests.length, 1);
});

test('server errors and invalid JSON remain unknown', async () => {
  for (const fetchImpl of [
    async () => response({ error: { code: 2, is_transient: true } }, 500),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(TOKEN); } }),
  ]) {
    const { client, ledger } = fixture(fetchImpl);
    await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), { outcome: 'unknown' });
    assert.equal((await ledger.get(ACCOUNT, 'private', COMMENT)).status, 'unknown');
  }
});

test('bounded comment pagination follows local cursors and never provider next URL', async () => {
  const seen = [];
  const { client } = fixture(async url => {
    seen.push(url);
    return response({ data: [{ id: String(100 + seen.length), text: 'quero', timestamp: new Date(NOW).toISOString(), username: 'teste' }],
      paging: { next: `https://unsafe.invalid/?access_token=${TOKEN}`, cursors: { after: `cursor-${seen.length}` } } });
  });
  const result = await client.listComments('2468', { maxPages: 2, pageSize: 1 });
  assert.equal(result.comments.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.nextCursor, 'cursor-2');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].searchParams.get('after'), 'cursor-1');
  assert.equal(seen.every(url => url.origin === 'https://graph.instagram.com'), true);
  assert.equal(seen.every(url => !url.searchParams.has('access_token')), true);
});

test('comment pagination deduplicates IDs and stops on absent next; malformed pagination fails closed', async () => {
  const { client } = fixture(async () => response({ data: [
    { id: COMMENT, text: 'quero', timestamp: new Date(NOW).toISOString() },
    { id: COMMENT, text: 'quero', timestamp: new Date(NOW).toISOString() },
  ] }));
  assert.equal((await client.listComments('2468')).comments.length, 1);
  const malformed = fixture(async () => response({ data: [], paging: { next: 'https://graph.instagram.com/next' } }));
  await assert.rejects(malformed.client.listComments('2468'), { code: 'INVALID_PAGINATION' });
  const repeated = fixture(async () => response({ data: [], paging: { next: 'next', cursors: { after: 'same-cursor' } } }));
  await assert.rejects(repeated.client.listComments('2468'), { code: 'INVALID_PAGINATION' });
  assert.equal(repeated.requests.length, 2);
});

test('comment author ID is exposed only when numeric, without unrequested author fields', async () => {
  const { client } = fixture(async () => response({ data: [
    { id: COMMENT, text: 'quero', timestamp: new Date(NOW).toISOString(), from: { id: '123987', username: 'publico', access_token: TOKEN } },
    { id: '987', text: 'quero', timestamp: new Date(NOW).toISOString(), from: { id: TOKEN, username: 'outro' } },
  ] }));
  const result = await client.listComments('2468');
  assert.equal(result.comments[0].fromId, '123987');
  assert.equal(result.comments[0].fromUsername, 'publico');
  assert.equal(Object.hasOwn(result.comments[1], 'fromId'), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('canonical comments with omitted text retain ID, timestamp and author without inventing text', async () => {
  const { client } = fixture(async () => response({ data: [
    { id: '101', timestamp: new Date(NOW).toISOString(), from: { id: RECIPIENT } },
    { id: '102', text: null, timestamp: new Date(NOW).toISOString(), username: 'pessoa' },
  ] }));
  const result = await client.listComments(COMMENT);
  assert.equal(result.truncated, false);
  assert.equal(result.comments.length, 2);
  assert.equal(result.comments[0].fromId, RECIPIENT);
  assert.ok(result.comments.every(row => !Object.hasOwn(row, 'text')));
  for (const bad of [{ text: {} }, { timestamp: 'not-a-date' }]) {
    const invalid = fixture(async () => response({ data: [{ id: '103', timestamp: new Date(NOW).toISOString(), ...bad }] }));
    await assert.rejects(invalid.client.listComments(COMMENT), { code: 'INVALID_GRAPH_RESPONSE' });
  }
});

test('media lookup is bounded, uses configured account and cursors, and returns only public metadata', async () => {
  const { client, requests } = fixture(async (_url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    const current = requests.length;
    return response({ data: [{ id: String(1000 + current), shortcode: `Reel_${current}`,
      permalink: `https://www.instagram.com/reel/Reel_${current}/?tracking=discard#discard`,
      caption: 'unrequested content', access_token: TOKEN,
    }], paging: { next: `https://unsafe.invalid/?access_token=${TOKEN}`, cursors: { after: `cursor-${current}` } } });
  });
  const result = await client.listMedia(ACCOUNT, { maxPages: 2, pageSize: 1 });
  assert.deepEqual(result, {
    media: [
      { id: '1001', shortcode: 'Reel_1', permalink: 'https://www.instagram.com/reel/Reel_1/' },
      { id: '1002', shortcode: 'Reel_2', permalink: 'https://www.instagram.com/reel/Reel_2/' },
    ], pages: 2, truncated: true, nextCursor: 'cursor-2',
  });
  assert.equal(requests.length, 2);
  assert.equal(requests.every(({url}) => url.origin === 'https://graph.instagram.com' && url.pathname === `/v26.0/${ACCOUNT}/media` && !url.searchParams.has('access_token')), true);
  assert.equal(requests[0].url.searchParams.get('fields'), 'id,permalink,shortcode,comments_count');
  assert.equal(requests[1].url.searchParams.get('after'), 'cursor-1');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('media lookup deduplicates IDs and rejects malformed media or cyclic pagination', async () => {
  const valid = { id: '1001', shortcode: 'EXAMPLEREEL1', permalink: 'https://www.instagram.com/p/EXAMPLEREEL1/' };
  const { client } = fixture(async () => response({ data: [valid, valid] }));
  assert.equal((await client.listMedia(ACCOUNT)).media.length, 1);
  for (const data of [
    { data: {} }, { data: [null] },
    { data: [{ ...valid, id: 'not-a-Graph-id' }] },
    { data: [{ ...valid, permalink: 'https://unsafe.invalid/reel/EXAMPLEREEL1/' }] },
    { data: [{ ...valid, permalink: 'http://www.instagram.com/p/EXAMPLEREEL1/' }] },
    { data: [{ ...valid, shortcode: 'different' }] },
    { data: [{ ...valid, permalink: 'not a URL' }] },
  ]) {
    const malformed = fixture(async () => response(data));
    await assert.rejects(malformed.client.listMedia(ACCOUNT), { code: 'INVALID_GRAPH_RESPONSE', outcome: 'none' });
  }
  const repeated = fixture(async () => response({ data: [], paging: { next: 'next', cursors: { after: 'same' } } }));
  await assert.rejects(repeated.client.listMedia(ACCOUNT), { code: 'INVALID_PAGINATION' });
  assert.equal(repeated.requests.length, 2);
});

test('media comment counts remain explicit and malformed counts fail closed', async () => {
  const media = { id: '1001', shortcode: 'Reel_1', permalink: 'https://www.instagram.com/reel/Reel_1/' };
  const counted = fixture(async () => response({ data: [{ ...media, comments_count: 12, access_token: TOKEN }] }));
  assert.deepEqual((await counted.client.listMedia(ACCOUNT)).media, [{ ...media, commentsCount: 12 }]);
  const absent = fixture(async () => response({ data: [media] }));
  assert.equal(Object.hasOwn((await absent.client.listMedia(ACCOUNT)).media[0], 'commentsCount'), false);
  for (const comments_count of [-1, 0.5, '12', null, Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = fixture(async () => response({ data: [{ ...media, comments_count }] }));
    await assert.rejects(malformed.client.listMedia(ACCOUNT), { code: 'INVALID_GRAPH_RESPONSE', outcome: 'none' });
  }
});

test('media and conversation diagnostics reject different accounts and invalid bounds before requests', async () => {
  const { client, requests } = fixture();
  await assert.rejects(client.listMedia('987'), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(client.listConversations('987'), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(client.listMedia(ACCOUNT, { maxPages: 101 }), { code: 'INVALID_PAGINATION' });
  await assert.rejects(client.listMedia(ACCOUNT, { pageSize: 51 }), { code: 'INVALID_PAGINATION' });
  await assert.rejects(client.listConversations(ACCOUNT, { pageSize: 2 }), { code: 'INVALID_PAGINATION' });
  assert.equal(requests.length, 0);
});

test('conversation diagnostic samples one ID with read-only transport and strips message/provider extras', async () => {
  const { client, requests } = fixture(async (_url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    return response({ data: [{ id: 'aWdfZAGM6-opaque', messages: [{ message: 'not requested' }], access_token: TOKEN }],
      paging: { next: 'https://unsafe.invalid/next' } });
  });
  const result = await client.listConversations(ACCOUNT);
  assert.deepEqual(result, { conversationIds: ['aWdfZAGM6-opaque'], count: 1, truncated: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, `/v26.0/${ACCOUNT}/conversations`);
  assert.equal(requests[0].url.searchParams.get('platform'), 'instagram');
  assert.equal(requests[0].url.searchParams.get('fields'), 'id');
  assert.equal(requests[0].url.searchParams.get('limit'), '1');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(Object.hasOwn(result, 'delivered'), false);
  assert.equal(Object.hasOwn(result, 'messages'), false);
});

test('empty conversation sample is valid, but malformed or oversized samples fail closed', async () => {
  const empty = fixture(async () => response({ data: [] }));
  assert.deepEqual(await empty.client.listConversations(ACCOUNT), { conversationIds: [], count: 0, truncated: false });
  for (const data of [
    {}, { data: {} }, { data: [null] }, { data: [{ id: '' }] }, { data: [{ id: 'line\nbreak' }] },
    { data: [{ id: 'one' }, { id: 'two' }] }, { data: [], paging: { next: {} } },
  ]) {
    const malformed = fixture(async () => response(data));
    await assert.rejects(malformed.client.listConversations(ACCOUNT), { code: 'INVALID_GRAPH_RESPONSE', outcome: 'none' });
  }
});

test('continuation requires a recent inbound event, stable key and text-only payload', async () => {
  const { client, requests } = fixture();
  for (const lastInboundAt of [undefined, NOW + 1, NOW - DAY, NOW - DAY - 1]) {
    await assert.rejects(client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Mais detalhes.' }, { lastInboundAt, idempotencyKey: 'inbound-1' }), { code: 'CONTINUATION_WINDOW_CLOSED' });
  }
  await assert.rejects(client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes', recipient: { id: '987' } }, { lastInboundAt: NOW, idempotencyKey: 'inbound-1' }), { code: 'INVALID_MESSAGE' });
  await assert.rejects(client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes' }, { lastInboundAt: NOW }), { code: 'INVALID_LEDGER_KEY' });
  assert.equal(requests.length, 0);
  assert.equal((await client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes' }, { lastInboundAt: NOW - DAY + 1, idempotencyKey: 'inbound-1' })).outcome, 'accepted');
  assert.deepEqual(JSON.parse(requests[0].init.body).recipient, { id: RECIPIENT });
  await assert.rejects(client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes' }, { lastInboundAt: NOW, idempotencyKey: 'inbound-1' }), { code: 'DUPLICATE_SEND' });
});

test('continuation recipient mismatch is persisted as unknown', async () => {
  const { client, ledger } = fixture(async () => response({ ...acceptance, recipient_id: '999' }));
  await assert.rejects(client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes' }, { lastInboundAt: NOW, idempotencyKey: 'inbound-1' }), { code: 'INVALID_GRAPH_RESPONSE', outcome: 'unknown' });
  assert.equal((await ledger.get(ACCOUNT, 'continuation', 'inbound-1')).status, 'unknown');
});

test('comment campaign pause during durable reservation blocks the private POST and replay', async () => withDirectory(async directory => {
  let running = true;
  class PausingLedger extends SendLedger {
    async reserve(...args) { const reservation = await super.reserve(...args); running = false; return reservation; }
  }
  const { client, ledger, requests } = fixture(undefined, { ledger: new PausingLedger({ directory, clock: () => NOW }) });
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'https://example.com/trial', {
    commentCreatedAt: NOW, beforeSend: () => { if (!running) throw new Error('campaign paused'); },
  }), { code: 'SEND_GATE_CHANGED', outcome: 'rejected' });
  assert.equal(requests.length, 0);
  assert.equal((await ledger.get(ACCOUNT, 'private', COMMENT)).status, 'rejected');
  const restarted = fixture(undefined, { ledger: new SendLedger({ directory, clock: () => NOW }) });
  await assert.rejects(restarted.client.sendPrivateReply(ACCOUNT, COMMENT, 'https://example.com/trial', { commentCreatedAt: NOW }), { code: 'DUPLICATE_SEND', status: 'rejected' });
  assert.equal(restarted.requests.length, 0);
}));

test('continuation preflight runs after reservation and before the only POST', async () => {
  const { client, ledger, requests } = fixture();
  let checks = 0;
  await client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes' }, {
    lastInboundAt: NOW, idempotencyKey: 'preflight-accepted', beforeSend: async () => {
      checks++;
      assert.equal((await ledger.get(ACCOUNT, 'continuation', 'preflight-accepted')).status, 'inflight');
      assert.equal(requests.length, 0);
    },
  });
  assert.equal(checks, 1); assert.equal(requests.length, 1);
  assert.equal((await ledger.get(ACCOUNT, 'continuation', 'preflight-accepted')).status, 'sent');
  await assert.rejects(client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes' }, {
    lastInboundAt: NOW, idempotencyKey: 'invalid-preflight', beforeSend: true,
  }), { code: 'INVALID_SEND_PREFLIGHT' });
  assert.equal(await ledger.get(ACCOUNT, 'continuation', 'invalid-preflight'), null);
});

test('handoff during durable reservation rejects before POST and remains deduplicated after restart', async () => withDirectory(async directory => {
  let automaticEnabled = true; let checks = 0;
  class HandoffLedger extends SendLedger {
    async reserve(...args) {
      const reservation = await super.reserve(...args);
      automaticEnabled = false;
      return reservation;
    }
  }
  const ledger = new HandoffLedger({ directory, clock: () => NOW });
  const { client, requests } = fixture(undefined, { ledger });
  await assert.rejects(client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes' }, {
    lastInboundAt: NOW, idempotencyKey: 'preflight-cancelled', beforeSend: async () => {
      checks++;
      assert.equal((await ledger.get(ACCOUNT, 'continuation', 'preflight-cancelled')).status, 'inflight');
      if (!automaticEnabled) throw new Error(`private gate detail ${TOKEN}`);
    },
  }), error => {
    assert.equal(error.code, 'SEND_GATE_CHANGED'); assert.equal(error.outcome, 'rejected');
    assert.doesNotMatch(String(error) + JSON.stringify(error), /test-only-private-token|private gate detail/);
    return true;
  });
  assert.equal(checks, 1); assert.equal(requests.length, 0);
  const record = await ledger.get(ACCOUNT, 'continuation', 'preflight-cancelled');
  assert.equal(record.status, 'rejected'); assert.equal(record.outcome, 'rejected'); assert.equal(record.errorCode, 'SEND_GATE_CHANGED');
  const restarted = fixture(undefined, { ledger: new SendLedger({ directory, clock: () => NOW }) });
  await assert.rejects(restarted.client.sendContinuation(ACCOUNT, RECIPIENT, { text: 'Detalhes' }, {
    lastInboundAt: NOW, idempotencyKey: 'preflight-cancelled',
  }), { code: 'DUPLICATE_SEND', status: 'rejected' });
  assert.equal(restarted.requests.length, 0);
}));

test('public reply pause during durable reservation prevents POST while preserving the accepted private DM', async () => withDirectory(async directory => {
  let running = true;
  class PausingPublicLedger extends SendLedger {
    async reserve(...args) { const reservation = await super.reserve(...args); if (args[1] === 'public') running = false; return reservation; }
  }
  const { client, ledger, requests } = fixture(undefined, { ledger: new PausingPublicLedger({ directory, clock: () => NOW }) });
  await client.sendPrivateReply(ACCOUNT, COMMENT, 'https://example.com/trial', { commentCreatedAt: NOW });
  await assert.rejects(client.sendPublicReply(ACCOUNT, COMMENT, 'Enviei o link na sua dm 🎈', {
    beforeSend: () => { if (!running) throw new Error('campaign paused'); },
  }), { code: 'SEND_GATE_CHANGED', outcome: 'rejected' });
  assert.equal(requests.length, 1);
  assert.equal((await ledger.get(ACCOUNT, 'private', COMMENT)).status, 'sent');
  assert.equal((await ledger.get(ACCOUNT, 'public', COMMENT)).status, 'rejected');
  const restarted = fixture(undefined, { ledger: new SendLedger({ directory, clock: () => NOW }) });
  await assert.rejects(restarted.client.sendPublicReply(ACCOUNT, COMMENT, 'Enviei o link na sua dm 🎈'), { code: 'DUPLICATE_SEND', status: 'rejected' });
  assert.equal(restarted.requests.length, 0);
}));

test('public comment reply is sent only after recorded private acceptance and is deduplicated', async () => {
  const { client, requests } = fixture(async url => response(url.pathname.endsWith('/replies') ? { id: '567890' } : acceptance));
  await assert.rejects(client.sendPublicReply(ACCOUNT, COMMENT, 'Enviei no Direct.'), { code: 'PRIVATE_ACCEPTANCE_REQUIRED' });
  assert.equal(requests.length, 0);
  await client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW });
  assert.deepEqual(await client.sendPublicReply(ACCOUNT, COMMENT, 'Enviei no Direct.'), { outcome: 'accepted', commentReplyId: '567890' });
  assert.equal(requests[1].url.pathname, `/v26.0/${COMMENT}/replies`);
  assert.deepEqual(JSON.parse(requests[1].init.body), { message: 'Enviei no Direct.' });
  await assert.rejects(client.sendPublicReply(ACCOUNT, COMMENT, 'Enviei.'), { code: 'DUPLICATE_SEND' });
});

test('durable reservation survives restart, blocks two ledger instances, and stores no tokens', async () => withDirectory(async directory => {
  const first = new SendLedger({ directory, clock: () => NOW });
  const second = new SendLedger({ directory, clock: () => NOW });
  const results = await Promise.allSettled([first.reserve(ACCOUNT, 'private', COMMENT), second.reserve(ACCOUNT, 'private', COMMENT)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'DUPLICATE_SEND');
  const restarted = new SendLedger({ directory });
  await assert.rejects(restarted.reserve(ACCOUNT, 'private', COMMENT), { code: 'DUPLICATE_SEND', status: 'inflight' });
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.equal((await readFile(path.join(directory, files[0]), 'utf8')).includes(TOKEN), false);
}));

test('manual recovery migration blocks canonical sent/unknown comment IDs without inventing API proof', async () => withDirectory(async directory => {
  const ledger = new SendLedger({ directory, clock: () => NOW });
  const imported = await ledger.importHandledComments(ACCOUNT, [
    { commentId: COMMENT, status: 'sent', source: 'manual_recovery_verified' },
    { commentId: '2222', status: 'unknown', source: 'manual_recovery_uncertain' },
  ]);
  assert.equal(imported.length, 2);
  assert.equal((await ledger.importHandledComments(ACCOUNT, [{ commentId: COMMENT, status: 'sent', source: 'same_record' }])).length, 0);
  const { client, requests } = fixture(undefined, { ledger: new SendLedger({ directory }) });
  await assert.rejects(client.sendPrivateReply(ACCOUNT, COMMENT, 'Link', { commentCreatedAt: NOW }), { code: 'DUPLICATE_SEND', status: 'sent' });
  await assert.rejects(client.sendPrivateReply(ACCOUNT, '2222', 'Link', { commentCreatedAt: NOW }), { code: 'DUPLICATE_SEND', status: 'unknown' });
  await assert.rejects(client.sendPublicReply(ACCOUNT, COMMENT, 'Enviei.'), { code: 'PRIVATE_ACCEPTANCE_REQUIRED' });
  assert.equal(requests.length, 0);
  await assert.rejects(ledger.importHandledComments(ACCOUNT, [{ commentId: 'username', status: 'sent', source: 'recovery' }]), { code: 'INVALID_ID' });
}));

test('token inspection requests only public identity using a server-only header and returns no provider extras', async () => {
  const inspected = await inspectInstagramToken({ accessToken: TOKEN, apiVersion: 'v26.0', fetchImpl: async (url, init) => {
    assert.equal(url.origin, 'https://graph.instagram.com');
    assert.equal(url.pathname, '/v26.0/me');
    assert.equal(url.searchParams.get('fields'), 'user_id,username,id');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    return response({ user_id: '17841400000000100', username: 'example.owner', id: '1020123456', access_token: TOKEN,
      permissions: 'instagram_business_manage_messages' });
  } });
  assert.deepEqual(inspected, {
    userId: '17841400000000100', username: 'example.owner', id: '1020123456',
    permissions: null, permissionsVerified: false,
  });
  assert.equal(JSON.stringify(inspected).includes(TOKEN), false);
  assert.notEqual(inspected.userId, inspected.id);
});

test('token inspection accepts the official single data wrapper without inventing app-scoped ID', async () => {
  const inspected = await inspectInstagramToken({ accessToken: TOKEN, apiVersion: 'v26.0', fetchImpl: async () => response({ data: [
    { user_id: ACCOUNT, username: 'teste' },
  ] }) });
  assert.equal(inspected.userId, ACCOUNT);
  assert.equal(inspected.id, null);
  assert.equal(inspected.permissionsVerified, false);
});

test('token inspection rejects missing canonical identity and ambiguous wrappers', async () => {
  for (const data of [
    { id: ACCOUNT, username: 'teste' },
    { user_id: 123, username: 'teste' },
    { user_id: ACCOUNT, username: '@teste' },
    { user_id: ACCOUNT, username: 'teste', id: 'invalid' },
    { data: [] },
    { data: [{ user_id: ACCOUNT, username: 'teste' }, { user_id: '123', username: 'outro' }] },
    { data: [{ user_id: ACCOUNT, username: 'teste' }], user_id: '123' },
  ]) {
    await assert.rejects(inspectInstagramToken({ accessToken: TOKEN, apiVersion: 'v26.0', fetchImpl: async () => response(data) }), { code: 'IDENTITY_RESPONSE_INVALID' });
  }
});

test('token inspection sanitizes Graph/transport/JSON errors without retrying', async () => {
  let calls = 0;
  for (const fetchImpl of [
    async () => { throw new Error(`failed with ${TOKEN}`); },
    async () => response({ error: { code: 190, message: TOKEN } }, 400),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(TOKEN); } }),
  ]) {
    await assert.rejects(inspectInstagramToken({ accessToken: TOKEN, apiVersion: 'v26.0', fetchImpl: async (...args) => {
      calls++; return fetchImpl(...args);
    } }), error => {
      assert.ok(error instanceof MetaError);
      assert.equal(error.outcome, 'none');
      assert.equal(String(error).includes(TOKEN), false);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(calls, 3);
});

test('token inspection timeout is bounded even when transport ignores abort', async () => {
  await assert.rejects(inspectInstagramToken({ accessToken: TOKEN, apiVersion: 'v26.0', timeoutMs: 8,
    fetchImpl: () => new Promise(() => {}),
  }), { code: 'NETWORK_TIMEOUT', outcome: 'none' });
});

test('token inspection validates configuration before making a request', async () => {
  const fetchImpl = async () => assert.fail('configuration failure must not call API');
  await assert.rejects(inspectInstagramToken({ accessToken: '', apiVersion: 'v26.0', fetchImpl }), { code: 'CONFIG_REQUIRED' });
  await assert.rejects(inspectInstagramToken({ accessToken: TOKEN, apiVersion: 'latest', fetchImpl }), { code: 'INVALID_VERSION' });
  await assert.rejects(inspectInstagramToken({ accessToken: TOKEN, apiVersion: 'v26.0', timeoutMs: -1, fetchImpl }), { code: 'INVALID_CLIENT_CONFIG' });
});
