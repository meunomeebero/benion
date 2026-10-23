import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AllReelsCommentAutomation, CampaignCommentLedger, CampaignContactLedger, CampaignSendBudget } from '../automation.mjs';
import { SendLedger, GraphClient } from '../integrations/meta.mjs';

const NOW = Date.UTC(2026, 9, 9, 18);
const MINUTE = 60000;
const ACCOUNT = '17841400000000200';
const MESSAGE = 'Ooopa tudo bem?\nAqui está o link para você testar de graça\nhttps://example.com/trial';
const PUBLIC = 'Enviei o link na sua dm 🎈';
const comment = (id, time, extra = {}) => ({ id, timestamp: new Date(time).toISOString(), username: 'mesma_pessoa', fromId: '999', text: 'qualquer comentário', ...extra });
const media = (id, kind = 'reel') => ({ id, shortcode: `Video${id}`, permalink: `https://www.instagram.com/${kind}/Video${id}/` });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let index = 0; index < 2000; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail('Asynchronous checkpoint not reached'); }

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benion-all-reels-'));
  let now = NOW; let owned = [media('111'), media('222'), media('333', 'p')]; let mediaTruncated = false;
  const rows = new Map([['111', [comment('100', NOW - MINUTE)]], ['222', []], ['333', []]]);
  const truncated = new Set(); const counts = new Map(); const reads = []; const sends = []; const publicSends = []; const operations = []; const engines = [];
  const ledger = new SendLedger({ directory: path.join(root, 'send-ledger'), clock: () => now });
  if (options.onGraphReservation) {
    const reserve = ledger.reserve.bind(ledger);
    ledger.reserve = async (...args) => { const reservation = await reserve(...args); await options.onGraphReservation(reservation); return reservation; };
  }
  const comments = new CampaignCommentLedger({ directory: path.join(root, 'comment-ledger'), clock: () => now });
  const contacts = new CampaignContactLedger({ directory: path.join(root, 'contact-ledger'), clock: () => now });
  const budget = new CampaignSendBudget({ clock: () => now });
  const publicBudget = new CampaignSendBudget({ clock: () => now });
  const graph = new GraphClient({ accountId: ACCOUNT, accessToken: 'synthetic-all-reels-token', apiVersion: 'v26.0', ledger, clock: () => now,
    fetchImpl: async (url, request) => {
      assert.equal(url.origin, 'https://graph.instagram.com'); assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error'); const body = JSON.parse(request.body);
      if (url.pathname === `/v26.0/${ACCOUNT}/messages`) {
        sends.push({ accountId: ACCOUNT, commentId: body.recipient.comment_id, text: body.message.text }); operations.push({ kind: 'private', commentId: body.recipient.comment_id });
        if (options.beforePrivatePost) await options.beforePrivatePost(body.recipient.comment_id, { contacts, comments, ledger });
        if (options.send) return options.send(body.recipient.comment_id);
        return Response.json({ recipient_id: '999', message_id: `message-${body.recipient.comment_id}` });
      }
      assert.match(url.pathname, /^\/v26\.0\/\d+\/replies$/); const commentId = url.pathname.split('/')[2];
      publicSends.push({ accountId: ACCOUNT, commentId, text: body.message }); operations.push({ kind: 'public', commentId });
      return options.publicSend ? options.publicSend(commentId) : Response.json({ id: `999${commentId}` });
    } });
  const client = {
    async listMedia(accountId, pagination) {
      assert.equal(accountId, ACCOUNT); assert.deepEqual(pagination, { pageSize: 50, maxPages: 10 }); reads.push({ kind: 'media' });
      if (options.listMedia) await options.listMedia();
      return { media: owned.map(item => ({ ...item, commentsCount: counts.has(item.id) ? counts.get(item.id) : (rows.get(item.id) || []).filter(row => !row.parentId).length })), truncated: mediaTruncated };
    },
    async listComments(mediaId, pagination) {
      assert.deepEqual(pagination, { pageSize: 50, maxPages: 10 }); reads.push({ kind: 'comments', mediaId });
      if (options.listComments) await options.listComments(mediaId);
      return { comments: structuredClone(rows.get(mediaId) || []), truncated: truncated.has(mediaId) };
    },
    sendPrivateReply: (...args) => graph.sendPrivateReply(...args),
    sendPublicReply: (...args) => graph.sendPublicReply(...args),
  };
  const makeEngine = (overrides = {}) => {
    const engine = new AllReelsCommentAutomation({ client, ledger, commentLedger: comments, contactLedger: contacts, accountId: ACCOUNT, accountUsername: 'second.example',
      messageText: MESSAGE, publicReplies: options.publicReplies || [], clock: () => now, sendBudget: budget, publicSendBudget: publicBudget, ...overrides }); engines.push(engine); return engine;
  };
  const engine = makeEngine();
  t.after(async () => { for (const current of engines) current.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, engine, makeEngine, comments, contacts, ledger, budget, publicBudget, client, reads, sends, publicSends, operations, rows, truncated, counts,
    advance: (time = MINUTE) => { now += time; }, now: () => now, setMedia: items => { owned = items; }, setMediaTruncated: value => { mediaTruncated = value; } };
}

