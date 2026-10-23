import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { ConnectionService, createConnectionHandler } from '../connection.mjs';
import { inspectInstagramToken } from '../integrations/meta.mjs';

const FAKE_TOKEN = 'test-only-access-token-for-connection';
const USER_ID = '17841400000000100';
const USERNAME = 'example.owner';
const goodIdentity = { userId: USER_ID, username: USERNAME, id: 'different-app-scoped-id', permissions: null, permissionsVerified: false, extraSecret: FAKE_TOKEN };
const body = { accessToken: FAKE_TOKEN, apiVersion: 'v26.0' };
const IDENTITY = { expectedUsername: USERNAME, expectedUserId: USER_ID };
const recoveryRows = () => Array.from({ length: 11 }, (_, index) => ({ commentId: String(1000 + index), username: `person_${index}`, text: 'quero', status: 'sent', note: 'manual' }));
const LEGACY = { reelUrl: 'https://www.instagram.com/reel/EXAMPLEREEL1/', shortcode: 'EXAMPLEREEL1', mediaId: '2468', protectedCount: 11,
  requiredLinks: ['https://example.com/app', 'https://example.com/credits'],
  recovery: { schemaVersion: 1, account: USERNAME, reel: 'https://www.instagram.com/reel/EXAMPLEREEL1/', comments: recoveryRows(), excludedReplies: [{ commentId: '2000', username: 'person_0' }, { commentId: '2001', username: 'discussion_only' }] } };
const RECOVERY_SOURCE = structuredClone(LEGACY.recovery);

