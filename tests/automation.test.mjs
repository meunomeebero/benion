import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SendLedger, GraphClient } from '../integrations/meta.mjs';
import { LocalCommentAutomation, CampaignContactLedger } from '../automation.mjs';

const NOW = Date.UTC(2026, 9, 1, 21);
const MINUTE = 60000;
const ACCOUNT = '17841400000000100';
const MEDIA = '17900000000000001';
const MESSAGE = 'Aqui estão os dois links: https://example.com/app e https://example.com/credits';
const manual = { commentId: '101', username: 'recuperado' };
const comment = (id, name, time, extra = {}) => ({ id, username: name, timestamp: new Date(time).toISOString(), ...extra });
const baseline = () => [comment(manual.commentId, manual.username, NOW - MINUTE, { fromId: '999' })];
const response = data => ({ ok: true, status: 200, json: async () => data });

async function fixture(options = {}) {
  let now = NOW;
  const recovered = options.reconciledComments || [manual];
  let rows = options.rows || baseline();
  let truncated = false;
  let reads = 0;
  const sends = [];
  const publicSends = [];
  const ledger = options.ledger || new SendLedger({ clock: () => now });
  await ledger.importHandledComments(ACCOUNT, recovered.map(item => ({ ...item, status: 'sent', source: 'manual_recovery_verified' })));
  const contacts = options.contacts || new CampaignContactLedger({ clock: () => now });
  const client = {
    listComments: async (_mediaId, pagination) => {
      assert.equal(_mediaId, MEDIA);
      assert.deepEqual(pagination, { pageSize: 50, maxPages: 10 });
      reads++; return { comments: rows, truncated };
    },
    sendPrivateReply: async (accountId, commentId, text, settings) => {
      sends.push({ accountId, commentId, text, settings });
      const reservation = await ledger.reserve(accountId, 'private', commentId);
      try {
        const result = options.send ? await options.send(commentId) : { outcome: 'accepted', messageId: `message-${commentId}`, recipientId: '777' };
        await ledger.finish(reservation, { status: 'sent', outcome: 'accepted', messageId: result.messageId, recipientId: result.recipientId });
        return result;
      } catch (error) {
        await ledger.finish(reservation, { status: error.outcome === 'rejected' ? 'rejected' : 'unknown', outcome: error.outcome === 'rejected' ? 'rejected' : 'unknown' });
        throw error;
      }
    },
    sendPublicReply: async (_accountId, commentId, text) => {
      publicSends.push({ commentId, text });
      return options.publicSend ? options.publicSend(commentId) : { outcome: 'accepted', commentReplyId: '888' };
    },
  };
  const makeEngine = (overrides = {}) => new LocalCommentAutomation({
    client, ledger, contactLedger: contacts, accountId: ACCOUNT, mediaId: MEDIA, messageText: MESSAGE,
    publicReplies: options.publicReplies || [], reconciledComments: recovered,
    preflight: { diagnosticComplete: true, protectedCount: recovered.length, accountId: ACCOUNT, mediaId: MEDIA },
    clock: () => now, allowInMemory: true, accountUsername: 'example.owner', ...options.engineOptions, ...overrides,
  });
  const engine = makeEngine();
  return { engine, makeEngine, ledger, contacts, client, sends, publicSends, reads: () => reads,
    setRows: value => { rows = value; }, setTruncated: value => { truncated = value; },
    advance: (amount = MINUTE) => { now += amount; }, now: () => now };
}

test('engine starts disabled and requires confirmed private preflight and recovered protection', async () => {
  const fx = await fixture({ engineOptions: { preflight: {} } });
  assert.equal(fx.engine.status().state, 'disabled');
  await fx.engine.pollOnce();
  assert.equal(fx.reads(), 0);
  assert.equal((await fx.engine.start()).reviewReason, 'PREFLIGHT_REQUIRED');
  assert.equal(fx.sends.length, 0);
});

test('activation baseline never sends historical comments; empty or incomplete recovery stays paused', async () => {
  const fx = await fixture();
  fx.setRows([...baseline(), comment('102', 'historico', NOW - 1000, { fromId: '8888' })]);
  assert.equal((await fx.engine.start()).running, true);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.engine.status().baselineCount, 2);
  assert.equal(fx.sends.length, 0);
  fx.engine.stop();
  const empty = await fixture(); empty.setRows([]);
  assert.equal((await empty.engine.start()).reviewReason, 'RECOVERY_NOT_VISIBLE');
  assert.equal(empty.sends.length, 0);
});