test('all current Reels are baselined without sending; posts are never read and activation is a global cutoff', async t => {
  const fx = await fixture(t); assert.equal(fx.engine.status().running, false); assert.equal(fx.reads.length, 0);
  const result = await fx.engine.start();
  assert.equal(result.running, true); assert.equal(result.activatedAt, NOW); assert.equal(result.monitoredReelCount, 2); assert.equal(result.baselineCount, 1);
  assert.deepEqual(fx.reads.filter(row => row.kind === 'comments').map(row => row.mediaId), ['111', '222']);
  fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 0);
});

test('all words match with no keywords; repeated authors get one DM per distinct eligible comment, never per replay', async t => {
  const fx = await fixture(t); await fx.engine.start();
  fx.rows.get('111').push(comment('101', NOW + 1000), comment('102', NOW + 2000, { text: 'Sem palavra-chave' }));
  fx.rows.set('222', [comment('201', NOW + 3000)]); fx.advance(); await fx.engine.pollOnce();
  assert.deepEqual(fx.sends.map(row => row.commentId), ['101', '102', '201']);
  assert.equal(fx.sends.every(row => row.accountId === ACCOUNT && row.text === MESSAGE), true);
  fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 3); assert.equal(fx.engine.status().publicAcceptedCount, 0);
  assert.equal((await fx.ledger.get(ACCOUNT, 'private', '101')).outcome, 'accepted');
  assert.equal((await fx.comments.get(ACCOUNT, '102')).status, 'accepted');
});

test('future discovered Reel keeps original cutoff and immediately admits post-activation comments, excluding its older history', async t => {
  const fx = await fixture(t); await fx.engine.start(); fx.advance();
  fx.setMedia([media('111'), media('222'), media('444')]);
  fx.rows.set('444', [comment('401', NOW - 1000), comment('402', NOW + 1000)]);
  const result = await fx.engine.pollOnce();
  assert.equal(result.activatedAt, NOW); assert.equal(result.baselineCount, 1); assert.equal(result.monitoredReelCount, 3);
  assert.deepEqual(fx.sends.map(row => row.commentId), ['402']);
  fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 1);
});

test('empty complete account can activate and discover its first future Reel without an historical reset', async t => {
  const fx = await fixture(t); fx.setMedia([]); assert.equal((await fx.engine.start()).running, true);
  fx.setMedia([media('555')]); fx.rows.set('555', [comment('501', NOW + 1000)]); fx.advance();
  assert.equal((await fx.engine.pollOnce()).monitoredReelCount, 1); assert.deepEqual(fx.sends.map(row => row.commentId), ['501']);
});

test('own, nested, authorless, future, pre-cutoff and expired comments never send; out-of-scope post comments never enter snapshots', async t => {
  const fx = await fixture(t); await fx.engine.start();
  fx.rows.get('111').push(comment('101', NOW + 1000, { fromId: ACCOUNT }), comment('102', NOW + 1000, { username: 'SECOND.EXAMPLE' }),
    comment('103', NOW + 1000, { parentId: '100' }), comment('104', NOW + 1000, { username: undefined, fromId: undefined }),
    comment('105', NOW), comment('106', NOW + 2 * MINUTE));
  fx.rows.set('333', [comment('301', NOW + 1000)]); fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 0);
  fx.advance(8 * 86400000); fx.rows.set('222', [comment('202', NOW + 1000)]); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 0);
});

