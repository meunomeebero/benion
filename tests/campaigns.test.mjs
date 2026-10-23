import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CampaignService, DEFAULT_PUBLIC_REPLIES } from '../campaigns.mjs';
import { GraphClient, SendLedger } from '../integrations/meta.mjs';
import { CampaignContactLedger } from '../automation.mjs';
import { createBenionServer } from '../server.mjs';

const NOW = Date.UTC(2026, 9, 2, 18);
const MINUTE = 60000;
const ACCOUNT = '17841400000000100';
const USERNAME = 'example.owner';
const FIRST = '222';
const SECOND = '333';
const ORIGINAL = '17900000000000001';
const LEGACY = { mediaId: ORIGINAL, shortcode: 'EXAMPLEREEL1', protectedCount: 11 };
const MESSAGE = 'Aqui estão os links: https://example.com/app e https://example.com/credits';
const comment = (id, username, timestamp, extra = {}) => ({ id, username, timestamp: new Date(timestamp).toISOString(), ...extra });
const media = (id, shortcode, commentsCount = 0) => ({ id, shortcode, permalink: `https://www.instagram.com/reel/${shortcode}/`,
  ...(commentsCount === undefined ? {} : { commentsCount }) });
const original = Array.from({ length: 11 }, (_, index) => ({ commentId: String(101 + index), username: `manual_${index}` }));
const originalRows = () => original.map((row, index) => comment(row.commentId, row.username, NOW - MINUTE, { fromId: String(800 + index) }));
const delay = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let tries = 0; tries < 2000; tries++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail('Expected asynchronous checkpoint was not reached'); }
async function untilAsync(check) { for (let tries = 0; tries < 2000; tries++) { if (await check()) return; await delay(); } assert.fail('Expected asynchronous checkpoint was not reached'); }

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benion-campaign-test-'));
  const dataDir = path.join(root, 'private');
  let now = NOW; let error = null;
  const identity = { userId: ACCOUNT, username: USERNAME };
  let owned = [media(FIRST, 'FirstReel'), media(SECOND, 'SecondReel'), media(ORIGINAL, LEGACY.shortcode, 12)];
  const rows = new Map([[FIRST, []], [SECOND, []], [ORIGINAL, originalRows()]]);
  const truncated = new Set(); const sends = []; const reads = []; const publicSends = []; const transportCalls = [];
  const ledger = new SendLedger({ directory: path.join(root, 'send-ledger'), clock: () => now });
  await ledger.importHandledComments(ACCOUNT, original.filter(row => row.commentId !== options.unprotectedCommentId)
    .map(row => ({ ...row, status: 'sent', source: 'manual_recovery_verified' })));
  const graph = new GraphClient({ accountId: ACCOUNT, accessToken: 'fixture-secret-sentinel', apiVersion: 'v26.0', ledger, clock: () => now,
    fetchImpl: async (url, request) => {
      assert.equal(url.origin, 'https://graph.instagram.com'); assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      const body = JSON.parse(request.body); transportCalls.push({ path: url.pathname, body });
      if (url.pathname === `/v26.0/${ACCOUNT}/messages`) {
        return Response.json(options.privateResponse || { recipient_id: '777', message_id: `message-${body.recipient.comment_id}` });
      }
      assert.match(url.pathname, /^\/v26\.0\/\d+\/replies$/);
      const commentId = url.pathname.split('/')[2]; publicSends.push({ commentId, text: body.message });
      if (options.publicFailure) throw options.publicFailure;
      return Response.json(options.publicResponse || { id: `999${commentId}` });
    } });
  const client = {
    async listMedia(accountId, settings) {
      assert.equal(accountId, ACCOUNT); assert.deepEqual(settings, { pageSize: 50, maxPages: 10 });
      reads.push({ kind: 'media' });
      if (error) throw error;
      return { media: structuredClone(owned), truncated: false };
    },
    async listComments(mediaId, settings) {
      assert.deepEqual(settings, { pageSize: 50, maxPages: 10 }); reads.push({ kind: 'comments', mediaId });
      return options.readComments ? options.readComments(mediaId, rows) : { comments: structuredClone(rows.get(mediaId)), truncated: truncated.has(mediaId) };
    },
    async sendPrivateReply(accountId, commentId, text, settings) {
      sends.push({ accountId, commentId, text, settings });
      if (options.apiTransport) return graph.sendPrivateReply(accountId, commentId, text, settings);
      const reservation = await ledger.reserve(accountId, 'private', commentId);
      let result;
      try { result = options.send ? await options.send(commentId) : { outcome: 'accepted', messageId: `message-${commentId}`, recipientId: '777' }; }
      catch (failure) { await ledger.finish(reservation, { status: failure.outcome === 'rejected' ? 'rejected' : 'unknown', outcome: failure.outcome || 'unknown' }); throw failure; }
      await ledger.finish(reservation, { status: 'sent', ...result }); return result;
    },
    sendPublicReply: (...args) => graph.sendPublicReply(...args),
  };
  const context = { client, ledger, identity, accessToken: 'fixture-secret-sentinel' };
  const provider = async () => { if (options.provider) return options.provider(context); return context; };
  const recovery = options.recovery === false ? null : options.recovery || (async () => ({ diagnosticComplete: true,
    accountId: ACCOUNT, mediaId: ORIGINAL, protectedCount: 11, reconciledComments: structuredClone(original), checkedAt: now }));
  const services = [];
  const makeService = () => { const service = new CampaignService({ dataDir, clientProvider: provider, recoveryProvider: recovery, clock: () => now,
    accountId: ACCOUNT, accountUsername: USERNAME, legacy: LEGACY }); services.push(service); return service; };
  const service = makeService();
  t.after(async () => { for (const value of services) await value.shutdown().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, service, makeService, ledger, identity, reads, sends, publicSends, transportCalls, rows,
    advance: (amount = MINUTE) => { now += amount; }, now: () => now,
    setMedia: value => { owned = value; }, setError: value => { error = value; }, truncated,
    create: (values = {}) => service.create({ name: 'Links do Reel', mediaId: FIRST, messageText: MESSAGE, keywords: [], ...values }),
  };
}

