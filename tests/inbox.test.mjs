import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InboxService, normalizeInstagramWebhook } from '../inbox.mjs';
import { SendLedger, GraphClient, MetaError } from '../integrations/meta.mjs';
import { CatalogStore, AssistantConfigStore, SalesAssistant } from '../sales.mjs';

const NOW = Date.parse('2026-10-02T15:00:00Z');
const ACCOUNT = '100'; const CONTACT = '200';
const OPTIONS = { signatureVerified: true, verifiedAccountId: ACCOUNT, receivedAt: NOW };
const eligibility = { faq: { eligible: true, reason: '' }, sales: { eligible: true, reason: '' }, story: { eligible: true, reason: '' }, follower: { eligible: false, reason: '' } };
function config() { return { enabled: true, faqEnabled: true, salesEnabled: true, storyEnabled: true, eligibility }; }
function webhook(input = {}) {
  const { mid = 'm_in', text: supplied, at = NOW - 1000, sender = CONTACT, recipient = ACCOUNT, ...extra } = input;
  const text = Object.hasOwn(input, 'text') ? supplied : 'Oi';
  return { object: 'instagram', entry: [{ id: ACCOUNT, time: NOW, messaging: [{ sender: { id: sender }, recipient: { id: recipient }, timestamp: at, message: { mid, ...(text === undefined ? {} : { text }), ...extra } }] }] };
}
function fixture({ decision, send, enabled = true, dataDir = null, clock = () => NOW } = {}) {
  const current = { ...config(), enabled }; const calls = []; let decisions = 0;
  const assistant = { getConfig: async () => structuredClone(current), makeDecision: async context => { decisions++; return decision ? decision(context) : { action: 'reply', feature: 'faq', text: 'Informação cadastrada.' }; } };
  const client = { sendContinuation: async (...args) => { calls.push(args); return send ? send(...args) : { outcome: 'accepted', recipientId: args[1], messageId: `m_out_${calls.length}` }; } };
  const service = new InboxService({ dataDir, allowInMemory: true, clock, assistant, clientProvider: async () => ({ client, identity: { userId: ACCOUNT } }) });
  return { service, calls, current, get decisions() { return decisions; } };
}
async function threadId(service) { return (await service.list()).threads[0].id; }
async function temporary(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'benion-inbox-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('normalization requires verified signature/account and official recipient/timestamp', () => {
  assert.throws(() => normalizeInstagramWebhook(webhook(), { ...OPTIONS, signatureVerified: false }), { code: 'WEBHOOK_SIGNATURE_REQUIRED' });
  assert.throws(() => normalizeInstagramWebhook(webhook(), { ...OPTIONS, verifiedAccountId: '999' }), { code: 'WEBHOOK_ACCOUNT_MISMATCH' });
  assert.throws(() => normalizeInstagramWebhook(webhook({ recipient: '999' }), OPTIONS), { code: 'INVALID_MESSAGE_EVENT' });
  assert.throws(() => normalizeInstagramWebhook(webhook({ at: NOW + 1 }), OPTIONS), { code: 'INVALID_MESSAGE_EVENT' });
  assert.throws(() => normalizeInstagramWebhook(webhook({ text: '😊'.repeat(1001) }), OPTIONS), { code: 'INVALID_MESSAGE_EVENT' });
  const event = normalizeInstagramWebhook(webhook(), OPTIONS).events[0];
  assert.equal(event.recipientId, CONTACT); assert.equal(event.kind, 'message'); assert.equal(event.messageId, 'm_in');
});