test('media or any later Reel truncation blocks the whole snapshot before the first eligible send', async t => {
  for (const kind of ['media', 'comments']) {
    const fx = await fixture(t); await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000));
    if (kind === 'media') fx.setMediaTruncated(true); else fx.truncated.add('222'); fx.advance();
    const result = await fx.engine.pollOnce(); assert.equal(result.running, false);
    assert.equal(result.reviewReason, kind === 'media' ? 'MEDIA_SNAPSHOT_INCOMPLETE' : 'SNAPSHOT_INCOMPLETE'); assert.equal(fx.sends.length, 0);
  }
  const fx = await fixture(t); fx.setMediaTruncated(true); assert.equal((await fx.engine.start()).reviewReason, 'MEDIA_SNAPSHOT_INCOMPLETE'); assert.equal(fx.sends.length, 0);
});

test('new traffic arriving after listMedia but before its complete comment snapshot does not pause on the stale zero count', async t => {
  let active = false; let fx;
  fx = await fixture(t, { listComments: async mediaId => { if (active && mediaId === '222') fx.rows.set('222', [comment('201', NOW + 1000)]); } });
  await fx.engine.start(); active = true; fx.advance(); const result = await fx.engine.pollOnce();
  assert.equal(result.running, true); assert.equal(result.reviewReason, null); assert.deepEqual(fx.sends.map(row => row.commentId), ['201']);
});

test('independent counts, malformed comment/media, duplicated cross-media IDs and lost visibility pause before sending', async t => {
  for (const kind of ['count', 'invalid', 'duplicate', 'visibility']) {
    const fx = await fixture(t); await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000));
    if (kind === 'count') fx.counts.set('222', 1);
    if (kind === 'invalid') fx.rows.set('222', [{ id: '202', timestamp: 'invalid' }]);
    if (kind === 'duplicate') fx.rows.set('222', [comment('101', NOW + 1000)]);
    if (kind === 'visibility') fx.rows.set('111', []);
    fx.advance(); const result = await fx.engine.pollOnce(); assert.equal(result.running, false); assert.equal(fx.sends.length, 0);
  }
});

test('one global rolling five-attempt budget covers all media, queues the sixth and cannot be reset by replacing the engine', async t => {
  const fx = await fixture(t); await fx.engine.start();
  fx.rows.get('111').push(...['101', '102', '103'].map(id => comment(id, NOW + 1000)));
  fx.rows.set('222', ['201', '202', '203'].map(id => comment(id, NOW + 1000))); fx.advance();
  const poll1 = fx.engine.pollOnce(); const poll2 = fx.engine.pollOnce(); await Promise.all([poll1, poll2]);
  assert.equal(fx.sends.length, 5); const readCount = fx.reads.length;
  await fx.engine.pollOnce(); assert.equal(fx.reads.length, readCount); assert.equal(fx.budget.available(), false);
  const freshBudgetConsumer = fx.makeEngine(); assert.equal(fx.budget.take(), false); freshBudgetConsumer.stop();
  fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 6);
});

test('unknown and documented token, permission or rate rejections quarantine one comment and stop the aggregate cycle', async t => {
  for (const graphCode of [null, 190, 10, 200, 4, 17, 613, 80002]) {
    const fx = await fixture(t, { send: async () => {
      if (graphCode === null) throw new Error('synthetic-secret-provider-detail');
      return Response.json({ error: { code: graphCode, message: 'synthetic-secret-provider-detail' } }, { status: 400 });
    } });
    await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.rows.set('222', [comment('201', NOW + 1000)]); fx.advance();
    const result = await fx.engine.pollOnce(); assert.equal(fx.sends.length, 1); assert.equal(result.running, false);
    assert.equal((await fx.comments.get(ACCOUNT, '101')).status, graphCode === null ? 'unknown' : 'rejected');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/); fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 1);
  }
});