test('server worker restores wanted campaigns after shutdown, preserves backlog and never restores manual pauses or uncertain sends', async t => {
  for (const scope of ['reel', 'all_reels']) await t.test(scope, async t => {
    let offline = false;
    const fx = await fixture(t, { apiTransport: true, provider: async context => {
      if (offline) throw Object.assign(new Error('temporary identity lookup failure'), { code: 'NETWORK_ERROR', outcome: 'none' });
      return context;
    } });
    fx.setMedia([media(FIRST, 'FirstReel', 1)]);
    fx.rows.set(FIRST, [comment('1000', 'historical', NOW - 1000)]);
    const row = await fx.create({ scope, mediaId: scope === 'reel' ? FIRST : null, publicReplies: ['Enviei.'] });
    await fx.service.start(row.id);
    fx.rows.get(FIRST).push(comment('1001', 'first', NOW + 1000, { fromId: '9001' }));
    fx.advance(); await fx.service.pollOnce(row.id); await fx.service.shutdown();
    const restarted = fx.makeService();
    assert.equal((await restarted.status(row.id)).enabled, true);
    assert.equal((await restarted.status(row.id)).running, false);
    fx.rows.get(FIRST).push(comment('1002', 'while_offline', fx.now() - 500, { fromId: '9002' }));
    fx.setMedia([media(FIRST, 'FirstReel', 3)]);
    const app = createBenionServer({ privateDirectory: fx.dataDir, webRoot: path.join(fx.root, 'public'), campaigns: restarted,
      owner: { primaryAccount: { id: ACCOUNT, username: USERNAME }, legacy: null }, connection: { status: () => ({ connected: true }) }, clock: fx.now });
    offline = true; await app.worker();
    assert.equal((await restarted.status(row.id)).reviewReason, 'NETWORK_ERROR');
    offline = false; await app.worker();
    assert.equal((await restarted.status(row.id)).running, true);
    assert.equal((await restarted.status(row.id)).status.activatedAt, NOW);
    fx.advance(); await restarted.pollOnce(row.id); fx.advance(); await restarted.pollOnce(row.id);
    assert.deepEqual(fx.sends.map(x => x.commentId), ['1001', '1002']);
    assert.deepEqual(fx.publicSends.map(x => x.commentId), ['1001', '1002']);
    await restarted.stop(row.id);
    const stopped = fx.makeService(); await stopped.restoreRunning();
    assert.equal((await stopped.status(row.id)).enabled, false);
    assert.equal((await stopped.status(row.id)).running, false);
    assert.equal(fx.sends.length, 2);
  });
  const fx = await fixture(t, { send: async () => { throw Object.assign(new Error(), { code: 'NETWORK_TIMEOUT', outcome: 'unknown' }); } });
  const row = await fx.create(); await fx.service.start(row.id);
  fx.rows.set(FIRST, [comment('2001', 'unknown', NOW + 1000, { fromId: '9005' })]);
  fx.advance(); await fx.service.pollOnce(row.id); await fx.service.shutdown();
  const restarted = fx.makeService(); await restarted.restoreRunning();
  assert.equal((await restarted.status(row.id)).enabled, true);
  assert.equal((await restarted.status(row.id)).reviewReason, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(fx.sends.length, 1);
});

test('read outages recover without activation, and explicit network recovery keeps the cutoff and deduplicates backlog', async t => {
  for (const scope of ['reel', 'all_reels']) await t.test(scope, async t => {
    let readError = null;
    const fx = await fixture(t, { apiTransport: true, readComments: async (mediaId, rows) => {
      if (readError) throw readError;
      return { comments: structuredClone(rows.get(mediaId)), truncated: false };
    } });
    fx.setMedia([media(FIRST, 'FirstReel', 1)]);
    fx.rows.set(FIRST, [comment('1000', 'historical', NOW - 1000)]);
    const row = await fx.create({ scope, mediaId: scope === 'reel' ? FIRST : null, publicReplies: ['Enviei.'] });
    await fx.service.start(row.id);
    fx.rows.get(FIRST).push(comment('1001', 'first', NOW + 1000, { fromId: '9001' }));
    fx.advance(); await fx.service.pollOnce(row.id);
    readError = Object.assign(new Error('fixture read outage'), { code: 'NETWORK_ERROR', outcome: 'none' });
    for (let i = 0; i < 2; i++) {
      fx.advance(); const status = await fx.service.pollOnce(row.id);
      assert.equal(status.running, true); assert.equal(status.reviewReason, null);
      assert.equal(status.status.records.at(-1).kind, 'read_retry');
      assert.equal(fx.sends.length, 1);
    }
    fx.rows.get(FIRST).push(comment('1002', 'during_outage', fx.now() - 1000, { fromId: '9002' }));
    readError = null; fx.advance(); await fx.service.pollOnce(row.id);
    assert.deepEqual(fx.sends.map(x => x.commentId), ['1001', '1002']);
    await fx.service.shutdown();
    const filename = path.join(fx.dataDir, 'campaigns.json');
    const stored = JSON.parse(await readFile(filename, 'utf8'));
    Object.assign(stored.campaigns[0].status, { running: false, state: 'review', reviewReason: 'NETWORK_ERROR' });
    await writeFile(filename, JSON.stringify(stored));
    fx.rows.get(FIRST).push(comment('1003', 'before_resume', fx.now() - 500, { fromId: '9003' }));
    fx.setMedia([media(FIRST, 'FirstReel', 4)]);
    const resumed = fx.makeService(); const activated = await resumed.start(row.id);
    assert.equal(activated.status.activatedAt, NOW); assert.equal(activated.status.baselineCount, 1);
    fx.advance(); await resumed.pollOnce(row.id); fx.advance(); await resumed.pollOnce(row.id);
    assert.deepEqual(fx.sends.map(x => x.commentId), ['1001', '1002', '1003']);
    assert.deepEqual(fx.publicSends.map(x => x.commentId), ['1001', '1002', '1003']);
  });
});

test('construction and campaign listing do not perform provider I/O; only owned Reels enter media DTO', async t => {
  const fx = await fixture(t);
  assert.deepEqual(await fx.service.list(), { campaigns: [], runningCampaignId: null });
  await assert.rejects(stat(fx.dataDir), { code: 'ENOENT' }); assert.equal(fx.reads.length, 0);
  fx.setMedia([media(FIRST, 'FirstReel'), { id: '444', shortcode: 'Post', permalink: 'https://www.instagram.com/p/Post/' },
    { ...media(SECOND, 'SecondReel'), accessToken: 'fixture-secret-sentinel' }]);
  const result = await fx.service.listMedia();
  assert.equal(result.available, true); assert.deepEqual(result.media.map(row => row.id), [FIRST, SECOND]);
  assert.equal(result.media[0].mediaType, 'REELS'); assert.equal(result.media[0].commentsCount, 0);
  assert.equal(JSON.stringify(result).includes('fixture-secret-sentinel'), false); assert.equal(fx.sends.length, 0);
});

test('configuration persists privately, trims accents in keywords, and never stores provider secrets', async t => {
  const fx = await fixture(t);
  const row = await fx.create({ name: ' Minha campanha ', keywords: [' QUÉRO ', 'quero', 'Preço'] });
  assert.equal(row.name, 'Minha campanha'); assert.deepEqual(row.keywords, ['quero', 'preco']);
  assert.equal(row.status.state, 'disabled'); assert.equal(row.shortcode, 'FirstReel'); assert.equal(row.requiresRecovery, false);
  assert.equal((await stat(fx.dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(fx.dataDir, 'campaigns.json'))).mode & 0o777, 0o600);
  const encoded = await readFile(path.join(fx.dataDir, 'campaigns.json'), 'utf8');
  assert.equal(encoded.includes('fixture-secret-sentinel'), false);
  const updated = await fx.service.update(row.id, { name: 'Outro', mediaId: SECOND });
  assert.equal(updated.mediaId, SECOND); assert.equal(updated.messageText, MESSAGE); assert.equal(fx.sends.length, 0);
});

test('public replies are explicit, bounded, copied into DTOs, and restored without activation', async t => {
  const fx = await fixture(t);
  const blank = await fx.create(); assert.deepEqual(blank.publicReplies, []);
  const row = await fx.create({ publicReplies: DEFAULT_PUBLIC_REPLIES.map(text => ` ${text} `) });
  assert.deepEqual(row.publicReplies, [...DEFAULT_PUBLIC_REPLIES]); assert.equal(row.running, false);
  row.publicReplies[0] = 'changed client copy';
  assert.deepEqual((await fx.service.status(row.id)).publicReplies, [...DEFAULT_PUBLIC_REPLIES]);
  const updated = await fx.service.update(row.id, { name: 'Persistida' });
  assert.deepEqual(updated.publicReplies, [...DEFAULT_PUBLIC_REPLIES]);
  const reads = fx.reads.length; const restarted = fx.makeService();
  const restored = (await restarted.list()).campaigns.find(value => value.id === row.id);
  assert.deepEqual(restored.publicReplies, [...DEFAULT_PUBLIC_REPLIES]); assert.equal(restored.running, false);
  assert.equal(fx.reads.length, reads); assert.equal(fx.sends.length, 0); assert.equal(fx.publicSends.length, 0);
  const stored = JSON.parse(await readFile(path.join(fx.dataDir, 'campaigns.json'), 'utf8'));
  assert.deepEqual(stored.campaigns.find(value => value.id === row.id).publicReplies, [...DEFAULT_PUBLIC_REPLIES]);
  assert.deepEqual((await fx.service.update(row.id, { publicReplies: [] })).publicReplies, []);
  for (const publicReplies of [null, 'texto', [1], [' '], ['x\u0000'], Array(4).fill('texto'), ['🦀'.repeat(251)]]) {
    await assert.rejects(fx.create({ publicReplies }), { code: 'CAMPAIGN_PUBLIC_REPLIES_INVALID' });
  }
  assert.deepEqual((await fx.create({ publicReplies: ['🦀'.repeat(250)] })).publicReplies, ['🦀'.repeat(250)]);
});

test('version-1 campaigns without publicReplies migrate to an empty list and never enable suggestions', async t => {
  const fx = await fixture(t); const row = await fx.create();
  const filename = path.join(fx.dataDir, 'campaigns.json');
  const state = JSON.parse(await readFile(filename, 'utf8')); delete state.campaigns[0].publicReplies;
  await writeFile(filename, JSON.stringify(state));
  const reads = fx.reads.length; const restarted = fx.makeService();
  const restored = await restarted.status(row.id);
  assert.deepEqual(restored.publicReplies, []); assert.equal(restored.running, false); assert.equal(fx.reads.length, reads);
  await restarted.update(row.id, { name: 'Migrada explicitamente' });
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).campaigns[0].publicReplies, []);
  assert.equal(fx.sends.length, 0); assert.equal(fx.publicSends.length, 0);
});