test('truncated reads pause both activation and active polling without partial sends', async () => {
  const fx = await fixture(); fx.setTruncated(true);
  assert.equal((await fx.engine.start()).reviewReason, 'SNAPSHOT_INCOMPLETE');
  fx.setTruncated(false); await fx.engine.start();
  fx.setRows([...baseline(), comment('102', 'novo', NOW + 1000)]);
  fx.setTruncated(true); fx.advance();
  assert.equal((await fx.engine.pollOnce()).running, false);
  assert.equal(fx.sends.length, 0);
});

test('loss of all previously visible comments pauses an active engine without interpreting empty as eligible', async () => {
  const fx = await fixture(); await fx.engine.start(); fx.advance(); fx.setRows([]);
  const result = await fx.engine.pollOnce();
  assert.equal(result.state, 'review');
  assert.equal(result.reviewReason, 'COMMENT_VISIBILITY_DEGRADED');
  assert.equal(result.acceptedCount, 0);
  assert.equal(fx.sends.length, 0);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.reads(), 2);
});

test('new eligible comment sends both configured links once, with optional public reply after acknowledgement', async () => {
  const fx = await fixture({ publicReplies: ['Enviei os links no Direct.'] });
  await fx.engine.start();
  fx.setRows([...baseline(), comment('102', 'novo', NOW + 1000, { fromId: '555' })]);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 1);
  assert.equal(fx.sends[0].text, MESSAGE);
  assert.deepEqual(fx.sends[0].settings, { commentCreatedAt: NOW + 1000 });
  assert.equal(fx.publicSends.length, 1);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 1);
  assert.equal(fx.engine.status().acceptedCount, 1);
  assert.equal(fx.engine.status().publicAcceptedCount, 1);
  assert.equal(JSON.stringify(fx.engine.status()).includes(MESSAGE), false);
  fx.engine.stop();
});

test('manual campaign protection blocks another comment by stable ID or conservative username fallback', async () => {
  const fx = await fixture(); await fx.engine.start();
  fx.setRows([...baseline(),
    comment('102', 'renomeado', NOW + 1000, { fromId: '999' }),
    comment('103', 'RECUPERADO', NOW + 2000),
  ]);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 0);
  assert.equal(fx.engine.status().skippedCount, 2);
  fx.engine.stop();
});

test('nested, own, future, pre-activation and expired comments are not sent', async () => {
  const fx = await fixture(); await fx.engine.start();
  fx.setRows([...baseline(),
    comment('102', 'nested', NOW + 1000, { parentId: '101' }),
    comment('103', 'example.owner', NOW + 1000),
    comment('104', 'own_id', NOW + 1000, { fromId: ACCOUNT }),
    comment('105', 'future', NOW + 2 * MINUTE),
    comment('106', 'hidden_old', NOW - 1000),
    comment('108', 'activation_boundary', NOW),
  ]);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 0);
  fx.advance(8 * 86400000);
  fx.setRows([...baseline(), comment('107', 'expired', NOW + 1000)]);
  await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 0);
  fx.engine.stop();
});

test('missing recovered protection or durable contact storage prevents activation before any read', async () => {
  const noStorage = await fixture({ engineOptions: { allowInMemory: false } });
  assert.equal((await noStorage.engine.start()).reviewReason, 'AUTOMATION_STORAGE_REQUIRED');
  assert.equal(noStorage.reads(), 0);
  const noProtection = await fixture({ engineOptions: { ledger: new SendLedger() } });
  assert.equal((await noProtection.engine.start()).reviewReason, 'RECOVERY_UNPROTECTED');
  assert.equal(noProtection.reads(), 0);
});

test('two new comments by the same person produce one first DM for the campaign', async () => {
  const fx = await fixture(); await fx.engine.start();
  fx.setRows([...baseline(), comment('102', 'primeiro_nome', NOW + 1000, { fromId: '555' }),
    comment('103', 'nome_atual', NOW + 2000, { fromId: '555' })]);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 1);
  assert.equal(fx.engine.status().skippedCount, 1);
  fx.engine.stop();
});

test('five per poll and one-minute throttle keep later new comments queued for the next cycle', async () => {
  const fx = await fixture(); await fx.engine.start();
  fx.setRows([...baseline(), ...Array.from({ length: 6 }, (_, index) => comment(String(200 + index), `pessoa_${index}`, NOW + 1000, { fromId: String(300 + index) }))]);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 5);
  const reads = fx.reads(); await fx.engine.pollOnce();
  assert.equal(fx.reads(), reads);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 6);
  fx.engine.stop();
});