test('stop drains one in-flight accepted request and prevents subsequent media sends; fresh process stays disabled and never replays', async t => {
  let release;
  const fx = await fixture(t, { send: () => new Promise(resolve => { release = () => resolve(Response.json({ recipient_id: '999', message_id: 'drained' })); }) });
  await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.rows.set('222', [comment('201', NOW + 2000)]); fx.advance();
  const poll = fx.engine.pollOnce(); await until(() => release); const drain = fx.engine.pollOnce(); fx.engine.stop(); release(); await Promise.all([poll, drain]);
  assert.equal(fx.sends.length, 1); assert.equal(fx.engine.status().acceptedCount, 1); assert.equal(fx.engine.status().running, false);
  const restarted = fx.makeEngine(); const reads = fx.reads.length; await restarted.pollOnce(); assert.equal(fx.reads.length, reads); assert.equal(restarted.status().state, 'disabled');
  await restarted.start(); fx.advance(); await restarted.pollOnce(); assert.equal(fx.sends.length, 1);
});

test('stop during a comment snapshot or durable reservation prevents POST, including stale aggregate discovery', async t => {
  let held = false; let release;
  const fx = await fixture(t, { listComments: async mediaId => { if (held && mediaId === '222') await new Promise(resolve => { release = resolve; }); } });
  await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); held = true; fx.advance();
  const poll = fx.engine.pollOnce(); await until(() => release); fx.engine.stop(); release(); await poll; assert.equal(fx.sends.length, 0);
});

test('stop or seven-day expiry during the real Graph durable reservation fences the later POST and records a known rejection', { timeout: 5000 }, async t => {
  for (const change of ['stop', 'expire']) {
    let release; let reached;
    const checkpoint = new Promise(resolve => { reached = resolve; });
    const fx = await fixture(t, { onGraphReservation: () => new Promise(resolve => { release = resolve; reached(); }) });
    await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.rows.set('222', [comment('201', NOW + 2000)]); fx.advance();
    const poll = fx.engine.pollOnce(); await checkpoint;
    if (change === 'stop') fx.engine.stop(); else fx.advance(8 * 86400000);
    release(); await poll;
    assert.equal(fx.sends.length, 0); assert.equal(fx.engine.status().unknownCount, 0); assert.equal(fx.engine.status().rejectedCount, 1);
    assert.equal(fx.engine.status().running, false);
    assert.equal((await fx.ledger.get(ACCOUNT, 'private', '101')).errorCode, 'SEND_GATE_CHANGED');
    assert.equal((await fx.comments.get(ACCOUNT, '101')).status, 'rejected');
    fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 0);
  }
});

test('persistent per-comment attempts survive ledger reconstruction without blocking the same author on another comment or account', async t => {
  const fx = await fixture(t); await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.advance(); await fx.engine.pollOnce();
  const reloaded = new CampaignCommentLedger({ directory: path.join(fx.root, 'comment-ledger') });
  assert.equal((await reloaded.get(ACCOUNT, '101')).status, 'accepted');
  await assert.rejects(reloaded.reserve(ACCOUNT, '111', '101'), { code: 'COMMENT_ALREADY_ATTEMPTED' });
  const another = await reloaded.reserve(ACCOUNT, '111', '102'); await reloaded.finish(another, 'protected');
  const otherAccount = await reloaded.reserve('888', '111', '101'); await reloaded.finish(otherAccount, 'protected');
  for (const file of await readdir(path.join(fx.root, 'comment-ledger'))) {
    const filename = path.join(fx.root, 'comment-ledger', file); assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(filename, 'utf8'), /https:\/\/example\.com\/trial|synthetic-all-reels-token/);
  }
});

test('memory-only attempts cannot activate a real worker and wrong-account official transport cannot escape binding', async t => {
  const fx = await fixture(t); const unsafe = fx.makeEngine({ commentLedger: new CampaignCommentLedger() });
  assert.equal((await unsafe.start()).reviewReason, 'AUTOMATION_STORAGE_REQUIRED'); assert.equal(fx.reads.length, 0);
  await assert.rejects(fx.client.sendPrivateReply('888', '101', MESSAGE, { commentCreatedAt: NOW }), { code: 'ACCOUNT_MISMATCH' }); assert.equal(fx.sends.length, 0);
});