test('configured public replies use the Graph connector only after private acceptance and do not repeat either step', async t => {
  const fx = await fixture(t, { apiTransport: true }); const row = await fx.create({ publicReplies: [...DEFAULT_PUBLIC_REPLIES] });
  await fx.service.start(row.id);
  fx.rows.set(FIRST, ['1001', '1002', '1003'].map((id, index) => comment(id, `person_${index}`, NOW + 1000, { fromId: String(9001 + index) })));
  fx.advance(); const result = await fx.service.pollOnce(row.id);
  assert.equal(result.status.acceptedCount, 3); assert.equal(result.status.publicAcceptedCount, 3);
  assert.deepEqual(fx.transportCalls.map(value => value.path), [
    `/v26.0/${ACCOUNT}/messages`, '/v26.0/1001/replies',
    `/v26.0/${ACCOUNT}/messages`, '/v26.0/1002/replies',
    `/v26.0/${ACCOUNT}/messages`, '/v26.0/1003/replies',
  ]);
  assert.deepEqual(fx.publicSends.map(value => value.text), [...DEFAULT_PUBLIC_REPLIES]);
  assert.deepEqual(fx.transportCalls[0].body, { recipient: { comment_id: '1001' }, message: { text: MESSAGE } });
  assert.deepEqual(fx.transportCalls[1].body, { message: DEFAULT_PUBLIC_REPLIES[0] });
  assert.equal((await fx.ledger.get(ACCOUNT, 'public', '1001')).commentReplyId, '9991001');
  fx.advance(); await fx.service.pollOnce(row.id);
  await fx.service.stop(row.id); fx.setMedia([media(FIRST, 'FirstReel', 3)]);
  const restarted = fx.makeService(); await restarted.start(row.id); fx.advance(); await restarted.pollOnce(row.id);
  assert.equal(fx.sends.length, 3); assert.equal(fx.publicSends.length, 3);
});

test('a private HTTP 200 without recipient acknowledgement quarantines the DM and never announces publicly', async t => {
  const fx = await fixture(t, { apiTransport: true, privateResponse: { message_id: 'unproved' } });
  const row = await fx.create({ publicReplies: [...DEFAULT_PUBLIC_REPLIES] }); await fx.service.start(row.id);
  fx.rows.set(FIRST, [comment('1001', 'new', NOW + 1000)]); fx.advance();
  const result = await fx.service.pollOnce(row.id);
  assert.equal(result.status.unknownCount, 1); assert.equal(result.running, false);
  assert.equal(fx.publicSends.length, 0); assert.equal((await fx.ledger.get(ACCOUNT, 'private', '1001')).status, 'unknown');
  fx.advance(); await fx.service.pollOnce(row.id); assert.equal(fx.sends.length, 1);
});

test('an unknown public acknowledgement does not retry the public step or resend the accepted DM after reactivation', async t => {
  const fx = await fixture(t, { apiTransport: true, publicResponse: {} });
  const row = await fx.create({ publicReplies: [...DEFAULT_PUBLIC_REPLIES] }); await fx.service.start(row.id);
  fx.rows.set(FIRST, [comment('1001', 'new', NOW + 1000)]); fx.advance();
  const result = await fx.service.pollOnce(row.id);
  assert.equal(result.status.acceptedCount, 1); assert.equal(result.status.publicAcceptedCount, 0);
  assert.equal(result.reviewReason, 'PUBLIC_REPLY_REQUIRES_REVIEW');
  assert.equal((await fx.ledger.get(ACCOUNT, 'public', '1001')).status, 'unknown');
  fx.setMedia([media(FIRST, 'FirstReel', 1)]); await fx.service.start(row.id); fx.advance(); await fx.service.pollOnce(row.id);
  assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
});

test('invalid inputs and foreign account/media cannot prepare or start a campaign', async t => {
  const fx = await fixture(t);
  for (const values of [{ messageText: 'http://example.com' }, { messageText: 'https://user:pass@example.com' },
    { messageText: `https://example.com ${'🔥'.repeat(250)}` }, { name: '' }, { extra: true }]) {
    await assert.rejects(fx.create(values), { code: 'CAMPAIGN_CONFIG_INVALID' });
  }
  await assert.rejects(fx.create({ keywords: [''] }), { code: 'CAMPAIGN_KEYWORDS_INVALID' });
  await assert.rejects(fx.create({ mediaId: '9999' }), { code: 'OWNERSHIP_UNVERIFIED' });
  fx.identity.userId = '9999';
  await assert.rejects(fx.create(), { code: 'WRONG_ACCOUNT' });
  assert.equal((await fx.service.listMedia()).reason, 'WRONG_ACCOUNT');
  fx.identity.userId = ACCOUNT;
  const row = await fx.create(); fx.setMedia([]);
  await assert.rejects(fx.service.start(row.id), { code: 'OWNERSHIP_UNVERIFIED' });
  assert.equal((await fx.service.status(row.id)).reviewReason, 'OWNERSHIP_UNVERIFIED'); assert.equal(fx.sends.length, 0);
});