async function fixture(run, inspectToken = async () => goodIdentity, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benion-connection-test-'));
  const servedRoot = path.join(directory, 'served');
  const privateDirectory = path.join(directory, 'private');
  await mkdir(servedRoot);
  const service = new ConnectionService({ privateDirectory, servedRoot, inspectToken, ...IDENTITY, legacy: LEGACY, fetchImpl: options.fetchImpl || (async () => assert.fail('Unexpected Graph call')), clock: options.clock || (() => Date.UTC(2026, 9, 1, 20)) });
  try { await run({ service, privateDirectory, servedRoot }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function httpFixture(run, options = {}) {
  await fixture(async ({ service, privateDirectory, servedRoot }) => {
    let handler;
    const server = http.createServer((request, response) => handler(request, response));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    handler = createConnectionHandler({ service, origin, clock: options.clock || Date.now });
    try { await run({ service, privateDirectory, servedRoot, origin }); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }, options.inspectToken, options);
}
async function csrf(origin, extraHeaders = {}) {
  const response = await fetch(`${origin}/api/connection/csrf`, { headers: { Origin: origin, 'X-Benion-Request': '1', ...extraHeaders } });
  const data = await response.json();
  return { response, nonce: data.nonce, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function post(origin, csrfData, extra = {}) {
  return fetch(`${origin}${extra.endpoint || '/api/connection'}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Benion-Request': '1', 'X-Benion-CSRF': csrfData.nonce, Cookie: csrfData.cookie, ...extra.headers },
    body: extra.body ?? JSON.stringify(body),
  });
}
async function rawGet(origin, endpoint, headers) {
  return new Promise((resolve, reject) => {
    http.get(new URL(endpoint, origin), { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

test('no files are created before identity validation; successful secret storage is private and outside served root', async () => fixture(async ({ service, privateDirectory }) => {
  await assert.rejects(access(privateDirectory), { code: 'ENOENT' });
  assert.deepEqual(service.status(), { connected: false, identity: null, checkedAt: null, permissionsVerified: false });
  const result = await service.connect(body);
  assert.equal(result.connected, true);
  assert.deepEqual(result.identity, { userId: USER_ID, username: USERNAME });
  assert.equal(result.permissionsVerified, false);
  assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  assert.equal(JSON.stringify(service).includes(FAKE_TOKEN), false);
  const filename = path.join(privateDirectory, 'connection.json');
  const stored = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(stored.accessToken, FAKE_TOKEN);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(privateDirectory, 'ledger'))).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(privateDirectory)).sort(), ['connection.json', 'ledger']);
}));

test('wrong canonical ID and wrong username fail before creating token or ledger directories', async () => {
  for (const identity of [{ ...goodIdentity, userId: '123' }, { ...goodIdentity, username: 'another_account' }]) {
    await fixture(async ({ service, privateDirectory }) => {
      await assert.rejects(service.connect(body), { code: 'WRONG_ACCOUNT' });
      await assert.rejects(access(privateDirectory), { code: 'ENOENT' });
      assert.equal(service.status().connected, false);
    }, async () => identity);
  }
});

function readMock({ changeComments = comments => comments, deny = null, mediaMissing = false, truncatedComments = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.method, 'GET', 'No Meta mutation is allowed in access verification');
    assert.equal(url.origin, 'https://graph.instagram.com');
    if (deny && url.pathname.endsWith(`/${deny}`)) return { ok: false, status: 403, json: async () => ({ error: { code: 10, message: `provider-secret ${FAKE_TOKEN}` } }) };
    let data;
    if (url.pathname.endsWith('/media')) data = mediaMissing ? [] : [{ id: '2468', shortcode: 'EXAMPLEREEL1', permalink: 'https://www.instagram.com/reel/EXAMPLEREEL1/', access_token: FAKE_TOKEN }];
    else if (url.pathname.endsWith('/comments')) data = changeComments([
      ...recoveryRows().map(row => ({ id: row.commentId, username: row.username, text: 'quero', timestamp: '2026-10-01T16:00:00.000Z' })),
      { id: '2000', username: 'person_0', parent_id: '1000', text: 'reply', timestamp: '2026-10-01T16:00:00.000Z' },
      { id: '2001', username: 'discussion_only', parent_id: '1000', text: 'reply', timestamp: '2026-10-01T16:00:00.000Z' },
    ]);
    else if (url.pathname.endsWith('/conversations')) {
      assert.equal(url.searchParams.get('fields'), 'id');
      assert.equal(url.searchParams.get('limit'), '1');
      data = [{ id: 'conversation_1', messages: { data: [{ text: 'not requested secret message' }] } }];
    } else assert.fail(`Unexpected API edge: ${url.pathname}`);
    const paging = truncatedComments && url.pathname.endsWith('/comments') ? { next: 'https://graph.instagram.com/next', cursors: { after: `page-${requests.filter(request => request.url.pathname.endsWith('/comments')).length}` } } : undefined;
    return { ok: true, status: 200, json: async () => ({ data, ...(paging ? { paging } : {}) }) };
  };
  return { requests, fetchImpl };
}

test('explicit preflight confirms owned reel and protects the 11 canonical manual sends without Meta writes', async () => {
  const mock = readMock();
  let identityCalls = 0;
  await fixture(async ({ service, privateDirectory, servedRoot }) => {
    await service.connect(body);
    const status = await service.verifyAccess();
    assert.equal(identityCalls, 2, 'Identity must be revalidated before reading account edges');
    assert.equal(status.capabilities.diagnosticComplete, true);
    assert.deepEqual(status.capabilities.recovery, { expected: 11, matched: 11, protected: 11, blocked: 0, excluded: 2, unmatched: 0 });
    assert.equal(status.capabilities.futureOnlyReady, true);
    assert.equal(Object.values(status.capabilities.reads).every(read => read.status === 'accepted'), true);
    assert.equal(JSON.stringify(status).includes(FAKE_TOKEN), false);
    assert.equal(JSON.stringify(status).includes('not requested secret message'), false);
    assert.equal(Object.hasOwn(status, 'canSend'), false);
    assert.equal(mock.requests.every(request => request.init.method === 'GET'), true);
    const ledger = await readdir(path.join(privateDirectory, 'ledger'));
    assert.equal(ledger.length, 11);
    for (const file of ledger) {
      const record = JSON.parse(await readFile(path.join(privateDirectory, 'ledger', file), 'utf8'));
      assert.equal(record.outcome, 'external_handled');
      assert.equal(record.status, 'sent');
      assert.equal(['2000', '2001'].includes(record.key), false);
    }
    const capabilitiesFile = path.join(privateDirectory, 'capabilities.json');
    assert.equal((await stat(capabilitiesFile)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(capabilitiesFile, 'utf8'));
    assert.equal(persisted.mediaId, '2468');
    assert.equal(JSON.stringify(persisted).includes(FAKE_TOKEN), false);
    assert.equal(persisted.reconciliation.every(item => item.state === 'external_handled'), true);
    assert.deepEqual(LEGACY.recovery, RECOVERY_SOURCE, 'verification never mutates the private recovery record');
    await service.verifyAccess();
    assert.equal((await readdir(path.join(privateDirectory, 'ledger'))).length, 11, 'Repeat diagnostic must not duplicate private protection');
  }, async () => { identityCalls++; return goodIdentity; }, mock);
});

test('manual IDs stay protected while mismatched API rows never supply speculative author identities', async () => {
  const mock = readMock({ changeComments: comments => comments.map(comment => {
    if (comment.id === '1000') return { ...comment, id: '9999', from: { id: '7777', username: comment.username } };
    if (comment.id === '1001') return { ...comment, username: 'different_person' };
    if (comment.id === '1002') return { ...comment, parent_id: '8888' };
    if (comment.id === '1003') return { ...comment, from: { username: 'contradiction' } };
    if (comment.id === '1004') { const { username, ...rest } = comment; return { ...rest, from: { username } }; }
    return comment;
  }) });
  await fixture(async ({ service, privateDirectory, servedRoot }) => {
    await service.connect(body);
    const status = await service.verifyAccess();
    assert.equal(status.capabilities.diagnosticComplete, false);
    assert.equal(status.capabilities.recovery.matched, 7);
    assert.equal(status.capabilities.recovery.protected, 11);
    assert.equal(status.capabilities.recovery.blocked, 0);
    assert.equal(status.capabilities.recovery.unmatched, 4);
    const persisted = JSON.parse(await readFile(path.join(privateDirectory, 'capabilities.json'), 'utf8'));
    assert.equal(persisted.reconciliation.filter(item => item.state === 'blocked').length, 4);
    assert.equal(persisted.reconciliation.find(item => item.commentId === '1000').fromId, undefined);
    const ledger = await Promise.all((await readdir(path.join(privateDirectory, 'ledger'))).map(async file => JSON.parse(await readFile(path.join(privateDirectory, 'ledger', file), 'utf8'))));
    assert.equal(ledger.length, 11);
    assert.equal(ledger.some(item => item.key === '9999'), false);
    assert.equal(ledger.every(item => item.outcome === 'external_handled' && !item.messageId && !item.recipientId), true);
  }, async () => goodIdentity, mock);
});

test('denied conversation read is a sanitized partial diagnostic and does not prevent protecting matching comments', async () => {
  const mock = readMock({ deny: 'conversations' });
  await fixture(async ({ service, servedRoot }) => {
    await service.connect(body);
    const status = await service.verifyAccess();
    assert.equal(status.capabilities.diagnosticComplete, false);
    assert.equal(status.capabilities.reads.conversations.status, 'blocked');
    assert.equal(status.capabilities.reads.conversations.graphCode, 10);
    assert.equal(status.capabilities.reads.conversations.httpStatus, 403);
    assert.equal(status.capabilities.recovery.protected, 11);
    assert.equal(JSON.stringify(status).includes(FAKE_TOKEN), false);
    assert.equal(JSON.stringify(status).includes('provider-secret'), false);
  }, async () => goodIdentity, mock);
});

test('missing owned reel blocks reconciliation and prevents any comment lookup or import', async () => {
  const mock = readMock({ mediaMissing: true });
  await fixture(async ({ service, servedRoot, privateDirectory }) => {
    await service.connect(body);
    const status = await service.verifyAccess();
    assert.equal(status.capabilities.reads.comments.status, 'not_checked');
    assert.equal(status.capabilities.recovery.blocked, 11);
    assert.equal(mock.requests.some(request => request.url.pathname.endsWith('/comments')), false);
    assert.equal((await readdir(path.join(privateDirectory, 'ledger'))).length, 0);
  }, async () => goodIdentity, mock);
});

test('stored credential mode and revalidated account ownership gate every preflight API read', async () => {
  const mock = readMock();
  await fixture(async ({ service, privateDirectory }) => {
    await service.connect(body);
    await chmod(path.join(privateDirectory, 'connection.json'), 0o644);
    await assert.rejects(service.verifyAccess(), { code: 'PRIVATE_STORE_INVALID' });
    assert.equal(mock.requests.length, 0);
  }, async () => goodIdentity, mock);
  let calls = 0;
  await fixture(async ({ service }) => {
    await service.connect(body);
    await assert.rejects(service.verifyAccess(), { code: 'WRONG_ACCOUNT' });
    assert.equal(service.status().connected, false);
    assert.equal(mock.requests.length, 0);
  }, async () => ++calls === 1 ? goodIdentity : { ...goodIdentity, userId: 'wrong' }, mock);
});

test('truncated comments cannot complete the diagnostic or authorize automatic sending', async () => {
  const mock = readMock({ truncatedComments: true });
  await fixture(async ({ service, servedRoot }) => {
    await service.connect(body);
    const status = await service.verifyAccess();
    assert.equal(status.capabilities.recovery.protected, 11);
    assert.equal(status.capabilities.reads.comments.truncated, true);
    assert.equal(status.capabilities.diagnosticComplete, false);
    await assert.rejects(service.startAutomation({ messageText: 'Os dois links: https://example.com/app e https://example.com/credits' }), { code: 'PREFLIGHT_REQUIRED' });
    assert.equal(mock.requests.every(request => request.init.method === 'GET'), true);
  }, async () => goodIdentity, mock);
});

test('automatic sending requires preflight and validates both links and UTF-8 length before transport', async () => fixture(async ({ service }) => {
  await service.connect(body);
  for (const messageText of ['', 'apenas um https://example.com/app', 'sem os links', `${'😀'.repeat(300)} https://example.com/app https://example.com/credits`]) {
    await assert.rejects(service.startAutomation({ messageText }), { code: 'INVALID_MESSAGE' });
  }
  await assert.rejects(service.startAutomation({ messageText: 'Os dois links: https://example.com/app e https://example.com/credits' }), { code: 'PREFLIGHT_REQUIRED' });
}));

test('start and stop endpoints remain behind the origin, JSON and nonce guard', async () => httpFixture(async ({ service, origin }) => {
  await service.connect(body);
  const messageText = 'Os dois links: https://example.com/app e https://example.com/credits';
  const denied = await post(origin, await csrf(origin), { endpoint: '/api/connection/start', body: JSON.stringify({ messageText }), headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
  const missingPreflight = await post(origin, await csrf(origin), { endpoint: '/api/connection/start', body: JSON.stringify({ messageText }) });
  assert.equal(missingPreflight.status, 409);
  assert.equal(JSON.parse(await missingPreflight.text()).error, 'PREFLIGHT_REQUIRED');
  const auth = await csrf(origin);
  const stopped = await post(origin, auth, { endpoint: '/api/connection/stop', body: '{}' });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.text()).includes(FAKE_TOKEN), false);
  assert.equal((await post(origin, auth, { endpoint: '/api/connection/stop', body: '{}' })).status, 403);
}));

test('reviewed positive start takes a fresh complete baseline and stop performs no Meta mutation', async () => {
  const mock = readMock();
  await fixture(async ({ service, servedRoot, privateDirectory }) => {
    await service.connect(body); await service.verifyAccess();
    try {
      const result = await service.startAutomation({ messageText: 'Os dois links: https://example.com/app e https://example.com/credits' });
      assert.equal(result.automation.running, true);
      assert.equal(result.automation.baselineCount, 13);
      assert.equal(result.automation.acceptedCount, 0);
      assert.equal(result.automation.unknownCount, 0);
      assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
      assert.equal(mock.requests.every(request => request.init.method === 'GET'), true);
      assert.equal((await stat(path.join(privateDirectory, 'contact-ledger'))).mode & 0o777, 0o700);
    } finally { service.stopAutomation(); }
    assert.equal(service.status().automation.running, false);
  }, async () => goodIdentity, mock);
});

test('a fresh baseline may omit a protected historical ID while remaining future-only and sending no backfill', async () => {
  let commentReads = 0;
  const mock = readMock({ changeComments: comments => ++commentReads === 1 ? comments : comments.filter(comment => comment.id !== '1000') });
  await fixture(async ({ service, servedRoot }) => {
    await service.connect(body); await service.verifyAccess();
    try {
      const status = await service.startAutomation({ messageText: 'Os dois links: https://example.com/app e https://example.com/credits' });
      assert.equal(status.automation.running, true);
      assert.equal(status.automation.baselineCount, 12);
      assert.equal(status.automation.acceptedCount, 0);
    } finally { service.stopAutomation(); }
    assert.equal(mock.requests.every(request => request.init.method === 'GET'), true);
  }, async () => goodIdentity, mock);
});

test('ten visible histories protect eleven manual IDs and expose incomplete visibility plus the author limitation', async () => {
  const mock = readMock({ changeComments: comments => comments.filter(comment => comment.id !== '1010').map(comment => ({ ...comment,
    from: { id: String(9000 + Number(comment.id)), username: comment.username } })) });
  await fixture(async ({ service, servedRoot, privateDirectory }) => {
    await service.connect(body);
    const status = await service.verifyAccess();
    assert.equal(status.capabilities.diagnosticComplete, false);
    assert.equal(status.capabilities.futureOnlyReady, true);
    assert.deepEqual(status.capabilities.recovery, { expected: 11, matched: 10, protected: 11, blocked: 0, excluded: 2, unmatched: 1 });
    assert.match(status.capabilities.futureOnlyNote, /mudança de nome/);
    const preflight = service.campaignRecovery({ accountId: USER_ID, mediaId: '2468' });
    assert.equal(preflight.diagnosticComplete, false);
    assert.equal(preflight.futureOnlyReady, true);
    assert.equal(preflight.protectedCount, 11);
    assert.equal(preflight.reconciledComments.find(row => row.commentId === '1010').fromId, undefined);
    assert.equal(preflight.reconciledComments.find(row => row.commentId === '1000').fromId, '10000');
    const records = await Promise.all((await readdir(path.join(privateDirectory, 'ledger'))).map(async file => JSON.parse(await readFile(path.join(privateDirectory, 'ledger', file), 'utf8'))));
    assert.equal(records.length, 11);
    assert.equal(records.every(record => record.status === 'sent' && record.outcome === 'external_handled' && record.source === 'manual_recovery_ui_confirmed'), true);
    assert.equal(records.every(record => !record.messageId && !record.recipientId), true);
    assert.deepEqual(LEGACY.recovery, RECOVERY_SOURCE, 'verification never mutates the private recovery record');
    try {
      const started = await service.startAutomation({ messageText: 'Os dois links: https://example.com/app e https://example.com/credits' });
      assert.equal(started.automation.running, true);
      assert.equal(started.automation.acceptedCount, 0);
    } finally { service.stopAutomation(); }
    assert.equal(mock.requests.every(request => request.init.method === 'GET'), true);
  }, async () => goodIdentity, mock);
});

test('future-only readiness is not granted by an empty or denied comments read and expires before activation', async () => {
  for (const options of [{ changeComments: () => [] }, { deny: 'comments' }]) {
    const mock = readMock(options);
    await fixture(async ({ service, servedRoot }) => {
      await service.connect(body);
      const status = await service.verifyAccess();
      assert.equal(status.capabilities.futureOnlyReady, false);
      assert.equal(status.capabilities.recovery.protected, 11);
      await assert.rejects(service.startAutomation({ messageText: 'Os dois links: https://example.com/app e https://example.com/credits' }), { code: 'PREFLIGHT_REQUIRED' });
    }, async () => goodIdentity, mock);
  }
  let now = Date.UTC(2026, 9, 1, 20);
  const mock = { ...readMock(), clock: () => now };
  await fixture(async ({ service, servedRoot }) => {
    await service.connect(body); await service.verifyAccess();
    now += 15 * 60000 + 1;
    assert.throws(() => service.campaignRecovery({ accountId: USER_ID, mediaId: '2468' }), { code: 'PREFLIGHT_REQUIRED' });
    await assert.rejects(service.startAutomation({ messageText: 'Os dois links: https://example.com/app e https://example.com/credits' }), { code: 'PREFLIGHT_REQUIRED' });
  }, async () => goodIdentity, mock);
});

test('verification endpoint requires its own single-use CSRF nonce and an empty JSON body', async () => {
  const mock = readMock();
  await httpFixture(async ({ service, servedRoot, origin }) => {
    await service.connect(body);
    const auth = await csrf(origin);
    const invalid = await post(origin, auth, { endpoint: '/api/connection/verify', body: JSON.stringify({ unexpected: true }) });
    assert.equal(invalid.status, 400);
    assert.equal(mock.requests.length, 0);
    const badOrigin = await post(origin, await csrf(origin), { endpoint: '/api/connection/verify', body: '{}', headers: { Origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);
    const response = await post(origin, await csrf(origin), { endpoint: '/api/connection/verify', body: '{}' });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(JSON.parse(text).capabilities.recovery.protected, 11);
    assert.equal(text.includes(FAKE_TOKEN), false);
  }, mock);
});

test('connection uses the official identity helper with an injected fetch and no messaging call', async () => {
  const requests = [];
  const inspectToken = input => inspectInstagramToken({ ...input, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ user_id: USER_ID, username: USERNAME, id: '987654321', access_token: FAKE_TOKEN }) };
  } });
  await fixture(async ({ service }) => {
    const result = await service.connect(body);
    assert.equal(result.connected, true);
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.origin, 'https://graph.instagram.com');
    assert.equal(requests[0].url.pathname, '/v26.0/me');
    assert.equal(requests[0].url.searchParams.has('access_token'), false);
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  }, inspectToken);
});

test('provider errors are redacted and do not write any secret', async () => fixture(async ({ service, privateDirectory }) => {
  await assert.rejects(service.connect(body), error => {
    assert.equal(error.code, 'TOKEN_VALIDATION_FAILED');
    assert.equal(String(error).includes(FAKE_TOKEN), false);
    assert.equal(JSON.stringify(error).includes(FAKE_TOKEN), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(access(privateDirectory), { code: 'ENOENT' });
}, async () => { throw new Error(`provider may include a secret: ${FAKE_TOKEN}`); }));

test('invalid identity and malformed input cannot produce a connected status', async () => {
  await fixture(async ({ service }) => {
    await assert.rejects(service.connect(body), { code: 'IDENTITY_UNVERIFIED' });
    assert.equal(service.status().connected, false);
  }, async () => ({ username: USERNAME, id: USER_ID }));
  await fixture(async ({ service }) => {
    for (const invalid of [null, [], { ...body, accountId: USER_ID }, { ...body, accessToken: 'short' }, { ...body, apiVersion: 'latest' }]) {
      await assert.rejects(service.connect(invalid), { code: 'INVALID_BODY' });
    }
  }, async () => assert.fail('validation must precede provider call'));
});

test('server restart does not read credentials or claim a fresh validation', async () => fixture(async ({ service, privateDirectory, servedRoot }) => {
  await service.connect(body);
  const restarted = new ConnectionService({ privateDirectory, servedRoot, ...IDENTITY, inspectToken: async () => assert.fail('no automatic provider call') });
  assert.equal(restarted.status().connected, false);
  assert.equal(restarted.status().identity, null);
}));

test('private store refuses a served directory and symlinked credential destination', async () => fixture(async ({ service, privateDirectory, servedRoot }) => {
  assert.throws(() => new ConnectionService({ privateDirectory: path.join(servedRoot, 'tokens'), servedRoot, ...IDENTITY, inspectToken: async () => goodIdentity }), { code: 'PRIVATE_STORE_FAILED' });
  await mkdir(privateDirectory);
  const publicTarget = path.join(servedRoot, 'stolen.json');
  await symlink(publicTarget, path.join(privateDirectory, 'connection.json'));
  await assert.rejects(service.connect(body), { code: 'PRIVATE_STORE_FAILED' });
  await assert.rejects(access(publicTarget), { code: 'ENOENT' });
  assert.equal(service.status().connected, false);
}));

test('Host, Origin, custom header and fetch-site guards block cross-site attempts before provider calls', async () => httpFixture(async ({ origin, privateDirectory }) => {
  for (const headers of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }, { 'X-Benion-Request': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const result = await rawGet(origin, '/api/connection/csrf', { Origin: origin, 'X-Benion-Request': '1', ...headers });
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.equal(JSON.parse(result.body).nonce, undefined);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  const response = await fetch(`${origin}/api/connection/status`);
  assert.equal(response.status, 403);
  await assert.rejects(access(privateDirectory), { code: 'ENOENT' });
}, { inspectToken: async () => assert.fail('guard must run before provider call') }));

test('mutations require exact Origin, JSON, valid nonce and the matching HttpOnly session', async () => httpFixture(async ({ origin, privateDirectory }) => {
  for (const change of [
    { headers: { Origin: 'http://localhost:5197' } },
    { headers: { 'Content-Type': 'text/plain' } },
    { headers: { 'X-Benion-CSRF': 'missing-nonce' } },
    { headers: { Cookie: 'benion_csrf=' + 'a'.repeat(64) } },
  ]) {
    const auth = await csrf(origin);
    assert.match(auth.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const response = await post(origin, auth, change);
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes(FAKE_TOKEN), false);
  }
  await assert.rejects(access(privateDirectory), { code: 'ENOENT' });
}, { inspectToken: async () => assert.fail('guard must run before provider call') }));

test('a valid one-use nonce allows identity validation; responses and status never return the token', async () => httpFixture(async ({ origin }) => {
  const auth = await csrf(origin);
  const response = await post(origin, auth);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(FAKE_TOKEN), false);
  assert.equal(text.includes('extraSecret'), false);
  assert.equal(JSON.parse(text).connected, true);
  const repeated = await post(origin, auth);
  assert.equal(repeated.status, 403);
  const status = await fetch(`${origin}/api/connection/status`, { headers: { Origin: origin, 'X-Benion-Request': '1' } });
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const statusText = await status.text();
  assert.equal(statusText.includes(FAKE_TOKEN), false);
  assert.deepEqual(Object.keys(JSON.parse(statusText)).sort(), ['checkedAt', 'connected', 'identity', 'permissionsVerified']);
}));

test('expired nonces and malformed or oversized JSON are rejected without provider calls', async () => {
  let now = 0;
  await httpFixture(async ({ origin }) => {
    const auth = await csrf(origin);
    now = 300001;
    assert.equal((await post(origin, auth)).status, 403);
    const malformed = await post(origin, await csrf(origin), { body: '{invalid-json' });
    assert.equal(malformed.status, 400);
    const oversized = await post(origin, await csrf(origin), { body: JSON.stringify({ accessToken: 'x'.repeat(13 * 1024), apiVersion: 'v26.0' }) });
    assert.equal(oversized.status, 413);
  }, { clock: () => now, inspectToken: async () => assert.fail('invalid request must precede provider call') });
});

test('realistic provider failure is returned as a fixed safe error without token or raw provider message', async () => httpFixture(async ({ origin }) => {
  const response = await post(origin, await csrf(origin));
  assert.equal(response.status, 422);
  const text = await response.text();
  assert.equal(text.includes(FAKE_TOKEN), false);
  assert.equal(text.includes('provider-secret-message'), false);
  assert.equal(JSON.parse(text).error, 'TOKEN_VALIDATION_FAILED');
}, { inspectToken: async () => { throw new Error(`provider-secret-message ${FAKE_TOKEN}`); } }));