async function seedAcceptedPending(fx, mediaId, row, text = PUBLIC) {
  const intent = await fx.contacts.reservePublicReply(ACCOUNT, mediaId, row.id, text);
  const reservation = await fx.comments.reserve(ACCOUNT, mediaId, row.id);
  const accepted = await fx.client.sendPrivateReply(ACCOUNT, row.id, MESSAGE, { commentCreatedAt: Date.parse(row.timestamp) });
  await fx.comments.finish(reservation, 'accepted', accepted);
  return intent;
}

test('all-Reels public intent is durable before the private POST; canonical acknowledgement unlocks exactly one public reply per comment', async t => {
  const fx = await fixture(t, { publicReplies: [PUBLIC], beforePrivatePost: async (id, { contacts, comments, ledger }) => {
    const mediaId = id === '101' ? '111' : '222'; const intents = await contacts.listPublicReplies(ACCOUNT, mediaId);
    assert.equal(intents.find(intent => intent.commentId === id)?.status, 'pending');
    assert.equal((await comments.get(ACCOUNT, id)).status, 'inflight'); assert.equal((await ledger.get(ACCOUNT, 'private', id)).status, 'inflight');
  } });
  await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.rows.set('222', [comment('201', NOW + 2000)]); fx.advance();
  const result = await fx.engine.pollOnce();
  assert.equal(result.acceptedCount, 2); assert.equal(result.publicAcceptedCount, 2);
  assert.deepEqual(fx.operations, [{ kind: 'private', commentId: '101' }, { kind: 'public', commentId: '101' }, { kind: 'private', commentId: '201' }, { kind: 'public', commentId: '201' }]);
  assert.deepEqual(fx.publicSends.map(row => row.text), [PUBLIC, PUBLIC]);
  assert.equal((await fx.ledger.get(ACCOUNT, 'public', '101')).commentReplyId, '999101');
  fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 2); assert.equal(fx.publicSends.length, 2);
});

test('unknown, malformed acknowledgement or rejected private DM cancels its public intent and never announces a link', async t => {
  for (const outcome of ['unknown', 'invalid', 'rejected']) {
    const fx = await fixture(t, { publicReplies: [PUBLIC], send: async () => {
      if (outcome === 'unknown') throw new Error('untrusted transport detail');
      return outcome === 'invalid' ? Response.json({ message_id: 'missing-recipient' }) : Response.json({ error: { code: 551, message: 'private blocked' } }, { status: 400 });
    } });
    await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.advance(); await fx.engine.pollOnce();
    assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 0);
    assert.equal((await fx.contacts.listPublicReplies(ACCOUNT, '111'))[0].status, 'cancelled');
    fx.engine.stop(); const restarted = fx.makeEngine(); await restarted.start(); fx.advance(); await restarted.pollOnce();
    assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 0);
  }
});

test('explicit restart completes the original pending public text after an accepted stopped DM without issuing a second DM', { timeout: 5000 }, async t => {
  let release; let reached; const checkpoint = new Promise(resolve => { reached = resolve; });
  const fx = await fixture(t, { publicReplies: [PUBLIC], send: () => new Promise(resolve => { release = () => resolve(Response.json({ recipient_id: '999', message_id: 'stopped-accepted' })); reached(); }) });
  await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.advance();
  const poll = fx.engine.pollOnce(); await checkpoint; fx.engine.stop(); release(); await poll;
  assert.equal(fx.engine.status().acceptedCount, 1); assert.equal(fx.publicSends.length, 0);
  assert.equal((await fx.contacts.listPublicReplies(ACCOUNT, '111'))[0].status, 'pending');
  const restarted = fx.makeEngine({ publicReplies: ['Uma nova configuração não muda a intenção reservada.'] });
  await restarted.start(); fx.advance(); const result = await restarted.pollOnce();
  assert.equal(result.publicAcceptedCount, 1); assert.equal(fx.sends.length, 1); assert.deepEqual(fx.publicSends.map(row => row.text), [PUBLIC]);
  fx.advance(); await restarted.pollOnce(); assert.equal(fx.publicSends.length, 1);
});