test('unknown result quarantines contact, stops polling and never issues a public reply or automatic retry', async () => {
  const fx = await fixture({ publicReplies: ['Enviei.'], send: async () => { throw Object.assign(new Error('secret transport detail'), { code: 'NETWORK_TIMEOUT', outcome: 'unknown' }); } });
  await fx.engine.start(); fx.advance();
  fx.setRows([...baseline(), comment('102', 'novo', NOW + 1000, { fromId: '555' })]);
  const result = await fx.engine.pollOnce();
  assert.equal(result.unknownCount, 1);
  assert.equal(result.reviewReason, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(fx.publicSends.length, 0);
  assert.equal(JSON.stringify(result).includes('secret transport detail'), false);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 1);
  await assert.rejects(fx.contacts.reserve(ACCOUNT, MEDIA, { commentId: '103', username: 'novo', fromId: '555' }), { code: 'CONTACT_ALREADY_PROTECTED' });
});

test('rejected contact is quarantined while other contacts may continue; malformed acknowledgement pauses', async () => {
  const fx = await fixture({ send: async id => {
    if (id === '102') throw Object.assign(new Error('provider text'), { code: 'GRAPH_REJECTED', outcome: 'rejected', graphCode: 551 });
    return { outcome: 'accepted', messageId: `message-${id}`, recipientId: '777' };
  } });
  await fx.engine.start(); fx.advance();
  fx.setRows([...baseline(), comment('102', 'blocked_user', NOW + 1000), comment('103', 'other', NOW + 1000)]);
  await fx.engine.pollOnce();
  assert.equal(fx.engine.status().rejectedCount, 1);
  assert.equal(fx.engine.status().acceptedCount, 1);
  fx.engine.stop();
  const malformed = await fixture({ send: async () => ({ outcome: 'accepted' }) });
  await malformed.engine.start(); malformed.advance(); malformed.setRows([...baseline(), comment('102', 'novo', NOW + 1000)]);
  assert.equal((await malformed.engine.pollOnce()).reviewReason, 'SEND_OUTCOME_UNKNOWN');
});

test('documented Graph rate-limit errors halt the cycle before the next recipient without retry', async () => {
  for (const graphCode of [4, 17, 32, 613, 80002]) {
    const fx = await fixture({ send: async () => { throw Object.assign(new Error('do not expose provider text'), {
      code: 'GRAPH_REJECTED', outcome: 'rejected', graphCode,
    }); } });
    await fx.engine.start(); fx.advance();
    fx.setRows([...baseline(), comment('102', 'primeiro', NOW + 1000), comment('103', 'segundo', NOW + 1000)]);
    const result = await fx.engine.pollOnce();
    assert.equal(result.reviewReason, 'RATE_LIMIT_REJECTED');
    assert.equal(result.rejectedCount, 1);
    assert.equal(fx.sends.length, 1);
    fx.advance(); await fx.engine.pollOnce();
    assert.equal(fx.sends.length, 1);
  }
});

test('concurrent poll calls serialize; stop during private send preserves truthful acceptance and prevents public/new sends', async () => {
  let release;
  const fx = await fixture({ publicReplies: ['Enviei.'], send: () => new Promise(resolve => { release = () => resolve({ outcome: 'accepted', messageId: 'message-live', recipientId: '777' }); }) });
  await fx.engine.start(); fx.advance();
  fx.setRows([...baseline(), comment('102', 'novo', NOW + 1000), comment('103', 'outro', NOW + 1000)]);
  const first = fx.engine.pollOnce(); const second = fx.engine.pollOnce();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.sends.length, 1);
  fx.engine.stop(); release();
  await Promise.all([first, second]);
  assert.equal(fx.engine.status().state, 'stopped');
  assert.equal(fx.engine.status().acceptedCount, 1);
  assert.equal(fx.publicSends.length, 0);
  assert.equal(fx.sends.length, 1);
});