test('empty baseline requires a separately verified zero comment count', async t => {
  for (const [count, reason] of [[undefined, 'COMMENT_VISIBILITY_UNVERIFIED'], [12, 'COMMENT_COUNT_MISMATCH'], [0, null]]) {
    const fx = await fixture(t); fx.setMedia([{ ...media(FIRST, 'FirstReel'), ...(count === undefined ? { commentsCount: undefined } : { commentsCount: count }) }]);
    const row = await fx.create(); const started = await fx.service.start(row.id);
    assert.equal(started.status.reviewReason, reason); assert.equal(started.status.running, reason === null);
    assert.equal(fx.sends.length, 0);
  }
});

test('positive visible baseline is discarded, counts need not equal main comments, and truncated or inconsistent snapshots pause', async t => {
  const fx = await fixture(t);
  const historical = comment('1001', 'historical', NOW - MINUTE, { text: 'quero', fromId: '9001' });
  fx.rows.set(FIRST, [historical]); fx.setMedia([media(FIRST, 'FirstReel', 3)]);
  const row = await fx.create(); assert.equal((await fx.service.start(row.id)).running, true);
  fx.advance(); await fx.service.pollOnce(row.id); assert.equal(fx.sends.length, 0);
  await fx.service.stop(row.id); fx.setMedia([media(FIRST, 'FirstReel', 0)]);
  assert.equal((await fx.service.start(row.id)).reviewReason, 'COMMENT_COUNT_MISMATCH');
  fx.setMedia([media(FIRST, 'FirstReel', 1)]); fx.truncated.add(FIRST);
  assert.equal((await fx.service.start(row.id)).reviewReason, 'SNAPSHOT_INCOMPLETE'); assert.equal(fx.sends.length, 0);
});

test('new comments match normalized keyword OR, retain text, and receive at most one first message per person', async t => {
  const fx = await fixture(t); const row = await fx.create({ keywords: ['QUERO', 'Preço'] });
  await fx.service.start(row.id);
  fx.rows.set(FIRST, [comment('1001', 'one', NOW + 1000, { text: 'Eu QUÉRO o link', fromId: '9001' }),
    comment('1002', 'renamed', NOW + 2000, { text: 'Qual preço?', fromId: '9001' }),
    comment('1003', 'unmatched', NOW + 1000, { text: 'Legal', fromId: '9003' }),
    comment('1004', 'missing_text', NOW + 1000, { fromId: '9004' }),
    comment('1005', 'second', NOW + 1000, { text: 'me passa o PREÇO', fromId: '9005' })]);
  fx.advance(); const result = await fx.service.pollOnce(row.id);
  assert.deepEqual(fx.sends.map(row => row.commentId), ['1001', '1005']);
  assert.equal(result.status.acceptedCount, 2); assert.equal(result.status.skippedCount, 3);
  assert.equal(fx.sends[0].text, MESSAGE);
  fx.advance(); await fx.service.pollOnce(row.id); assert.equal(fx.sends.length, 2);
});

test('an empty keyword filter permits an eligible comment without text but not own/nested/old comments', async t => {
  const fx = await fixture(t); const row = await fx.create(); await fx.service.start(row.id);
  fx.rows.set(FIRST, [comment('1001', 'new', NOW + 1000), comment('1002', USERNAME, NOW + 1000),
    comment('1003', 'nested', NOW + 1000, { parentId: '1001' }), comment('1004', 'old', NOW)]);
  fx.advance(); await fx.service.pollOnce(row.id);
  assert.deepEqual(fx.sends.map(row => row.commentId), ['1001']);
});

test('legacy Reel requires exactly 11 recent recovered protections, account identity and visible canonical comments', async t => {
  for (const option of [false, async () => ({ diagnosticComplete: true, accountId: ACCOUNT, mediaId: ORIGINAL,
    protectedCount: 10, reconciledComments: original.slice(0, 10), checkedAt: NOW }),
  async () => ({ diagnosticComplete: true, accountId: ACCOUNT, mediaId: ORIGINAL,
    protectedCount: 11, reconciledComments: original, checkedAt: NOW - 16 * MINUTE })]) {
    const fx = await fixture(t, { recovery: option }); const row = await fx.create({ mediaId: ORIGINAL });
    await assert.rejects(fx.service.start(row.id), { code: 'PREFLIGHT_REQUIRED' });
    assert.equal((await fx.service.status(row.id)).status.running, false); assert.equal(fx.sends.length, 0);
  }
  const fx = await fixture(t); const row = await fx.create({ mediaId: ORIGINAL });
  assert.equal(row.requiresRecovery, true); assert.equal((await fx.service.start(row.id)).status.baselineCount, 11);
  fx.rows.set(ORIGINAL, [...originalRows(), comment('201', 'renamed', NOW + 1000, { fromId: '800' }),
    comment('202', 'MANUAL_1', NOW + 1000)]);
  fx.advance(); await fx.service.pollOnce(row.id); assert.equal(fx.sends.length, 0);
  await fx.service.stop(row.id); fx.rows.set(ORIGINAL, []);
  assert.equal((await fx.service.start(row.id)).reviewReason, 'RECOVERY_NOT_VISIBLE');
});

test('future-only recovery protects all 11 manual IDs while a complete 10-main snapshot admits only new people', async t => {
  const recovery = async () => ({ diagnosticComplete: false, futureOnlyReady: true, accountId: ACCOUNT, mediaId: ORIGINAL,
    protectedCount: 11, reconciledComments: structuredClone(original), checkedAt: NOW,
    futureOnlyNote: 'Um comentário histórico não está visível; todos os 11 permanecem bloqueados.' });
  const fx = await fixture(t, { recovery });
  const visible = [...originalRows().slice(0, 10), comment('501', 'reply_one', NOW - MINUTE, { parentId: '101' }),
    comment('502', 'reply_two', NOW - MINUTE, { parentId: '102' })];
  fx.rows.set(ORIGINAL, visible);
  const row = await fx.create({ mediaId: ORIGINAL, publicReplies: [...DEFAULT_PUBLIC_REPLIES] });
  const started = await fx.service.start(row.id);
  assert.equal(started.running, true); assert.equal(started.status.baselineCount, 12);
  assert.equal(fx.sends.length, 0); assert.equal(fx.publicSends.length, 0);
  for (const handled of original) {
    const entry = await fx.ledger.get(ACCOUNT, 'private', handled.commentId);
    assert.equal(entry.status, 'sent'); assert.equal(entry.outcome, 'external_handled');
    assert.equal(entry.messageId, undefined); assert.equal(entry.recipientId, undefined);
  }
  fx.rows.set(ORIGINAL, [...visible,
    comment('601', 'manual_10', NOW + 1000),
    comment('602', 'renamed_manual', NOW + 1000, { fromId: '800' }),
    comment('603', 'new_person', NOW + 1000, { fromId: '9003' })]);
  fx.advance(); const polled = await fx.service.pollOnce(row.id);
  assert.deepEqual(fx.sends.map(value => value.commentId), ['603']);
  assert.deepEqual(fx.publicSends.map(value => value.commentId), ['603']);
  assert.equal(polled.status.acceptedCount, 1);
});