test('official comment variants persist notification metadata without invented creation time; follows never open inbox', async () => {
  const value = { id: '300', from: { id: CONTACT, username: 'owned_commenter' }, text: 'quero', media: { id: '400' } };
  const direct = { object: 'instagram', entry: [{ id: ACCOUNT, time: 1_500_000_000, field: 'comments', value }] };
  const event = normalizeInstagramWebhook(direct, OPTIONS).events[0];
  assert.equal(event.commentCreatedAt, null); assert.equal(event.at, new Date(NOW).toISOString());
  const changes = { object: 'instagram', entry: [{ id: ACCOUNT, changes: [{ field: 'comments', value: { ...value, id: undefined, comment_id: '300', parent_id: '299' } }, { field: 'follows', value: { id: CONTACT } }] }] };
  const normalized = normalizeInstagramWebhook(changes, OPTIONS);
  assert.equal(normalized.events[0].parentId, '299'); assert.equal(normalized.unsupported[0].field, 'follows');
  const f = fixture(); const result = await f.service.ingestWebhook(changes, OPTIONS);
  assert.equal(result.queued, 0); assert.equal((await f.service.list()).threads.length, 0); assert.equal(f.calls.length, 0);
});

test('story shapes normalize without fetching or retaining media URLs; echo/self unsupported do not grant inbound', () => {
  const mention = normalizeInstagramWebhook(webhook({ text: undefined, attachments: [{ type: 'story_mention', payload: { url: 'https://private-cdn.invalid/secret' } }] }), OPTIONS).events[0];
  assert.equal(mention.kind, 'story_mention'); assert.equal(mention.mediaOnly, true); assert.doesNotMatch(JSON.stringify(mention), /cdn|secret/);
  const reply = normalizeInstagramWebhook(webhook({ text: 'quero o link', reply_to: { story: { id: '333', url: 'https://cdn.invalid' } } }), OPTIONS).events[0];
  assert.equal(reply.kind, 'story_reply');
  assert.equal(normalizeInstagramWebhook(webhook({ is_self: true }), OPTIONS).events.length, 0);
  const echo = normalizeInstagramWebhook(webhook({ sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS).events[0]; assert.equal(echo.kind, 'echo');
});

test('ingress persists dedupe before ACK and never runs a model or send; global off does not backfill later', async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.service.ingestWebhook(webhook(), OPTIONS)).queued, 0);
  assert.equal((await f.service.ingestWebhook(webhook(), OPTIONS)).duplicates, 1);
  assert.equal(f.decisions, 0); assert.equal(f.calls.length, 0);
  f.current.enabled = true;
  await f.service.processPending(); assert.equal(f.calls.length, 0);
  await f.service.ingestWebhook(webhook({ mid: 'm_new', at: NOW - 100 }), OPTIONS);
  await f.service.processPending(); assert.equal(f.calls.length, 1);
  assert.equal((await f.service.list()).threads[0].aiEnabled, true);
  assert.equal((await f.service.detail(await threadId(f.service))).messages.filter(message => message.direction === 'outbound')[0].status, 'accepted');
});

test('manual reply is bound to canonical account, trusted latest inbound and UUID, with durable repeat suppression', async () => {
  const f = fixture({ enabled: false }); await f.service.ingestWebhook(webhook(), OPTIONS); const id = await threadId(f.service); const requestId = randomUUID();
  const first = await f.service.reply(id, { text: 'Resposta humana.', requestId });
  const repeat = await f.service.reply(id, { text: 'Resposta humana.', requestId });
  assert.equal(first.outcome, 'accepted'); assert.equal(repeat.duplicate, true); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], ACCOUNT); assert.equal(f.calls[0][1], CONTACT); assert.equal(f.calls[0][3].lastInboundAt, new Date(NOW - 1000).toISOString());
  assert.match(f.calls[0][3].idempotencyKey, /^inbox:[a-f0-9]{64}$/);
  assert.equal((await f.service.detail(id)).thread.handoff, true);
  await assert.rejects(f.service.reply(id, { text: 'Texto diferente', requestId }), { code: 'REQUEST_ID_REUSED' });
  await assert.rejects(f.service.reply(id, { text: 'Texto', requestId: 'unstable' }), { code: 'INVALID_REPLY' });
});