test('durable campaign aliases survive restart and files are private; no message bodies are persisted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benion-contact-test-'));
  try {
    const contacts = new CampaignContactLedger({ directory, clock: () => NOW });
    const attempt = await contacts.reserve(ACCOUNT, MEDIA, { commentId: '102', username: 'novo', fromId: '555' });
    await contacts.finish(attempt, 'accepted', { messageId: 'message-102', recipientId: '777' });
    const restarted = new CampaignContactLedger({ directory });
    await assert.rejects(restarted.reserve(ACCOUNT, MEDIA, { commentId: '103', username: 'renamed', fromId: '555' }), { code: 'CONTACT_ALREADY_PROTECTED' });
    await assert.rejects(restarted.reserve(ACCOUNT, MEDIA, { commentId: '104', username: 'NOVO' }), { code: 'CONTACT_ALREADY_PROTECTED' });
    for (const file of await readdir(directory)) {
      assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o600);
      assert.equal((await readFile(path.join(directory, file), 'utf8')).includes(MESSAGE), false);
    }
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real GraphClient transport remains GET until a new eligible comment and reserves both ledgers before POST', async () => {
  const fx = await fixture(); let rows = baseline(); const methods = [];
  const client = new GraphClient({ accountId: ACCOUNT, accessToken: 'test-token-never-real', apiVersion: 'v26.0', ledger: fx.ledger,
    clock: fx.now, fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'GET') return response({ data: rows.map(row => ({ id: row.id, timestamp: row.timestamp, text: 'quero', username: row.username, from: { id: row.fromId } })) });
      await assert.rejects(fx.contacts.reserve(ACCOUNT, MEDIA, { commentId: '9999', username: 'novo', fromId: '555' }), { code: 'CONTACT_ALREADY_PROTECTED' });
      assert.equal((await fx.ledger.get(ACCOUNT, 'private', '102')).status, 'inflight');
      return response({ message_id: 'ack-102', recipient_id: '777' });
    } });
  const engine = new LocalCommentAutomation({ client, ledger: fx.ledger, contactLedger: fx.contacts, accountId: ACCOUNT, mediaId: MEDIA,
    messageText: MESSAGE, reconciledComments: [manual], preflight: { diagnosticComplete: true, protectedCount: 1, accountId: ACCOUNT, mediaId: MEDIA },
    clock: fx.now, allowInMemory: true });
  await engine.start(); assert.deepEqual(methods, ['GET']);
  rows = [...baseline(), comment('102', 'novo', NOW + 1000, { fromId: '555' })]; fx.advance();
  await engine.pollOnce(); assert.deepEqual(methods, ['GET', 'GET', 'POST']);
  assert.equal((await fx.ledger.get(ACCOUNT, 'private', '102')).status, 'sent');
  engine.stop();
});

function futureRecovery() {
  return Array.from({ length: 11 }, (_, index) => ({ commentId: String(1000 + index), username: `historic_${index}`,
    ...(index < 10 ? { fromId: String(9000 + index) } : {}) }));
}
function futureRows(recovered = futureRecovery()) {
  return recovered.slice(0, 10).map(item => comment(item.commentId, item.username, NOW - MINUTE, { fromId: item.fromId }));
}
function futurePreflight(extra = {}) {
  return { diagnosticComplete: false, futureOnlyReady: true, protectedCount: 11, accountId: ACCOUNT, mediaId: MEDIA, checkedAt: NOW, ...extra };
}

test('future-only baseline protects eleven histories with ten visible and never backfills a missing/reappearing ID', async () => {
  const recovered = futureRecovery();
  const fx = await fixture({ reconciledComments: recovered, rows: futureRows(recovered), engineOptions: { preflight: futurePreflight() } });
  assert.equal((await fx.engine.start()).running, true);
  assert.equal(fx.engine.status().baselineCount, 10);
  assert.equal(fx.sends.length, 0);
  fx.setRows([...futureRows(recovered),
    comment('1010', 'name_changed', NOW + 1000, { fromId: '7777' }),
    comment('8000', 'HISTORIC_10', NOW + 1000, { fromId: '8888' }),
    comment('8001', 'renamed_known_author', NOW + 1000, { fromId: '9000' }),
    comment('8002', 'old_newly_visible', NOW - 1000, { fromId: '8889' }),
    comment('8003', 'new_person', NOW + 1000, { fromId: '8890' }),
  ]);
  fx.advance(); await fx.engine.pollOnce();
  assert.deepEqual(fx.sends.map(item => item.commentId), ['8003']);
  assert.equal((await fx.ledger.get(ACCOUNT, 'private', '1010')).outcome, 'external_handled');
  fx.engine.stop();
});