test('future-only readiness never replaces freshness, protected-ledger proof or a complete activation snapshot', async t => {
  const makeRecovery = overrides => async () => ({ diagnosticComplete: false, futureOnlyReady: true,
    accountId: ACCOUNT, mediaId: ORIGINAL, protectedCount: 11, reconciledComments: structuredClone(original), checkedAt: NOW, ...overrides });
  for (const overrides of [{ futureOnlyReady: false }, { checkedAt: NOW - 16 * MINUTE }, { checkedAt: NOW + 1 }, { protectedCount: 10 }, { accountId: '999' }]) {
    const fx = await fixture(t, { recovery: makeRecovery(overrides) }); const row = await fx.create({ mediaId: ORIGINAL });
    await assert.rejects(fx.service.start(row.id), { code: 'PREFLIGHT_REQUIRED' });
    assert.equal(fx.sends.length, 0); assert.equal(fx.publicSends.length, 0);
  }
  const unprotected = await fixture(t, { recovery: makeRecovery({}), unprotectedCommentId: original[10].commentId });
  const unprotectedRow = await unprotected.create({ mediaId: ORIGINAL });
  assert.equal((await unprotected.service.start(unprotectedRow.id)).reviewReason, 'RECOVERY_UNPROTECTED');
  assert.equal(unprotected.sends.length, 0);
  const incomplete = await fixture(t, { recovery: makeRecovery({}) }); const row = await incomplete.create({ mediaId: ORIGINAL });
  incomplete.truncated.add(ORIGINAL);
  assert.equal((await incomplete.service.start(row.id)).reviewReason, 'SNAPSHOT_INCOMPLETE'); assert.equal(incomplete.sends.length, 0);
  const invisible = await fixture(t, { recovery: makeRecovery({}) }); const invisibleRow = await invisible.create({ mediaId: ORIGINAL });
  invisible.rows.set(ORIGINAL, []);
  assert.equal((await invisible.service.start(invisibleRow.id)).reviewReason, 'COMMENT_VISIBILITY_UNVERIFIED'); assert.equal(invisible.sends.length, 0);
});

test('a stopped accepted DM leaves its original public intent for explicit restart, without a second DM', async t => {
  let release;
  const finish = CampaignContactLedger.prototype.finishPublicReply;
  let intercept = true;
  CampaignContactLedger.prototype.finishPublicReply = async function (...args) {
    const value = await finish.apply(this, args);
    if (intercept && args[1] === 'inflight') { intercept = false; await new Promise(resolve => { release = resolve; }); }
    return value;
  };
  t.after(() => { CampaignContactLedger.prototype.finishPublicReply = finish; });
  const fx = await fixture(t);
  const row = await fx.create({ publicReplies: [...DEFAULT_PUBLIC_REPLIES] }); await fx.service.start(row.id);
  fx.rows.set(FIRST, [comment('1001', 'new', NOW + 1000)]); fx.advance();
  const poll = fx.service.pollOnce(row.id); await until(() => release);
  const stopping = fx.service.stop(row.id); await untilAsync(async () => !(await fx.service.status(row.id)).running); release(); await Promise.all([poll, stopping]);
  assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 0);
  fx.setMedia([media(FIRST, 'FirstReel', 1)]);
  const restarted = fx.makeService(); const reads = fx.reads.length;
  assert.equal((await restarted.status(row.id)).running, false); assert.equal(fx.reads.length, reads);
  await restarted.update(row.id, { publicReplies: ['Uma nova configuração não muda a intenção antiga.'] });
  assert.equal(fx.publicSends.length, 0);
  await restarted.start(row.id); fx.advance(); await restarted.pollOnce(row.id);
  assert.equal(fx.sends.length, 1); assert.deepEqual(fx.publicSends, [{ commentId: '1001', text: DEFAULT_PUBLIC_REPLIES[0] }]);
  fx.advance(); await restarted.pollOnce(row.id); assert.equal(fx.publicSends.length, 1);
});

test('overlapping campaigns drain the old send before a new baseline, preserving truthful acceptance', async t => {
  let release;
  const fx = await fixture(t, { send: () => new Promise(resolve => { release = () => resolve({ outcome: 'accepted', messageId: 'message-live', recipientId: '777' }); }) });
  const first = await fx.create(); const second = await fx.create({ mediaId: FIRST });
  await fx.service.start(first.id); fx.rows.set(FIRST, [comment('1001', 'first', NOW + 1000), comment('1002', 'second', NOW + 1000)]); fx.advance();
  const poll = fx.service.pollOnce(first.id); await until(() => release);
  fx.setMedia([media(FIRST, 'FirstReel', 2)]);
  let switched = false; const switching = fx.service.start(second.id).then(value => { switched = true; return value; });
  await until(() => fx.reads.filter(row => row.kind === 'media').length >= 4); await delay();
  assert.equal(switched, false); assert.equal(fx.reads.filter(row => row.kind === 'comments').length, 2);
  release(); const [accepted, running] = await Promise.all([poll, switching]);
  assert.equal(accepted.status.acceptedCount, 1); assert.equal(running.running, true);
  assert.equal(fx.sends.length, 1); assert.equal((await fx.service.status(first.id)).state, 'stopped');
  assert.equal((await fx.service.list()).runningCampaignId, second.id);
});

test('stop and shutdown wait for an in-flight acknowledgement and disallow queued/new starts', async t => {
  for (const action of ['stop', 'shutdown']) {
    let release;
    const fx = await fixture(t, { send: () => new Promise(resolve => { release = () => resolve({ outcome: 'accepted', messageId: 'message-live', recipientId: '777' }); }) });
    const row = await fx.create(); await fx.service.start(row.id);
    fx.rows.set(FIRST, [comment('1001', 'new', NOW + 1000), comment('1002', 'later', NOW + 1000)]); fx.advance();
    const poll = fx.service.pollOnce(row.id); await until(() => release);
    let completed = false;
    const stopping = (action === 'stop' ? fx.service.stop(row.id) : fx.service.shutdown()).then(value => { completed = true; return value; });
    await delay(); assert.equal(completed, false); release(); await Promise.all([poll, stopping]);
    assert.equal((await fx.service.status(row.id)).status.acceptedCount, 1); assert.equal(fx.sends.length, 1);
    if (action === 'shutdown') await assert.rejects(fx.service.start(row.id), { code: 'CAMPAIGN_SERVICE_STOPPED' });
  }
});

test('restart stays paused and durable aliases prevent a second message on the same Reel across campaigns', async t => {
  const fx = await fixture(t); const first = await fx.create(); await fx.service.start(first.id);
  fx.rows.set(FIRST, [comment('1001', 'recipient', NOW + 1000, { fromId: '9001' })]); fx.advance(); await fx.service.pollOnce(first.id);
  const restarted = fx.makeService(); const reads = fx.reads.length;
  const stored = (await restarted.list()).campaigns[0];
  assert.equal(stored.running, false); assert.equal(stored.reviewReason, 'PROCESS_RESTARTED'); assert.equal(fx.reads.length, reads);
  await fx.service.stop(first.id);
  const second = await restarted.create({ name: 'Segunda configuração', mediaId: FIRST, messageText: MESSAGE, keywords: [] });
  fx.setMedia([media(FIRST, 'FirstReel', 1)]); await restarted.start(second.id);
  fx.rows.set(FIRST, [comment('1001', 'recipient', NOW + 1000, { fromId: '9001' }),
    comment('1002', 'renamed', fx.now() + 1000, { fromId: '9001' }), comment('1003', 'new_person', fx.now() + 1000, { fromId: '9003' })]);
  fx.advance(); await restarted.pollOnce(second.id);
  assert.deepEqual(fx.sends.map(row => row.commentId), ['1001', '1003']);
});