test('exact 24-hour boundary and optout block manual and automatic sends', async () => {
  const f = fixture(); await f.service.ingestWebhook(webhook({ at: NOW - 86_400_000 }), OPTIONS); const id = await threadId(f.service);
  assert.equal((await f.service.detail(id)).permissions.reason, 'WINDOW_CLOSED');
  await assert.rejects(f.service.reply(id, { text: 'Oi', requestId: randomUUID() }), { code: 'WINDOW_CLOSED' });
  await f.service.ingestWebhook(webhook({ mid: 'm_stop', text: 'Não me envie!', at: NOW - 100 }), OPTIONS);
  await assert.rejects(f.service.setAssistant(id, { enabled: true }), { code: 'ASSISTANT_BLOCKED' });
  await assert.rejects(f.service.reply(id, { text: 'Oi', requestId: randomUUID() }), { code: 'CONTACT_OPTED_OUT' });
  await f.service.processPending(); assert.equal(f.calls.length, 0);
});

test('unmatched/manual echoes hand off while accepted own echoes and echo-before-ack keep automation available', async () => {
  const f = fixture(); await f.service.ingestWebhook(webhook(), OPTIONS); await f.service.processPending(); const id = await threadId(f.service);
  await f.service.ingestWebhook(webhook({ mid: 'm_out_1', text: 'Informação cadastrada.', sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS);
  assert.equal((await f.service.detail(id)).thread.handoff, false);
  assert.equal((await f.service.detail(id)).messages.filter(message => message.id === 'm_out_1').length, 1);
  await f.service.ingestWebhook(webhook({ mid: 'm_manual', text: 'Eu assumi.', sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS);
  assert.equal((await f.service.detail(id)).thread.handoff, true);
  const race = fixture({ send: async () => {
    await race.service.ingestWebhook(webhook({ mid: 'm_out_race', text: 'Informação cadastrada.', sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS);
    return { outcome: 'accepted', recipientId: CONTACT, messageId: 'm_out_race' };
  } });
  await race.service.ingestWebhook(webhook(), OPTIONS); await race.service.processPending();
  assert.equal((await race.service.detail(await threadId(race.service))).thread.handoff, false);
});

test('a manual echo while API is inflight remains human takeover after a different acknowledgement', async () => {
  const f = fixture({ send: async () => {
    await f.service.ingestWebhook(webhook({ mid: 'm_external', sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS);
    return { outcome: 'accepted', recipientId: CONTACT, messageId: 'm_api' };
  } });
  await f.service.ingestWebhook(webhook(), OPTIONS); await f.service.processPending();
  assert.equal((await f.service.detail(await threadId(f.service))).thread.handoff, true);
});

test('worker serializes cycles, skips superseded inbounds and rechecks handoff/config/feature/eligibility after decision', async () => {
  for (const change of ['handoff', 'enabled', 'faqEnabled', 'eligible', 'newInbound']) {
    const f = fixture({ decision: async context => {
      if (change === 'newInbound' && context.inboundId === 'm_later') return { action: 'ignore' };
      if (change === 'handoff') await f.service.setHandoff(context.threadId, { enabled: true });
      else if (change === 'newInbound') await f.service.ingestWebhook(webhook({ mid: 'm_later', at: NOW - 100 }), OPTIONS);
      else if (change === 'eligible') f.current.eligibility.faq = { eligible: false, reason: '' };
      else f.current[change] = false;
      return { action: 'reply', feature: 'faq', text: 'Resposta antiga.' };
    } });
    // Fresh independent eligibility object for this case.
    f.current.eligibility = structuredClone(eligibility); f.current.eligibility.faq.eligible = true;
    await f.service.ingestWebhook(webhook(), OPTIONS);
    await Promise.all([f.service.processPending(), f.service.processPending()]);
    assert.equal(f.calls.length, 0, change);
  }
});

test('unknown network outcome quarantines the contact, no repeat POST across restart, and never claims delivery', async t => {
  const dataDir = await temporary(t); const ledgerDir = path.join(dataDir, 'sends'); let posts = 0;
  const client = new GraphClient({ accessToken: 'fake-secret', apiVersion: 'v26.0', accountId: ACCOUNT, ledger: new SendLedger({ directory: ledgerDir }), clock: () => NOW,
    fetchImpl: async () => { posts++; throw new Error('fake-secret upstream URL'); } });
  const assistant = { getConfig: async () => config(), makeDecision: async () => ({ action: 'reply', feature: 'faq', text: 'Resposta cadastrada.' }) };
  const create = () => new InboxService({ dataDir, assistant, clock: () => NOW, clientProvider: async () => ({ client, identity: { userId: ACCOUNT } }) });
  const service = create(); await service.ingestWebhook(webhook(), OPTIONS); await service.processPending(); const id = await threadId(service);
  assert.equal((await service.detail(id)).permissions.reason, 'OUTCOME_REQUIRES_REVIEW');
  const restarted = create(); await restarted.processPending(); assert.equal(posts, 1); assert.equal((await restarted.status()).unknown, 1);
  await assert.rejects(restarted.reply(id, { text: 'Não repetir', requestId: randomUUID() }), { code: 'OUTCOME_REQUIRES_REVIEW' });
  assert.doesNotMatch(JSON.stringify(await restarted.detail(id)), /fake-secret|delivered|upstream/);
});

test('Graph rate/permission refusal stops worker before another recipient; malformed acceptance quarantines', async () => {
  const f = fixture({ send: async () => { throw new MetaError('GRAPH_REJECTED', 'safe', { outcome: 'rejected', graphCode: 80002 }); } });
  await f.service.ingestWebhook(webhook(), OPTIONS); await f.service.ingestWebhook(webhook({ sender: '201', mid: 'm_other' }), OPTIONS);
  await f.service.processPending(); assert.equal(f.calls.length, 1); assert.equal((await f.service.status()).reviewReason, 'META_REJECTION_REQUIRES_REVIEW');
  const invalid = fixture({ send: async () => ({ outcome: 'accepted', recipientId: '999', messageId: 'm_wrong' }) });
  await invalid.service.ingestWebhook(webhook(), OPTIONS); await invalid.service.processPending();
  assert.equal((await invalid.service.status()).unknown, 1);
});

test('durable pending jobs survive restart; processing jobs remain blocked and private state is 0700/0600', async t => {
  const dataDir = await temporary(t); const first = fixture({ dataDir }); await first.service.ingestWebhook(webhook(), OPTIONS);
  const file = path.join(dataDir, 'inbox', 'inbox-state.json');
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const second = fixture({ dataDir }); await second.service.processPending(); assert.equal(second.calls.length, 1);
  await second.service.ingestWebhook(webhook({ mid: 'm_crash', at: NOW - 100 }), OPTIONS);
  const state = JSON.parse(await readFile(file, 'utf8')); const pending = Object.values(state.jobs).find(job => job.status === 'pending'); pending.status = 'processing';
  await writeFile(file, JSON.stringify(state));
  const third = fixture({ dataDir }); await third.service.processPending(); assert.equal(third.calls.length, 0); assert.equal((await third.service.status()).processing, 1);
  assert.doesNotMatch(await readFile(file, 'utf8'), /accessToken|Authorization|apiKey/);
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['inbox-state.json']);
});

test('story mention attachment without text receives grounded acknowledgement only with story eligibility', async () => {
  const catalog = new CatalogStore({ initialProducts: [{ id: 'example-app', name: 'Example App', description: 'App de anúncios.', facts: [], url: 'https://example.com/app' }] });
  const configStore = new AssistantConfigStore({ eligibilityProvider: () => eligibility, clock: () => NOW - 2000 });
  await configStore.set({ enabled: true, storyEnabled: true });
  const assistant = new SalesAssistant({ catalogStore: catalog, configStore }); let calls = 0;
  const service = new InboxService({ allowInMemory: true, assistant, clock: () => NOW, clientProvider: async () => ({ identity: { userId: ACCOUNT }, client: { sendContinuation: async () => { calls++; return { outcome: 'accepted', recipientId: CONTACT, messageId: 'm_story_ack' }; } } }) });
  const body = webhook({ text: undefined, attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.invalid/no-fetch' } }] });
  await service.ingestWebhook(body, OPTIONS); await service.processPending(); assert.equal(calls, 1);
  const detail = await service.detail(await threadId(service)); assert.match(detail.messages.at(-1).text, /Valeu pela menção/); assert.doesNotMatch(detail.messages.at(-1).text, /vi|imagem|foto|vídeo/);
  await configStore.set({ storyEnabled: false });
  await service.ingestWebhook(webhook({ mid: 'm_story_disabled', text: undefined, attachments: [{ type: 'story_mention' }] }), OPTIONS); await service.processPending(); assert.equal(calls, 1);
});

test('shutdown waits for one inflight decision/send and leaves the next durable job untouched', async () => {
  let resolveDecision; const waiting = new Promise(resolve => { resolveDecision = resolve; }); let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = fixture({ decision: async () => { started(); await waiting; return { action: 'reply', feature: 'faq', text: 'Resposta em andamento.' }; } });
  await f.service.ingestWebhook(webhook(), OPTIONS); await f.service.ingestWebhook(webhook({ mid: 'm_second', sender: '201' }), OPTIONS);
  const work = f.service.processPending(); await entered; const closing = f.service.shutdown(); resolveDecision(); await Promise.all([work, closing]);
  assert.equal(f.calls.length, 1); assert.equal((await f.service.status()).pending, 1); assert.equal((await f.service.status()).stopping, true);
  await f.service.processPending(); assert.equal(f.calls.length, 1);
});

test('event evidence excludes echoes/comments and separates actual stories; counters are deduplicated', async () => {
  const f = fixture({ enabled: false });
  await f.service.ingestWebhook(webhook({ mid: 'm_echo_only', sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS);
  assert.equal((await f.service.status()).threads, 1); assert.equal((await f.service.status()).receivedMessageCount, 0);
  await f.service.ingestWebhook(webhook(), OPTIONS); await f.service.ingestWebhook(webhook(), OPTIONS);
  assert.equal((await f.service.status()).receivedMessageCount, 1); assert.equal((await f.service.status()).receivedStoryCount, 0);
  await f.service.ingestWebhook(webhook({ mid: 'm_story_evidence', text: undefined, attachments: [{ type: 'story_mention' }] }), OPTIONS);
  const state = await f.service.status(); assert.equal(state.receivedMessageCount, 2); assert.equal(state.receivedStoryCount, 1);
});

test('restart eligibility absence preserves durable pending jobs until connection is verified again', async t => {
  const dataDir = await temporary(t); const first = fixture({ dataDir }); await first.service.ingestWebhook(webhook(), OPTIONS);
  const second = fixture({ dataDir }); second.current.eligibility = { faq: { eligible: false }, sales: { eligible: false }, story: { eligible: false } };
  const blocked = await second.service.processPending(); assert.equal(blocked.unavailable, true); assert.equal((await second.service.status()).pending, 1); assert.equal(second.calls.length, 0);
  second.current.eligibility = structuredClone(eligibility); await second.service.processPending();
  assert.equal(second.calls.length, 1); assert.equal((await second.service.status()).pending, 0); assert.equal((await second.service.status()).acceptedSendCount, 1);
});

test('inbox exposes customer/bot/human provenance, sending state, attachment flag and deduplicated echo acknowledgement', async () => {
  let finish; let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ send: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  await f.service.ingestWebhook(webhook(), OPTIONS); const id = await threadId(f.service); const work = f.service.processPending(); await started;
  const sending = await f.service.detail(id);
  assert.equal(sending.messages[0].actor, 'customer'); assert.equal(sending.messages.at(-1).actor, 'assistant'); assert.equal(sending.messages.at(-1).status, 'sending');
  assert.equal(sending.thread.sendInProgress, true); assert.equal(sending.thread.quarantine, false); assert.equal((await f.service.list()).status.processing, 1);
  await f.service.ingestWebhook(webhook({ mid: 'm_correlated', sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS);
  finish({ outcome: 'accepted', recipientId: CONTACT, messageId: 'm_correlated' }); await work;
  const accepted = await f.service.detail(id); const outbound = accepted.messages.filter(message => message.direction === 'outbound');
  assert.equal(outbound.length, 1); assert.equal(outbound[0].actor, 'assistant'); assert.equal(outbound[0].status, 'accepted');
  assert.equal(accepted.thread.lastMessageActor, 'assistant'); assert.equal(accepted.thread.sendInProgress, false);
  // A reply entered in Benion has proven human provenance.
  f.calls.length = 0;
  const manual = f.service.reply(id, { text: 'Sou o Bero.', requestId: randomUUID() });
  await new Promise(resolve => setImmediate(resolve)); finish({ outcome: 'accepted', recipientId: CONTACT, messageId: 'm_human' }); await manual;
  assert.equal((await f.service.detail(id)).messages.at(-1).actor, 'human');
  await f.service.ingestWebhook(webhook({ mid: 'm_external', sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS);
  assert.equal((await f.service.detail(id)).messages.find(message => message.id === 'm_external').actor, 'unknown');
  await f.service.ingestWebhook(webhook({ mid: 'm_attachment', text: undefined, attachments: [{ type: 'image' }], at: NOW }), OPTIONS);
  assert.equal((await f.service.detail(id)).messages.find(message => message.id === 'm_attachment').mediaOnly, true);
  assert.equal((await f.service.list()).status.acceptedSendCount, 2);
});

test('human takeover then explicit resume cancels old generation and only a fresh inbound can respond', async () => {
  let release; let entered; let aborted;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ decision: async context => {
    if (context.inboundId === 'm_new') return { action: 'reply', feature: 'faq', text: 'Resposta nova.' };
    entered(); await new Promise(resolve => { release = resolve; }); aborted = context.signal.aborted;
    return { action: 'reply', feature: 'faq', text: 'Resposta antiga.' };
  } });
  await f.service.ingestWebhook(webhook(), OPTIONS); const id = await threadId(f.service); const work = f.service.processPending(); await started;
  await f.service.setHandoff(id, { enabled: true }); await f.service.setAssistant(id, { enabled: true }); release(); await work;
  assert.equal(aborted, true); assert.equal(f.calls.length, 0); assert.equal((await f.service.status()).pending, 0);
  await f.service.ingestWebhook(webhook({ mid: 'm_delayed', at: NOW - 100 }), OPTIONS); await f.service.processPending(); assert.equal(f.calls.length, 0);
  await f.service.ingestWebhook(webhook({ mid: 'm_new', at: NOW }), OPTIONS); await f.service.processPending();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].text, 'Resposta nova.');
});

test('a stale handoff or optout model decision cannot override explicit resume', async () => {
  for (const action of ['handoff', 'optout']) {
    const f = fixture({ decision: async context => {
      await f.service.setHandoff(context.threadId, { enabled: true }); await f.service.setAssistant(context.threadId, { enabled: true });
      return { action, reason: 'stale' };
    } });
    await f.service.ingestWebhook(webhook(), OPTIONS); await f.service.processPending();
    const detail = await f.service.detail(await threadId(f.service)); assert.equal(detail.thread.handoff, false, action); assert.equal(detail.thread.aiEnabled, true, action); assert.equal(detail.thread.optout, false, action);
  }
});

test('global pause/resume at the same clock discards previous jobs and delayed pre-activation webhooks across restart', async t => {
  const dataDir = await temporary(t); let now = NOW - 2000; let decisions = 0; let sends = 0;
  const configStore = new AssistantConfigStore({ dataDir, clock: () => now, eligibilityProvider: () => eligibility });
  await configStore.set({ enabled: true, faqEnabled: true });
  const assistant = { getConfig: () => configStore.get(), isConfigCurrent: epoch => configStore.isCurrent(epoch), makeDecision: async () => { decisions++; return { action: 'reply', feature: 'faq', text: 'Atual.' }; } };
  const create = () => new InboxService({ dataDir, clock: () => now, assistant, clientProvider: async () => ({ identity: { userId: ACCOUNT }, client: { sendContinuation: async () => { sends++; return { outcome: 'accepted', recipientId: CONTACT, messageId: 'm_global_new' }; } } }) });
  now = NOW; const first = create(); await first.ingestWebhook(webhook(), OPTIONS);
  await configStore.set({ enabled: false }); await configStore.set({ enabled: true });
  const restarted = create(); await restarted.processPending(); assert.equal(sends, 0); assert.equal(decisions, 0);
  await restarted.ingestWebhook(webhook({ mid: 'm_late_global', at: NOW - 100 }), OPTIONS); await restarted.processPending(); assert.equal(decisions, 0);
  await restarted.ingestWebhook(webhook({ mid: 'm_current_global', at: NOW }), OPTIONS); await restarted.processPending(); assert.equal(sends, 1); assert.equal(decisions, 1);
});

test('global pause/resume during generation aborts and cannot send the obsolete plan', async () => {
  const configStore = new AssistantConfigStore({ clock: () => NOW - 2000, eligibilityProvider: () => eligibility });
  await configStore.set({ enabled: true, faqEnabled: true }); let entered; let release; let sends = 0; let signal;
  const started = new Promise(resolve => { entered = resolve; });
  const assistant = { getConfig: () => configStore.get(), onConfigChange: callback => configStore.onChange(callback), isConfigCurrent: epoch => configStore.isCurrent(epoch), makeDecision: async context => {
    signal = context.signal; entered(); await new Promise(resolve => { release = resolve; }); return { action: 'reply', feature: 'faq', text: 'Antiga.' };
  } };
  const service = new InboxService({ allowInMemory: true, clock: () => NOW, assistant, clientProvider: async () => ({ identity: { userId: ACCOUNT }, client: { sendContinuation: async () => { sends++; } } }) });
  await service.ingestWebhook(webhook(), OPTIONS); const work = service.processPending(); await started;
  await configStore.set({ enabled: false }); await configStore.set({ enabled: true }); assert.equal(signal.aborted, true); release(); await work; assert.equal(sends, 0);
});

test('handoff during the final async config gate or after durable Meta reservation blocks POST', async () => {
  for (const during of ['config', 'reservation']) {
    const current = config(); let id; let intervene = false; let posts = 0;
    const assistant = { getConfig: async () => { if (during === 'config' && intervene) { intervene = false; await service.setHandoff(id, { enabled: true }); } return current; }, makeDecision: async () => ({ action: 'reply', feature: 'faq', text: 'Resposta.' }) };
    const service = new InboxService({ allowInMemory: true, clock: () => NOW, assistant, clientProvider: async () => {
      if (during === 'config') intervene = true;
      return { identity: { userId: ACCOUNT }, client: { sendContinuation: async (_account, _recipient, _message, options) => {
        await service.setHandoff(id, { enabled: true });
        try { await options.beforeSend(); } catch { throw new MetaError('SEND_GATE_CHANGED', 'safe', { outcome: 'rejected' }); }
        posts++; return { outcome: 'accepted', recipientId: CONTACT, messageId: 'm_bad' };
      } } };
    } });
    await service.ingestWebhook(webhook(), OPTIONS); id = await threadId(service); await service.processPending(); assert.equal(posts, 0, during);
    assert.equal((await service.detail(id)).messages.at(-1).status, 'rejected');
  }
});

test('verified real-runtime provider requirement blocks deterministic replies when the configured provider is unavailable', async () => {
  const f = fixture(); f.current.providerRequired = true;
  let index = 0;
  for (const provider of [{ configured: false }, { configured: true, name: 'openai', model: 'gpt-6-luna' }, { configured: true, name: 'openrouter', model: 'wrong' }]) {
    f.current.provider = provider; await f.service.ingestWebhook(webhook({ mid: `m_provider_${index++}` }), OPTIONS); await f.service.processPending();
  }
  assert.equal(f.decisions, 0); assert.equal(f.calls.length, 0);
});

test('a new inbound MID in the same millisecond supersedes the earlier message', async () => {
  const f = fixture(); await f.service.ingestWebhook(webhook({ mid: 'm_same_1' }), OPTIONS); await f.service.ingestWebhook(webhook({ mid: 'm_same_2' }), OPTIONS);
  await f.service.processPending(); assert.equal(f.decisions, 1); assert.equal(f.calls.length, 1); assert.equal((await f.service.getContext(await threadId(f.service))).inboundId, 'm_same_2');
});

test('pending or rejected outbound text is visible for review but excluded from model conversation history', async () => {
  let entered; let finish; const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ send: async () => { entered(); await new Promise(resolve => { finish = resolve; }); throw new MetaError('GRAPH_REJECTED', 'safe', { outcome: 'rejected' }); } });
  await f.service.ingestWebhook(webhook(), OPTIONS); const id = await threadId(f.service); const work = f.service.processPending(); await started;
  assert.equal((await f.service.detail(id)).messages.at(-1).status, 'sending'); assert.equal((await f.service.getContext(id)).messages.length, 1);
  finish(); await work; assert.equal((await f.service.detail(id)).messages.at(-1).status, 'rejected'); assert.equal((await f.service.getContext(id)).messages.length, 1);
});

test('an unmatched external echo observed before POST cancels the reserved bot send and hands over', async () => {
  const current = config(); let posts = 0; let id;
  const service = new InboxService({ allowInMemory: true, clock: () => NOW,
    assistant: { getConfig: async () => current, makeDecision: async () => ({ action: 'reply', feature: 'faq', text: 'Bot.' }) },
    clientProvider: async () => {
      await service.ingestWebhook(webhook({ mid: 'm_external_before_post', sender: ACCOUNT, recipient: CONTACT, is_echo: true }), OPTIONS);
      return { identity: { userId: ACCOUNT }, client: { sendContinuation: async () => { posts++; } } };
    } });
  await service.ingestWebhook(webhook(), OPTIONS); id = await threadId(service); await service.processPending(); assert.equal(posts, 0);
  const detail = await service.detail(id); assert.equal(detail.thread.handoff, true); assert.equal(detail.messages.at(-1).status, 'rejected');
});

test('obsolete global generations are purged together so a fresh DM does not wait behind the send limit', async () => {
  const f = fixture(); f.current.activationEpoch = randomUUID();
  for (let index = 0; index < 20; index++) await f.service.ingestWebhook(webhook({ mid: `m_old_epoch_${index}`, sender: String(300 + index) }), OPTIONS);
  f.current.activationEpoch = randomUUID();
  await f.service.ingestWebhook(webhook({ mid: 'm_fresh_epoch' }), OPTIONS); await f.service.processPending({ maximum: 1 });
  assert.equal(f.decisions, 1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], CONTACT); assert.equal((await f.service.status()).pending, 0);
});

test('expired pending jobs after downtime do not delay a fresh DM behind the per-cycle send limit', async () => {
  let now = NOW; const f = fixture({ clock: () => now });
  for (let index = 0; index < 20; index++) await f.service.ingestWebhook(webhook({ mid: `m_expired_${index}`, sender: String(300 + index) }), OPTIONS);
  now += 86_401_000;
  await f.service.ingestWebhook(webhook({ mid: 'm_after_downtime', at: now }), OPTIONS); await f.service.processPending({ maximum: 1 });
  assert.equal(f.decisions, 1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], CONTACT); assert.equal((await f.service.status()).pending, 0);
});