test('same username on a different historical ID never remaps the absent author canonical ID', async () => {
  const recovered = futureRecovery();
  const rows = [...futureRows(recovered), comment('7770', 'historic_10', NOW - MINUTE, { fromId: '7777' })];
  const fx = await fixture({ reconciledComments: recovered, rows, engineOptions: { preflight: futurePreflight() } });
  await fx.engine.start();
  // The literal username remains a refusal alias, but no ID is invented from 7770.
  const reservation = await fx.contacts.reserve(ACCOUNT, MEDIA, { commentId: '7771', username: 'unrelated_name', fromId: '7777' });
  await fx.contacts.finish(reservation, 'protected');
  await assert.rejects(fx.contacts.reserve(ACCOUNT, MEDIA, { commentId: '7772', username: 'historic_10', fromId: '9999' }), { code: 'CONTACT_ALREADY_PROTECTED' });
  fx.engine.stop();
});

test('future-only scope, fresh preflight, durable handled evidence and complete fresh snapshot are still required', async () => {
  for (const extra of [{ checkedAt: NOW - 15 * MINUTE - 1 }, { checkedAt: NOW + 1 }, { checkedAt: undefined }, { accountId: '123' }, { protectedCount: 10 }]) {
    const fx = await fixture({ reconciledComments: futureRecovery(), rows: futureRows(), engineOptions: { preflight: futurePreflight(extra) } });
    assert.equal((await fx.engine.start()).reviewReason, 'PREFLIGHT_REQUIRED');
    assert.equal(fx.reads(), 0); assert.equal(fx.sends.length, 0);
  }
  const empty = await fixture({ reconciledComments: futureRecovery(), rows: [], engineOptions: { preflight: futurePreflight() } });
  assert.equal((await empty.engine.start()).reviewReason, 'COMMENT_VISIBILITY_UNVERIFIED');
  const truncated = await fixture({ reconciledComments: futureRecovery(), rows: futureRows(), engineOptions: { preflight: futurePreflight() } });
  truncated.setTruncated(true);
  assert.equal((await truncated.engine.start()).reviewReason, 'SNAPSHOT_INCOMPLETE');
  const conflictRows = futureRows(); conflictRows[0].fromId = '99999';
  const conflicting = await fixture({ reconciledComments: futureRecovery(), rows: conflictRows, engineOptions: { preflight: futurePreflight() } });
  assert.equal((await conflicting.engine.start()).reviewReason, 'AUTHOR_IDENTITY_CONFLICT');
});

test('durable public intent precedes private POST and completes the original text after explicit restart without another DM', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benion-public-intent-test-'));
  let release;
  const publicText = 'Te enviei uma DM com os links.';
  const contacts = new CampaignContactLedger({ directory, clock: () => NOW });
  const fx = await fixture({ contacts, publicReplies: [publicText], send: async () => {
    const intents = await contacts.listPublicReplies(ACCOUNT, MEDIA);
    assert.equal(intents.length, 1); assert.equal(intents[0].status, 'pending'); assert.equal(intents[0].text, publicText);
    return new Promise(resolve => { release = () => resolve({ outcome: 'accepted', messageId: 'ack-durable', recipientId: '777' }); });
  } });
  try {
    await fx.engine.start(); fx.advance(); fx.setRows([...baseline(), comment('102', 'novo', NOW + 1000, { fromId: '555' })]);
    const poll = fx.engine.pollOnce();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    fx.engine.stop(); release(); await poll;
    assert.equal(fx.publicSends.length, 0);
    assert.equal((await contacts.listPublicReplies(ACCOUNT, MEDIA))[0].status, 'pending');
    const restartedContacts = new CampaignContactLedger({ directory, clock: fx.now });
    const restarted = fx.makeEngine({ contactLedger: restartedContacts, publicReplies: ['Texto alterado depois.'] });
    const readCount = fx.reads();
    assert.equal(restarted.status().running, false);
    await restarted.pollOnce(); assert.equal(fx.reads(), readCount); assert.equal(fx.publicSends.length, 0);
    await restarted.start(); assert.equal(fx.publicSends.length, 0);
    fx.advance(); await restarted.pollOnce();
    assert.equal(fx.sends.length, 1);
    assert.deepEqual(fx.publicSends, [{ commentId: '102', text: publicText }]);
    assert.equal((await restartedContacts.listPublicReplies(ACCOUNT, MEDIA))[0].status, 'accepted');
    fx.advance(); await restarted.pollOnce(); assert.equal(fx.publicSends.length, 1);
    restarted.stop();
    for (const file of await readdir(directory)) assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o600);
  } finally { fx.engine.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('pending public work cannot send without verified private acknowledgement or with public replies disabled', async () => {
  const fx = await fixture({ publicReplies: ['Resposta.'] });
  await fx.contacts.reservePublicReply(ACCOUNT, MEDIA, '102', 'Resposta original.');
  await fx.engine.start(); fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.publicSends.length, 0); assert.equal(fx.sends.length, 0);
  const attempt = await fx.ledger.reserve(ACCOUNT, 'private', '102');
  await fx.ledger.finish(attempt, { status: 'sent', outcome: 'accepted', messageId: 'ack', recipientId: '777' });
  fx.engine.stop();
  const disabled = fx.makeEngine({ publicReplies: [] });
  await disabled.start(); fx.advance(); await disabled.pollOnce();
  assert.equal(fx.publicSends.length, 0);
  disabled.stop();
});