test('public unknown or rejected outcomes quarantine the public attempt, pause and never replay either step', async t => {
  for (const outcome of ['unknown', 'invalid', 'rejected']) {
    const fx = await fixture(t, { publicReplies: [PUBLIC], publicSend: async () => {
      if (outcome === 'unknown') throw new Error('private transport detail');
      return outcome === 'invalid' ? Response.json({}) : Response.json({ error: { code: 10, message: 'no public access' } }, { status: 400 });
    } });
    await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.advance(); const result = await fx.engine.pollOnce();
    assert.equal(result.reviewReason, 'PUBLIC_REPLY_REQUIRES_REVIEW'); assert.equal(result.acceptedCount, 1); assert.equal(result.publicAcceptedCount, 0);
    assert.equal((await fx.contacts.listPublicReplies(ACCOUNT, '111'))[0].status, outcome === 'rejected' ? 'rejected' : 'unknown');
    const restarted = fx.makeEngine(); await restarted.start(); fx.advance(); await restarted.pollOnce(); assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
  }
});

test('public completion requires visible owned top-level non-own comments plus the account-wide accepted attempt, and stays disabled without configured copy', async t => {
  const fx = await fixture(t, { publicReplies: [PUBLIC] });
  const existing = [comment('101', NOW - 1000, { parentId: '100' }), comment('102', NOW - 1000, { fromId: ACCOUNT }), comment('103', NOW - 1000)];
  fx.rows.get('111').push(...existing);
  for (const row of existing) await seedAcceptedPending(fx, '111', row);
  await seedAcceptedPending(fx, '444', comment('401', NOW - 1000));
  await fx.contacts.reservePublicReply(ACCOUNT, '111', '104', PUBLIC);
  fx.rows.get('111').push(comment('104', NOW - 1000));
  await fx.client.sendPrivateReply(ACCOUNT, '104', MESSAGE, { commentCreatedAt: NOW - 1000 }); // No account-wide attempt proof.
  await fx.engine.start(); fx.advance(); await fx.engine.pollOnce();
  assert.deepEqual(fx.publicSends.map(row => row.commentId), ['103']);
  assert.equal((await fx.contacts.listPublicReplies(ACCOUNT, '444'))[0].status, 'pending');
  fx.engine.stop(); const disabled = fx.makeEngine({ publicReplies: [] }); await disabled.start(); fx.advance(); await disabled.pollOnce(); assert.equal(fx.publicSends.length, 1);
});

test('pending public attempts in inflight or with prior unknown Graph records cannot authorize another public POST', async t => {
  for (const kind of ['intent-inflight', 'graph-unknown']) {
    const fx = await fixture(t, { publicReplies: [PUBLIC] }); const row = comment('101', NOW - 1000); fx.rows.get('111').push(row);
    const intent = await seedAcceptedPending(fx, '111', row);
    if (kind === 'intent-inflight') await fx.contacts.finishPublicReply(intent, 'inflight');
    else { const claim = await fx.ledger.reserve(ACCOUNT, 'public', '101'); await fx.ledger.finish(claim, { status: 'unknown', outcome: 'unknown' }); }
    await fx.engine.start(); fx.advance(); const result = await fx.engine.pollOnce();
    assert.equal(result.reviewReason, 'PUBLIC_REPLY_REQUIRES_REVIEW'); assert.equal(fx.publicSends.length, 0); assert.equal(fx.sends.length, 1);
  }
});

test('durable Graph private acceptance reconciles a crashed local inflight attempt and resumes only its public step', async t => {
  const fx = await fixture(t, { publicReplies: [PUBLIC] }); const row = comment('101', NOW - 1000); fx.rows.get('111').push(row);
  await fx.contacts.reservePublicReply(ACCOUNT, '111', row.id, PUBLIC);
  await fx.comments.reserve(ACCOUNT, '111', row.id);
  await fx.client.sendPrivateReply(ACCOUNT, row.id, MESSAGE, { commentCreatedAt: NOW - 1000 });
  assert.equal((await fx.comments.get(ACCOUNT, '101')).status, 'inflight');
  await fx.engine.start(); fx.advance(); const result = await fx.engine.pollOnce();
  assert.equal(result.publicAcceptedCount, 1); assert.equal((await fx.comments.get(ACCOUNT, '101')).status, 'accepted');
  assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
  fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
});