test('scheduled timer persists an accepted DM/public reply and later Graph review before restart, without another send', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejected = false;
  const fx = await fixture(t, { readComments: (mediaId, rows) => {
    if (rejected) throw Object.assign(new Error('fixture-secret-sentinel upstream'), { code: 'GRAPH_REJECTED' });
    return { comments: structuredClone(rows.get(mediaId)), truncated: false };
  } });
  const row = await fx.create({ publicReplies: DEFAULT_PUBLIC_REPLIES }); await fx.service.start(row.id);
  fx.rows.set(FIRST, [comment('1001', 'new_person', NOW + 1000, { fromId: '9001' })]); fx.advance();
  const filename = path.join(fx.dataDir, 'campaigns.json');
  t.mock.timers.tick(MINUTE);
  await untilAsync(async () => JSON.parse(await readFile(filename, 'utf8')).campaigns[0].status.publicAcceptedCount === 1);
  await untilAsync(async () => (await fx.service.status(row.id)).status.nextCheckAt === NOW + 2 * MINUTE);
  assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
  const accepted = await fx.ledger.get(ACCOUNT, 'private', '1001'); assert.equal(accepted.outcome, 'accepted');
  rejected = true; fx.advance(); t.mock.timers.tick(MINUTE);
  await untilAsync(async () => JSON.parse(await readFile(filename, 'utf8')).campaigns[0].status.reviewReason === 'GRAPH_REJECTED');
  await untilAsync(async () => { try { await stat(`${filename}.lock`); return false; } catch (error) { return error.code === 'ENOENT'; } });
  const durable = JSON.parse(await readFile(filename, 'utf8')).campaigns[0].status;
  assert.equal(durable.running, false); assert.equal(durable.state, 'review'); assert.equal(durable.acceptedCount, 1); assert.equal(durable.publicAcceptedCount, 1);
  assert.equal(durable.lastCheckAt, NOW + MINUTE);
  assert.doesNotMatch(JSON.stringify(durable), /fixture-secret-sentinel|upstream/);
  const restarted = fx.makeService(); const reads = fx.reads.length;
  const restored = await restarted.status(row.id);
  assert.deepEqual(restored.status, durable); assert.equal(restored.reviewReason, 'GRAPH_REJECTED'); assert.equal(restored.running, false);
  assert.equal(fx.reads.length, reads); assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
  assert.deepEqual(await fx.ledger.get(ACCOUNT, 'private', '1001'), accepted);
  // Graceful shutdown must also preserve a review, rather than relabeling it.
  await fx.service.shutdown(); assert.equal((await restarted.status(row.id)).reviewReason, 'GRAPH_REJECTED');
  fx.advance(10 * MINUTE); t.mock.timers.tick(10 * MINUTE); await delay();
  assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
});

test('scheduled status persistence failure pauses before a later timer can send and keeps the accepted ledger', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fx = await fixture(t); const row = await fx.create(); await fx.service.start(row.id);
  const lockFile = path.join(fx.dataDir, 'campaigns.json.lock');
  await writeFile(lockFile, 'synthetic-held-write-lock', { mode: 0o600 });
  fx.rows.set(FIRST, [comment('1001', 'new_person', NOW + 1000, { fromId: '9001' })]); fx.advance(); t.mock.timers.tick(MINUTE);
  await untilAsync(async () => (await fx.service.status(row.id)).reviewReason === 'CAMPAIGN_STATUS_PERSISTENCE_FAILED');
  const paused = await fx.service.status(row.id); assert.equal(paused.running, false); assert.equal(paused.status.acceptedCount, 1);
  assert.equal((await fx.ledger.get(ACCOUNT, 'private', '1001')).outcome, 'accepted');
  fx.rows.get(FIRST).push(comment('1002', 'later_person', fx.now() + 1000, { fromId: '9002' }));
  fx.advance(10 * MINUTE); t.mock.timers.tick(10 * MINUTE); await delay(); assert.equal(fx.sends.length, 1);
  assert.doesNotMatch(JSON.stringify(paused), /fixture-secret-sentinel|synthetic-held-write-lock/);
  await rm(lockFile); await fx.service.shutdown();
  assert.equal((await fx.makeService().status(row.id)).reviewReason, 'CAMPAIGN_STATUS_PERSISTENCE_FAILED');
});

test('concurrent starts serialize, active updates fail, and new activation discards comments received while paused', async t => {
  const fx = await fixture(t); const first = await fx.create(); const second = await fx.create({ mediaId: SECOND });
  await Promise.all([fx.service.start(first.id), fx.service.start(second.id)]);
  assert.deepEqual((await fx.service.list()).campaigns.filter(row => row.running).map(row => row.id), [first.id, second.id]);
  await assert.rejects(fx.service.update(second.id, { name: 'Edited' }), { code: 'CAMPAIGN_RUNNING' });
  await fx.service.stop(second.id); fx.advance(); fx.rows.set(SECOND, [comment('1001', 'paused', fx.now() - 1000)]);
  fx.setMedia([media(SECOND, 'SecondReel', 1)]); await fx.service.start(second.id); fx.advance(); await fx.service.pollOnce(second.id);
  assert.equal(fx.sends.length, 0); assert.equal((await fx.service.status(second.id)).status.baselineCount, 1);
});

test('provider failure returns a redacted media diagnostic, never a false success', async t => {
  const fx = await fixture(t); fx.setError(Object.assign(new Error('fixture-secret-sentinel'), { code: 'GRAPH_REJECTED' }));
  const result = await fx.service.listMedia(); assert.equal(result.available, false); assert.equal(result.reason, 'GRAPH_REJECTED');
  assert.equal(JSON.stringify(result).includes('fixture-secret-sentinel'), false); assert.equal(fx.sends.length, 0);
});

test('corrupt, extra-field, malformed public copy, symlink and permissive state files stop reads without leaking content or sending', async t => {
  for (const mutation of ['extra', 'publicReplies', 'malformed', 'symlink', 'permissions']) {
    const fx = await fixture(t); await fx.create(); const filename = path.join(fx.dataDir, 'campaigns.json');
    if (mutation === 'extra') { const state = JSON.parse(await readFile(filename, 'utf8')); state.campaigns[0].status.accessToken = 'fixture-secret-sentinel'; await writeFile(filename, JSON.stringify(state)); }
    if (mutation === 'publicReplies') { const state = JSON.parse(await readFile(filename, 'utf8')); state.campaigns[0].publicReplies = Array(4).fill('texto'); await writeFile(filename, JSON.stringify(state)); }
    if (mutation === 'malformed') await writeFile(filename, '{');
    if (mutation === 'symlink') { const target = path.join(fx.root, 'other.json'); await writeFile(target, await readFile(filename)); await rm(filename); await symlink(target, filename); }
    if (mutation === 'permissions') await chmod(filename, 0o644);
    await assert.rejects(fx.service.list(), failure => /^CAMPAIGN_STORE_/.test(failure.code) && !failure.message.includes('fixture-secret-sentinel'));
    assert.equal(fx.sends.length, 0);
  }
});