test('public inflight, unknown, rejected or malformed acknowledgement is quarantined and never repeated', async () => {
  for (const outcome of ['unknown', 'rejected', 'malformed']) {
    const fx = await fixture({ publicReplies: ['Resposta.'], publicSend: async () => {
      if (outcome === 'malformed') return { outcome: 'accepted', commentReplyId: '' };
      throw Object.assign(new Error('safe fake failure'), { code: 'GRAPH_REJECTED', outcome });
    } });
    await fx.engine.start(); fx.advance(); fx.setRows([...baseline(), comment('102', 'novo', NOW + 1000, { fromId: '555' })]);
    await fx.engine.pollOnce();
    assert.equal(fx.engine.status().reviewReason, 'PUBLIC_REPLY_REQUIRES_REVIEW');
    fx.engine.stop(); const restarted = fx.makeEngine(); await restarted.start(); fx.advance(); await restarted.pollOnce();
    assert.equal(fx.sends.length, 1); assert.equal(fx.publicSends.length, 1); restarted.stop();
  }
  const fx = await fixture({ publicReplies: ['Resposta.'] });
  const pending = await fx.contacts.reservePublicReply(ACCOUNT, MEDIA, '102', 'Resposta.');
  await fx.contacts.finishPublicReply(pending, 'inflight');
  const privateAttempt = await fx.ledger.reserve(ACCOUNT, 'private', '102');
  await fx.ledger.finish(privateAttempt, { status: 'sent', outcome: 'accepted', messageId: 'ack', recipientId: '777' });
  await fx.engine.start(); fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.engine.status().reviewReason, 'PUBLIC_REPLY_REQUIRES_REVIEW');
  assert.equal(fx.publicSends.length, 0); assert.equal(fx.sends.length, 0);
  fx.engine.stop();
});

test('resumed public intents and fresh private sends share at most five public attempts per poll', async () => {
  const fx = await fixture({ publicReplies: ['Resposta.'] });
  for (let index = 0; index < 5; index++) {
    const commentId = String(7000 + index);
    await fx.contacts.reservePublicReply(ACCOUNT, MEDIA, commentId, 'Resposta anterior.');
    const reservation = await fx.ledger.reserve(ACCOUNT, 'private', commentId);
    await fx.ledger.finish(reservation, { status: 'sent', outcome: 'accepted', messageId: `ack-${index}`, recipientId: '777' });
  }
  await fx.engine.start(); fx.advance();
  fx.setRows([...baseline(), ...Array.from({ length: 5 }, (_, index) => comment(String(8000 + index), `novo_${index}`, NOW + 1000, { fromId: String(6000 + index) }))]);
  await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 5); assert.equal(fx.publicSends.length, 5);
  assert.equal((await fx.contacts.listPublicReplies(ACCOUNT, MEDIA)).filter(item => item.status === 'pending').length, 5);
  fx.advance(); await fx.engine.pollOnce();
  assert.equal(fx.sends.length, 5); assert.equal(fx.publicSends.length, 10);
  fx.engine.stop();
});

test('durable public claims are exclusive across ledger instances before the public POST', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benion-public-claim-test-'));
  try {
    const first = new CampaignContactLedger({ directory });
    const second = new CampaignContactLedger({ directory });
    const intent = await first.reservePublicReply(ACCOUNT, MEDIA, '102', 'Resposta.');
    const results = await Promise.allSettled([first.finishPublicReply(intent, 'inflight'), second.finishPublicReply(intent, 'inflight')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failed = results.find(result => result.status === 'rejected');
    assert.ok(['PUBLIC_INTENT_BUSY', 'PUBLIC_INTENT_CONFLICT'].includes(failed.reason.code));
    assert.equal((await first.listPublicReplies(ACCOUNT, MEDIA))[0].status, 'inflight');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