test('pending public replies across all media share five per minute and later replies queue without blocking new private work', async t => {
  const fx = await fixture(t, { publicReplies: [PUBLIC] });
  const first = ['101', '102', '103'].map(id => comment(id, NOW - 1000)); const second = ['201', '202', '203'].map(id => comment(id, NOW - 1000));
  fx.rows.get('111').push(...first); fx.rows.set('222', second);
  for (const row of first) await seedAcceptedPending(fx, '111', row);
  for (const row of second) await seedAcceptedPending(fx, '222', row);
  await fx.engine.start(); fx.rows.get('111').push(comment('104', NOW + 1000)); fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.publicSends.length, 5); assert.equal(fx.sends.length, 7); assert.equal(fx.publicBudget.available(), false);
  fx.advance(); await fx.engine.pollOnce(); assert.equal(fx.publicSends.length, 7); assert.equal(fx.sends.length, 7);
});

test('pause during the real public Graph durable reservation blocks the public POST and preserves a known non-retryable rejection', { timeout: 5000 }, async t => {
  let release; let reached; const checkpoint = new Promise(resolve => { reached = resolve; });
  const fx = await fixture(t, { publicReplies: [PUBLIC], onGraphReservation: reservation => reservation.kind === 'public' ? new Promise(resolve => { release = resolve; reached(); }) : undefined });
  await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.rows.set('222', [comment('201', NOW + 2000)]); fx.advance();
  const poll = fx.engine.pollOnce(); await checkpoint; const drain = fx.engine.pollOnce(); fx.engine.stop(); release(); await Promise.all([poll, drain]);
  assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 0); assert.equal(fx.engine.status().publicAcceptedCount, 0);
  assert.equal((await fx.ledger.get(ACCOUNT, 'public', '101')).errorCode, 'SEND_GATE_CHANGED');
  assert.equal((await fx.contacts.listPublicReplies(ACCOUNT, '111'))[0].status, 'rejected');
  const restarted = fx.makeEngine(); await restarted.start(); fx.advance(); await restarted.pollOnce(); assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 0);
});

test('stop drains a public request already posted and persists truthful acknowledgement before another comment can send', { timeout: 5000 }, async t => {
  let release; let reached; const checkpoint = new Promise(resolve => { reached = resolve; });
  const fx = await fixture(t, { publicReplies: [PUBLIC], publicSend: () => new Promise(resolve => { release = () => resolve(Response.json({ id: '999101' })); reached(); }) });
  await fx.engine.start(); fx.rows.get('111').push(comment('101', NOW + 1000)); fx.rows.set('222', [comment('201', NOW + 2000)]); fx.advance();
  const poll = fx.engine.pollOnce(); await checkpoint; fx.engine.stop(); release(); const result = await poll;
  assert.equal(result.running, false); assert.equal(result.acceptedCount, 1); assert.equal(result.publicAcceptedCount, 1); assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
  assert.equal((await fx.contacts.listPublicReplies(ACCOUNT, '111'))[0].status, 'accepted');
});

test('public-only resume cutoff protects histories but keeps unattempted comments from the controlled pause eligible', async t => {
  const fx = await fixture(t); await fx.engine.start(); fx.engine.stop(); fx.advance(); fx.rows.get('111').push(comment('101', NOW + 1000));
  const resumed = fx.makeEngine({ activationCutoff: NOW, publicReplies: [PUBLIC] }); const started = await resumed.start();
  assert.equal(started.activatedAt, NOW); assert.equal(started.baselineCount, 1); fx.advance(); await resumed.pollOnce();
  assert.deepEqual(fx.sends.map(row => row.commentId), ['101']); assert.deepEqual(fx.publicSends.map(row => row.commentId), ['101']);
  fx.advance(); await resumed.pollOnce(); assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1);
});