test('all-Reels drafts save and update offline without provider I/O or sends, while activation still requires access', async t => {
  let calls = 0;
  const fx = await fixture(t, { provider: async () => { calls++; throw Object.assign(new Error('secret upstream'), { code: 'GRAPH_REJECTED' }); } });
  const row = await fx.service.create({ name: 'Todos os Reels', scope: 'all_reels', messageText: 'Teste grátis\nhttps://example.com/trial', keywords: [], publicReplies: [] });
  assert.equal(row.scope, 'all_reels'); assert.equal(row.mediaId, null); assert.equal(row.reel, null); assert.equal(row.shortcode, null);
  assert.equal(row.requiresRecovery, false); assert.equal(row.state, 'disabled'); assert.equal(calls, 0); assert.equal(fx.reads.length, 0);
  const changed = await fx.service.update(row.id, { messageText: 'Outra mensagem\nhttps://example.com/trial' }); assert.equal(changed.scope, 'all_reels'); assert.equal(calls, 0);
  await assert.rejects(fx.service.start(row.id), { code: 'GRAPH_REJECTED' }); assert.equal(calls, 1);
  assert.equal((await fx.service.status(row.id)).state, 'review'); assert.equal(fx.sends.length, 0);
});

test('scope is explicit for new rows and missing scope in old rows reads as an inactive single Reel', async t => {
  const fx = await fixture(t); const row = await fx.create(); assert.equal(row.scope, 'reel');
  const filename = path.join(fx.dataDir, 'campaigns.json'); const stored = JSON.parse(await readFile(filename, 'utf8')); delete stored.campaigns[0].scope;
  await writeFile(filename, JSON.stringify(stored)); const reads = fx.reads.length;
  assert.equal((await fx.makeService().status(row.id)).scope, 'reel'); assert.equal(fx.reads.length, reads);
  await fx.service.update(row.id, { name: 'Atualizada' }); assert.equal(JSON.parse(await readFile(filename, 'utf8')).campaigns[0].scope, 'reel');
  for (const invalid of [{ scope: 'all' }, { scope: null }, { scope: 'all_reels', mediaId: FIRST }]) {
    await assert.rejects(fx.create(invalid), failure => ['CAMPAIGN_CONFIG_INVALID', 'CAMPAIGN_PUBLIC_REPLIES_INVALID'].includes(failure.code));
  }
});

test('account-wide activation baselines every current Reel and discovers future ones with the original cutoff', async t => {
  const fx = await fixture(t); fx.rows.set(FIRST, [comment('1001', 'history', NOW - 1000)]);
  fx.setMedia([media(FIRST, 'FirstReel', 1), media(SECOND, 'SecondReel', 0)]);
  const row = await fx.create({ scope: 'all_reels', mediaId: null }); const started = await fx.service.start(row.id);
  assert.equal(started.running, true); assert.equal(started.status.monitoredReelCount, 2); assert.equal(started.status.activatedAt, NOW);
  assert.equal(started.status.baselineCount, 1); assert.equal(fx.sends.length, 0);
  fx.setMedia([media(FIRST, 'FirstReel', 3), media(SECOND, 'SecondReel', 1), media('444', 'FutureReel', 2)]);
  fx.rows.get(FIRST).push(comment('1002', 'same_person', NOW + 1000, { fromId: '9001' }), comment('1003', 'same_person', NOW + 2000, { fromId: '9001' }));
  fx.rows.set(SECOND, [comment('2001', 'same_person', NOW + 3000, { fromId: '9001' })]);
  fx.rows.set('444', [comment('4001', 'old', NOW - 1000), comment('4002', 'future', NOW + 4000)]);
  fx.advance(); const result = await fx.service.pollOnce(row.id);
  assert.deepEqual(fx.sends.map(value => value.commentId), ['1002', '1003', '2001', '4002']);
  assert.equal(result.status.monitoredReelCount, 3); assert.equal(result.status.activatedAt, NOW); assert.equal(result.status.publicAcceptedCount, 0);
  fx.advance(); await fx.service.pollOnce(row.id); assert.equal(fx.sends.length, 4);
});

test('all-Reels start validates account identity and complete snapshots before any send, including a late truncated Reel', async t => {
  const fx = await fixture(t); const row = await fx.create({ scope: 'all_reels', mediaId: null });
  fx.identity.userId = '999'; await assert.rejects(fx.service.start(row.id), { code: 'WRONG_ACCOUNT' }); assert.equal(fx.sends.length, 0);
  fx.identity.userId = ACCOUNT; fx.truncated.add(SECOND); const rejected = await fx.service.start(row.id);
  assert.equal(rejected.running, false); assert.equal(rejected.reviewReason, 'SNAPSHOT_INCOMPLETE'); assert.equal(fx.sends.length, 0);
});

test('all-Reels stop/shutdown drain accepted in-flight work, persist its status, and restart requires explicit activation', async t => {
  for (const action of ['stop', 'shutdown']) {
    let release;
    const fx = await fixture(t, { send: () => new Promise(resolve => { release = () => resolve({ outcome: 'accepted', messageId: 'drained', recipientId: '777' }); }) });
    fx.setMedia([media(FIRST, 'FirstReel'), media(SECOND, 'SecondReel')]);
    const row = await fx.create({ scope: 'all_reels', mediaId: null }); await fx.service.start(row.id);
    fx.rows.set(FIRST, [comment('1001', 'first', NOW + 1000)]); fx.rows.set(SECOND, [comment('2001', 'second', NOW + 2000)]);
    fx.setMedia([media(FIRST, 'FirstReel', 1), media(SECOND, 'SecondReel', 1)]); fx.advance();
    const poll = fx.service.pollOnce(row.id); await until(() => release);
    let done = false; const draining = (action === 'stop' ? fx.service.stop(row.id) : fx.service.shutdown()).then(result => { done = true; return result; });
    await delay(); assert.equal(done, false); release(); await Promise.all([poll, draining]);
    assert.equal(fx.sends.length, 1); const stopped = await fx.service.status(row.id); assert.equal(stopped.running, false); assert.equal(stopped.status.acceptedCount, 1);
    const reads = fx.reads.length; const restarted = fx.makeService(); assert.equal((await restarted.status(row.id)).running, false); assert.equal(fx.reads.length, reads);
    await restarted.start(row.id); fx.advance(); await restarted.pollOnce(row.id); assert.equal(fx.sends.length, 1);
  }
});

test('all-Reels scheduled snapshots persist acknowledgement then provider failure and do not restart automatically', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const fx = await fixture(t); fx.setMedia([media(FIRST, 'FirstReel')]);
  const row = await fx.create({ scope: 'all_reels', mediaId: null }); await fx.service.start(row.id);
  fx.rows.set(FIRST, [comment('1001', 'new', NOW + 1000)]); fx.setMedia([media(FIRST, 'FirstReel', 1)]); fx.advance();
  const filename = path.join(fx.dataDir, 'campaigns.json'); t.mock.timers.tick(MINUTE);
  await untilAsync(async () => JSON.parse(await readFile(filename, 'utf8')).campaigns[0].status.acceptedCount === 1);
  await untilAsync(async () => (await fx.service.status(row.id)).status.nextCheckAt === NOW + 2 * MINUTE);
  fx.setError(Object.assign(new Error('secret upstream'), { code: 'GRAPH_REJECTED' })); fx.advance(); t.mock.timers.tick(MINUTE);
  await untilAsync(async () => JSON.parse(await readFile(filename, 'utf8')).campaigns[0].status.reviewReason === 'GRAPH_REJECTED');
  const durable = await fx.makeService().status(row.id); assert.equal(durable.running, false); assert.equal(durable.status.acceptedCount, 1);
  assert.equal(durable.scope, 'all_reels'); assert.doesNotMatch(JSON.stringify(durable), /secret upstream/); assert.equal(fx.sends.length, 1);
});

