import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { ConnectionService } from '../connection.mjs';
import { MetaError, refreshInstagramToken } from '../integrations/meta.mjs';

const DAY = 86400000;
const TOKEN = 'synthetic-original-instagram-token';
const RENEWED = 'synthetic-renewed-instagram-token';
const identity = { userId: '17841400000000200', username: 'example.owner', permissionsVerified: false };
const response = body => ({ ok: true, status: 200, json: async () => body });

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benion-refresh-'));
  const servedRoot = path.join(root, 'served');
  const privateDirectory = path.join(root, 'private');
  await mkdir(servedRoot);
  let now = Date.UTC(2026, 9, 1);
  let inspect = async () => identity;
  let refresh = async () => response({ access_token: RENEWED, token_type: 'bearer', expires_in: 60 * DAY / 1000 });
  const calls = [];
  const options = { privateDirectory, servedRoot, expectedUsername: identity.username, expectedUserId: identity.userId,
    clock: () => now, inspectToken: input => inspect(input), fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(url.origin, 'https://graph.instagram.com');
      if (url.pathname === '/refresh_access_token') {
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.equal(url.searchParams.get('grant_type'), 'ig_refresh_token');
        return refresh(url, init);
      }
      return response({ data: [] });
    } };
  const create = () => new ConnectionService(options);
  const service = create();
  const read = async () => JSON.parse(await readFile(path.join(privateDirectory, 'connection.json'), 'utf8'));
  try {
    await service.connect({ accessToken: TOKEN, apiVersion: 'v26.0' });
    await run({ service, create, read, calls, privateDirectory, advance: ms => { now += ms; }, setInspect: fn => { inspect = fn; }, setRefresh: fn => { refresh = fn; } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('automatic renewal preserves state and existing clients adopt the atomically saved token', async () => fixture(async ({ service, create, read, calls, privateDirectory, advance }) => {
  const protectedFiles = ['campaigns.json', 'publishing.json', 'ledger/protected-comment.json'];
  for (const file of protectedFiles) await writeFile(path.join(privateDirectory, file), 'synthetic durable state');
  const { client } = await service.messagingContext();
  advance(DAY - 1);
  assert.equal((await service.refreshIfDue()).state, 'waiting');
  assert.equal(calls.length, 0);
  advance(1);
  const result = await service.refreshIfDue();
  assert.equal(result.refreshed, true);
  assert.equal(result.state, 'scheduled');
  assert.equal(Date.parse(result.nextAttemptAt), Date.parse(result.expiresAt) - 7 * DAY);
  assert.equal((await read()).accessToken, RENEWED);
  assert.equal((await stat(path.join(privateDirectory, 'connection.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(service.status()).includes(RENEWED), false);
  for (const file of protectedFiles) assert.equal(await readFile(path.join(privateDirectory, file), 'utf8'), 'synthetic durable state');
  await client.listComments('123');
  assert.equal(calls.at(-1).init.headers.Authorization, `Bearer ${RENEWED}`);
  const restarted = create();
  advance(53 * DAY - 1);
  assert.equal((await restarted.refreshIfDue()).refreshed, false);
  advance(1);
  assert.equal((await restarted.refreshIfDue()).refreshed, true);
  assert.equal(calls.filter(call => call.url.pathname === '/refresh_access_token').length, 2);
}));

test('renewed credentials stay inactive until identity verification succeeds across a restart', async () => fixture(async ({ service, create, read, calls, advance, setInspect }) => {
  let identityUnavailable = true;
  setInspect(async ({ accessToken }) => {
    if (accessToken === RENEWED && identityUnavailable) throw new MetaError('NETWORK_TIMEOUT', 'safe synthetic error', { outcome: 'none' });
    return identity;
  });
  advance(DAY);
  assert.equal((await service.refreshIfDue()).state, 'retrying');
  assert.equal((await read()).accessToken, TOKEN);
  assert.equal((await read()).pendingRefresh.accessToken, RENEWED);
  const restarted = create();
  assert.equal((await restarted.refreshIfDue()).refreshed, false);
  advance(DAY);
  identityUnavailable = false;
  assert.equal((await restarted.refreshIfDue()).refreshed, true);
  assert.equal((await read()).pendingRefresh, undefined);
  assert.equal((await read()).accessToken, RENEWED);
  assert.equal(calls.length, 1, 'reconcile a known replacement instead of requesting another refresh');
}));

test('wrong identities and permanent rejection never replace credentials or loop after restart', async () => {
  for (const cause of ['wrong_identity', 'revoked', 'expired']) await fixture(async ({ service, create, read, calls, advance, setInspect, setRefresh, privateDirectory }) => {
    if (cause === 'wrong_identity') setInspect(async ({ accessToken }) => accessToken === RENEWED ? { ...identity, userId: '999' } : identity);
    if (cause === 'revoked') setRefresh(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 190, message: `do not expose ${TOKEN}` } }) }));
    if (cause === 'expired') {
      const saved = await read();
      saved.tokenRefresh.expiresAt = saved.tokenRefresh.firstSeenAt + DAY;
      await writeFile(path.join(privateDirectory, 'connection.json'), JSON.stringify(saved), { mode: 0o600 });
    }
    advance(DAY);
    const failed = await service.refreshIfDue();
    assert.equal(failed.state, 'reauthorization_required');
    assert.equal(failed.action, 'reconnect');
    assert.equal((await read()).accessToken, TOKEN);
    assert.equal(JSON.stringify(failed).includes(TOKEN), false);
    const attempts = calls.length;
    advance(2 * DAY);
    assert.equal((await create().refreshIfDue()).state, 'reauthorization_required');
    assert.equal(calls.length, attempts);
  });
});

test('legacy expiry stays unknown; transient and malformed provider responses remain private', async () => fixture(async ({ service, create, read, calls, advance, privateDirectory, setRefresh }) => {
  const saved = await read();
  delete saved.tokenRefresh;
  await writeFile(path.join(privateDirectory, 'connection.json'), JSON.stringify(saved), { mode: 0o600 });
  advance(90 * DAY);
  assert.equal((await service.refreshIfDue()).expiresAt, null);
  assert.equal(calls.length, 0, 'an old checkedAt is not a verified issue date');
  setRefresh(async () => { throw new Error(`network log ${TOKEN}`); });
  advance(DAY);
  const failed = await service.refreshIfDue();
  assert.equal(failed.state, 'retrying');
  assert.equal(failed.code, 'NETWORK_ERROR');
  assert.equal((await read()).accessToken, TOKEN);
  assert.equal((await create().refreshIfDue()).refreshed, false);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(failed).includes(TOKEN), false);
  await assert.rejects(refreshInstagramToken({ accessToken: TOKEN, fetchImpl: async () => response({ access_token: RENEWED, token_type: 'bearer', expires_in: -1, message: TOKEN }) }), error => error.code === 'TOKEN_RESPONSE_INVALID' && !JSON.stringify(error).includes(TOKEN));
}));
