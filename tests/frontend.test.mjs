import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import * as simulator from '../simulator.mjs';

const apiSource = (await readFile(new URL('../ui/api.mjs', import.meta.url), 'utf8')).replace('export function', 'function');
const source = apiSource + '\n' + (await readFile(new URL('../app.mjs', import.meta.url), 'utf8')).replace(/^import .*?;\n/gm, '') + '';
const simulatorBindings = 'const { DEFAULT_FLOW, HOUR, DAY, validateFlow, createSession, addComment, receiveInteraction, sendContinuation, advanceClock, takeOver, windowRemaining } = __simulator;\n';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// DOM stand-ins exercise controller decisions; rendered layout is checked separately in the browser.
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.value = ''; this._text = ''; this.hidden = false; this.disabled = false; this.checked = false; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.scrollWidth = 0; this.clientWidth = 0; this.offsetWidth = 100; this.offsetParent = {}; this.attributes = {}; this.classes = new Set(); this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name), add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) }; }
  get textContent() { return this._text + this.children.map(node => typeof node === 'object' ? node.textContent || '' : String(node)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { for (const node of nodes) { if (node && typeof node === 'object') node.parentElement = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes) if (node && typeof node === 'object') node.parentElement = this; this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  contains(node) { return this === node || this.children.some(child => child === node || child.contains?.(node)); }
  before(node) { this.parentElement?.prepend(node); }
  after(node) { this.parentElement?.append(node); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  closest(selector) { return ['.field', '.file-drop'].includes(selector) ? this.parentElement : null; }
  querySelector(selector) { if (selector === 'h1') return this.heading ||= new Node('h1'); return this.children.find(node => selector === '.button-label' && node.className === 'button-label') || null; }
  querySelectorAll(selector) { const all = []; const visit = node => { if (!node || typeof node !== 'object') return; if (selector === '[data-product-field]' && node.dataset?.productField) all.push(node); node.children?.forEach(visit); }; this.children.forEach(visit); return all; }
  focus() {} select() {} showModal() {} close() {} scrollTo() {} scrollIntoView() {}
}
function setup(onFetch = async () => null) {
  const nodes = new Map([...html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)].map(match => { const node = new Node(); node.disabled = /\sdisabled(?:\s|>)/.test(match[0]); node.hidden = /\shidden(?:\s|>)/.test(match[0]); node.checked = /\schecked(?:\s|>)/.test(match[0]); return [`#${match[1]}`, node]; }));
  for (const [selector, node] of nodes) { node.id = selector.slice(1); const parent = new Node(); parent.append(node); }
  for (const match of html.matchAll(/<button\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
    const button = nodes.get(`#${match[1]}`); const label = match[2].match(/<span class="button-label">([^<]*)<\/span>/);
    if (label) { const span = new Node('span'); span.className = 'button-label'; span.textContent = label[1]; button.append(span); nodes.set(`#${match[1]} .button-label`, span); }
    else button.textContent = match[2].replace(/<[^>]*>/g, '');
  }
  nodes.set('.thread-sidebar', new Node());
  for (const [formId, fields] of [['#campaign-form', { campaignScope: '#campaign-scope', campaignTrigger: '#campaign-trigger' }], ['#publishing-form', { publishingVideoSource: '#publishing-video-source' }], ['#assistant-config-form', { assistantTone: '#assistant-tone' }]]) {
    nodes.get(formId).elements = Object.fromEntries(Object.entries(fields).map(([name, id]) => [name, nodes.get(id)]));
  }
  for (const feature of ['story', 'faq', 'sales', 'follower']) { nodes.set(`[data-assistant-feature="${feature}Enabled"]`, new Node('input')); nodes.set(`[data-feature-status="${feature}"]`, new Node()); nodes.set(`[data-feature-gate="${feature}"]`, new Node()); }
  const form = nodes.get('#flow-form'); form.elements = {};
  for (const key of ['name', 'reel', 'keywords', 'trigger', 'firstMessage', 'optInLabel', 'secondMessage', 'linkLabel', 'linkUrl', 'enabled', 'reply0', 'reply1', 'reply2']) form.elements[key] = new Node('input');
  const calls = []; const storageWrites = [];
  const context = vm.createContext({ __simulator: simulator, structuredClone, TextEncoder, URL, Intl, queueMicrotask, crypto: webcrypto, navigator: { clipboard: { writeText: async () => {} } }, localStorage: { getItem: () => null, setItem: (key, value) => storageWrites.push({ key, value }) }, location: { hash: '#recovery' }, window: { addEventListener: () => {} }, document: { visibilityState: 'hidden', querySelector: selector => { if (!nodes.has(selector) && /^#[a-z-]+ \.flow-actions$/.test(selector) && nodes.has(selector.split(' ')[0])) nodes.set(selector, new Node('span')); if (!nodes.has(selector) && selector === '#campaign-detail-content .detail-meta .status') return nodes.get('#campaign-detail-content').children.find(node => node.className === 'detail-meta')?.children.find(node => node.className === 'status') || null; if (!nodes.has(selector) && selector.startsWith('#')) { const visit = node => node?.id === selector.slice(1) ? node : node?.children?.map(visit).find(Boolean); const match = [...nodes.values()].map(visit).find(Boolean); if (match) return match; } assert.ok(nodes.has(selector), `unknown selector ${selector}`); return nodes.get(selector); }, getElementById: id => nodes.get(`#${id}`) || [...nodes.values()].flatMap(node => node.parentElement?.children || []).find(node => node.id === id) || null, querySelectorAll: () => [], createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), createTextNode: value => ({ textContent: value }) }, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, fetch: async (path, options = {}) => { calls.push({ path, options }); const handled = await onFetch(path, options); if (handled) return handled; if (path === '/api/accounts') return response({ defaultAccountId: defaultId, accounts: accountList }); if (path === '/api/connection/recovery') return { status: 404 }; if (path === '/api/connection/status') return { ok: true, json: async () => ({ connected: false }) }; if (path === '/api/csrf' || path === '/api/connection/csrf') return { ok: true, json: async () => ({ nonce: 'a'.repeat(64) }) }; throw new Error('Unexpected fetch'); } });
  vm.runInContext(simulatorBindings + source, context);
  const run = code => vm.runInContext(code, context);
  return { nodes, calls, run, storageWrites };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const defaultId = '17840000000000001';
const secondId = '17840000000000002';
const accountList = [{ id: defaultId, username: 'example_creator', isDefault: true, legacyRecovery: true }, { id: secondId, username: 'example_shop', isDefault: false, legacyRecovery: false }];
const response = value => ({ ok: true, json: async () => value });
function accountResponse(path, options) {
  if (path === '/api/accounts') return response({ defaultAccountId: defaultId, accounts: accountList });
  const id = options.headers?.['X-Benion-Account'] || defaultId;
  const username = id === secondId ? 'example_shop' : 'example_creator';
  if (path === '/api/connection/status') return response({ connected: true, identity: { userId: id, username } });
  if (path === '/api/catalog') return response({ products: [{ id: username, name: username, url: 'https://example.org' }] });
  if (path === '/api/assistant/config') return response({ enabled: false, rules: username, provider: { configured: false }, eligibility: {} });
  if (path === '/api/campaigns') return response({ campaigns: [], runningCampaignId: null });
  if (path === '/api/campaigns/media') return response({ media: [] });
  if (path === '/api/inbox') return response({ threads: [] });
  return null;
}

const testedProvider = { configured: true, name: 'openrouter', model: 'openai/gpt-6-luna', verifiedAt: '2026-10-05T12:00:00.000Z' };
const botConfig = { enabled: true, faqEnabled: true, salesEnabled: true, provider: testedProvider, eligibility: { faq: { eligible: true }, sales: { eligible: true } } };
const threadDetail = (overrides = {}, messages = []) => ({ thread: { id: 'lead', username: 'pessoa', handoff: true, aiEnabled: false, windowOpen: true, windowClosesAt: '2026-10-06T12:00:00.000Z', lastInboundAt: '2026-10-05T12:00:00.000Z', ...overrides }, messages, permissions: { canReply: true } });

test('logout runs only on explicit action with CSRF, blocks repeats and redirects after confirmation', async () => {
  let finish;
  const { calls, nodes, run, storageWrites } = setup((path, options) => {
    if (path === '/api/admin/logout') return new Promise(resolve => { finish = () => resolve(response({ loggedOut: true })); });
    return accountResponse(path, options);
  });
  await settle(); assert.equal(calls.some(call => call.path === '/api/admin/logout'), false);
  const before = calls.length; const pending = nodes.get('#logout-admin').listeners.click(); await settle();
  assert.equal(nodes.get('#logout-admin').disabled, true); assert.equal(nodes.get('#logout-admin').textContent, 'Saindo…');
  assert.equal(run('location.href'), undefined);
  await nodes.get('#logout-admin').listeners.click();
  const sequence = calls.slice(before); assert.equal(sequence.length, 2); assert.equal(sequence[0].path, '/api/csrf');
  const write = sequence[1]; assert.equal(write.path, '/api/admin/logout'); assert.equal(write.options.method, 'POST');
  assert.equal(write.options.credentials, 'same-origin'); assert.equal(write.options.headers['X-Benion-Request'], '1');
  assert.equal(Object.hasOwn(write.options.headers, 'X-Benion-Account'), false);
  assert.equal(write.options.headers['X-Benion-CSRF'], 'a'.repeat(64)); assert.deepEqual(JSON.parse(write.options.body), {});
  finish(); await pending; assert.equal(run('location.href'), '/admin/login'); assert.equal(storageWrites.length, 0);
  assert.equal(calls.some(call => call.path === '/api/admin/logout' && call.options.method !== 'POST'), false);
});

test('a confirmed global logout redirects even when the selected Instagram account changes after POST', async () => {
  let finish;
  const { calls, nodes, run } = setup((path, options) => {
    if (path === '/api/admin/logout') return new Promise(resolve => { finish = () => resolve(response({ loggedOut: true })); });
    return accountResponse(path, options);
  });
  await settle(); const pending = nodes.get('#logout-admin').listeners.click(); await settle();
  assert.equal(typeof finish, 'function'); assert.equal(calls.filter(call => call.path === '/api/admin/logout').length, 1);
  await run(`selectAccount('${secondId}')`); assert.equal(run('selectedAccountId'), secondId);
  finish(); await pending;
  assert.equal(run('location.href'), '/admin/login'); assert.equal(nodes.get('#logout-admin').disabled, true);
  assert.equal(nodes.get('#logout-feedback').dataset.kind === 'error', false);
});

test('failed logout keeps the current page, restores its button and reports an unconfirmed exit', async () => {
  const { calls, nodes, run, storageWrites } = setup((path, options) => path === '/api/admin/logout' ? { ok: false, status: 503, json: async () => ({ error: 'private-provider-secret' }) } : accountResponse(path, options));
  await settle(); run("location.href = '/#automation'");
  await nodes.get('#logout-admin').listeners.click();
  assert.equal(run('location.href'), '/#automation'); assert.equal(nodes.get('#logout-admin').disabled, false);
  assert.equal(nodes.get('#logout-feedback').hidden, false); assert.equal(nodes.get('#logout-feedback').dataset.kind, 'error');
  assert.equal(nodes.get('#logout-feedback').textContent, 'Não foi possível confirmar a saída. Tente novamente.');
  assert.equal(nodes.get('#logout-feedback').textContent.includes('private-provider-secret'), false);
  assert.equal(calls.filter(call => call.path === '/api/admin/logout').length, 1); assert.equal(storageWrites.length, 0);
});

test('visible Inbox polling is read-only, bounded and preserves draft ID and reading position', async () => {
  let detail = threadDetail({}, [{ id: '1', direction: 'inbound', actor: 'customer', text: 'Olá', at: '2026-10-05T12:00:00Z' }]);
  let hold = false; let release;
  const { calls, nodes, run } = setup((path, options) => {
    if (path === '/api/assistant/config') return response(botConfig);
    if (path === '/api/inbox') { const value = response({ threads: [detail.thread] }); return hold ? new Promise(resolve => { release = () => resolve(value); }) : value; }
    if (path === '/api/inbox/threads/lead') return response(detail);
    return accountResponse(path, options);
  });
  await settle(); await run('loadInbox();'); await run("selectThread('lead')");
  nodes.get('#inbox-reply').value = 'Meu rascunho'; nodes.get('#inbox-reply').listeners.input(); const draftId = run("inboxDrafts.get('lead').requestId");
  const log = nodes.get('#thread-messages'); log.scrollTop = 120; log.scrollHeight = 1800; log.clientHeight = 400;
  const before = calls.length; await run('pollInbox()'); assert.equal(calls.length, before);
  run("document.visibilityState = 'visible'"); nodes.get('#inbox-view').hidden = false;
  nodes.get('#inbox-auto-refresh').checked = false; await run('pollInbox()'); assert.equal(calls.length, before);
  nodes.get('#inbox-auto-refresh').checked = true; hold = true;
  detail = threadDetail({}, [...detail.messages, { id: '2', direction: 'outbound', actor: 'human', text: 'Resposta anterior', at: '2026-10-05T12:01:00Z', status: 'accepted' }]);
  const pending = run('pollInbox()'); await settle(); const reads = calls.filter(call => call.path === '/api/inbox').length;
  const duplicate = run('pollInbox()'); await settle(); assert.equal(calls.filter(call => call.path === '/api/inbox').length, reads);
  release(); await pending; await duplicate;
  assert.equal(nodes.get('#inbox-reply').value, 'Meu rascunho'); assert.equal(run("inboxDrafts.get('lead').requestId"), draftId); assert.equal(log.scrollTop, 120);
  assert.equal(run('inboxState'), 'ready');
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('failed Inbox refresh preserves last-known messages and draft while blocking a new send', async () => {
  let failed = false; const detail = threadDetail({}, [{ id: '1', direction: 'inbound', actor: 'customer', text: 'Olá', at: '2026-10-05T12:00:00Z' }]);
  const { nodes, run } = setup((path, options) => {
    if (path === '/api/inbox') return failed ? Promise.reject(new Error('Offline')) : response({ threads: [detail.thread] });
    if (path === '/api/inbox/threads/lead') return response(detail);
    return accountResponse(path, options);
  });
  await settle(); await run('loadInbox()'); await run("selectThread('lead')");
  nodes.get('#inbox-reply').value = 'Não apagar'; nodes.get('#inbox-reply').listeners.input(); const history = nodes.get('#thread-messages').children;
  failed = true; await run('loadInbox()');
  assert.equal(nodes.get('#inbox-reply').value, 'Não apagar'); assert.equal(nodes.get('#thread-messages').children, history);
  assert.equal(run('inboxThreads.length'), 1); assert.equal(nodes.get('#send-inbox-reply').disabled, true); assert.match(nodes.get('#composer-gate').textContent, /Atualize/);
  failed = false; await run('loadInbox()'); assert.equal(nodes.get('#send-inbox-reply').disabled, false);
});

test('takeover is confirmed before enabling human replies and bot resumes only by explicit action', async () => {
  let detail = threadDetail({ handoff: false, aiEnabled: true }); let finish;
  const { nodes, calls, run } = setup((path, options) => {
    if (path === '/api/assistant/config') return response(botConfig);
    if (path === '/api/inbox') return response({ threads: [detail.thread] });
    if (path === '/api/inbox/threads/lead') return response(detail);
    if (path.endsWith('/handoff') && options.method === 'POST') return new Promise(resolve => { finish = () => { detail = threadDetail({ handoff: true, aiEnabled: false }); resolve(response(detail)); }; });
    if (path.endsWith('/assistant') && options.method === 'POST') { detail = threadDetail({ handoff: false, aiEnabled: true }); return response(detail); }
    return accountResponse(path, options);
  });
  await settle(); await run('loadInbox()'); await run("selectThread('lead')");
  nodes.get('#inbox-reply').value = 'Rascunho manual'; nodes.get('#inbox-reply').listeners.input(); const id = run("inboxDrafts.get('lead').requestId");
  assert.equal(nodes.get('#send-inbox-reply').disabled, true); assert.match(nodes.get('#composer-gate').textContent, /Assuma/);
  const pending = nodes.get('#thread-handoff').listeners.click(); await settle(); assert.equal(run('selectedThread.thread.handoff'), false); assert.equal(nodes.get('#inbox-reply').disabled, true);
  finish(); await pending;
  assert.equal(run('selectedThread.thread.handoff'), true); assert.equal(nodes.get('#inbox-reply').value, 'Rascunho manual'); assert.equal(run("inboxDrafts.get('lead').requestId"), id); assert.equal(nodes.get('#send-inbox-reply').disabled, false);
  await run('loadInbox()'); assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  await nodes.get('#thread-assistant').listeners.click();
  assert.equal(run('selectedThread.thread.handoff'), false); assert.equal(nodes.get('#inbox-reply').value, 'Rascunho manual'); assert.equal(nodes.get('#send-inbox-reply').disabled, true);
  assert.equal(calls.filter(call => call.path.endsWith('/assistant') && call.options.method === 'POST').length, 1); assert.match(nodes.get('#inbox-feedback').textContent, /novas DMs/);
});

test('messages identify bot and human only with provenance and show media without inventing text', async () => {
  const { nodes, run } = setup(); await settle();
  const detail = threadDetail({}, [
    { id: '1', direction: 'inbound', actor: 'customer', text: '', mediaOnly: true, at: '2026-10-05T12:00:00Z' },
    { id: '2', direction: 'outbound', actor: 'assistant', text: 'Automática', status: 'accepted' },
    { id: '3', direction: 'outbound', actor: 'human', text: 'Manual', status: 'sending' },
    { id: '4', direction: 'outbound', text: 'Eco externo', status: 'echo' },
  ]);
  run(`selectedThreadId = 'lead'; selectedThread = ${JSON.stringify(detail)}; renderThread();`);
  const messages = nodes.get('#thread-messages').children;
  assert.equal(messages[0].children[0].textContent, 'Lead'); assert.match(messages[0].children[1].textContent, /Anexo ou mídia/);
  assert.equal(messages[1].children[0].textContent, 'Bot do Benion'); assert.match(messages[2].children[0].textContent, /Você.*example_creator/);
  assert.match(messages[2].children[3].textContent, /andamento/); assert.match(messages[3].children[0].textContent, /autoria não registrada/);
  assert.match(nodes.get('#thread-last-inbound').textContent, /Última mensagem recebida/); assert.match(nodes.get('#thread-window').textContent, /24h.*até/);
});

test('a refresh started before takeover cannot restore the old bot state after confirmation', async () => {
  const oldDetail = threadDetail({ handoff: false, aiEnabled: true }); const humanDetail = threadDetail({ handoff: true, aiEnabled: false }); let hold = false; let finish;
  const { nodes, run } = setup((path, options) => {
    if (path === '/api/assistant/config') return response(botConfig);
    if (path === '/api/inbox') return response({ threads: [oldDetail.thread] });
    if (path === '/api/inbox/threads/lead') return hold ? new Promise(resolve => { finish = () => resolve(response(oldDetail)); }) : response(oldDetail);
    if (path.endsWith('/handoff') && options.method === 'POST') return response(humanDetail);
    return accountResponse(path, options);
  });
  await settle(); await run('loadInbox()'); await run("selectThread('lead')"); hold = true;
  const refresh = run('loadInbox()'); await settle(); assert.equal(typeof finish, 'function');
  await nodes.get('#thread-handoff').listeners.click(); assert.equal(run('selectedThread.thread.handoff'), true);
  finish(); await refresh;
  assert.equal(run('selectedThread.thread.handoff'), true); assert.equal(run('inboxThreads[0].handoff'), true); assert.equal(nodes.get('#thread-assistant').textContent, 'Retomar bot');
});

test('a pending old-account Inbox read cannot populate the selected account or its composer', async () => {
  let finish; let hold = false;
  const { nodes, run } = setup((path, options) => {
    if (path === '/api/inbox' && hold && options.headers?.['X-Benion-Account'] === defaultId) return new Promise(resolve => { finish = () => resolve(response({ threads: [threadDetail().thread] })); });
    return accountResponse(path, options);
  });
  await settle(); hold = true; const refresh = run('loadInbox()'); await settle();
  await run(`selectAccount('${secondId}')`); finish(); await refresh;
  assert.equal(run('inboxThreads.length'), 0); assert.equal(run('selectedThread'), null); assert.equal(nodes.get('#inbox-reply').value, ''); assert.equal(nodes.get('#thread-detail').hidden, true);
  assert.doesNotMatch(nodes.get('#inbox-source').textContent, /1 conversa/);
});

test('provider key stays private, is cleared and saving it does not activate any account or send to a lead', async () => {
  const { nodes, calls, storageWrites, run } = setup((path, options) => path === '/api/assistant/provider' ? response(options.method === 'POST' ? testedProvider : { ...testedProvider, configured: false, verifiedAt: null }) : accountResponse(path, options));
  await settle(); await run('loadProvider()'); await run('loadAssistantConfig()');
  nodes.get('#assistant-rules').value = 'Instrução ainda não salva'; nodes.get('#provider-api-key').value = 'synthetic-openrouter-test-key';
  await nodes.get('#provider-form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/assistant/provider');
  assert.equal(JSON.parse(writes[0].options.body).apiKey, 'synthetic-openrouter-test-key'); assert.equal(nodes.get('#provider-api-key').value, '');
  assert.equal(storageWrites.length, 0); assert.equal(run('assistantConfig.enabled'), false); assert.equal(nodes.get('#assistant-rules').value, 'Instrução ainda não salva');
  assert.doesNotMatch(nodes.get('#provider-feedback').textContent, /synthetic-openrouter/);
  assert.match(html, /id="provider-api-key" type="password"[^>]*maxlength="1000"/); assert.match(nodes.get('#provider-feedback').textContent, /separadamente/);
});

test('changing account during private key CSRF cancels submission and clears the private field', async () => {
  let release; const { nodes, calls, run } = setup((path, options) => {
    if (path === '/api/csrf') return new Promise(resolve => { release = () => resolve(response({ nonce: 'a'.repeat(64) })); });
    if (path === '/api/assistant/provider') return response({ ...testedProvider, configured: false, verifiedAt: null });
    return accountResponse(path, options);
  });
  await settle(); await run('loadProvider()'); nodes.get('#provider-api-key').value = 'synthetic-key-not-submitted';
  const pending = nodes.get('#provider-form').listeners.submit({ preventDefault() {} }); await settle();
  await run(`selectAccount('${secondId}')`); release(); await pending;
  assert.equal(nodes.get('#provider-api-key').value, ''); assert.equal(nodes.get('#provider-feedback').hidden, true); assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('unknown provider errors do not echo private data and unverified models cannot enable the bot', async () => {
  const { nodes, run } = setup((path, options) => path === '/api/assistant/provider' ? options.method === 'POST' ? { ok: false, status: 400, json: async () => ({ error: 'synthetic-private-key-in-error' }) } : response({ ...testedProvider, configured: false, verifiedAt: null }) : accountResponse(path, options));
  await settle(); await run('loadProvider()'); nodes.get('#provider-api-key').value = 'synthetic-private-key-in-error'; await nodes.get('#provider-form').listeners.submit({ preventDefault() {} });
  assert.equal(nodes.get('#provider-api-key').value, ''); assert.doesNotMatch(nodes.get('#provider-feedback').textContent, /synthetic-private/);
  for (const provider of [{ ...testedProvider, verifiedAt: null }, { ...testedProvider, model: '' }]) {
    run(`assistantState='ready'; assistantConfig=${JSON.stringify({ ...botConfig, enabled: false, provider })}; selectedThreadId='lead'; selectedThread=${JSON.stringify(threadDetail({ handoff: false, aiEnabled: true }))}; renderAssistantConfig(); renderThread();`);
    assert.equal(nodes.get('#assistant-enabled').disabled, true); assert.equal(nodes.get('#thread-assistant').disabled, true); assert.doesNotMatch(nodes.get('#thread-ai-state').textContent, /Bot habilitado/);
  }
});

test('a running assistant can be paused after losing provider or eligibility, but cannot be reactivated', async () => {
  for (const unavailable of [{ provider: { configured: false }, eligibility: botConfig.eligibility }, { provider: testedProvider, eligibility: { faq: { eligible: false }, sales: { eligible: false } } }]) {
    const { nodes, calls, run } = setup((path, options) => path === '/api/assistant/config' && options.method === 'POST' ? response({ ...botConfig, ...unavailable, ...JSON.parse(options.body) }) : accountResponse(path, options));
    await settle(); run(`assistantState='ready'; assistantConfig=${JSON.stringify({ ...botConfig, ...unavailable })}; renderAssistantConfig();`);
    assert.equal(nodes.get('#assistant-enabled').disabled, false);
    nodes.get('#assistant-enabled').checked = false; run('assistantStep = 2'); await nodes.get('#assistant-config-form').listeners.submit({ preventDefault() {} });
    const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1); assert.equal(JSON.parse(writes[0].options.body).enabled, false);
    assert.equal(run('assistantConfig.enabled'), false); assert.equal(nodes.get('#assistant-enabled').disabled, true);
    nodes.get('#assistant-enabled').checked = true; run('assistantStep = 2'); await nodes.get('#assistant-config-form').listeners.submit({ preventDefault() {} });
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1); assert.match(nodes.get('#assistant-feedback').textContent, /ativação exige/);
  }
});

test('switching accounts clears drafts, catalogs, previews and legacy recovery without any write', async () => {
  const { nodes, calls, run } = setup(accountResponse); await settle();
  assert.equal(run('selectedAccountId'), defaultId);
  run(`inboxDrafts.set('lead', {text:'Resposta da conta original',requestId:'old'}); unknownReplies.add('lead'); selectedThreadId='lead'; selectedThread={thread:{id:'lead'},messages:[]}; catalogProducts=[{id:'old',name:'Produto antigo'}]; editingCampaignId='old'; assistantPreviewHistory=[{direction:'outbound',text:'Antigo'}];`);
  nodes.get('#inbox-reply').value = 'Resposta da conta original'; nodes.get('#campaign-message').value = 'Links da conta original'; nodes.get('#connection-token').value = 'token-original';
  await run(`selectAccount('${secondId}')`); await settle();
  assert.equal(run('selectedThread'), null); assert.equal(run('inboxDrafts.size'), 0); assert.equal(run('unknownReplies.size'), 0); assert.equal(run('editingCampaignId'), null); assert.equal(run('assistantPreviewHistory.length'), 0);
  assert.equal(nodes.get('#inbox-reply').value, ''); assert.equal(nodes.get('#connection-token').value, ''); assert.equal(nodes.get('#campaign-message').value, '');
  assert.equal(nodes.get('#nav-recovery').hidden, true); assert.equal(nodes.get('#recovery-view').hidden, true); assert.equal(nodes.get('#legacy-comment-card').hidden, true);
  assert.match(nodes.get('#account-scope-note').textContent, /@example_shop/); assert.match(nodes.get('#connection-summary').textContent, /@example_shop/);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('switching during CSRF acquisition cancels the original write before POST', async () => {
  let release;
  const { calls, run } = setup((path, options) => path === '/api/csrf' ? new Promise(resolve => { release = () => resolve(response({ nonce: 'a'.repeat(64) })); }) : accountResponse(path, options));
  await settle();
  const pending = run("apiWrite('/api/catalog', {products:[]}).catch(error => error.code)");
  await settle(); assert.equal(typeof release, 'function');
  await run(`selectAccount('${secondId}')`); release();
  assert.equal(await pending, 'ACCOUNT_CHANGED');
  const csrf = calls.find(call => call.path === '/api/csrf'); assert.equal(csrf.options.headers['X-Benion-Account'], defaultId);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('stale catalog, assistant and campaign responses cannot replace the new account state', async () => {
  let hold = false; const releases = [];
  const { nodes, run } = setup((path, options) => {
    const result = accountResponse(path, options);
    if (hold && options.headers?.['X-Benion-Account'] === defaultId && ['/api/catalog', '/api/assistant/config', '/api/campaigns', '/api/campaigns/media'].includes(path)) return new Promise(resolve => releases.push(() => resolve(result)));
    return result;
  });
  await settle(); hold = true;
  const pending = run('Promise.all([loadCatalog(), loadAssistantConfig(), loadCampaigns()])'); await settle(); assert.equal(releases.length, 4);
  await run(`selectAccount('${secondId}')`); await run('Promise.all([loadCatalog(), loadAssistantConfig(), loadCampaigns()])'); await settle();
  releases.forEach(release => release()); await pending;
  assert.equal(run('catalogProducts[0].name'), 'example_shop'); assert.equal(run('assistantConfig.rules'), 'example_shop'); assert.equal(run('catalogState'), 'ready'); assert.equal(run('assistantState'), 'ready'); assert.equal(run('campaignState'), 'ready');
  assert.equal(nodes.get('#catalog-feedback').hidden, true); assert.equal(nodes.get('#assistant-feedback').hidden, true);
});

test('an already submitted reply retains its original sender header and its result cannot reopen another account thread', async () => {
  let release;
  const { calls, nodes, run } = setup((path, options) => path.endsWith('/reply') && options.method === 'POST' ? new Promise(resolve => { release = () => resolve(response({ outcome: 'accepted' })); }) : accountResponse(path, options));
  await settle();
  run("selectedThreadId='lead'; selectedThread={thread:{id:'lead',username:'pessoa',handoff:true,windowOpen:true},messages:[],permissions:{canReply:true}}; renderThread();");
  nodes.get('#inbox-reply').value = 'Resposta confirmada'; nodes.get('#inbox-reply').listeners.input();
  const pending = nodes.get('#inbox-composer').listeners.submit({ preventDefault() {} }); await settle(); assert.equal(typeof release, 'function');
  await run(`selectAccount('${secondId}')`); release(); await pending;
  const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].options.headers['X-Benion-Account'], defaultId);
  assert.equal(run('selectedThread'), null); assert.equal(nodes.get('#thread-detail').hidden, true); assert.equal(nodes.get('#inbox-feedback').hidden, true);
  assert.equal(calls.some(call => call.path === '/api/inbox/threads/lead'), false);
});

test('unknown reply protection and stable request ID survive switching away and back', async () => {
  for (const outcome of ['transport-lost', 'unknown']) {
    let finish;
    const { calls, nodes, run } = setup((path, options) => path.endsWith('/reply') && options.method === 'POST' ? new Promise((resolve, reject) => { finish = () => outcome === 'transport-lost' ? reject(new Error('Lost response')) : resolve(response({ outcome: 'unknown' })); }) : accountResponse(path, options));
    await settle();
    run("selectedThreadId='lead'; selectedThread={thread:{id:'lead',username:'pessoa',handoff:true,windowOpen:true},messages:[],permissions:{canReply:true}}; renderThread();");
    nodes.get('#inbox-reply').value = 'Texto que não pode ser repetido'; nodes.get('#inbox-reply').listeners.input();
    const requestId = run("inboxDrafts.get('lead').requestId");
    const pending = nodes.get('#inbox-composer').listeners.submit({ preventDefault() {} }); await settle();
    await run(`selectAccount('${secondId}')`); finish(); await pending;
    assert.equal(nodes.get('#inbox-feedback').hidden, true); assert.equal(run("unknownReplies.has('lead')"), false);
    await run(`selectAccount('${defaultId}')`); await settle();
    assert.equal(run("unknownReplies.has('lead')"), true); assert.equal(run("inboxDrafts.get('lead').requestId"), requestId);
    run("selectedThreadId='lead'; selectedThread={thread:{id:'lead',username:'pessoa',handoff:true,windowOpen:true},messages:[],permissions:{canReply:true}}; renderThread();");
    assert.equal(nodes.get('#send-inbox-reply').disabled, true);
    await nodes.get('#inbox-composer').listeners.submit({ preventDefault() {} });
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

test('adding a professional account uses a masked token, clears it and never stores it in the browser', async () => {
  let registered = false;
  const { calls, nodes, run, storageWrites } = setup((path, options) => {
    if (path === '/api/accounts' && options.method === 'POST') { registered = true; return response({ account: accountList[1], defaultAccountId: secondId }); }
    if (path === '/api/accounts') return response({ defaultAccountId: registered ? secondId : null, accounts: registered ? [accountList[1]] : [] });
    return accountResponse(path, options);
  });
  await settle();
  assert.equal(run('selectedAccountId'), null);
  assert.equal(calls.some(call => call.path === '/api/connection/status' || call.path === '/api/publishing'), false);
  nodes.get('#open-connection').listeners.click();
  assert.equal(nodes.get('#new-account-form').hidden, false);
  assert.equal(nodes.get('#choose-renew-account').hidden, true);
  nodes.get('#new-account-username').value = '@example_shop'; nodes.get('#new-account-token').value = 'synthetic-test-token-123456789'; nodes.get('#new-account-version').value = 'v26.0';
  await nodes.get('#new-account-form').listeners.submit({ preventDefault() {} }); await settle();
  const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/accounts'); assert.equal(writes[0].options.headers['X-Benion-Account'], undefined);
  assert.deepEqual(JSON.parse(writes[0].options.body), { expectedUsername: 'example_shop', accessToken: 'synthetic-test-token-123456789', apiVersion: 'v26.0' });
  assert.equal(nodes.get('#new-account-token').value, ''); assert.equal(storageWrites.length, 0); assert.equal(run('selectedAccountId'), secondId); assert.match(nodes.get('#new-account-feedback').textContent, /começam pausadas/);
  assert.match(html, /id="new-account-token" type="password"/);
});

test('initial UI reads source/status but never activates AI or sends a message', async () => {
  const { calls, nodes } = setup(); await settle();
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
  assert.equal(nodes.get('#send-inbox-reply').disabled, true);
  assert.equal(nodes.get('#assistant-enabled').disabled, true);
  assert.equal(nodes.get('[data-assistant-feature="followerEnabled"]').disabled, true);
});

test('an unknown human reply keeps its stable request ID and blocks a second send', async () => {
  const { calls, nodes, run } = setup(async (path, options) => options.method === 'POST' ? { ok: true, json: async () => ({ outcome: 'unknown' }) } : null);
  await settle();
  run(`selectedThreadId = 'opaque/thread'; selectedThread = {thread:{id:'opaque/thread',username:'pessoa',handoff:true,windowOpen:true},messages:[],permissions:{canReply:true}}; renderThread();`);
  nodes.get('#inbox-reply').value = 'Resposta confirmada pelo operador';
  nodes.get('#inbox-reply').listeners.input();
  const firstId = run("inboxDrafts.get('opaque/thread').requestId");
  nodes.get('#inbox-reply').listeners.input();
  assert.equal(run("inboxDrafts.get('opaque/thread').requestId"), firstId);
  await nodes.get('#inbox-composer').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/inbox/threads/opaque%2Fthread/reply');
  assert.equal(JSON.parse(writes[0].options.body).requestId, firstId);
  assert.equal(nodes.get('#send-inbox-reply').disabled, true);
  assert.equal(nodes.get('#inbox-reply').value, 'Resposta confirmada pelo operador');
  await nodes.get('#inbox-composer').listeners.submit({ preventDefault() {} });
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('follower automation is forced off even if an unexpected config advertises eligibility', async () => {
  const { calls, nodes, run } = setup(async (path, options) => options.method === 'POST' ? { ok: true, json: async () => ({ ...JSON.parse(options.body), provider: { configured: true }, eligibility: {} }) } : null);
  await settle();
  run(`assistantState = 'ready'; assistantConfig = {enabled:false,provider:{configured:true},eligibility:{follower:{eligible:true}}}; renderAssistantConfig();`);
  assert.equal(nodes.get('[data-assistant-feature="followerEnabled"]').disabled, true);
  nodes.get('[data-assistant-feature="followerEnabled"]').checked = true;
  run('assistantStep = 2'); await nodes.get('#assistant-config-form').listeners.submit({ preventDefault() {} });
  const write = calls.find(call => call.path === '/api/assistant/config'); assert.ok(write);
  assert.equal(JSON.parse(write.options.body).followerEnabled, false);
});

test('a transport failure after the human reply attempt blocks repeat sends', async () => {
  const { calls, nodes, run } = setup(async (path, options) => { if (options.method === 'POST') throw new Error('Lost response'); return null; });
  await settle();
  run(`selectedThreadId = 'opaque'; selectedThread = {thread:{id:'opaque',username:'pessoa',handoff:true,windowOpen:true},messages:[],permissions:{canReply:true}}; renderThread();`);
  nodes.get('#inbox-reply').value = 'Uma resposta'; nodes.get('#inbox-reply').listeners.input();
  await nodes.get('#inbox-composer').listeners.submit({ preventDefault() {} });
  assert.equal(nodes.get('#send-inbox-reply').disabled, true);
  assert.equal(run("unknownReplies.has('opaque')"), true);
  await nodes.get('#inbox-composer').listeners.submit({ preventDefault() {} });
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('thread preference alone does not claim active AI while the global assistant is paused', async () => {
  const { nodes, run } = setup(); await settle();
  run(`assistantState = 'ready'; assistantConfig = {enabled:false,provider:{configured:true}}; selectedThreadId = 'opaque'; selectedThread = {thread:{id:'opaque',username:'pessoa',aiEnabled:true,handoff:false,windowOpen:true},messages:[],permissions:{canReply:true}}; renderThread();`);
  assert.equal(nodes.get('#thread-ai-state').textContent, 'Assistente pausado nas configurações');
  assert.equal(nodes.get('#thread-assistant').disabled, true);
});

test('legacy campaign remains blocked at 0/11 while an owned new Reel can be reviewed separately', async () => {
  const { nodes, run } = setup(async path => path === '/api/campaigns' ? { ok: true, json: async () => ({ campaigns: [{ id: 'legacy', name: 'Anterior', mediaId: '1', shortcode: 'LegacyReel', requiresRecovery: true, status: { running: false } }, { id: 'new', name: 'Novo', mediaId: '2', shortcode: 'NovoReel', status: { running: false } }], runningCampaignId: null }) } : path === '/api/campaigns/media' ? { ok: true, json: async () => ({ media: [{ id: '1', shortcode: 'LegacyReel' }, { id: '2', shortcode: 'NovoReel' }] }) } : null);
  await settle(); await run('loadCampaigns()');
  run('currentConnection = {connected:true,capabilities:{diagnosticComplete:false,recovery:{protected:0}}}; renderCampaignList();');
  run("selectedCampaignId = 'legacy'; renderCampaignDetail()");
  assert.equal(nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button').disabled, true);
  run("selectedCampaignId = 'new'; renderCampaignDetail()");
  assert.equal(nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button').disabled, false);
});

test('saving a campaign posts grounded draft data without automatically activating it', async () => {
  const { calls, nodes, run } = setup(async (path, options) => path === '/api/campaigns/media' ? { ok: true, json: async () => ({ media: [{ id: '2', shortcode: 'NovoReel' }] }) } : path === '/api/campaigns' ? { ok: true, json: async () => options.method === 'POST' ? ({ campaign: { id: 'new' } }) : ({ campaigns: [], runningCampaignId: null }) } : null);
  await settle(); await run('loadCampaigns()');
  nodes.get('#campaign-name').value = 'Meu Reel'; nodes.get('#campaign-media').value = '2'; nodes.get('#campaign-keywords').value = 'quero, link, quero'; nodes.get('#campaign-message').value = 'Aqui está: https://example.org/teste';
  run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/campaigns');
  assert.deepEqual(JSON.parse(writes[0].options.body).keywords, ['quero', 'link']);
  assert.equal(writes.some(call => call.path.endsWith('/start')), false);
});

test('all-Reels draft validates and stores its optional public reply without activating sends', async () => {
  const { calls, nodes, run } = setup(async (path, options) => {
    if (path === '/api/campaigns/media') return response({ available: true, media: [], truncated: false });
    if (path === '/api/campaigns') return response(options.method === 'POST' ? { campaign: { id: 'all' } } : { campaigns: [], runningCampaignId: null });
    return accountResponse(path, options);
  });
  await settle(); await run(`selectAccount('${secondId}')`); await run('loadCampaigns()');
  nodes.get('#campaign-scope').value = 'all_reels'; nodes.get('#campaign-scope').listeners.change();
  assert.equal(nodes.get('#save-campaign').disabled, false); assert.equal(nodes.get('#campaign-media-field').hidden, true);
  assert.equal(nodes.get('#campaign-media').required, false); assert.equal(nodes.get('#campaign-media').disabled, true);
  assert.equal(nodes.get('#campaign-public-replies').hidden, false); assert.equal(Boolean(nodes.get('#campaign-public-reply-0').disabled), false);
  for (let index = 0; index < 3; index++) assert.equal(nodes.get(`#campaign-public-reply-${index}`).value, '');
  assert.match(nodes.get('#campaign-scope-note').textContent, /@example_shop.*atuais e futuros.*mesmo comentário/);
  nodes.get('#campaign-name').value = 'Example Shop em todos os Reels';
  nodes.get('#campaign-message').value = 'Ooopa tudo bem?\nAqui está o link do produto para você testar de graça\nhttps://example.com';
  nodes.get('#campaign-public-reply-0').value = '😀'.repeat(251);
  run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} });
  assert.equal(calls.some(call => call.options.method === 'POST'), false); assert.equal(nodes.get('#campaign-public-reply-0').attributes['aria-invalid'], 'true');
  nodes.get('#campaign-public-reply-0').value = ' Enviei o link do produto na sua dm 🎈 '; nodes.get('#campaign-form').listeners.input({ target: nodes.get('#campaign-public-reply-0') });
  run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/campaigns'); assert.equal(writes[0].options.headers['X-Benion-Account'], secondId);
  const body = JSON.parse(writes[0].options.body);
  assert.equal(body.scope, 'all_reels'); assert.equal(body.mediaId, null); assert.equal(Object.hasOwn(body, 'reel'), false);
  assert.deepEqual(body.publicReplies, ['Enviei o link do produto na sua dm 🎈']); assert.deepEqual(body.keywords, []); assert.match(body.messageText, /https:\/\/example\.com$/);
  assert.equal(writes.some(call => call.path.endsWith('/start')), false);
});

test('partial or unknown media allows an all-Reels paused draft while activation requires explicit completeness', async () => {
  for (const truncated of [true, undefined]) {
    const campaign = { id: 'all', name: 'Todos', scope: 'all_reels', mediaId: null, messageText: 'https://example.com', status: { running: false } };
    const { calls, nodes, run } = setup(async (path, options) => path === '/api/campaigns/media' ? response({ available: true, media: [{ id: '2', shortcode: 'Atual' }], ...(truncated === undefined ? {} : { truncated }) }) : path === '/api/campaigns' ? response(options.method === 'POST' ? { campaign } : { campaigns: [campaign], runningCampaignId: null }) : null);
    await settle(); await run('loadCampaigns()'); run('currentConnection = {connected:true}; renderCampaignList();');
    run("selectedCampaignId = 'all'; renderCampaignDetail()"); const action = nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button');
    assert.equal(action.disabled, true);
    nodes.get('#campaign-scope').value = 'all_reels'; nodes.get('#campaign-scope').listeners.change();
    nodes.get('#campaign-name').value = 'Todos'; nodes.get('#campaign-message').value = 'https://example.com';
    assert.equal(nodes.get('#save-campaign').disabled, false); assert.match(nodes.get('#campaign-scope-note').textContent, /Pode salvar a mensagem; ativação exige conexão válida e lista completa/);
    run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} });
    const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/campaigns');
    assert.equal(JSON.parse(writes[0].options.body).scope, 'all_reels'); assert.equal(run('campaignBusy'), false);
    assert.equal(writes.some(call => call.path.endsWith('/start')), false);
    nodes.get('#campaign-scope').value = 'reel'; nodes.get('#campaign-scope').listeners.change();
    assert.equal(nodes.get('#save-campaign').disabled, false); assert.equal(nodes.get('#campaign-media-field').hidden, false); assert.equal(nodes.get('#campaign-media').required, true);
  }
});

test('unavailable Meta media permits saving only an all-Reels draft and keeps activation blocked', async () => {
  const campaign = { id: 'all', name: 'Todos', scope: 'all_reels', mediaId: null, messageText: 'https://example.com', status: { running: false } };
  const { calls, nodes, run } = setup(async (path, options) => {
    if (path === '/api/campaigns/media') throw new Error('Meta unavailable');
    if (path === '/api/campaigns') return response(options.method === 'POST' ? { campaign } : { campaigns: [campaign], runningCampaignId: null });
    return null;
  });
  await settle(); await run('loadCampaigns()');
  nodes.get('#campaign-scope').value = 'all_reels'; nodes.get('#campaign-scope').listeners.change();
  nodes.get('#campaign-name').value = 'Todos'; nodes.get('#campaign-message').value = 'https://example.com';
  assert.equal(nodes.get('#save-campaign').disabled, false); assert.equal(run('campaignMediaState'), 'unavailable');
  const action = () => { run("selectedCampaignId = 'all'; renderCampaignDetail()"); return nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button'); };
  assert.equal(action().disabled, true); assert.match(nodes.get('#campaign-scope-note').textContent, /Quando ativa.*ativação exige conexão válida/);
  run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/campaigns');
  assert.equal(action().disabled, true); assert.equal(run('campaignBusy'), false);
  nodes.get('#campaign-scope').value = 'reel'; nodes.get('#campaign-scope').listeners.change();
  assert.equal(nodes.get('#save-campaign').disabled, true);
  run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} }); assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('cached connection cannot activate all-Reels when a failed inventory returns an empty non-truncated result', async () => {
  let available = false;
  const campaign = { id: 'all', name: 'Todos', scope: 'all_reels', mediaId: null, messageText: 'https://example.com', status: { running: false } };
  const { calls, nodes, run } = setup(async path => {
    if (path === '/api/campaigns/media') return response({ available, media: [], truncated: false, ...(available ? {} : { reason: 'GRAPH_REJECTED' }) });
    if (path === '/api/campaigns') return response({ campaigns: [campaign], runningCampaignId: null });
    return null;
  });
  await settle(); await run('loadCampaigns()'); run('currentConnection = {connected:true}; renderCampaignList();');
  const action = () => { run("selectedCampaignId = 'all'; renderCampaignDetail()"); return nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button'); };
  assert.equal(run('campaignMediaComplete'), false); assert.equal(run('campaignMediaState'), 'unavailable'); assert.equal(action().disabled, true);
  assert.equal(nodes.get('#campaign-media').children[0].textContent, 'Verifique a conexão para listar seus Reels');
  assert.equal(nodes.get('#campaign-media-note').dataset.kind, 'warning');
  nodes.get('#campaign-scope').value = 'all_reels'; nodes.get('#campaign-scope').listeners.change();
  assert.equal(nodes.get('#save-campaign').disabled, false);
  available = true; await run('loadCampaigns()');
  assert.equal(run('campaignMediaComplete'), true); assert.equal(run('campaignMediaState'), 'ready'); assert.equal(action().disabled, false);
  assert.equal(nodes.get('#campaign-media').children[0].textContent, 'Nenhum Reel retornado pela API');
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('all-Reels campaigns retain their scope through edit and explicit start or pause', async () => {
  let running = false;
  const campaign = () => ({ id: 'all', name: 'Example Shop', scope: 'all_reels', mediaId: null, messageText: 'https://example.com', keywords: [], publicReplies: ['Enviei o link do produto na sua dm 🎈'], status: { running } });
  const { calls, nodes, run } = setup(async (path, options) => {
    if (path === '/api/campaigns/media') return response({ available: true, media: [], truncated: false });
    if (path === '/api/campaigns/all/start') { running = true; return response({ campaign: campaign() }); }
    if (path === '/api/campaigns/all/stop') { running = false; return response({ campaign: campaign() }); }
    if (path === '/api/campaigns') return response({ campaigns: [campaign()], runningCampaignId: running ? 'all' : null });
    return accountResponse(path, options);
  });
  await settle(); await run(`selectAccount('${secondId}')`); await run('loadCampaigns()');
  run(`editCampaign(${JSON.stringify(campaign())})`);
  assert.equal(nodes.get('#campaign-scope').value, 'all_reels'); assert.equal(nodes.get('#campaign-media').value, '');
  assert.equal(nodes.get('#campaign-public-replies').hidden, false); assert.equal(nodes.get('#campaign-public-reply-0').value, 'Enviei o link do produto na sua dm 🎈');
  const action = () => { run("selectedCampaignId = 'all'; renderCampaignDetail()"); return nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button'); };
  assert.match(nodes.get('#campaign-review-note').textContent, /resposta pública.*após o aceite da DM pela Meta/);
  assert.equal(action().disabled, false); assert.equal(calls.some(call => call.options.method === 'POST'), false);
  await action().listeners.click();
  assert.equal(calls.filter(call => call.path.endsWith('/start')).length, 1); assert.equal(action().textContent, 'Pausar automação'); assert.equal(nodes.get('#campaign-scope').disabled, true); assert.equal(nodes.get('#campaign-public-reply-0').disabled, true);
  run('currentConnection = {connected:false}; renderCampaignList();'); assert.equal(action().disabled, false);
  await action().listeners.click(); assert.equal(calls.filter(call => call.path.endsWith('/stop')).length, 1); assert.equal(action().textContent, 'Ativar automação');
  const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 2);
  assert.equal(writes.every(call => call.options.headers['X-Benion-Account'] === secondId), true);
  run("editCampaign({id:'old',name:'Original',mediaId:'2',messageText:'https://example.org'})");
  assert.equal(nodes.get('#campaign-scope').value, 'reel'); assert.equal(nodes.get('#campaign-media-field').hidden, false); assert.equal(nodes.get('#campaign-public-replies').hidden, false);
});

test('account change clears all-Reels draft and ignores another account complete-media result', async () => {
  let hold = false; let finish;
  const { nodes, run, calls } = setup((path, options) => {
    if (path === '/api/campaigns/media') {
      if (hold && options.headers?.['X-Benion-Account'] === defaultId) return new Promise(resolve => { finish = () => resolve(response({ available: true, media: [{ id: 'old' }], truncated: false })); });
      return response({ available: true, media: [{ id: 'own' }], truncated: options.headers?.['X-Benion-Account'] === secondId });
    }
    return accountResponse(path, options);
  });
  await settle(); await run('loadCampaigns()'); nodes.get('#campaign-scope').value = 'all_reels'; nodes.get('#campaign-scope').listeners.change();
  nodes.get('#campaign-message').value = 'Rascunho de outra conta https://example.org';
  nodes.get('#campaign-public-reply-0').value = 'Resposta pública de outra conta';
  hold = true; const oldLoad = run('loadCampaigns()'); await settle();
  await run(`selectAccount('${secondId}')`); await run('loadCampaigns()'); finish(); await oldLoad;
  assert.equal(nodes.get('#campaign-scope').value, 'reel'); assert.equal(nodes.get('#campaign-message').value, ''); assert.equal(run('campaignMedia[0].id'), 'own'); assert.equal(run('campaignMediaComplete'), false);
  for (let index = 0; index < 3; index++) assert.equal(nodes.get(`#campaign-public-reply-${index}`).value, '');
  nodes.get('#campaign-scope').value = 'all_reels'; nodes.get('#campaign-scope').listeners.change();
  assert.equal(nodes.get('#save-campaign').disabled, false); assert.match(nodes.get('#campaign-scope-note').textContent, /@example_shop/);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('partial recovery enables future-only controls with 11 protections without claiming a complete diagnosis or activating sends', async () => {
  const { calls, nodes, run } = setup(async path => path === '/api/campaigns' ? { ok: true, json: async () => ({ campaigns: [{ id: 'legacy', name: 'Anterior', mediaId: '1', shortcode: 'LegacyReel', requiresRecovery: true, status: { running: false } }], runningCampaignId: null }) } : path === '/api/campaigns/media' ? { ok: true, json: async () => ({ media: [{ id: '1', shortcode: 'LegacyReel' }] }) } : null);
  await settle(); await run('loadCampaigns()');
  const status = { connected: true, identity: { username: 'example_creator', userId: '17840000000000001' }, capabilities: { diagnosticComplete: false, futureOnlyReady: true, recovery: { expected: 11, protected: 11, matched: 10, unmatched: 1, blocked: 0, excluded: 2 }, futureOnlyNote: 'Autor sem ID oficial; mudança de nome exige conferência.' } };
  const campaignAction = () => { run("selectedCampaignId = 'legacy'; renderCampaignDetail()"); return nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button'); };
  run(`displayConnection(${JSON.stringify(status)})`);
  assert.equal(nodes.get('#start-automation').disabled, false);
  assert.equal(campaignAction().disabled, false);
  assert.match(nodes.get('#real-gate').textContent, /11 comentários já atendidos.*10 visíveis/);
  assert.match(nodes.get('#real-gate').textContent, /histórico continua parcial/);
  assert.match(nodes.get('#real-gate').textContent, /Autor sem ID oficial/);
  assert.equal(run('currentConnection.capabilities.diagnosticComplete'), false);
  status.capabilities.futureOnlyReady = false;
  run(`displayConnection(${JSON.stringify(status)})`);
  assert.equal(nodes.get('#start-automation').disabled, true); assert.equal(campaignAction().disabled, true);
  status.capabilities.futureOnlyReady = true; status.capabilities.recovery.protected = 10;
  run(`displayConnection(${JSON.stringify(status)})`);
  assert.equal(nodes.get('#start-automation').disabled, true); assert.equal(campaignAction().disabled, true);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('editing and saving a DM-only or legacy campaign does not inject suggested public replies or activate sends', async () => {
  const campaign = { id: 'old', name: 'Original', mediaId: '2', messageText: 'Link: https://example.org', keywords: [], publicReplies: [], status: { running: false } };
  const { calls, nodes, run } = setup(async (path, options) => path === '/api/campaigns/media' ? { ok: true, json: async () => ({ media: [{ id: '2', shortcode: 'NovoReel' }] }) } : path === '/api/campaigns' || path === '/api/campaigns/old' ? { ok: true, json: async () => options.method === 'POST' ? ({ campaign }) : ({ campaigns: [campaign], runningCampaignId: null }) } : null);
  await settle(); await run('loadCampaigns()');
  for (const value of [campaign, { ...campaign, publicReplies: undefined }]) {
    run(`editCampaign(${JSON.stringify(value)})`);
    for (let index = 0; index < 3; index++) assert.equal(nodes.get(`#campaign-public-reply-${index}`).value, '');
  }
  run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/campaigns/old');
  assert.deepEqual(JSON.parse(writes[0].options.body).publicReplies, []);
  assert.equal(writes.some(call => call.path.endsWith('/start')), false);
  assert.equal(nodes.get('#campaign-public-reply-0').value, '');
});

test('campaign save trims public replies and blocks oversized UTF8 before any write', async () => {
  const { calls, nodes, run } = setup(async path => path === '/api/campaigns/media' ? { ok: true, json: async () => ({ media: [{ id: '2', shortcode: 'NovoReel' }] }) } : path === '/api/campaigns' ? { ok: true, json: async () => ({ campaigns: [], runningCampaignId: null }) } : null);
  await settle(); await run('loadCampaigns()');
  nodes.get('#campaign-name').value = 'Novo'; nodes.get('#campaign-media').value = '2'; nodes.get('#campaign-message').value = 'https://example.org';
  nodes.get('#campaign-public-reply-0').value = '😀'.repeat(251);
  run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} });
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
  assert.equal(nodes.get('#campaign-public-reply-0').attributes['aria-invalid'], 'true');
  nodes.get('#campaign-public-reply-0').value = '  Link na DM  '; nodes.get('#campaign-form').listeners.input({ target: nodes.get('#campaign-public-reply-0') });
  nodes.get('#campaign-public-reply-1').value = '  '; nodes.get('#campaign-public-reply-2').value = ' Confira seu Direct ';
  assert.equal(nodes.get('#campaign-public-reply-0').attributes['aria-invalid'], undefined);
  run('campaignStep = 4'); await nodes.get('#campaign-form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/campaigns');
  assert.deepEqual(JSON.parse(writes[0].options.body).publicReplies, ['Link na DM', 'Confira seu Direct']);
  assert.equal(writes.some(call => call.path.endsWith('/start')), false);
});

test('premium preview uses only the simulation endpoint and keeps its history in memory', async () => {
  const { calls, nodes, run } = setup(async (path, options) => path === '/api/assistant/preview' ? { ok: true, json: async () => ({ mode: 'simulation', action: 'handoff', reason: 'PRICE_NOT_CONFIRMED', text: 'Preço não informado no catálogo.' }) } : null);
  await settle(); nodes.get('#assistant-preview-text').value = 'Quanto custa?'; nodes.get('#assistant-preview-kind').value = 'message';
  await nodes.get('#assistant-preview-form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/assistant/preview');
  assert.deepEqual(JSON.parse(writes[0].options.body).history, []);
  assert.equal(run('assistantPreviewHistory.length'), 3);
  assert.equal(run('assistantPreviewHistory.at(-1).text'), 'Preço não cadastrado. Atendimento humano sugerido.');
  assert.match(nodes.get('#assistant-preview-feedback').textContent, /nenhuma DM foi enviada/);
});

test('preview handoff explains missing catalog facts without exposing unknown provider reasons', async () => {
  for (const [reason, expected] of [['FACT_NOT_CONFIRMED', 'O catálogo não confirma essa informação. Atendimento humano sugerido.'], ['CATALOG_EMPTY', 'Cadastre seus produtos antes de testar.'], ['UNEXPECTED_PROVIDER_CODE', 'Atendimento humano sugerido. O assistente respeitou um limite da resposta.']]) {
    const { nodes, run } = setup(async path => path === '/api/assistant/preview' ? { ok: true, json: async () => ({ mode: 'simulation', action: 'handoff', reason }) } : null);
    await settle(); nodes.get('#assistant-preview-text').value = 'Uma dúvida'; nodes.get('#assistant-preview-kind').value = 'message';
    await nodes.get('#assistant-preview-form').listeners.submit({ preventDefault() {} });
    assert.equal(run('assistantPreviewHistory.at(-1).text'), expected);
  }
});

test('empty Story mention stays empty on the wire and its display label never enters later history', async () => {
  const { calls, nodes, run } = setup(async path => path === '/api/assistant/preview' ? { ok: true, json: async () => ({ mode: 'simulation', action: 'ignore' }) } : null);
  await settle();
  nodes.get('#assistant-preview-kind').value = 'story_mention'; nodes.get('#assistant-preview-kind').listeners.change();
  assert.equal(nodes.get('#assistant-preview-text').required, false);
  nodes.get('#assistant-preview-text').value = '';
  await nodes.get('#assistant-preview-form').listeners.submit({ preventDefault() {} });
  let writes = calls.filter(call => call.path === '/api/assistant/preview'); assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].options.body).text, ''); assert.equal(JSON.parse(writes[0].options.body).kind, 'story_mention');
  assert.equal(run('assistantPreviewHistory[0].placeholder'), true); assert.equal(run('assistantPreviewHistory[0].text'), '');
  const firstBubble = nodes.get('#assistant-preview-log').children[0].children[0]; assert.equal(firstBubble.textContent, 'Menção em Story sem texto');
  nodes.get('#assistant-preview-kind').value = 'message'; nodes.get('#assistant-preview-kind').listeners.change();
  assert.equal(nodes.get('#assistant-preview-text').required, true);
  nodes.get('#assistant-preview-text').value = 'Oi'; await nodes.get('#assistant-preview-form').listeners.submit({ preventDefault() {} });
  writes = calls.filter(call => call.path === '/api/assistant/preview'); assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(writes[1].options.body).history, []);
});

test('Direct messages and Story replies still require test text before any preview request', async () => {
  const { calls, nodes } = setup(); await settle();
  for (const kind of ['message', 'story_reply']) {
    nodes.get('#assistant-preview-kind').value = kind; nodes.get('#assistant-preview-kind').listeners.change(); nodes.get('#assistant-preview-text').value = '';
    assert.equal(nodes.get('#assistant-preview-text').required, true);
    await nodes.get('#assistant-preview-form').listeners.submit({ preventDefault() {} });
  }
  assert.equal(calls.some(call => call.path === '/api/assistant/preview'), false);
});

test('blocked Inbox composer explains known permission states and hides raw unknown codes', async () => {
  const { nodes, run } = setup(); await settle();
  const expected = {
    WINDOW_CLOSED: 'A janela de 24 horas encerrou. Aguarde uma nova interação da pessoa para responder.',
    CONTACT_OPTED_OUT: 'A pessoa pediu para parar. O envio está bloqueado.',
    OUTCOME_REQUIRES_REVIEW: 'O resultado anterior precisa de revisão. Confira o Direct antes de enviar novamente.',
    VERIFIED_INBOUND_REQUIRED: 'Conclua a conexão e aguarde uma nova interação verificada do Instagram.',
    SEND_IN_PROGRESS: 'Há um envio em andamento. Aguarde a confirmação antes de responder.',
    RAW_PROVIDER_CODE: 'Esta conversa ainda não está elegível para resposta. Confira a conexão e a janela de atendimento.',
  };
  for (const [reason, message] of Object.entries(expected)) {
    run(`selectedThreadId = 'opaque'; selectedThread = {thread:{id:'opaque',username:'pessoa'},messages:[],permissions:{canReply:false,reason:${JSON.stringify(reason)}}}; renderThread();`);
    assert.equal(nodes.get('#composer-gate').textContent, message);
    assert.equal(nodes.get('#inbox-reply').disabled, true); assert.equal(nodes.get('#send-inbox-reply').disabled, true);
  }
});

test('product review saves only the selected edit while preserving the other product and account', async () => {
  const products = [{ id: 'first', name: 'Primeiro', url: 'https://example.org/first', facts: ['Confirmado'] }, { id: 'second', name: 'Segundo', url: 'https://example.org/second', facts: ['Preservar'] }];
  const { calls, nodes, run } = setup((path, options) => {
    if (path === '/api/catalog') return response({ products: options.method === 'POST' ? JSON.parse(options.body).products : products });
    return accountResponse(path, options);
  });
  await settle(); await run('loadCatalog();'); run('openProduct(catalogProducts[0]);');
  nodes.get('#product-name').value = 'Primeiro revisado';
  await nodes.get('#catalog-form').listeners.submit({ preventDefault() {} });
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
  nodes.get('#product-next').listeners.click();
  await nodes.get('#catalog-form').listeners.submit({ preventDefault() {} });
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].options.headers['X-Benion-Account'], defaultId);
  const saved = JSON.parse(writes[0].options.body).products;
  assert.equal(saved[0].name, 'Primeiro revisado'); assert.deepEqual(saved[1], products[1]);
  assert.equal(run('productDraft'), null);
});

test('campaign activation permits different Reels and asks before replacing an overlapping campaign', async () => {
  const rows = [{ id: 'one', name: 'Primeira', mediaId: '1', enabled: true, status: { running: true } }, { id: 'two', name: 'Segunda', mediaId: '2', status: { running: false } }, { id: 'all', name: 'Todos', scope: 'all_reels', status: { running: false } }];
  const { calls, nodes, run } = setup((path, options) => {
    if (path === '/api/campaigns') return response({ campaigns: rows, runningCampaignId: 'one' });
    if (path === '/api/campaigns/media') return response({ media: [{ id: '1' }, { id: '2' }], available: true, truncated: false });
    if (path.endsWith('/start')) return response({});
    return accountResponse(path, options);
  });
  await settle(); await run('loadCampaigns()');
  run("selectedCampaignId = 'two'; renderCampaignDetail()");
  assert.equal(nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button').disabled, false);
  await nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button').listeners.click();
  assert.equal(calls.filter(call => call.path === '/api/campaigns/two/start').length, 1);
  run("selectedCampaignId = 'all'; renderCampaignDetail()");
  nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button').listeners.click();
  assert.equal(calls.some(call => call.path === '/api/campaigns/all/start'), false);
  assert.equal(run('confirmingCampaignId'), 'all');
  await nodes.get('#campaign-detail-actions').children.find(node => node.tagName === 'button').listeners.click();
  assert.equal(calls.filter(call => call.path === '/api/campaigns/all/start').length, 1);
});