test('all-Reels copy-only updates preserve the cutoff and ledger while unrelated edits reset the cutoff', async t => {
  const text = 'Enviei o link na sua dm 🎈'; const messageText = 'Sua análise gratuita:\n\nhttps://example.com/trial'; const fx = await fixture(t, { apiTransport: true });
  fx.rows.set(FIRST, [comment('1001', 'historical', NOW - 1000)]); fx.setMedia([media(FIRST, 'FirstReel', 1)]);
  const row = await fx.create({ scope: 'all_reels', mediaId: null }); const started = await fx.service.start(row.id); assert.equal(started.status.activatedAt, NOW);
  fx.advance(); fx.rows.get(FIRST).push(comment('1002', 'during_pause', NOW + 1000)); fx.setMedia([media(FIRST, 'FirstReel', 2)]);
  await fx.service.stop(row.id); assert.equal(fx.sends.length, 0);
  const restarted = fx.makeService(); const changed = await restarted.update(row.id, { messageText, publicReplies: [text] });
  assert.equal(changed.state, 'disabled'); assert.equal(changed.status.resumeCutoff, NOW); assert.equal(changed.messageText, messageText);
  assert.equal((await restarted.update(row.id, { messageText })).status.resumeCutoff, NOW);
  const retried = await restarted.update(row.id, { publicReplies: [text] }); assert.equal(retried.status.resumeCutoff, NOW);
  const another = fx.makeService(); const resumed = await another.start(row.id);
  assert.equal(resumed.status.activatedAt, NOW); assert.equal(resumed.status.baselineCount, 1); assert.equal(Object.hasOwn(resumed.status, 'resumeCutoff'), false);
  fx.advance(); const result = await another.pollOnce(row.id);
  assert.equal(result.status.acceptedCount, 1); assert.equal(result.status.publicAcceptedCount, 1);
  assert.deepEqual(fx.sends.map(value => value.commentId), ['1002']); assert.deepEqual(fx.publicSends, [{ commentId: '1002', text }]);
  assert.equal(fx.sends[0].text, messageText);
  fx.advance(); await another.pollOnce(row.id); assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
  await another.stop(row.id); fx.advance(); fx.rows.get(FIRST).push(comment('1003', 'ordinary_paused', fx.now() - 1000)); fx.setMedia([media(FIRST, 'FirstReel', 3)]);
  const ordinary = fx.makeService();
  assert.equal((await ordinary.update(row.id, { messageText })).status.resumeCutoff, NOW);
  const renamed = await ordinary.update(row.id, { name: 'Novo nome' }); assert.equal(Object.hasOwn(renamed.status, 'resumeCutoff'), false);
  assert.equal((await ordinary.start(row.id)).status.activatedAt, fx.now());
  fx.advance(); await ordinary.pollOnce(row.id); assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
  await assert.rejects(ordinary.update(row.id, { resumeCutoff: NOW }), failure => ['CAMPAIGN_RUNNING', 'CAMPAIGN_CONFIG_INVALID'].includes(failure.code));
});

test('all-Reels failed provider or incomplete preflight preserves the server-only resume cutoff until successful activation', async t => {
  const fx = await fixture(t); fx.setMedia([media(FIRST, 'FirstReel')]); const row = await fx.create({ scope: 'all_reels', mediaId: null });
  await fx.service.start(row.id); await fx.service.stop(row.id); await fx.service.update(row.id, { publicReplies: ['Enviei o link.'] });
  fx.setError(Object.assign(new Error('private provider detail'), { code: 'GRAPH_REJECTED' }));
  await assert.rejects(fx.service.start(row.id), { code: 'GRAPH_REJECTED' }); assert.equal((await fx.service.status(row.id)).status.resumeCutoff, NOW);
  fx.setError(null); fx.truncated.add(FIRST); const failed = await fx.service.start(row.id);
  assert.equal(failed.reviewReason, 'SNAPSHOT_INCOMPLETE'); assert.equal(failed.status.activatedAt, NOW); assert.equal(failed.status.resumeCutoff, NOW);
  fx.truncated.delete(FIRST); const accepted = await fx.service.start(row.id); assert.equal(accepted.status.activatedAt, NOW); assert.equal(Object.hasOwn(accepted.status, 'resumeCutoff'), false);
  assert.equal(fx.sends.length, 0); assert.equal(fx.publicSends.length, 0);
});

test('ordinary campaign edits clear a pending public-only resume marker and never accept a client-provided cutoff', async t => {
  const fx = await fixture(t); fx.setMedia([media(FIRST, 'FirstReel')]); const row = await fx.create({ scope: 'all_reels', mediaId: null });
  await fx.service.start(row.id); await fx.service.stop(row.id); const publicOnly = await fx.service.update(row.id, { publicReplies: ['Enviei.'] });
  assert.equal(publicOnly.status.resumeCutoff, NOW); const changed = await fx.service.update(row.id, { name: 'Outra campanha' }); assert.equal(Object.hasOwn(changed.status, 'resumeCutoff'), false);
  await assert.rejects(fx.service.update(row.id, { resumeCutoff: NOW }), { code: 'CAMPAIGN_CONFIG_INVALID' });
  const row2 = await fx.create({ scope: 'all_reels', mediaId: null, publicReplies: ['Enviei.'] }); assert.equal(Object.hasOwn(row2.status, 'resumeCutoff'), false);
});


test('distinct Reel campaigns deliver the correct links and public replies concurrently, restore together and preserve manual pause', async t => {
  const fx = await fixture(t, { apiTransport: true });
  const first = await fx.create({ publicReplies: ['Link do primeiro enviado.'] });
  const second = await fx.create({ mediaId: SECOND, messageText: 'Segundo link: https://example.com/second', publicReplies: ['Link do segundo enviado.'] });
  await fx.service.start(first.id); await fx.service.start(second.id);
  fx.rows.set(FIRST, [comment('3001', 'same_person', NOW + 1000, { fromId: '9001' })]);
  fx.rows.set(SECOND, [comment('3002', 'same_person', NOW + 1000, { fromId: '9001' })]);
  fx.advance(); await fx.service.pollOnce();
  assert.deepEqual(fx.sends.map(x => [x.commentId, x.text]), [['3001', MESSAGE], ['3002', 'Segundo link: https://example.com/second']]);
  assert.deepEqual(fx.publicSends.map(x => x.commentId), ['3001', '3002']);
  await fx.service.shutdown();
  fx.setMedia([media(FIRST, 'FirstReel', 1), media(SECOND, 'SecondReel', 1)]);
  const resumed = fx.makeService(); await resumed.restoreRunning();
  assert.equal((await resumed.status(first.id)).running, true);
  assert.equal((await resumed.status(second.id)).running, true);
  fx.advance(); await resumed.pollOnce(); assert.equal(fx.sends.length, 2);
  await resumed.stop(second.id); await resumed.shutdown();
  const last = fx.makeService(); await last.restoreRunning();
  assert.equal((await last.status(first.id)).running, true);
  assert.equal((await last.status(second.id)).running, false);
  await last.stop(); assert.equal((await last.status(first.id)).enabled, false);
});
