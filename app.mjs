import { createBrowserApi } from './ui/api.mjs';
import { DEFAULT_FLOW, HOUR, DAY, validateFlow, createSession, addComment, receiveInteraction, sendContinuation, advanceClock, takeOver, windowRemaining } from './simulator.mjs';

const $ = (selector) => document.querySelector(selector);
const STORE = 'benion.flow.v1';
const REVIEW_STORE = 'benion.reviews.v1';
const labels = { needs_review: 'Para revisar', sent: 'DM registrada', already_received: 'Já recebeu', blocked: 'Bloqueado' };
function readLocal(key, fallback) {
  try { const item = JSON.parse(localStorage.getItem(key)); return item && typeof item === 'object' ? item : fallback; } catch { return fallback; }
}
function persist(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { toast('Não foi possível salvar neste navegador.'); return false; }
}
const savedFlow = readLocal(STORE, {});
let flow = { ...structuredClone(DEFAULT_FLOW), ...savedFlow };
if (validateFlow(flow).length) flow = structuredClone(DEFAULT_FLOW);
let reviews = readLocal(REVIEW_STORE, {});
let recovery = { comments: [], updatedAt: null };
let recoveryState = 'loading';
let simulation = createSession();
let toastTimer;
let accounts = [];
let defaultAccountId = null;
let selectedAccountId = null;
let accountRevision = 0;
let accountsBusy = false;
let accountsState = 'loading';
function accountScope() { return { id: selectedAccountId, revision: accountRevision }; }
function currentScope(scope) { return scope.id === selectedAccountId && scope.revision === accountRevision; }
function assertScope(scope) { if (!currentScope(scope)) { const error = new Error('account-changed'); error.code = 'ACCOUNT_CHANGED'; throw error; } }
function selectedAccount() { return accounts.find(account => account.id === selectedAccountId); }
function legacyAccountSelected() { return selectedAccount()?.legacyRecovery === true; }
function accountUsername() { return selectedAccount()?.username || 'conta por verificar'; }
const { apiRead, apiWrite, scopedHeaders } = createBrowserApi({ accountScope, assertScope, currentScope });
function renderAccounts() {
  const select = $('#account-select'); select.replaceChildren();
  for (const account of accounts) { const option = el('option', '', `@${account.username}`); option.value = account.id; select.append(option); }
  if (!accounts.length) { const option = el('option', '', 'Nenhuma conta conectada'); option.value = ''; select.append(option); }
  select.value = selectedAccountId || ''; select.disabled = accountsBusy || !accounts.length;
  // The header select already shows the account; the note stays for screen readers unless the list could not be verified.
  const scopeNote = $('#account-scope-note'); const unavailable = accountsState === 'unavailable';
  scopeNote.textContent = !selectedAccountId && accountsState === 'ready' ? 'Nenhuma conta conectada.' : unavailable ? `A lista de contas ainda não foi verificada. Conta atual: @${accountUsername()}. Atualize a página para conferir as conexões.` : `Conta selecionada: @${accountUsername()}`;
  scopeNote.classList.toggle('sr-only', !unavailable); scopeNote.classList.toggle('notice', unavailable); scopeNote.classList.toggle('warning', unavailable);
  $('#choose-verify-account').hidden = !selectedAccountId;
  $('#choose-renew-account').hidden = !selectedAccountId;
  $('#connection-account-note').hidden = !selectedAccountId;
  $('#nav-recovery').hidden = !legacyAccountSelected();
  $('#legacy-tools').hidden = !legacyAccountSelected();
  $('#manychat-simulator').hidden = !legacyAccountSelected();
  $('#connection-account-note').textContent = `Conexão selecionada: @${accountUsername()}. Verificar ou substituir o token abaixo afeta somente esta conta.`;
  $('#replace-token-note').textContent = `O token deve pertencer a @${accountUsername()}. A identidade é confirmada antes de substituir a conexão. Nenhuma DM é enviada.`;
  $('#access-check-note').textContent = legacyAccountSelected() ? 'Verifique a conexão, os acessos e a proteção dos atendimentos anteriores desta conta.' : `Verifique os acessos de @${accountUsername()}. Cada automação protege os comentários existentes quando você a ativa.`;
}
async function loadAccounts() {
  accountsBusy = true; renderAccounts();
  try {
    const result = await apiRead('/api/accounts', accountScope(), false);
    if (!Array.isArray(result.accounts) || result.defaultAccountId !== null && typeof result.defaultAccountId !== 'string') throw new Error('invalid-accounts');
    const registered = result.accounts.filter(account => typeof account.id === 'string' && typeof account.username === 'string' && /^[A-Za-z0-9_.]{1,30}$/.test(account.username));
    if (registered.length ? !registered.some(account => account.id === result.defaultAccountId) : result.defaultAccountId !== null) throw new Error('invalid-default-account');
    accounts = registered; defaultAccountId = result.defaultAccountId; accountsState = 'ready';
    if (!accounts.length) { selectedAccountId = null; route(); displayConnection({ connected: false }); }
    if (!accounts.some(account => account.id === selectedAccountId)) await selectAccount(defaultAccountId);
  } catch { accountsState = 'unavailable'; }
  finally { accountsBusy = false; renderAccounts(); renderPublishing(); }
}
async function selectAccount(id) {
  if (!accounts.some(account => account.id === id) || selectedAccountId === id) return;
  saveInboxDraft(); selectedAccountId = id; accountRevision++; threadRequestSequence++; threadActionRevision++;
  currentConnection = null; inboxState = 'idle'; inboxThreads = []; selectedThreadId = null; selectedThread = null; threadBusy = false;
  resetPublishing();
  inboxLastSyncedAt = null; inboxRefreshFailed = false; threadMessageSignature = null; renderInboxRefresh();
  const draftKey = id === defaultAccountId ? 'default' : id;
  if (!accountDraftStores.has(draftKey)) accountDraftStores.set(draftKey, new Map());
  if (!accountUnknownStores.has(draftKey)) accountUnknownStores.set(draftKey, new Set());
  inboxDrafts = accountDraftStores.get(draftKey); unknownReplies = accountUnknownStores.get(draftKey);
  $('#inbox-reply').value = ''; $('#inbox-reply').disabled = true; $('#send-inbox-reply').disabled = true; $('#thread-detail').hidden = true; $('#thread-empty').hidden = false; $('#inbox-search').value = ''; $('#inbox-nav-count').hidden = true; $('#refresh-inbox').disabled = false;
  catalogState = 'idle'; catalogLoaded = false; catalogAvailable = false; catalogDirty = false; catalogProducts = []; productDraft = null; productEditorOpen = false; productRemoving = false; catalogSaving = false; setHint('#catalog-save-state', 'neutral', 'Catálogo desta conta por verificar.');
  assistantState = 'idle'; assistantConfig = null; assistantBusy = false; assistantStep = 0; $('#assistant-rules').value = ''; setRadioValue('#assistant-config-form', 'assistantTone', 'friendly'); setHint('#assistant-save-state', 'neutral', 'Configurações desta conta por verificar.');
  campaignState = 'idle'; campaignMediaState = 'idle'; campaignMediaComplete = false; campaigns = []; campaignMedia = []; runningCampaignId = null; editingCampaignId = null; campaignBusy = false; $('#campaign-media').replaceChildren(); $('#refresh-campaigns').disabled = false;
  assistantPreviewHistory = []; assistantPreviewBusy = false; $('#assistant-preview-text').value = ''; $('#send-assistant-preview').disabled = false; $('#clear-assistant-preview').disabled = false;
  $('#connection-token').value = ''; $('#new-account-token').value = ''; $('#provider-api-key').value = ''; providerBusy = false; providerState = 'idle'; providerStatus = null; renderProvider();
  $('#validate-connection').disabled = false; $('#verify-access').disabled = false;
  $('#legacy-reel-link').hidden = true;
  recovery = { comments: [], updatedAt: null }; recoveryState = legacyAccountSelected() ? 'loading' : 'empty'; renderRecovery();
  for (const id of ['inbox-feedback', 'catalog-feedback', 'assistant-feedback', 'provider-feedback', 'campaign-feedback', 'assistant-preview-feedback', 'connection-feedback', 'access-feedback', 'real-feedback']) $(`#${id}`).hidden = true;
  $('#thread-messages').replaceChildren(); renderAccounts(); renderInboxList(); renderCatalog(); renderAssistantConfig(); resetCampaignEditor(); renderCampaignList(); renderAssistantPreview(); displayConnection({ connected: false });
  if (!legacyAccountSelected() && (!location.hash || location.hash === '#recovery')) location.hash = '#publishing';
  route(); if (legacyAccountSelected()) loadRecovery(); await refreshConnectionStatus();
}
$('#account-select').addEventListener('change', event => selectAccount(event.target.value));
$('#new-account-form').addEventListener('submit', async event => {
  event.preventDefault(); if (accountsBusy) return;
  const expectedUsername = $('#new-account-username').value.trim().replace(/^@/, '').toLowerCase();
  let accessToken = $('#new-account-token').value.trim(); $('#new-account-token').value = '';
  const apiVersion = $('#new-account-version').value.trim();
  for (const field of ['#new-account-username', '#new-account-token']) clearFieldError($(field));
  const usernameValid = /^[A-Za-z0-9_.]{1,30}$/.test(expectedUsername);
  if (!usernameValid || accessToken.length < 16) {
    if (accessToken.length < 16) fieldError('#new-account-token', 'Cole o token oficial completo desta conta.');
    if (!usernameValid) fieldError('#new-account-username', 'Use o usuário do Instagram, só com letras, números, ponto ou sublinhado.');
    accessToken = ''; $('#new-account-feedback').hidden = true; return;
  }
  accountsBusy = true; setButtonBusy($('#add-account'), true, 'Validando…'); renderAccounts(); showFeedback('#new-account-feedback', `Confirmando @${expectedUsername} na Meta…`, 'progress');
  try {
    const body = { expectedUsername, accessToken, apiVersion }; accessToken = '';
    const result = await apiWrite('/api/accounts', body, accountScope(), false); body.accessToken = '';
    if (!result.account?.id) throw new Error('invalid-account');
    accountsBusy = false; await loadAccounts(); await selectAccount(result.account.id);
    showFeedback('#new-account-feedback', `@${expectedUsername} conectada. As automações desta conta começam pausadas.`, 'success');
    flashSuccess($('#account-select'));
  } catch (error) {
    const messages = { ACCOUNT_ALREADY_REGISTERED: 'Esta conta já está cadastrada. Selecione-a para verificar ou substituir o token.', WRONG_ACCOUNT: 'O token não pertence ao usuário informado. Confira a conta autorizada na Meta.', IDENTITY_UNVERIFIED: 'A Meta não confirmou a identidade da conta.', TOKEN_VALIDATION_FAILED: 'A Meta não validou o token. Confira a autorização oficial.', CSRF_INVALID: 'Esta tentativa expirou. Valide novamente.', PRIVATE_STORE_FAILED: 'O servidor não confirmou o armazenamento privado.' };
    showFeedback('#new-account-feedback', messages[error.code] || 'Não foi possível confirmar a conexão. Nenhuma automação foi ativada.', 'error');
  } finally { accessToken = ''; $('#new-account-token').value = ''; accountsBusy = false; setButtonBusy($('#add-account'), false); $('#add-account').disabled = false; renderAccounts(); }
});
const TOAST_MS = 8000;
const TOAST_KINDS = new Set(['info', 'success', 'warning', 'error']);
function hideToastLater() { clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, TOAST_MS); }
function toast(text, kind = 'info') {
  const node = $('#toast');
  node.dataset.kind = TOAST_KINDS.has(kind) ? kind : 'info'; node.textContent = text; node.hidden = false;
  hideToastLater();
}
// Pause while the pointer or keyboard is on the toast, so it can be read.
$('#toast').addEventListener('mouseenter', () => clearTimeout(toastTimer));
$('#toast').addEventListener('mouseleave', hideToastLater);
$('#toast').addEventListener('focusin', () => clearTimeout(toastTimer));
$('#toast').addEventListener('focusout', hideToastLater);
function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
const ICONS = {
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4', external: 'M14 4h6v6M20 4l-9 9M10 4H4v16h16v-6', inbox: 'M4 4h16v12H9l-5 4zM8 8h8M8 12h5',
  publishing: 'M4 5h16v16H4zM8 2v6m8-6v6M4 11h16', automation: 'm13 3-8 11h6l-1 7 9-12h-6z', catalog: 'M4 4h7v16H4zM13 4h7v16h-7zM7 8h1M16 8h1',
  alert: 'M12 9v4m0 4h.01M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z', refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  chevronRight: 'm9 6 6 6-6 6', chevronDown: 'm6 9 6 6 6-6', search: 'M15 15l5 5M16 10a6 6 0 1 1-12 0a6 6 0 0 1 12 0z', list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
};
function icon(type, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); if (className) svg.setAttribute('class', className);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[type] || ICONS.inbox);
  svg.append(path); return svg;
}
// Explicit state enums for every visible state. Copy never decides the visual state.
const STATUS_KINDS = new Set(['neutral', 'info', 'progress', 'success', 'warning', 'error']);
// Unchanged text is not rewritten, so live regions are not re-announced on every redraw.
function setStatus(node, kind, text) { if (typeof node === 'string') node = $(node); node.dataset.kind = STATUS_KINDS.has(kind) ? kind : 'neutral'; if (node.textContent !== text) node.textContent = text; return node; }
function statusPill(kind, text) { return setStatus(el('span', 'status'), kind, text); }
function setHint(selector, kind, text) { return setStatus($(selector), kind, text); }
function plural(count, one, many) { return `${count} ${count === 1 ? one : many}`; }
function flashSuccess(node) {
  if (!node) return;
  node.classList.remove('just-saved'); void node.offsetWidth; node.classList.add('just-saved');
  node.addEventListener('animationend', () => node.classList.remove('just-saved'), { once: true });
}
// Keeps a button's width and announces work in progress without changing what the button does.
function setButtonBusy(button, busy, busyText = '') {
  const target = button.querySelector('.button-label') || button;
  if (busy) {
    if (button.dataset.idleLabel === undefined) { button.dataset.idleLabel = target.textContent; button.style.minInlineSize = `${button.offsetWidth}px`; }
    target.textContent = busyText; button.setAttribute('aria-busy', 'true'); button.disabled = true;
  } else if (button.dataset.idleLabel !== undefined) {
    target.textContent = button.dataset.idleLabel; delete button.dataset.idleLabel; button.style.minInlineSize = ''; button.removeAttribute('aria-busy');
  }
}
function describedBy(field, id, add) {
  const ids = new Set((field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  if (add) ids.add(id); else ids.delete(id);
  if (ids.size) field.setAttribute('aria-describedby', [...ids].join(' ')); else field.removeAttribute('aria-describedby');
}
// Inline validation: the message sits right under the field and is read with it.
function fieldError(selector, message, { focus = true } = {}) {
  const field = typeof selector === 'string' ? $(selector) : selector;
  const host = field.closest('.field') || field.parentElement;
  const id = `${field.id || field.name}-error`;
  let note = document.getElementById(id);
  if (!note) { note = el('span', 'field-error'); note.id = id; (field.closest('.file-drop, .select-wrap') || field).after(note); }
  if (!host.contains(note)) host.append(note);
  note.textContent = message; field.setAttribute('aria-invalid', 'true'); describedBy(field, id, true);
  if (focus) field.focus();
  return false;
}
function clearFieldError(field) {
  if (!field?.id && !field?.name) return;
  const id = `${field.id || field.name}-error`;
  document.getElementById(id)?.remove(); field.removeAttribute('aria-invalid'); describedBy(field, id, false);
}
function radioValue(formSelector, name) { return $(formSelector).elements[name].value; }
function setRadioValue(formSelector, name, value) { $(formSelector).elements[name].value = value; }
// Loading, empty and error look different; errors always offer the same loader again.
function stateBlock(kind, title, description = '', { iconName = 'inbox', retry = null, inset = false } = {}) {
  const node = el('div', `state-block${inset ? ' inset' : ''}`); node.dataset.kind = kind;
  if (kind === 'loading') {
    node.setAttribute('aria-busy', 'true'); node.append(el('span', 'sr-only', title));
    for (let index = 0; index < (inset ? 2 : 3); index++) { const bar = el('span', 'skeleton'); bar.setAttribute('aria-hidden', 'true'); node.append(bar); }
    return node;
  }
  node.append(icon(kind === 'error' ? 'alert' : iconName), el('h3', '', title));
  if (description) node.append(el('p', '', description));
  if (retry) { const button = el('button', 'button ghost'); button.type = 'button'; button.append(icon(retry === openConnection ? 'inbox' : 'refresh'), el('span', 'button-label', retry === openConnection ? 'Conectar Instagram' : 'Tentar de novo')); button.addEventListener('click', retry); node.append(button); }
  return node;
}
function placeFeedback(feedback, host) { if (host && feedback.parentElement !== host) host.prepend(feedback); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Mensagem copiada. Confira o histórico antes de enviar.', 'success'); }
  catch { toast('A cópia não foi permitida. Selecione o texto da mensagem e copie.', 'warning'); $('#recovery-text').focus(); $('#recovery-text').select(); }
}
function focusCurrentView() {
  const heading = [...document.querySelectorAll('main h1')].find(node => !node.closest('[hidden]'));
  const target = heading || $('#main'); target.setAttribute('tabindex', '-1'); target.focus();
}
document.querySelectorAll('.nav-item').forEach(link => link.addEventListener('click', () => { if (link.getAttribute('href') === location.hash) focusCurrentView(); }));
document.querySelectorAll('.skip-link').forEach(link => link.addEventListener('click', event => { event.preventDefault(); focusCurrentView(); }));
// The sticky offline strip sits under the sticky navigation row on narrow screens.
if ('ResizeObserver' in window) new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--nav-offset', `${entry.target.offsetHeight}px`)).observe($('#app-navigation'));
const views = ['publishing', 'automation', 'inbox', 'catalog', 'settings', 'assistant', 'provider', 'preview', 'recovery', 'simulator'];
const viewTitles = { publishing: 'Campanhas', automation: 'Automações', inbox: 'Conversas', catalog: 'Produtos', settings: 'Ajustes', assistant: 'Assistente', provider: 'Provedor de IA', preview: 'Teste do assistente', recovery: 'Recuperação', simulator: 'Simulador' };
function revealActiveNav(item) {
  const strip = item.parentElement;
  if (strip.scrollWidth <= strip.clientWidth) return;
  strip.scrollTo({ left: Math.max(0, item.offsetLeft - (strip.clientWidth - item.offsetWidth) / 2) });
}
function route() {
  const requested = location.hash.slice(1);
  const view = !selectedAccountId && accountsState === 'ready' && !['settings', 'provider'].includes(requested) ? 'publishing' : ['recovery', 'simulator'].includes(requested) && !legacyAccountSelected() ? 'settings' : views.includes(requested) ? requested : 'publishing';
  for (const name of views) $(`#${name}-view`).hidden = name !== view;
  document.title = `${viewTitles[view]} · Benion`;
  const section = ['provider', 'recovery', 'simulator'].includes(view) ? 'settings' : ['assistant', 'preview'].includes(view) ? 'automation' : view;
  for (const name of ['publishing', 'automation', 'inbox', 'catalog', 'settings']) {
    const nav = $(`#nav-${name}`); nav.classList.toggle('active', name === section);
    if (name === section) { nav.setAttribute('aria-current', 'page'); revealActiveNav(nav); } else nav.removeAttribute('aria-current');
  }
  if (!selectedAccountId) { if (view === 'provider' && providerState === 'idle') loadProvider(); renderPublishing(); return; }
  if (view === 'inbox') { if (inboxState === 'idle') loadInbox(); if (assistantState === 'idle') loadAssistantConfig(); }
  if (view === 'catalog' && catalogState === 'idle') loadCatalog();
  if (['automation', 'assistant', 'preview'].includes(view) && assistantState === 'idle') loadAssistantConfig();
  if (view === 'provider' && providerState === 'idle') loadProvider();
  if (view === 'automation' && campaignState === 'idle') loadCampaigns();
  if (view === 'publishing' && publishingState === 'idle') loadPublishing();
  renderInboxRefresh();
}
window.addEventListener('hashchange', () => { route(); focusCurrentView(); });

let legacyStep = 0;
function renderLegacyStep() {
  for (let step = 0; step < 3; step++) $(`#legacy-step-${step}`).hidden = legacyStep !== step;
  $('#legacy-step-label').textContent = `Passo ${legacyStep + 1} de 3`; $('#legacy-progress').value = legacyStep + 1;
  $('#legacy-next').hidden = legacyStep === 2; $('#legacy-back').hidden = legacyStep === 0;
}
$('#legacy-next').addEventListener('click', () => { legacyStep = Math.min(2, legacyStep + 1); renderLegacyStep(); });
$('#legacy-back').addEventListener('click', () => { legacyStep = Math.max(0, legacyStep - 1); renderLegacyStep(); });
function showLegacyTool(test) {
  $('#legacy-editor-panel').hidden = test; $('#legacy-simulator-panel').hidden = !test;
  $('#legacy-edit-tab').setAttribute('aria-pressed', String(!test)); $('#legacy-test-tab').setAttribute('aria-pressed', String(test));
}
$('#legacy-edit-tab').addEventListener('click', () => showLegacyTool(false));
$('#legacy-test-tab').addEventListener('click', () => showLegacyTool(true));
function renderForm() {
  const form = $('#flow-form');
  for (const key of ['name', 'reel', 'keywords', 'firstMessage', 'optInLabel', 'secondMessage', 'linkLabel', 'linkUrl']) form.elements[key].value = flow[key];
  form.elements.enabled.checked = flow.enabled;
  form.elements.trigger.value = flow.trigger;
  flow.publicReplies.forEach((text, i) => form.elements[`reply${i}`].value = text);
  $('#recovery-text').value = flow.recoveryMessage;
  updateFormVisibility();
}
function updateFormVisibility() {
  $('#keyword-field').hidden = $('#flow-form').elements.trigger.value !== 'keyword';
  $('#enabled-label').textContent = $('#flow-enabled').checked ? 'Ativa no simulador' : 'Pausada no simulador';
}
$('#flow-form').addEventListener('input', () => {
  $('#flow-save-state').textContent = 'Alterações ainda não salvas';
  updateFormVisibility();
});
$('#flow-form').addEventListener('submit', event => {
  event.preventDefault();
  if (legacyStep !== 2) { legacyStep++; renderLegacyStep(); return; }
  const data = new FormData(event.currentTarget);
  const next = { ...flow, enabled: $('#flow-enabled').checked };
  for (const key of ['name', 'reel', 'keywords', 'trigger', 'firstMessage', 'optInLabel', 'secondMessage', 'linkLabel', 'linkUrl']) next[key] = String(data.get(key) || '').trim();
  next.publicReplies = [0, 1, 2].map(i => String(data.get(`reply${i}`) || '').trim());
  const errors = validateFlow(next);
  $('#flow-errors').hidden = !errors.length;
  $('#flow-errors').replaceChildren(...errors.map(error => el('p', '', error)));
  if (errors.length) return;
  if (!persist(STORE, next)) return;
  flow = next;
  $('#flow-save-state').textContent = 'Fluxo salvo neste navegador';
  toast('Fluxo salvo. Reinicie a simulação para testar do começo.', 'success');
  renderSimulation();
});
let recoverySaveTimer;
$('#recovery-text').addEventListener('input', event => {
  clearTimeout(recoverySaveTimer);
  $('#recovery-save-state').textContent = 'Salvando…';
  recoverySaveTimer = setTimeout(() => {
    flow.recoveryMessage = event.target.value;
    $('#recovery-save-state').textContent = persist(STORE, flow) ? 'Salvo neste navegador' : 'Não foi salvo';
  }, 350);
});
$('#copy-recovery').addEventListener('click', () => copyText($('#recovery-text').value));
function chooseConnectionTask(task = null) {
  $('#connection-tasks').hidden = Boolean(task); $('#connection-task-back').hidden = !task;
  $('#new-account-form').hidden = task !== 'add'; $('#access-check-panel').hidden = task !== 'verify'; $('#renew-account-panel').hidden = task !== 'renew';
  $('#connection-meta-links').hidden = !['add', 'renew'].includes(task);
  if (task === 'add') $('#new-account-username').focus();
  if (task === 'renew') $('#connection-token').focus();
  if (task === 'verify') $('#verify-access').focus();
}
let connectionOpener = null;
function openConnection(event) { connectionOpener = event?.currentTarget || document.activeElement; $('#connection-dialog').showModal(); chooseConnectionTask(selectedAccountId ? null : 'add'); if (selectedAccountId) refreshConnectionStatus(); }
$('#open-connection').addEventListener('click', openConnection);
$('#settings-accounts').addEventListener('click', openConnection);
$('#connect-first-account').addEventListener('click', openConnection);
$('#choose-add-account').addEventListener('click', () => chooseConnectionTask('add'));
$('#choose-verify-account').addEventListener('click', () => chooseConnectionTask('verify'));
$('#choose-renew-account').addEventListener('click', () => chooseConnectionTask('renew'));
$('#connection-task-back').addEventListener('click', () => { chooseConnectionTask(); $('#choose-add-account').focus(); });
function renderNetwork() { $('#network-state').hidden = navigator.onLine !== false; }
window.addEventListener('online', renderNetwork); window.addEventListener('offline', renderNetwork);
$('#back-to-threads').addEventListener('click', () => {
  if (threadBusy) return;
  const previousId = selectedThreadId;
  saveInboxDraft(); selectedThreadId = null; selectedThread = null; threadRequestSequence++;
  $('#thread-detail').hidden = true; $('#thread-empty').hidden = false; renderInboxList();
  const previousItem = [...document.querySelectorAll('#thread-list [data-thread-id]')].find(item => item.dataset.threadId === previousId);
  (previousItem || $('#inbox-search')).focus();
});
$('#close-connection').addEventListener('click', () => $('#connection-dialog').close());
$('#connection-dialog').addEventListener('close', () => {
  $('#connection-token').value = ''; $('#new-account-token').value = '';
  // Return focus to whatever opened the dialog; fall back to the header button when it is gone or hidden.
  const opener = connectionOpener && connectionOpener.isConnected && connectionOpener.offsetParent !== null ? connectionOpener : $('#open-connection');
  connectionOpener = null; opener.focus();
});

function recoveryReady(capabilities) {
  return Number.isInteger(capabilities?.recovery?.expected) && capabilities.recovery.expected > 0 && capabilities.recovery.protected === capabilities.recovery.expected && (capabilities.diagnosticComplete === true || capabilities.futureOnlyReady === true);
}
function recoverySummary(capabilities) {
  const recovery = capabilities?.recovery;
  if (!recovery) return '';
  if (capabilities.futureOnlyReady === true && capabilities.diagnosticComplete !== true) {
    return `${recovery.protected} comentários já atendidos estão protegidos por ID; ${recovery.matched} visíveis na leitura atual e ${recovery.unmatched} ausente. O diagnóstico histórico continua parcial.`;
  }
  return `${recovery.protected} de ${recovery.expected} comentários atendidos protegidos contra repetição. ${recovery.blocked} aguardando conferência; ${recovery.excluded} respostas em discussão excluídas.`;
}
function recoveryFutureNote(capabilities) {
  return typeof capabilities?.futureOnlyNote === 'string' && capabilities.futureOnlyNote ? capabilities.futureOnlyNote : 'O autor do comentário ausente ainda não tem um ID oficial confirmado. Um novo comentário dessa pessoa pode exigir conferência; a ausência não confirma remoção.';
}
const accessDetailsOpen = new Set();
function displayConnection(status) {
  const previousAccess = JSON.stringify([currentConnection?.connected, currentConnection?.automation?.running, recoveryReady(currentConnection?.capabilities)]);
  const expected = selectedAccount();
  const validated = status?.connected === true && Boolean(expected) && status.identity?.username?.toLowerCase() === expected.username.toLowerCase() && String(status.identity?.userId) === String(expected.id);
  const automation = status?.automation;
  const running = validated && automation?.running === true;
  const hosted = status?.runtime?.environment === 'hosted';
  currentConnection = { ...status, connected: validated };
  $('#real-runtime-note').textContent = hosted ? 'O envio depende de o serviço estar em execução no servidor. Reiniciar desliga o envio até nova verificação e ativação. O aceite da API não confirma recebimento nem leitura.' : 'Funciona neste computador enquanto o Node estiver rodando e o computador estiver ligado. Reiniciar desliga o envio. O aceite da API não confirma recebimento nem leitura.';
  $('#connection-status').classList.toggle('validated', validated);
  $('#connection-status-label').textContent = running ? (hosted ? 'Ativo no servidor' : 'Ativo neste computador') : validated ? 'Conta validada' : 'Conexão por verificar';
  $('#connection-summary').textContent = !expected ? 'Conecte sua primeira conta profissional do Instagram.' : running ? `@${accountUsername()} · ${hosted ? 'Envio automático ativo no servidor.' : 'Envio automático ativo neste computador.'}` : validated ? `Conta @${accountUsername()} validada. Confira as automações em Automações.` : `@${accountUsername()} · Conexão por verificar nesta sessão.`;
  if (validated) {
    const checked = new Date(status.checkedAt);
    const timestamp = Number.isNaN(checked.getTime()) ? '' : ` Última validação: ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(checked)}.`;
    setHint('#connection-details', 'success', running ? `Identidade confirmada pela API oficial.${timestamp} O envio automático acompanha novos comentários enquanto o serviço estiver em execução.` : `Identidade confirmada pela API oficial.${timestamp} ${legacyAccountSelected() ? 'Verifique os acessos e a recuperação' : 'Verifique os acessos e revise uma automação desta conta'} antes de ativar o envio.`);
  } else setHint('#connection-details', 'warning', 'A identidade ainda não foi verificada nesta sessão do servidor. Use Verificar acessos para revalidar o token salvo. Validar a identidade não ativa a automação nem envia DMs.');
  const renewal = status?.tokenRefresh;
  const renewalNote = renewal?.state === 'reauthorization_required' ? 'Renovação interrompida: substitua o token para reconectar a conta.' : renewal?.state === 'retrying' ? 'A renovação encontrou uma falha temporária. O servidor tentará novamente no horário registrado.' : renewal?.state === 'scheduled' ? 'Renovação automática programada antes do vencimento.' : renewal?.state === 'waiting' ? 'Renovação automática aguardando a idade mínima do token; vencimento ainda não confirmado.' : '';
  if (renewalNote) $('#connection-details').append(document.createTextNode(` ${renewalNote}`));
  if (renewal?.state === 'reauthorization_required') $('#connection-details').dataset.kind = 'warning';
  const nextAccess = JSON.stringify([validated, status?.automation?.running, recoveryReady(status?.capabilities)]);
  if (previousAccess !== nextAccess) renderCampaignList();
  const caps = status?.capabilities;
  const ready = validated && recoveryReady(caps);
  const futureOnly = caps?.futureOnlyReady === true && caps.diagnosticComplete !== true;
  setStatus('#comment-card-state', running ? 'success' : ready ? 'info' : 'warning', running ? 'Em execução' : ready ? 'Pronto para novos comentários' : 'Bloqueado');
  $('#comment-card-gate').textContent = running ? 'Somente novos comentários após a ativação.' : futureOnly ? recoverySummary(caps) : caps && caps.recovery?.protected !== caps.recovery?.expected ? 'A proteção dos comentários anteriores já atendidos ainda não foi confirmada.' : 'Confira os acessos e a proteção dos atendimentos anteriores na Recuperação.';
  $('#legacy-comment-card').hidden = !legacyAccountSelected();
  if (!legacyAccountSelected()) {
    setStatus('#comment-card-state', 'neutral', 'Automações desta conta');
    $('#comment-card-gate').textContent = `Cadastre uma automação para os Reels de @${accountUsername()}. A nova automação começa pausada.`;
  }
  $('#start-automation').disabled = !ready || running || Boolean(automation?.reviewReason);
  $('#start-automation').hidden = running;
  $('#stop-automation').hidden = !running;
  $('#real-message').disabled = running;
  setStatus('#real-state', running ? 'success' : automation?.reviewReason ? 'warning' : 'neutral', running ? (hosted ? 'Ativo no servidor' : 'Ativo neste computador') : automation?.reviewReason ? 'Revisão necessária' : 'Inativo');
  const realGateKind = running ? 'info' : automation?.reviewReason ? 'error' : ready ? (futureOnly ? 'info' : 'success') : 'warning';
  setHint('#real-gate', realGateKind, running ? `Somente comentários novos após a ativação. A lista anterior fica protegida.${futureOnly ? ` ${recoveryFutureNote(caps)}` : ''}` : automation?.reviewReason ? `Envio bloqueado para revisão: ${automation.reviewReason}. Nenhuma tentativa será repetida automaticamente.` : ready ? futureOnly ? `${recoverySummary(caps)} ${recoveryFutureNote(caps)}` : 'Acessos verificados. Os atendimentos anteriores estão protegidos.' : caps && caps.recovery?.protected !== caps.recovery?.expected ? 'A proteção dos comentários anteriores já atendidos ainda não foi confirmada. Abra a conexão para conferir o diagnóstico.' : caps ? 'O diagnóstico de acessos ainda está incompleto. Abra a conexão para conferir o diagnóstico.' : 'Verifique os acessos da API e a proteção dos comentários anteriores antes de ativar.');
  $('#real-accepted').textContent = String(automation?.acceptedCount || 0);
  $('#real-unknown').textContent = String(automation?.unknownCount || 0);
  $('#real-last-check').textContent = automation?.lastCheckAt ? `Última checagem: ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(automation.lastCheckAt))}` : 'Nenhuma checagem automática.';
  $('#verify-access').disabled = running;
  $('#validate-connection').disabled = running;
  const records = (automation?.records || []).filter(record => record.messageId || ['unknown', 'rejected'].includes(record.kind)).slice(-10);
  $('#real-records-panel').hidden = !records.length;
  $('#real-records').replaceChildren(...records.map(record => {
    const row = el('div', 'real-record');
    const kinds = { accepted: 'success', unknown: 'warning', rejected: 'error' };
    row.append(el('strong', '', record.username ? `@${record.username}` : 'Tentativa registrada'));
    row.append(statusPill(kinds[record.kind] || 'neutral', record.kind === 'accepted' ? 'Aceito pela API' : record.kind === 'unknown' ? 'Resultado indeterminado' : record.kind === 'rejected' ? 'Rejeitado pela API' : 'Registro do provedor'));
    if (record.messageId) row.append(el('small', '', `message_id: ${record.messageId}`));
    if (record.recipientId) row.append(el('small', '', `recipient_id: ${record.recipientId}`));
    if (record.code) row.append(el('small', '', `Código: ${record.code}`));
    return row;
  }));
  const results = $('#access-results');
  results.replaceChildren(); results.hidden = !caps;
  if (caps) {
    for (const [key, title] of [['media', 'Publicações'], ['comments', 'Comentários do reel'], ['conversations', 'Conversas · amostra de 1']]) {
      const read = caps.reads?.[key];
      const row = el('div', 'access-result'); const top = el('div', 'access-result-top');
      const accepted = read?.status === 'accepted';
      top.append(el('strong', '', title), statusPill(accepted ? 'success' : read?.status === 'not_checked' ? 'neutral' : 'error', accepted ? 'Leitura aceita' : read?.status === 'not_checked' ? 'Não verificado' : 'Bloqueado'));
      row.append(top);
      if (accepted && key === 'comments') row.append(el('p', 'list-status', `${read.count} comentários retornados nesta leitura${read.truncated ? '; paginação incompleta' : ''}.`));
      if (accepted && key === 'conversations' && read.count === 0 && read.truncated) row.append(el('p', 'list-status', 'Esta página retornou 0 registros e continuidade. A existência de conversas é inconclusiva.'));
      if (read?.code) {
        // Error codes help support; they stay one tap away instead of in the main reading line.
        const technical = el('details', 'disclosure'); const summary = el('summary'); summary.append(icon('chevronRight'), document.createTextNode('Detalhes técnicos'));
        technical.open = accessDetailsOpen.has(key); technical.addEventListener('toggle', () => { if (technical.open) accessDetailsOpen.add(key); else accessDetailsOpen.delete(key); });
        technical.append(summary, el('p', 'access-code', `${read.code}${Number.isInteger(read.graphCode) ? ` · Meta ${read.graphCode}` : ''}${Number.isInteger(read.httpStatus) ? ` · HTTP ${read.httpStatus}` : ''}`));
        row.append(technical);
      }
      results.append(row);
    }
    const recovery = caps.recovery;
    if (recovery) results.append(el('p', 'access-recovery', recoverySummary(caps)));
    if (futureOnly) results.append(el('p', 'hint access-note', recoveryFutureNote(caps)));
    results.append(el('p', 'hint access-note', 'Leituras aceitas confirmam estes acessos. O envio de mensagens ainda não foi validado.'));
  }
}
async function refreshConnectionStatus() {
  if (!selectedAccountId) return;
  const scope = accountScope();
  try {
    const result = await apiRead('/api/connection/status', scope); assertScope(scope); displayConnection(result);
  } catch { /* Keep the conservative disconnected state when the server cannot answer. */ }
}
$('#connection-form').addEventListener('submit', async event => {
  event.preventDefault(); const scope = accountScope();
  let accessToken = $('#connection-token').value.trim(); $('#connection-token').value = '';
  const apiVersion = $('#connection-version').value.trim();
  clearFieldError($('#connection-token'));
  if (!accessToken) { $('#connection-feedback').hidden = true; fieldError('#connection-token', 'Cole o token oficial desta conta antes de validar.'); return; }
  setButtonBusy($('#validate-connection'), true, 'Validando…'); showFeedback('#connection-feedback', `Validando a identidade de @${accountUsername()} na Meta…`, 'progress');
  try {
    const body = { accessToken, apiVersion }; accessToken = '';
    const result = await apiWrite('/api/connection', body, scope); body.accessToken = '';
    assertScope(scope); displayConnection(result);
    showFeedback('#connection-feedback', 'Conta validada. Token guardado no servidor privado. A validação não ativa a automação.', 'success');
  } catch (error) {
    if (!currentScope(scope)) return;
    const messages = { WRONG_ACCOUNT: `O token precisa pertencer à conta @${accountUsername()}.`, IDENTITY_UNVERIFIED: 'A Meta não retornou uma identidade válida.', TOKEN_VALIDATION_FAILED: 'Não foi possível validar o token na Meta.', PRIVATE_STORE_FAILED: 'Não foi possível guardar a conexão no armazenamento privado.', BUSY: 'Já existe uma validação em andamento. Aguarde.', CSRF_INVALID: 'Esta tentativa expirou. Valide novamente.' };
    showFeedback('#connection-feedback', messages[error.code] || 'O serviço não confirmou a validação. Confira a conta e a autorização oficial.', 'error');
  } finally { accessToken = ''; setButtonBusy($('#validate-connection'), false); if (currentScope(scope)) { $('#connection-token').value = ''; $('#validate-connection').disabled = false; } }
});
$('#connection-token').addEventListener('input', event => clearFieldError(event.target));
$('#new-account-form').addEventListener('input', event => clearFieldError(event.target));
$('#verify-access').addEventListener('click', async () => {
  const scope = accountScope(); setButtonBusy($('#verify-access'), true, 'Verificando…');
  showFeedback('#access-feedback', `Verificando os acessos de @${accountUsername()} na Meta…`, 'progress');
  try {
    const result = await apiWrite('/api/connection/verify', {}, scope); assertScope(scope); displayConnection(result);
    const partial = legacyAccountSelected() && !result.capabilities?.diagnosticComplete;
    showFeedback('#access-feedback', legacyAccountSelected() ? result.capabilities?.diagnosticComplete ? 'Leituras verificadas e recuperação reconciliada. A verificação não ativa o envio.' : 'Verificação parcial. Confira os acessos e os registros abaixo.' : 'Conexão da conta verificada. Revise os acessos abaixo antes de ativar uma automação.', partial ? 'warning' : 'success');
  } catch (error) {
    if (!currentScope(scope)) return;
    const messages = { CONNECTION_REQUIRED: 'Valide um token oficial desta conta antes de verificar.', PRIVATE_STORE_INVALID: 'A conexão salva precisa ser validada novamente.', TOKEN_VALIDATION_FAILED: 'O token salvo não pôde ser validado na Meta.', WRONG_ACCOUNT: `A conexão salva precisa pertencer a @${accountUsername()}.`, RECOVERY_INVALID: 'O registro de recuperação precisa conter os atendimentos anteriores desta publicação.', BUSY: 'Já existe uma validação em andamento. Aguarde.', CSRF_INVALID: 'Esta tentativa expirou. Verifique novamente.' };
    showFeedback('#access-feedback', messages[error.code] || 'O serviço não confirmou a verificação dos acessos.', 'error'); await refreshConnectionStatus();
  } finally { setButtonBusy($('#verify-access'), false); if (currentScope(scope)) $('#verify-access').disabled = false; }
});
$('#real-message').value = DEFAULT_FLOW.recoveryMessage;
function realMessageSize() {
  const bytes = new TextEncoder().encode($('#real-message').value).length;
  $('#real-message-size').textContent = `${bytes} / 1000 bytes`;
  return bytes;
}
$('#real-message').addEventListener('input', realMessageSize); realMessageSize();
async function setRealAutomation(action) {
  if (!legacyAccountSelected()) return;
  const scope = accountScope(); const messageText = $('#real-message').value.trim();
  if (action === 'start' && (!messageText || realMessageSize() > 1000)) {
    showFeedback('#real-feedback', 'Preencha a primeira DM e respeite o limite de tamanho. O servidor confere os links configurados.', 'error'); return;
  }
  const button = $(action === 'start' ? '#start-automation' : '#stop-automation');
  $('#start-automation').disabled = true; $('#stop-automation').disabled = true; setButtonBusy(button, true, action === 'start' ? 'Ativando…' : 'Parando…');
  showFeedback('#real-feedback', action === 'start' ? 'Conferindo a lista atual antes de ativar…' : 'Parando novos envios…', 'progress');
  try {
    const result = await apiWrite(`/api/connection/${action}`, action === 'start' ? { messageText } : {}, scope); assertScope(scope); displayConnection(result);
    showFeedback('#real-feedback', action === 'start' ? 'Envio ativo. Só os novos comentários serão atendidos.' : 'Envio automático parado. Uma tentativa já iniciada pode concluir.', 'success');
  } catch { if (currentScope(scope)) showFeedback('#real-feedback', 'O serviço não confirmou a operação. Confira o estado e os acessos antes de tentar novamente.', 'error'); }
  finally { setButtonBusy(button, false); if (currentScope(scope)) { $('#stop-automation').disabled = false; await refreshConnectionStatus(); } }
}
$('#start-automation').addEventListener('click', () => setRealAutomation('start'));
$('#stop-automation').addEventListener('click', () => setRealAutomation('stop'));
setInterval(() => { if (document.visibilityState === 'visible') refreshConnectionStatus(); }, 15000);

function reviewKey(comment) { return `${comment.commentId || ''}:${comment.username}`; }
function localReview(comment) {
  const review = reviews[reviewKey(comment)];
  return review && Object.hasOwn(labels, review.status) && review.sourceStatus === comment.status && review.sourceNote === comment.note ? review : null;
}
function effectiveStatus(comment) { return localReview(comment)?.status || comment.status; }
function renderRecovery() {
  const pending = recovery.comments.filter(comment => effectiveStatus(comment) === 'needs_review').length;
  const sent = recovery.comments.filter(comment => comment.status === 'sent').length;
  const received = recovery.comments.filter(comment => comment.status === 'already_received').length;
  const countUnavailable = recoveryState === 'loading' || recoveryState === 'error';
  $('#pending-count').textContent = countUnavailable ? '—' : String(pending);
  $('#sent-count').textContent = countUnavailable ? '—' : String(sent);
  $('#received-count').textContent = countUnavailable ? '—' : String(received);
  $('#nav-count').textContent = String(pending);
  $('#nav-count').hidden = !pending;
  if (recovery.updatedAt) {
    const date = new Date(recovery.updatedAt);
    $('#source-updated').textContent = Number.isNaN(date.getTime()) ? 'Registro da sessão' : `Registro da sessão · ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(date)}`;
  } else $('#source-updated').textContent = recoveryState === 'loading' ? 'Carregando registros…' : recoveryState === 'error' ? 'Erro ao carregar o registro' : 'Sem registro importado';
  const filter = $('#status-filter').value;
  const shown = recovery.comments.filter(comment => filter === 'all' || effectiveStatus(comment) === filter);
  const list = $('#recovery-list');
  const focusedReview = document.activeElement?.closest?.('#recovery-list [data-review-key]')?.dataset.reviewKey;
  list.replaceChildren();
  if (!shown.length) {
    if (recoveryState === 'loading') list.append(stateBlock('loading', 'Carregando comentários…'));
    else if (recoveryState === 'error') list.append(stateBlock('error', 'Não foi possível carregar o registro', 'Confira o arquivo local de recuperação e tente de novo.', { retry: loadRecovery }));
    else if (recovery.comments.length) list.append(stateBlock('empty', 'Nenhuma pessoa neste status', 'Escolha outro filtro para ver os comentários registrados.', { iconName: 'list' }));
    else list.append(stateBlock('empty', 'Os comentários aparecerão aqui', 'A lista usa os comentários verificados e registrados nesta sessão. Atualize depois da revisão do reel.', { iconName: 'inbox' }));
    return;
  }
  const statusKinds = { needs_review: 'warning', sent: 'success', already_received: 'success', blocked: 'error' };
  for (const comment of shown) {
    const review = localReview(comment);
    const status = effectiveStatus(comment);
    const row = el('article', 'comment-row'); row.dataset.reviewKey = reviewKey(comment);
    const top = el('div', 'comment-top');
    const initials = comment.username.replace(/^@/, '').slice(0, 2).toUpperCase();
    const avatar = el('span', 'comment-avatar', initials); avatar.setAttribute('aria-hidden', 'true'); top.append(avatar);
    const person = el('div', 'comment-person');
    person.append(el('strong', '', `@${comment.username.replace(/^@/, '')}`), el('span', '', comment.ageLabel || 'Horário não registrado'));
    top.append(person, statusPill(statusKinds[status] || 'neutral', labels[status]));
    row.append(top, el('p', 'comment-text', comment.text || '(Comentário sem texto)'));
    if (comment.note) row.append(el('p', 'comment-note', comment.note));
    const actions = el('div', 'comment-actions');
    const profile = el('a', 'button ghost', 'Abrir perfil');
    profile.href = `https://www.instagram.com/${encodeURIComponent(comment.username.replace(/^@/, ''))}/`;
    profile.target = '_blank'; profile.rel = 'noopener noreferrer'; profile.append(icon('external'));
    const copy = el('button', 'button', 'Copiar mensagem'); copy.type = 'button';
    copy.addEventListener('click', () => copyText($('#recovery-text').value));
    actions.append(copy, profile);
    if (typeof comment.threadUrl === 'string' && /^https:\/\/www\.instagram\.com\/direct\/t\/\d+\/$/.test(comment.threadUrl)) {
      const thread = el('a', 'button ghost', 'Ver DM');
      thread.href = comment.threadUrl; thread.target = '_blank'; thread.rel = 'noopener noreferrer'; thread.append(icon('external'));
      actions.append(thread);
    }
    const edit = el('label', 'local-edit'); edit.append(el('span', '', 'Controle local'));
    const wrap = el('span', 'select-wrap'); const select = el('select'); select.setAttribute('aria-label', `Status local de @${comment.username}`);
    for (const [value, text] of Object.entries(labels)) {
      const option = el('option', '', text); option.value = value; select.append(option);
    }
    select.value = status;
    select.addEventListener('change', () => {
      reviews[reviewKey(comment)] = { status: select.value, sourceStatus: comment.status, sourceNote: comment.note };
      if (persist(REVIEW_STORE, reviews)) { renderRecovery(); toast('Controle local atualizado. Esta ação não envia DM.', 'success'); }
    });
    wrap.append(select, icon('chevronDown')); edit.append(wrap); actions.append(edit); row.append(actions);
    if (focusedReview === row.dataset.reviewKey) queueMicrotask(() => select.focus());
    if (review && review.status !== comment.status) row.append(el('p', 'local-stamp', `Controle local alterado · registro da sessão: ${labels[comment.status].toLowerCase()}`));
    list.append(row);
  }
}
async function loadRecovery() {
  if (!legacyAccountSelected()) return;
  const scope = accountScope();
  setButtonBusy($('#refresh-recovery'), true, 'Atualizando…');
  try {
    const response = await fetch('/api/connection/recovery', { headers: scopedHeaders(scope), credentials: 'same-origin', cache: 'no-store' }); assertScope(scope);
    if (response.status === 404) { recovery = { comments: [], updatedAt: null }; recoveryState = 'empty'; }
    else {
      if (!response.ok) throw new Error('read-failed');
      const data = await response.json();
      if (data.schemaVersion !== 1 || !Array.isArray(data.comments)) throw new Error('invalid-schema');
      for (const comment of data.comments) {
        if (typeof comment.username !== 'string' || !/^[\w.]+$/.test(comment.username.replace(/^@/, '')) || !Object.hasOwn(labels, comment.status) || typeof comment.text !== 'string') throw new Error('invalid-comment');
      }
      assertScope(scope); recovery = data; recoveryState = 'ready';
      if (typeof data.reel === 'string' && /^https:\/\/www\.instagram\.com\/reel\/[A-Za-z0-9_-]+\/$/.test(data.reel)) { $('#legacy-reel-link').href = data.reel; $('#legacy-reel-link').hidden = false; }
    }
  } catch { if (currentScope(scope)) { recovery = { comments: [], updatedAt: null }; recoveryState = 'error'; } }
  finally { setButtonBusy($('#refresh-recovery'), false); if (currentScope(scope)) { renderRecovery(); $('#refresh-recovery').disabled = false; } }
}
$('#refresh-recovery').addEventListener('click', () => loadRecovery());
$('#status-filter').addEventListener('change', renderRecovery);

function renderSimulation() {
  const log = $('#simulation-log'); log.replaceChildren();
  const timeFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  if (!simulation.logs.length) log.append(stateBlock('empty', 'Comece com um comentário', 'Veja a primeira DM, interaja com o botão e acompanhe o envio do link.', { inset: true }));
  for (const entry of simulation.logs) {
    if (entry.kind === 'outgoing' || entry.kind === 'incoming') {
      const item = el('div', `chat-event ${entry.kind}`);
      const bubble = el('div', 'bubble', entry.text);
      if (entry.button) {
        const button = el('div', 'bubble-cta', entry.button);
        if (entry.href) button.append(el('span', 'bubble-link', entry.href));
        bubble.append(button);
      }
      const time = el('time', '', `${timeFormatter.format(entry.at)} · simulado`); time.dateTime = new Date(entry.at).toISOString();
      item.append(bubble, time); log.append(item);
    } else {
      const item = el('div', `system-event ${entry.kind}`);
      const prefix = entry.kind === 'comment' ? 'Comentário de teste: ' : entry.kind === 'public' ? 'Resposta pública simulada: ' : '';
      item.append(el('strong', '', prefix), document.createTextNode(entry.text)); log.append(item);
    }
  }
  log.scrollTop = log.scrollHeight;
  const remaining = windowRemaining(simulation);
  const window = $('#window-status'); window.classList.toggle('open', remaining > 0 && !simulation.human);
  window.replaceChildren();
  const state = simulation.human ? 'Atendimento manual' : simulation.interactedAt === null ? 'Aguardando interação' : remaining ? `Janela aberta · ${Math.ceil(remaining / HOUR)}h restantes` : 'Janela de 24h encerrada';
  const elapsed = Math.floor((simulation.now - simulation.initialNow) / HOUR);
  window.append(el('span', '', state), el('span', '', elapsed ? `Relógio +${elapsed}h` : 'Relógio de teste'));
  $('#simulate-optin').textContent = `Clicar em “${flow.optInLabel}”`;
  $('#simulate-optin').disabled = !simulation.privateReplied || simulation.human || simulation.continued;
}
$('#simulate-comment').addEventListener('click', () => {
  const text = $('#test-comment').value.trim();
  if (!text) { fieldError('#test-comment', 'Escreva um comentário de teste.'); return; }
  clearFieldError($('#test-comment'));
  const createdAt = simulation.initialNow - Number($('#comment-age').value) * HOUR;
  simulation = addComment(simulation, flow, { commentId: 'demo-comment', username: 'ana.teste', text, createdAt }); renderSimulation();
});
$('#simulate-optin').addEventListener('click', () => {
  simulation = receiveInteraction(simulation, flow.optInLabel);
  simulation = sendContinuation(simulation, flow); renderSimulation();
});
$('#simulate-second').addEventListener('click', () => { simulation = sendContinuation(simulation, flow); renderSimulation(); });
$('#simulate-interaction').addEventListener('click', () => { simulation = receiveInteraction(simulation, 'Quero testar, pode me enviar o link?'); renderSimulation(); });
document.querySelectorAll('[data-advance]').forEach(button => button.addEventListener('click', () => { simulation = advanceClock(simulation, Number(button.dataset.advance) * HOUR); renderSimulation(); }));
$('#simulate-human').addEventListener('click', () => { simulation = takeOver(simulation); renderSimulation(); });
$('#reset-simulation').addEventListener('click', () => { simulation = createSession(); renderSimulation(); toast('Simulação reiniciada.', 'info'); });
$('#test-comment').addEventListener('input', event => clearFieldError(event.target));



// These views contain only API records. Drafts stay in memory until explicitly saved.
let currentConnection = null;
let inboxState = 'idle';
let inboxThreads = [];
let selectedThreadId = null;
let selectedThread = null;
let threadRequestSequence = 0;
let threadBusy = false;
let threadActionRevision = 0;
let threadMessageSignature = null;
let renderedMessageKeys = [];
let threadPendingControl = null;
let inboxRefreshOperation = null;
let inboxLastSyncedAt = null;
let inboxRefreshFailed = false;
let inboxDrafts = new Map();
let unknownReplies = new Set();
const accountDraftStores = new Map([['default', inboxDrafts]]);
const accountUnknownStores = new Map([['default', unknownReplies]]);
let catalogState = 'idle';
let catalogLoaded = false;
let catalogAvailable = false;
let catalogDirty = false;
let catalogProducts = [];
let assistantState = 'idle';
let assistantConfig = null;
let assistantBusy = false;
let providerState = 'idle';
let providerStatus = null;
let providerBusy = false;

// kind is an explicit enum: 'info' | 'progress' | 'success' | 'warning' | 'error'.
const FEEDBACK_KINDS = new Set(['info', 'progress', 'success', 'warning', 'error']);
function showFeedback(selector, text, kind = 'info') {
  const node = $(selector); node.hidden = false; node.textContent = text; node.dataset.kind = FEEDBACK_KINDS.has(kind) ? kind : 'info';
}
let logoutBusy = false;
$('#logout-admin').addEventListener('click', async () => {
  if (logoutBusy) return;
  logoutBusy = true; setButtonBusy($('#logout-admin'), true, 'Saindo…');
  showFeedback('#logout-feedback', 'Encerrando a sessão do Benion…', 'progress');
  try { await apiWrite('/api/admin/logout', {}, accountScope(), false); location.href = '/admin/login'; }
  catch {
    logoutBusy = false; setButtonBusy($('#logout-admin'), false); $('#logout-admin').disabled = false;
    showFeedback('#logout-feedback', 'Não foi possível confirmar a saída. Tente novamente.', 'error');
  }
});
function shortTime(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(date) : '';
}
function fullTime(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(date) : 'Horário não informado';
}
function threadUsername(thread) {
  if (typeof thread?.username !== 'string' || !thread.username) return 'Conversa do Instagram';
  return /^@?[a-zA-Z0-9_.]{1,30}$/.test(thread.username) ? `@${thread.username.replace(/^@/, '')}` : thread.username;
}
function renderInboxList() {
  const list = $('#thread-list');
  // Automatic refreshes redraw the list every 15 s; keep keyboard focus on the same conversation.
  const focusedId = document.activeElement?.closest?.('#thread-list [data-thread-id]')?.dataset.threadId;
  list.replaceChildren();
  const query = $('#inbox-search').value.trim().toLowerCase();
  const shown = inboxThreads.filter(thread => !query || threadUsername(thread).toLowerCase().includes(query));
  if (!shown.length) {
    if (inboxState === 'loading' || inboxState === 'idle') list.append(stateBlock('loading', 'Carregando conversas…', '', { inset: true }));
    else if (inboxState === 'unavailable') list.append(stateBlock('error', 'Conversas indisponíveis', 'O serviço ainda não retornou uma lista. Nenhuma conversa de exemplo foi criada.', { inset: true, retry: () => loadInbox() }));
    else if (query) list.append(stateBlock('empty', 'Nenhuma conversa encontrada', 'Tente outro nome de usuário.', { inset: true, iconName: 'search' }));
    else list.append(stateBlock('empty', 'Nenhuma conversa ainda', 'As novas DMs aparecem aqui assim que chegarem pelo Instagram.', { inset: true }));
    return;
  }
  for (const thread of shown) {
    const current = thread.id === selectedThreadId;
    const button = el('button', 'thread-item'); button.type = 'button'; button.disabled = threadBusy; button.dataset.threadId = thread.id;
    if (current) button.setAttribute('aria-current', 'true');
    const avatar = el('span', 'comment-avatar', (thread.username || 'IG').slice(0, 2).toUpperCase()); avatar.setAttribute('aria-hidden', 'true'); button.append(avatar);
    const content = el('span', 'thread-item-text'); const heading = el('span', 'thread-item-heading');
    heading.append(el('strong', '', threadUsername(thread)), el('time', '', shortTime(thread.lastMessageAt)));
    content.append(heading, el('span', 'thread-preview', thread.preview || 'Abrir histórico da conversa'));
    const meta = el('span', 'thread-item-meta'); meta.append(el('span', '', thread.handoff ? 'Atendimento humano' : !assistantConfig ? 'Bot por verificar' : threadBotActive(thread) ? 'Bot habilitado' : 'Bot pausado'));
    if (thread.optout) meta.append(statusPill('error', 'Pediu para parar'));
    else if (thread.reviewRequired) meta.append(thread.sendInProgress || thread.lastMessageStatus === 'sending' ? statusPill('progress', 'Enviando') : statusPill('warning', 'Revisão necessária'));
    else if (thread.lastMessageActor === 'assistant') meta.append(el('span', '', 'Última resposta: bot'));
    else if (thread.lastMessageActor === 'human') meta.append(el('span', '', 'Última resposta: você'));
    if (Number.isInteger(thread.unreadCount) && thread.unreadCount > 0) { const unread = el('span', 'unread-dot', String(thread.unreadCount)); unread.append(el('span', 'sr-only', thread.unreadCount === 1 ? ' não lida' : ' não lidas')); meta.append(unread); }
    content.append(meta); button.append(content); button.addEventListener('click', () => selectThread(thread.id)); list.append(button);
    if (focusedId === thread.id && !button.disabled) queueMicrotask(() => button.focus());
  }
}
function renderInboxRefresh() {
  const refreshing = inboxRefreshOperation && currentScope(inboxRefreshOperation.scope);
  const enabled = $('#inbox-auto-refresh').checked;
  const visible = document.visibilityState === 'visible' && !$('#inbox-view').hidden;
  const automatic = enabled ? visible ? 'automático a cada 15 s' : 'automático em pausa com a tela oculta' : 'automático desligado';
  const kind = refreshing ? 'progress' : inboxRefreshFailed ? 'warning' : 'neutral';
  const text = refreshing ? 'Atualizando conversas… Seu rascunho fica preservado.' : inboxRefreshFailed ? 'A última atualização falhou. O histórico exibido pode estar desatualizado.' : inboxLastSyncedAt ? `Atualizado às ${shortTime(inboxLastSyncedAt)} · ${automatic}.` : `Ainda não atualizado · ${automatic}.`;
  setHint('#inbox-refresh-state', kind, text);
  $('#refresh-inbox').disabled = Boolean(refreshing) || threadBusy;
  $('#refresh-inbox .button-label').textContent = refreshing ? 'Atualizando…' : 'Atualizar';
  $('#refresh-inbox').setAttribute('aria-busy', String(Boolean(refreshing)));
}
async function loadInbox(options = {}) {
  const scope = accountScope();
  if (threadBusy) return;
  if (inboxRefreshOperation && currentScope(inboxRefreshOperation.scope)) return inboxRefreshOperation.promise;
  const operation = { scope, promise: null }; inboxRefreshOperation = operation;
  operation.promise = refreshInbox(scope, options);
  renderInboxRefresh();
  try { await operation.promise; }
  finally { if (inboxRefreshOperation === operation) inboxRefreshOperation = null; if (currentScope(scope)) renderInboxRefresh(); }
}
async function refreshInbox(scope, options) {
  const revision = threadActionRevision;
  if (inboxState !== 'ready') { inboxState = 'loading'; setHint('#inbox-source', 'progress', 'Lendo as conversas registradas no Benion…'); renderInboxList(); }
  try {
    const [listRead, configRead] = await Promise.allSettled([apiRead('/api/inbox', scope), apiRead('/api/assistant/config', scope)]); assertScope(scope);
    if (revision !== threadActionRevision || threadBusy) return;
    if (listRead.status !== 'fulfilled') throw listRead.reason;
    const result = listRead.value;
    if (configRead.status === 'fulfilled' && typeof configRead.value?.enabled === 'boolean') { assistantConfig = configRead.value; assistantState = 'ready'; }
    else { assistantConfig = null; assistantState = 'unavailable'; }
    if (!Array.isArray(result.threads)) throw new Error('invalid-inbox');
    inboxThreads = result.threads.filter(thread => typeof thread.id === 'string' && thread.id.length > 0); inboxState = 'ready';
    const unread = inboxThreads.reduce((count, thread) => count + (Number.isInteger(thread.unreadCount) ? Math.max(0, thread.unreadCount) : 0), 0);
    const navWidth = $('#nav-inbox').offsetWidth;
    $('#inbox-nav-count').replaceChildren(String(unread), el('span', 'sr-only', unread === 1 ? ' não lida' : ' não lidas')); $('#inbox-nav-count').hidden = unread === 0;
    if ($('#nav-inbox').classList.contains('active') && $('#nav-inbox').offsetWidth !== navWidth) revealActiveNav($('#nav-inbox'));
    setHint('#inbox-source', 'neutral', `${plural(inboxThreads.length, 'conversa', 'conversas')} de @${accountUsername()}`);
    renderInboxList();
    if (selectedThreadId && inboxThreads.some(thread => thread.id === selectedThreadId)) await refreshSelectedThread(scope, revision);
    else if (selectedThreadId) { saveInboxDraft(); threadRequestSequence++; selectedThreadId = null; selectedThread = null; threadMessageSignature = null; $('#inbox-reply').value = ''; $('#thread-detail').hidden = true; $('#thread-empty').hidden = false; }
    assertScope(scope); if (revision !== threadActionRevision || threadBusy) return;
    inboxLastSyncedAt = new Date().toISOString(); inboxRefreshFailed = false;
  } catch {
    if (!currentScope(scope) || revision !== threadActionRevision) return;
    inboxRefreshFailed = true;
    if (inboxState !== 'ready') { inboxState = 'unavailable'; $('#inbox-nav-count').hidden = true; renderInboxList(); setHint('#inbox-source', 'error', 'As conversas ainda não puderam ser carregadas.'); }
    if (selectedThread) renderThread({ preserveScroll: true });
    if (!options.automatic) showFeedback('#inbox-feedback', 'Não foi possível atualizar. O histórico e o rascunho foram preservados; atualize antes de enviar.', 'error');
  }
}
async function refreshSelectedThread(scope, revision) {
  const id = selectedThreadId; const sequence = ++threadRequestSequence;
  const result = await apiRead(`/api/inbox/threads/${encodeURIComponent(id)}`, scope);
  if (sequence !== threadRequestSequence || selectedThreadId !== id || revision !== threadActionRevision || threadBusy) return;
  if (!result.thread || !Array.isArray(result.messages)) throw new Error('invalid-thread');
  selectedThread = result; inboxRefreshFailed = false;
  inboxThreads = inboxThreads.map(thread => thread.id === id ? result.thread : thread);
  renderThread({ preserveScroll: true }); renderInboxList();
}
function pollInbox() {
  if (document.visibilityState !== 'visible' || $('#inbox-view').hidden || !$('#inbox-auto-refresh').checked || threadBusy) return;
  return loadInbox({ automatic: true });
}
function saveInboxDraft() {
  if (!selectedThreadId) return;
  const previous = inboxDrafts.get(selectedThreadId);
  const text = $('#inbox-reply').value;
  if (!previous || previous.text !== text) inboxDrafts.set(selectedThreadId, { text, requestId: crypto.randomUUID() });
}
async function selectThread(id) {
  if (threadBusy) return;
  const scope = accountScope();
  saveInboxDraft(); selectedThreadId = id; selectedThread = null; threadBusy = true; threadMessageSignature = null; renderedMessageKeys = []; renderInboxList(); renderInboxRefresh();
  $('#thread-empty').hidden = true; $('#thread-detail').hidden = false; $('#thread-name').textContent = threadUsername(inboxThreads.find(thread => thread.id === id));
  $('#thread-avatar').textContent = 'IG'; $('#thread-channel').textContent = 'Carregando histórico…'; setStatus('#thread-window', 'neutral', 'Janela por verificar');
  setStatus('#thread-ai-state', 'neutral', 'Estado por verificar'); $('#thread-control-note').textContent = ''; $('#thread-last-inbound').textContent = ''; $('#thread-review-state').hidden = true;
  $('#inbox-reply').value = inboxDrafts.get(id)?.text || ''; $('#inbox-reply').disabled = true; $('#send-inbox-reply').disabled = true; $('#thread-handoff').disabled = true; $('#thread-assistant').disabled = true; $('#inbox-feedback').hidden = true;
  $('#thread-messages').replaceChildren(stateBlock('loading', 'Lendo o histórico…', '', { inset: true }));
  // On phones the list hides when a conversation opens; move focus to the conversation instead of losing it.
  if ($('.thread-sidebar').offsetParent === null) { $('#thread-name').focus(); $('#thread-detail').scrollIntoView({ block: 'start' }); }
  const sequence = ++threadRequestSequence;
  try {
    const result = await apiRead(`/api/inbox/threads/${encodeURIComponent(id)}`, scope);
    if (sequence !== threadRequestSequence || selectedThreadId !== id) return;
    if (!result.thread || !Array.isArray(result.messages)) throw new Error('invalid-thread');
    selectedThread = result; threadBusy = false; inboxRefreshFailed = false; renderThread({ preserveScroll: false }); renderInboxList(); renderInboxRefresh();
    // List items are disabled while the history loads; give keyboard focus back to the chosen conversation.
    if ((document.activeElement === document.body || !document.activeElement) && $('.thread-sidebar').offsetParent !== null) [...document.querySelectorAll('#thread-list [data-thread-id]')].find(item => item.dataset.threadId === id)?.focus();
  } catch {
    if (sequence !== threadRequestSequence) return;
    threadBusy = false; renderInboxList(); renderInboxRefresh(); $('#thread-channel').textContent = 'Histórico indisponível';
    $('#thread-messages').replaceChildren(stateBlock('error', 'Não foi possível ler esta conversa', 'Nenhuma resposta foi enviada. Tente ler o histórico de novo.', { inset: true, retry: () => selectThread(id) }));
    setHint('#composer-gate', 'warning', 'O histórico e a janela de resposta precisam ser verificados antes do envio.');
  }
}
function providerVerified(provider) { return provider?.configured === true && provider.name === 'openrouter' && typeof provider.model === 'string' && provider.model.length > 0 && typeof provider.verifiedAt === 'string' && Number.isFinite(Date.parse(provider.verifiedAt)); }
function threadBotActive(thread = selectedThread?.thread) { return thread?.aiEnabled === true && thread.handoff !== true && assistantConfig?.enabled === true && providerVerified(assistantConfig.provider); }
function threadBotUncertain(thread = selectedThread?.thread) { return thread?.aiEnabled === true && thread.handoff !== true && assistantState !== 'ready'; }
function renderThread({ preserveScroll = true } = {}) {
  if (!selectedThread) return;
  const { thread, messages, permissions = {} } = selectedThread;
  $('#thread-name').textContent = threadUsername(thread); $('#thread-avatar').textContent = (thread.username || 'IG').slice(0, 2).toUpperCase();
  $('#thread-channel').textContent = `${thread.channel === 'story' ? 'Interação em Story' : 'Instagram Direct'} · conta @${accountUsername()}`;
  const lastInbound = thread.lastInboundAt || [...messages].reverse().find(message => message.direction === 'inbound')?.at;
  $('#thread-last-inbound').textContent = lastInbound ? `· Última mensagem recebida: ${fullTime(lastInbound)}` : '· Última mensagem recebida ainda não registrada';
  setStatus('#thread-window', thread.windowOpen === true ? 'success' : 'neutral', thread.windowOpen === true ? `Janela de 24h aberta${thread.windowClosesAt ? ` até ${fullTime(thread.windowClosesAt)}` : ''}` : 'Janela de 24h encerrada ou por verificar');
  const ai = threadBotActive(thread);
  const uncertain = threadBotUncertain(thread);
  setStatus('#thread-ai-state', thread.handoff ? 'info' : uncertain ? 'warning' : ai ? 'success' : 'neutral', thread.handoff ? 'Você está atendendo · bot pausado' : uncertain ? 'Estado geral do bot por verificar' : ai ? 'Bot habilitado nesta conversa' : assistantConfig?.enabled !== true ? 'Assistente pausado nas configurações' : 'Bot pausado nesta conversa');
  $('#thread-control-note').textContent = thread.handoff ? 'Você conduz esta conversa. Retomar bot vale somente para novas DMs; seu rascunho permanece aqui.' : ai ? 'Para responder você mesmo, assuma a conversa e aguarde a confirmação da pausa.' : 'Assumir conversa mantém o bot pausado até você retomar.';
  $('#thread-handoff').classList.toggle('primary', thread.handoff !== true);
  $('#send-inbox-reply').classList.toggle('primary', thread.handoff === true);
  const pending = threadBusy ? threadPendingControl : null;
  $('#thread-handoff').textContent = pending === 'handoff' ? 'Assumindo…' : thread.handoff ? 'Conversa assumida' : 'Assumir conversa'; $('#thread-handoff').disabled = threadBusy || thread.handoff === true;
  $('#thread-handoff').setAttribute('aria-busy', String(pending === 'handoff'));
  $('#thread-assistant').textContent = pending === 'assistant' ? 'Confirmando…' : ai ? 'Pausar bot' : 'Retomar bot';
  $('#thread-assistant').setAttribute('aria-busy', String(pending === 'assistant'));
  const aiEligible = assistantConfig?.enabled === true && providerVerified(assistantConfig.provider) && (assistantConfig.eligibility?.faq?.eligible === true || assistantConfig.eligibility?.sales?.eligible === true || assistantConfig.eligibility?.story?.eligible === true);
  $('#thread-assistant').disabled = threadBusy || inboxRefreshFailed || unknownReplies.has(selectedThreadId) || (!ai && (!aiEligible || permissions.canReply !== true));
  const review = thread.optout ? 'A pessoa pediu para parar. Nenhuma resposta será enviada.' : thread.sendInProgress || permissions.reason === 'SEND_IN_PROGRESS' ? 'Envio em andamento. Aguarde a confirmação antes de responder.' : thread.quarantine || thread.reviewRequired || unknownReplies.has(selectedThreadId) ? 'Esta conversa precisa de revisão humana. Confira os resultados no Direct antes de novos envios.' : '';
  $('#thread-review-state').hidden = !review; $('#thread-review-state').textContent = review;
  const log = $('#thread-messages');
  const signature = JSON.stringify([selectedThreadId, messages, accountUsername()]);
  if (signature !== threadMessageSignature) {
    const position = Number(log.scrollTop) || 0; const nearBottom = (Number(log.scrollHeight) || 0) - position - (Number(log.clientHeight) || 0) < 80;
    const visible = messages.filter(message => ['inbound', 'outbound'].includes(message.direction));
    const keys = visible.map(message => JSON.stringify(message));
    // The history is a live log: when only new messages arrive, append them so screen readers hear just the additions.
    const appendOnly = renderedMessageKeys.length > 0 && renderedMessageKeys.length <= keys.length && renderedMessageKeys.every((key, index) => key === keys[index]);
    if (!appendOnly) {
      log.replaceChildren();
      if (!visible.length) log.append(stateBlock('empty', 'Nenhuma mensagem registrada', 'O histórico aparece depois que o Instagram registra interações desta conversa.', { inset: true }));
    }
    for (const message of visible.slice(appendOnly ? renderedMessageKeys.length : 0)) log.append(threadMessageItem(message));
    renderedMessageKeys = keys;
    threadMessageSignature = signature; log.scrollTop = !preserveScroll || nearBottom ? log.scrollHeight : position;
  }
  const unknown = unknownReplies.has(selectedThreadId);
  const canReply = permissions.canReply === true && !threadBusy && !unknown && !ai && !threadBotUncertain(thread) && !inboxRefreshFailed;
  $('#inbox-reply').disabled = !canReply;
  $('#send-inbox-reply').disabled = !canReply || !$('#inbox-reply').value.trim();
  const permissionMessages = {
    WINDOW_CLOSED: 'A janela de 24 horas encerrou. Aguarde uma nova interação da pessoa para responder.',
    CONTACT_OPTED_OUT: 'A pessoa pediu para parar. O envio está bloqueado.',
    OUTCOME_REQUIRES_REVIEW: 'O resultado anterior precisa de revisão. Confira o Direct antes de enviar novamente.',
    VERIFIED_INBOUND_REQUIRED: 'Conclua a conexão e aguarde uma nova interação verificada do Instagram.',
    SEND_IN_PROGRESS: 'Há um envio em andamento. Aguarde a confirmação antes de responder.',
  };
  const blockedReason = Object.hasOwn(permissionMessages, permissions.reason) ? permissionMessages[permissions.reason] : 'Esta conversa ainda não está elegível para resposta. Confira a conexão e a janela de atendimento.';
  const gateKind = unknown ? 'error' : inboxRefreshFailed || ai || uncertain ? 'warning' : permissions.canReply === true ? 'info' : 'warning';
  setHint('#composer-gate', gateKind, unknown ? 'Resultado anterior indeterminado. Revise o Direct antes de qualquer novo envio.' : inboxRefreshFailed ? 'Atualize a Inbox para conferir o histórico e a janela antes de enviar.' : ai || uncertain ? 'Assuma a conversa para confirmar a pausa do bot antes de enviar sua resposta.' : permissions.canReply === true ? `Resposta real de @${accountUsername()} pelo Instagram. O aceite não confirma recebimento nem leitura.` : blockedReason);
  $('#inbox-draft-state').textContent = $('#inbox-reply').value ? 'Rascunho preservado somente nesta sessão, para esta conta e conversa.' : 'Rascunhos ficam somente nesta sessão do painel.';
}
function threadMessageItem(message) {
  const actor = message.direction === 'inbound' ? 'customer' : ['assistant', 'human'].includes(message.actor) ? message.actor : 'unknown';
  const author = actor === 'customer' ? 'Lead' : actor === 'assistant' ? 'Bot do Benion' : actor === 'human' ? `Você · @${accountUsername()}` : `@${accountUsername()} · autoria não registrada`;
  const text = typeof message.text === 'string' && message.text ? message.text : message.mediaOnly ? 'Anexo ou mídia recebida · conteúdo não exibido' : 'Mensagem sem texto registrado';
  const item = el('div', `chat-event ${message.direction === 'outbound' ? 'outgoing' : 'incoming'}`);
  const time = el('time', '', fullTime(message.at)); if (message.at && !Number.isNaN(new Date(message.at).getTime())) time.dateTime = new Date(message.at).toISOString();
  item.append(el('span', `message-author${actor === 'assistant' ? ' bot' : actor === 'human' ? ' human' : ''}`, author), el('div', 'bubble', text), time);
  if (message.direction === 'outbound') {
    // Acceptance is never shown as delivery: accepted and echo stay informational.
    const notes = { sending: ['progress', 'Envio em andamento'], accepted: ['info', 'Aceita pela API · leitura não confirmada'], echo: ['info', 'Registrada pelo Instagram · leitura não confirmada'], unknown: ['warning', 'Resultado indeterminado · revisão necessária'], rejected: ['error', 'Rejeitada pela API'] };
    const note = notes[message.status];
    if (note) { const node = el('p', 'hint message-note'); node.dataset.kind = note[0]; node.textContent = note[1]; item.append(node); }
  }
  return item;
}
async function updateThreadControl(control, enabled) {
  if (!selectedThreadId || !selectedThread || threadBusy) return;
  if (control === 'handoff' && selectedThread.thread.handoff === true) return;
  const scope = accountScope(); const id = selectedThreadId;
  saveInboxDraft(); threadActionRevision++; threadRequestSequence++; threadBusy = true; threadPendingControl = control; renderThread(); renderInboxList(); renderInboxRefresh();
  try {
    let result = await apiWrite(`/api/inbox/threads/${encodeURIComponent(id)}/${control}`, { enabled }, scope); assertScope(scope);
    if (!result.thread || !Array.isArray(result.messages)) result = await apiRead(`/api/inbox/threads/${encodeURIComponent(id)}`, scope);
    assertScope(scope); if (!result.thread || !Array.isArray(result.messages)) throw new Error('invalid-thread');
    selectedThread = result; threadBusy = false; threadPendingControl = null; inboxRefreshFailed = false;
    inboxThreads = inboxThreads.map(thread => thread.id === id ? result.thread : thread);
    renderThread(); renderInboxList(); renderInboxRefresh();
    if (control === 'handoff' && !$('#inbox-reply').disabled) $('#inbox-reply').focus();
    showFeedback('#inbox-feedback', control === 'handoff' ? 'Conversa assumida. O bot está pausado; seu rascunho foi preservado.' : enabled ? 'Bot retomado para novas DMs elegíveis. Mensagens anteriores não são reprocessadas.' : 'Bot pausado nesta conversa. Seu rascunho foi preservado.', 'success');
  } catch { if (!currentScope(scope)) return; threadBusy = false; threadPendingControl = null; inboxRefreshFailed = true; renderThread(); renderInboxList(); renderInboxRefresh(); showFeedback('#inbox-feedback', 'Não foi possível confirmar a alteração. Atualize a Inbox antes de responder ou retomar o bot.', 'error'); }
}
$('#refresh-inbox').addEventListener('click', () => loadInbox()); $('#inbox-search').addEventListener('input', renderInboxList);
$('#inbox-auto-refresh').addEventListener('change', () => { renderInboxRefresh(); if ($('#inbox-auto-refresh').checked) pollInbox(); });
setInterval(pollInbox, 15000);
$('#inbox-reply').addEventListener('input', () => { clearFieldError($('#inbox-reply')); saveInboxDraft(); if (selectedThread) renderComposerState(); });
function renderComposerState() {
  $('#send-inbox-reply').disabled = threadBusy || inboxRefreshFailed || threadBotActive() || threadBotUncertain() || unknownReplies.has(selectedThreadId) || selectedThread?.permissions?.canReply !== true || !$('#inbox-reply').value.trim();
  $('#inbox-draft-state').textContent = $('#inbox-reply').value ? 'Rascunho preservado somente nesta sessão, para esta conta e conversa.' : 'Rascunhos ficam somente nesta sessão do painel.';
}
$('#thread-handoff').addEventListener('click', () => updateThreadControl('handoff', true));
$('#thread-assistant').addEventListener('click', () => { if (!$('#thread-assistant').disabled) return updateThreadControl('assistant', !threadBotActive()); });
$('#inbox-composer').addEventListener('submit', async event => {
  event.preventDefault();
  const scope = accountScope();
  if (!selectedThreadId || selectedThread?.permissions?.canReply !== true || threadBusy || inboxRefreshFailed || threadBotActive() || threadBotUncertain() || unknownReplies.has(selectedThreadId)) return;
  const text = $('#inbox-reply').value.trim();
  if (!text || new TextEncoder().encode(text).length > 1000) { fieldError('#inbox-reply', text ? 'A resposta passou do limite de tamanho. Encurte o texto.' : 'Escreva a resposta antes de enviar.'); return; }
  clearFieldError($('#inbox-reply'));
  saveInboxDraft(); const id = selectedThreadId; const draftStore = inboxDrafts; const unknownStore = unknownReplies; const requestId = draftStore.get(id).requestId; threadActionRevision++; threadRequestSequence++; threadBusy = true; renderThread(); renderInboxList(); renderInboxRefresh(); setButtonBusy($('#send-inbox-reply'), true, 'Enviando…'); showFeedback('#inbox-feedback', 'Enviando a resposta pelo Instagram…', 'progress');
  try {
    const result = await apiWrite(`/api/inbox/threads/${encodeURIComponent(id)}/reply`, { text, requestId }, scope); assertScope(scope);
    const status = result.outcome || result.status || result.message?.status;
    if (status === 'unknown' || !['accepted', 'rejected'].includes(status)) { unknownReplies.add(id); threadBusy = false; renderThread(); renderInboxList(); showFeedback('#inbox-feedback', 'Resultado indeterminado. Não repita o envio; confira a conversa no Instagram.', 'error'); return; }
    if (status === 'rejected') { threadBusy = false; renderThread(); renderInboxList(); showFeedback('#inbox-feedback', 'A API rejeitou a resposta. Confira os acessos e a janela de atendimento.', 'error'); return; }
    inboxDrafts.delete(id); $('#inbox-reply').value = ''; threadBusy = false; await selectThread(id); assertScope(scope);
    showFeedback('#inbox-feedback', status === 'accepted' ? 'Resposta aceita pela API. Recebimento e leitura não confirmados.' : 'Resposta registrada. Confira o histórico e o estado retornado pela API.', status === 'accepted' ? 'success' : 'info');
  } catch (error) {
    if (!currentScope(scope)) {
      if (error.confirmedStatus === 'accepted') draftStore.delete(id);
      else if (error.confirmedStatus === 'unknown' || error.mutationAttempted && !['accepted', 'rejected'].includes(error.confirmedStatus) && (!error.httpStatus || error.httpStatus >= 500 || error.httpStatus >= 200 && error.httpStatus < 300)) unknownStore.add(id);
      return;
    }
    if (error.mutationAttempted && (!error.httpStatus || error.httpStatus >= 500)) unknownReplies.add(id);
    threadBusy = false; if (selectedThreadId === id) renderThread(); renderInboxList();
    showFeedback('#inbox-feedback', unknownReplies.has(id) ? 'O serviço não confirmou o resultado. Não repita o envio; confira o Direct antes de continuar.' : 'A resposta não pôde ser confirmada. Verifique a conexão e a janela de atendimento.', 'error');
  } finally { setButtonBusy($('#send-inbox-reply'), false); if (currentScope(scope)) renderInboxRefresh(); }
});

let productDraft = null;
let productStep = 0;
let productEditorOpen = false;
let productRemoving = false;
let catalogSaving = false;
const productKeys = ['name', 'url', 'description', 'price', 'facts'];
function collectCatalog() {
  if (productDraft) {
    for (const key of productKeys) { const value = $(`#product-${key}`).value.trim(); productDraft[key] = key === 'facts' ? value.split('\n').map(line => line.trim()).filter(Boolean) : value; }
    if (!productDraft.price) delete productDraft.price;
  }
  return catalogProducts;
}
function openProduct(product = null) {
  productDraft = structuredClone(product || { id: crypto.randomUUID(), name: '', url: '', description: '', facts: [] });
  productStep = 0; productRemoving = false; productEditorOpen = true; catalogDirty = !product;
  for (const key of productKeys) { const field = $(`#product-${key}`); field.value = key === 'facts' ? (productDraft.facts || []).join('\n') : productDraft[key] || ''; clearFieldError(field); }
  $('#product-editor-title').textContent = product ? 'Editar produto' : 'Novo produto'; $('#catalog-feedback').hidden = true; renderCatalog(); $('#product-name').focus();
}
function focusStepHeading(step) { const heading = step.querySelector('h1'); heading.setAttribute('tabindex', '-1'); heading.focus(); }
function renderProductStep(focus = false) {
  $('#catalog-home').hidden = productEditorOpen; $('#catalog-form').hidden = !productEditorOpen;
  placeFeedback($('#catalog-feedback'), $(productEditorOpen ? '#catalog-form .flow-actions' : '#catalog-home .flow-actions'));
  for (let step = 0; step < 3; step++) $(`#product-step-${step}`).hidden = productStep !== step;
  $('#product-step-label').textContent = `Passo ${productStep + 1} de 3`; $('#product-progress').value = productStep + 1;
  $('#product-next').hidden = productStep === 2; $('#save-catalog').hidden = productStep !== 2; $('#product-back').hidden = productStep === 0;
  $('#save-catalog').textContent = catalogSaving ? 'Salvando…' : productRemoving ? 'Salvar remoção' : 'Salvar produto';
  $('#save-catalog').setAttribute('aria-busy', String(catalogSaving));
  $('#remove-product').hidden = productStep !== 2 || !productDraft || !catalogProducts.some(product => product.id === productDraft.id) || productRemoving;
  $('#product-removal').hidden = productStep !== 2 || !productRemoving;
  for (const id of ['product-next', 'product-back', 'cancel-product', 'remove-product', 'cancel-product-removal']) $(`#${id}`).disabled = catalogSaving;
  productKeys.forEach(key => { $(`#product-${key}`).disabled = catalogSaving; });
  if (productStep === 2 && productDraft) {
    const review = $('#product-review'); review.replaceChildren();
    const rows = [['Conta', `@${accountUsername()}`], ['Nome', productDraft.name], ['Link oficial', productDraft.url], ['Descrição', productDraft.description], ['Preço e condições', productDraft.price]];
    for (const [label, value] of rows) if (value) review.append(el('dt', '', label), el('dd', '', value));
    if (productDraft.facts?.length) { review.append(el('dt', '', 'Outros fatos')); productDraft.facts.forEach(fact => review.append(el('dd', '', fact))); }
  }
  if (focus && productEditorOpen) focusStepHeading($(`#product-step-${productStep}`));
}
function renderCatalog() {
  const list = $('#catalog-products'); list.replaceChildren();
  // Products appear only after the server confirms them; nothing local stands in for them.
  const products = catalogLoaded ? catalogProducts : [];
  for (const product of products) {
    const item = el('button', 'choice'); item.type = 'button'; item.disabled = catalogSaving; item.dataset.productId = product.id;
    const text = el('span', 'choice-text'); const title = el('strong'); title.append(el('span', 'sr-only', 'Editar '), document.createTextNode(product.name));
    text.append(title, el('span', 'choice-meta', product.url || 'Sem link cadastrado'));
    item.append(text, icon('chevronRight', 'chevron'));
    item.addEventListener('click', () => { if (productDraft && catalogDirty && product.id !== productDraft.id) { showFeedback('#catalog-feedback', 'Conclua o rascunho atual antes de editar outro produto.', 'warning'); return; } if (productDraft?.id === product.id) { productEditorOpen = true; renderProductStep(true); } else openProduct(product); }); list.append(item);
  }
  if (!products.length) {
    if (catalogState === 'loading' || catalogState === 'idle') list.append(stateBlock('loading', 'Buscando produtos…'));
    else if (catalogState === 'unavailable') list.append(stateBlock('error', 'Não foi possível carregar os produtos', 'Nada foi alterado. Tente de novo para ver o catálogo desta conta.', { retry: () => loadCatalog() }));
    else list.append(stateBlock('empty', 'Nenhum produto ainda', 'Adicione um produto para o assistente conhecer seus links e informações.', { iconName: 'catalog' }));
  }
  $('#catalog-save-state').classList.toggle('sr-only', !products.length && catalogState !== 'ready');
  $('#save-catalog').disabled = !catalogAvailable || catalogState === 'loading' || catalogSaving;
  $('#add-product').disabled = !catalogAvailable || catalogState === 'loading' || catalogSaving;
  $('#add-product').textContent = productDraft ? 'Continuar rascunho' : 'Adicionar produto';
  $('#refresh-catalog').disabled = catalogSaving || catalogState === 'loading' || catalogDirty;
  $('#refresh-catalog .button-label').textContent = catalogState === 'loading' ? 'Atualizando…' : 'Atualizar';
  $('#refresh-catalog').setAttribute('aria-busy', String(catalogState === 'loading'));
  renderProductStep();
}
async function loadCatalog() {
  const scope = accountScope();
  catalogState = 'loading'; setHint('#catalog-save-state', 'progress', 'Carregando produtos…'); renderCatalog();
  try {
    const result = await apiRead('/api/catalog', scope); assertScope(scope);
    if (!Array.isArray(result.products) || result.available === false) throw new Error('invalid-catalog');
    catalogProducts = result.products.filter(product => typeof product.id === 'string' && typeof product.name === 'string'); catalogLoaded = true; catalogAvailable = true; catalogState = 'ready'; catalogDirty = false; renderCatalog();
    setHint('#catalog-save-state', 'neutral', result.updatedAt ? `${plural(catalogProducts.length, 'produto', 'produtos')} · salvo no servidor em ${fullTime(result.updatedAt)}` : plural(catalogProducts.length, 'produto', 'produtos'));
  } catch { if (!currentScope(scope)) return; catalogState = 'unavailable'; catalogAvailable = false; renderCatalog(); setHint('#catalog-save-state', 'warning', catalogLoaded ? 'Os produtos não puderam ser atualizados. O conteúdo exibido pode estar desatualizado.' : 'Os produtos não puderam ser carregados.'); }
}
$('#add-product').addEventListener('click', () => { $('#catalog-feedback').hidden = true; if (productDraft) { productEditorOpen = true; renderProductStep(true); } else openProduct(); });
$('#refresh-catalog').addEventListener('click', () => loadCatalog());
$('#cancel-product').addEventListener('click', () => { collectCatalog(); productEditorOpen = false; $('#catalog-feedback').hidden = true; renderCatalog(); $('#add-product').focus(); });
$('#product-back').addEventListener('click', () => { collectCatalog(); productStep = Math.max(0, productStep - 1); $('#catalog-feedback').hidden = true; renderProductStep(true); });
function advanceProduct() {
  collectCatalog();
  if (productStep === 0) {
    if (!productDraft.name) return fieldError('#product-name', 'Informe o nome do produto.');
    try { if (new URL(productDraft.url).protocol !== 'https:') throw new Error(); }
    catch { return fieldError('#product-url', 'Use um link completo que comece com https://.'); }
  }
  $('#catalog-feedback').hidden = true; productStep = Math.min(2, productStep + 1); renderProductStep(true);
}
$('#product-next').addEventListener('click', advanceProduct);
$('#catalog-form').addEventListener('input', event => { clearFieldError(event.target); catalogDirty = true; setHint('#catalog-save-state', 'warning', 'Há um rascunho ainda não salvo.'); });
$('#remove-product').addEventListener('click', () => { productRemoving = true; renderProductStep(); $('#cancel-product-removal').focus(); });
$('#cancel-product-removal').addEventListener('click', () => { productRemoving = false; renderProductStep(); $('#save-catalog').focus(); });
$('#catalog-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!catalogAvailable || catalogSaving || !productDraft) return;
  if (productStep !== 2) { advanceProduct(); return; }
  const scope = accountScope(); collectCatalog();
  // Only the selected product changes. All other products keep their stored fields.
  const products = productRemoving ? catalogProducts.filter(product => product.id !== productDraft.id) : catalogProducts.map(product => product.id === productDraft.id ? structuredClone(productDraft) : product);
  if (!productRemoving && !catalogProducts.some(product => product.id === productDraft.id)) products.push(structuredClone(productDraft));
  const removing = productRemoving; const savedId = productDraft.id;
  catalogSaving = true; renderCatalog(); showFeedback('#catalog-feedback', removing ? 'Salvando remoção…' : 'Salvando produto…', 'progress');
  try {
    const result = await apiWrite('/api/catalog', { products }, scope); assertScope(scope);
    if (!Array.isArray(result.products)) throw new Error('invalid-catalog');
    catalogProducts = result.products; catalogLoaded = true; productDraft = null; productEditorOpen = false; productRemoving = false; catalogDirty = false; setHint('#catalog-save-state', 'success', `${plural(catalogProducts.length, 'produto', 'produtos')} · salvos no servidor`);
    $('#catalog-feedback').hidden = true; toast(removing ? 'Produto removido. O assistente deixa de usá-lo.' : 'Pronto! Conhecimento do assistente atualizado.', 'success');
  } catch { if (currentScope(scope)) showFeedback('#catalog-feedback', 'O salvamento não foi confirmado. Seu rascunho continua aqui.', 'error'); }
  finally {
    if (currentScope(scope)) {
      catalogSaving = false; renderCatalog();
      if (!productEditorOpen) { const row = [...document.querySelectorAll('#catalog-products [data-product-id]')].find(item => item.dataset.productId === savedId); if (row && !removing) { flashSuccess(row); row.focus(); } else $('#add-product').focus(); }
    }
  }
});

function validProviderStatus(result) {
  return result && typeof result.configured === 'boolean' && result.name === 'openrouter' && typeof result.model === 'string' && result.model.length > 0 && (result.verifiedAt === null || typeof result.verifiedAt === 'string' && Number.isFinite(Date.parse(result.verifiedAt)));
}
function renderProvider() {
  const verified = providerVerified(providerStatus);
  const kind = providerState === 'loading' ? 'progress' : providerState === 'unavailable' ? 'error' : verified ? 'success' : providerState === 'ready' ? 'warning' : 'neutral';
  setHint('#provider-status', kind, providerState === 'loading' ? 'Verificando a integração privada…' : providerState === 'unavailable' ? 'Integração indisponível nesta versão do serviço. A configuração não foi confirmada.' : verified ? `Chave configurada · ${providerStatus.model} testado em ${fullTime(providerStatus.verifiedAt)}.` : providerState === 'ready' ? 'Chave ainda não configurada e testada. O atendimento continua dependente da ativação por conta.' : 'Integração por verificar.');
  $('#provider-retry').hidden = providerState !== 'unavailable';
  $('#provider-api-key').disabled = providerBusy || providerState !== 'ready';
  $('#save-provider').disabled = providerBusy || providerState !== 'ready';
  $('#save-provider').textContent = providerBusy ? 'Testando modelo de IA…' : 'Salvar e testar modelo de IA';
  $('#save-provider').setAttribute('aria-busy', String(providerBusy));
}
$('#provider-retry').addEventListener('click', () => loadProvider());
$('#provider-api-key').addEventListener('input', event => clearFieldError(event.target));
async function loadProvider() {
  const scope = accountScope(); providerState = 'loading'; renderProvider();
  try {
    const result = await apiRead('/api/assistant/provider', scope); assertScope(scope);
    if (!validProviderStatus(result)) throw new Error('invalid-provider');
    providerStatus = { configured: result.configured, name: result.name, model: result.model, verifiedAt: result.verifiedAt }; providerState = 'ready';
  } catch { if (!currentScope(scope)) return; providerState = 'unavailable'; providerStatus = null; }
  if (currentScope(scope)) renderProvider();
}
$('#provider-form').addEventListener('submit', async event => {
  event.preventDefault(); if (providerBusy || providerState !== 'ready') return;
  const scope = accountScope(); const body = { apiKey: $('#provider-api-key').value.trim() }; $('#provider-api-key').value = ''; clearFieldError($('#provider-api-key'));
  if (!/^[\x21-\x7e]{16,1000}$/.test(body.apiKey)) { body.apiKey = ''; $('#provider-feedback').hidden = true; fieldError('#provider-api-key', 'Insira uma chave de API válida do OpenRouter.'); return; }
  providerBusy = true; renderProvider(); showFeedback('#provider-feedback', 'Validando a chave e testando modelo de IA com dados sintéticos. Nenhuma DM será enviada.', 'progress');
  try {
    const result = await apiWrite('/api/assistant/provider', body, scope); assertScope(scope);
    if (!validProviderStatus(result) || !providerVerified(result)) throw new Error('invalid-provider');
    providerStatus = { configured: result.configured, name: result.name, model: result.model, verifiedAt: result.verifiedAt }; providerState = 'ready';
    // Keep unsaved account settings while refreshing provider and eligibility metadata.
    const fields = ['#assistant-enabled', '[data-assistant-feature="faqEnabled"]', '[data-assistant-feature="salesEnabled"]', '[data-assistant-feature="storyEnabled"]'];
    const draft = fields.map(selector => $(selector).checked); const tone = radioValue('#assistant-config-form', 'assistantTone'); const rules = $('#assistant-rules').value;
    const saveState = { kind: $('#assistant-save-state').dataset.kind, text: $('#assistant-save-state').textContent };
    await loadAssistantConfig(); assertScope(scope);
    fields.forEach((selector, index) => { $(selector).checked = draft[index]; }); setRadioValue('#assistant-config-form', 'assistantTone', tone); $('#assistant-rules').value = rules; setHint('#assistant-save-state', saveState.kind, saveState.text); renderAssistantStep();
    showFeedback('#provider-feedback', 'Chave salva no servidor privado e modelo de IA testado. Ative o atendimento separadamente nas configurações desta conta.', 'success');
  } catch (error) {
    if (!currentScope(scope)) return;
    const messages = { MODEL_KEY_REJECTED: 'O OpenRouter não aceitou esta chave. Confira a chave de API.', MODEL_CREDITS_REQUIRED: 'A chave precisa de créditos disponíveis no OpenRouter.', MODEL_CONFIG_INVALID: 'A chave informada não é válida.', MODEL_VALIDATION_FAILED: 'Não foi possível testar o modelo. Confira a chave e os créditos do OpenRouter.', CSRF_INVALID: 'Esta tentativa expirou. Tente salvar novamente.' };
    showFeedback('#provider-feedback', messages[error.code] || 'O serviço não confirmou o teste e o armazenamento da chave. Verifique a integração antes de ativar o atendimento.', 'error');
  } finally { body.apiKey = ''; if (currentScope(scope)) { $('#provider-api-key').value = ''; providerBusy = false; renderProvider(); } }
});

let assistantStep = 0;
const toneNames = { friendly: 'Próximo e objetivo', concise: 'Curto e direto', professional: 'Profissional' };
function renderAssistantStep(focus = false) {
  for (let step = 0; step < 3; step++) $(`#assistant-step-${step}`).hidden = assistantStep !== step;
  $('#assistant-progress').value = assistantStep + 1; $('#assistant-step-label').textContent = `Passo ${assistantStep + 1} de 3`;
  $('#assistant-next').hidden = assistantStep === 2; $('#save-assistant-config').hidden = assistantStep !== 2; $('#assistant-back').hidden = assistantStep === 0;
  $('#assistant-next').disabled = assistantBusy || assistantState !== 'ready'; $('#assistant-back').disabled = assistantBusy;
  $('#assistant-retry').hidden = assistantState !== 'unavailable';
  $('#save-assistant-config').textContent = assistantBusy ? 'Salvando…' : $('#assistant-enabled').checked ? 'Salvar e ativar assistente' : 'Salvar assistente pausado';
  $('#save-assistant-config').setAttribute('aria-busy', String(assistantBusy));
  const review = $('#assistant-review'); review.replaceChildren();
  const names = { faq: 'Perguntas frequentes', sales: 'Ajuda para escolher um produto', story: 'Interações em Stories' };
  const chosen = Object.keys(names).filter(key => $(`[data-assistant-feature="${key}Enabled"]`).checked);
  const rules = $('#assistant-rules').value.trim();
  const rows = [['Conta', `@${accountUsername()}`], ['Tarefas', chosen.length ? chosen.map(key => names[key]).join(' · ') : 'Nenhuma tarefa selecionada.'], ['Tom de voz', toneNames[radioValue('#assistant-config-form', 'assistantTone')] || toneNames.friendly], ['Orientações adicionais', rules], ['Conhecimento', 'Usa os fatos dos produtos salvos. Ao assumir uma conversa, você pausa o bot para aquela pessoa.']];
  for (const [label, value] of rows) if (value) review.append(el('dt', '', label), el('dd', '', value));
  if (focus) focusStepHeading($(`#assistant-step-${assistantStep}`));
}
$('#assistant-retry').addEventListener('click', () => loadAssistantConfig());
$('#assistant-next').addEventListener('click', () => { assistantStep = Math.min(2, assistantStep + 1); renderAssistantStep(true); });
$('#assistant-back').addEventListener('click', () => { assistantStep = Math.max(0, assistantStep - 1); renderAssistantStep(true); });
$('#assistant-enabled').addEventListener('change', () => renderAssistantStep());
function assistantCanActivate(config = assistantConfig) { return providerVerified(config?.provider) && ['faq', 'sales', 'story'].some(feature => config?.eligibility?.[feature]?.eligible === true); }
function renderAssistantConfig() {
  const config = assistantConfig; const available = assistantState === 'ready';
  $('#assistant-enabled').checked = config?.enabled === true; $('#assistant-enabled').disabled = !available || assistantBusy || (config?.enabled !== true && !assistantCanActivate(config));
  setStatus('#assistant-overall-state', assistantState === 'unavailable' ? 'warning' : config?.enabled === true ? 'success' : 'neutral', assistantState === 'unavailable' ? 'Estado por verificar' : config?.enabled === true ? 'IA habilitada' : 'IA pausada');
  const providerReady = providerVerified(config?.provider);
  $('#assistant-provider-state').textContent = providerReady ? `OpenRouter · ${config.provider.model} testado. A ativação afeta somente @${accountUsername()}; a chave privada é compartilhada.` : available ? 'Para ativar, configure e teste a chave da IA no provedor. Os recursos dependem de catálogo e interações verificadas desta conta.' : 'Configuração do provedor ainda não verificada. Nenhuma IA foi ativada nesta página.';
  $('#assistant-provider-link').hidden = providerReady || !available;
  for (const feature of ['story', 'faq', 'sales', 'follower']) {
    const key = `${feature}Enabled`; const input = $(`[data-assistant-feature="${key}"]`); const eligibility = config?.eligibility?.[feature]; const eligible = feature !== 'follower' && eligibility?.eligible === true;
    input.checked = config?.[key] === true && feature !== 'follower'; input.disabled = !available || assistantBusy || !eligible;
    const enabled = eligible && config?.enabled === true && config?.[key] === true;
    setStatus(`[data-feature-status="${feature}"]`, enabled ? 'success' : eligible ? 'info' : feature === 'follower' ? 'neutral' : 'warning', enabled ? 'Habilitada' : eligible ? 'Disponível · pausada' : feature === 'follower' ? 'Indisponível' : 'Bloqueada');
    $(`[data-feature-gate="${feature}"]`).textContent = typeof eligibility?.reason === 'string' && eligibility.reason ? eligibility.reason : feature === 'follower' ? 'O Benion não tem acesso oficial confirmado ao gatilho de novos seguidores. Use comentários, DMs recebidas ou respostas a Stories.' : 'Aguardando catálogo, provedor e acessos verificados da API.';
  }
  if (config) { setRadioValue('#assistant-config-form', 'assistantTone', ['friendly', 'concise', 'professional'].includes(config.tone) ? config.tone : 'friendly'); $('#assistant-rules').value = config.rules || ''; }
  $('#assistant-tone').disabled = !available || assistantBusy; $('#assistant-rules').disabled = !available || assistantBusy; $('#save-assistant-config').disabled = !available || assistantBusy;
  if (selectedThread) renderThread();
  renderInboxList(); renderAssistantStep();
}
async function loadAssistantConfig() {
  const scope = accountScope();
  assistantState = 'loading'; setHint('#assistant-save-state', 'progress', 'Carregando configurações…'); renderAssistantConfig();
  try { const result = await apiRead('/api/assistant/config', scope); assertScope(scope); assistantConfig = result; assistantState = 'ready'; setHint('#assistant-save-state', 'neutral', 'Configurações carregadas do servidor.'); }
  catch { if (!currentScope(scope)) return; assistantState = 'unavailable'; assistantConfig = null; setHint('#assistant-save-state', 'error', 'Configurações ainda não retornadas pelo serviço. Nenhuma IA foi ativada.'); }
  renderAssistantConfig();
}
$('#assistant-config-form').addEventListener('input', () => { setHint('#assistant-save-state', 'warning', 'Alterações ainda não salvas.'); });
$('#assistant-config-form').addEventListener('submit', async event => {
  event.preventDefault(); if (assistantState !== 'ready' || assistantBusy) return;
  if (assistantStep !== 2) { assistantStep++; renderAssistantStep(true); return; }
  const scope = accountScope();
  const config = { enabled: $('#assistant-enabled').checked, faqEnabled: $('[data-assistant-feature="faqEnabled"]').checked, salesEnabled: $('[data-assistant-feature="salesEnabled"]').checked, storyEnabled: $('[data-assistant-feature="storyEnabled"]').checked, followerEnabled: false, tone: radioValue('#assistant-config-form', 'assistantTone'), rules: $('#assistant-rules').value.trim() };
  if (config.enabled && !assistantCanActivate()) { showFeedback('#assistant-feedback', 'A ativação exige modelo de IA testado e interações elegíveis desta conta. Você pode pausar o assistente desmarcando o atendimento.', 'error'); return; }
  assistantBusy = true; $('#save-assistant-config').disabled = true; renderAssistantStep(); showFeedback('#assistant-feedback', 'Salvando as preferências desta conta…', 'progress');
  let saved = false;
  try { const result = await apiWrite('/api/assistant/config', config, scope); assertScope(scope); assistantConfig = result; assistantState = 'ready'; saved = true; setHint('#assistant-save-state', 'success', 'Configurações salvas no servidor.'); showFeedback('#assistant-feedback', config.enabled ? 'Preferências salvas. O assistente responde apenas a interações elegíveis dentro da janela permitida.' : 'Assistente pausado. Configurações salvas.', 'success'); }
  catch { if (currentScope(scope)) showFeedback('#assistant-feedback', 'Não foi possível confirmar o salvamento. Suas escolhas continuam aqui; confira o serviço antes de ativar a IA.', 'error'); }
  finally {
    if (currentScope(scope)) {
      assistantBusy = false;
      // Only a confirmed save may redraw the form from server data; a failed save keeps the draft as typed.
      if (saved) renderAssistantConfig(); else { $('#save-assistant-config').disabled = assistantState !== 'ready'; renderAssistantStep(); }
    }
  }
});



let campaignState = 'idle';
let campaignMediaState = 'idle';
let campaignMediaComplete = false;
let campaigns = [];
let campaignMedia = [];
let runningCampaignId = null;
let editingCampaignId = null;
let campaignBusy = false;
let campaignScreen = 'list';
let campaignStep = 0;
let selectedCampaignId = null;
let campaignDraftOpen = false;
let confirmingCampaignId = null;
let campaignPendingAction = null;
function campaignStatus(campaign) { return campaign.status || campaign; }
function allReelsCampaign(campaign) { return campaign.scope === 'all_reels'; }
function allReelsSelected() { return radioValue('#campaign-form', 'campaignScope') === 'all_reels'; }
function keywordsTriggerSelected() { return radioValue('#campaign-form', 'campaignTrigger') === 'keywords'; }
function campaignShortcode(campaign) {
  return campaign.shortcode || campaignMedia.find(media => media.id === campaign.mediaId)?.shortcode || (typeof campaign.reel === 'string' ? campaign.reel.match(/\/reel\/([\w-]+)/)?.[1] : null);
}
// Byte limits stay exact internally; people only see a note when the text is close to the limit.
function sizeNote(selector, bytes) {
  const note = $(selector); note.hidden = bytes < 800;
  if (bytes > 1000) { note.dataset.kind = 'error'; note.textContent = 'A mensagem passou do limite. Encurte o texto.'; }
  else { note.dataset.kind = 'warning'; note.textContent = 'A mensagem está perto do limite. Encurte um pouco se puder.'; }
}
function campaignMessageSize() { const count = new TextEncoder().encode($('#campaign-message').value).length; sizeNote('#campaign-message-size', count); return count; }
const campaignReplyFields = [0, 1, 2].map(index => $(`#campaign-public-reply-${index}`));
function setCampaignReplies(replies) {
  campaignReplyFields.forEach((field, index) => { field.value = Array.isArray(replies) ? replies[index] || '' : ''; clearFieldError(field); });
}
function resetCampaignEditor() {
  editingCampaignId = null; campaignStep = 0; campaignDraftOpen = false; campaignScreen = 'list'; selectedCampaignId = null; confirmingCampaignId = null;
  $('#campaign-form-title').textContent = 'Nova automação'; $('#campaign-name').value = ''; setRadioValue('#campaign-form', 'campaignScope', 'reel'); $('#campaign-media').value = ''; $('#campaign-keywords').value = ''; setRadioValue('#campaign-form', 'campaignTrigger', 'any'); $('#campaign-message').value = ''; setCampaignReplies([]);
  for (const field of ['#campaign-media', '#campaign-keywords', '#campaign-message', '#campaign-name']) clearFieldError($(field));
  campaignMessageSize(); renderCampaignEditorState(); renderCampaignScreen();
}
function renderCampaignScreen(focus = false) {
  $('#automation-home').hidden = campaignScreen !== 'list'; $('#campaign-form').hidden = campaignScreen !== 'editor'; $('#campaign-detail').hidden = campaignScreen !== 'detail';
  const feedback = $('#campaign-feedback');
  placeFeedback(feedback, campaignScreen === 'editor' ? $('#campaign-form .flow-actions') : campaignScreen === 'detail' ? $('#campaign-detail-actions') : $('#automation-home .flow-actions'));
  $('#new-campaign').hidden = !currentConnection?.connected;
  $('#connect-first-account').hidden = currentConnection?.connected === true;
  setHint('#automation-next-note', currentConnection?.connected ? 'neutral' : 'warning', currentConnection?.connected ? 'Escolha os comentários e escreva a primeira mensagem.' : 'Conecte sua conta para criar a primeira automação.');
  $('#new-campaign').textContent = campaignDraftOpen ? 'Continuar rascunho' : 'Criar automação';
  for (let step = 0; step < 5; step++) $(`#campaign-step-${step}`).hidden = campaignStep !== step;
  $('#campaign-step-label').textContent = `Passo ${campaignStep + 1} de 5`;
  $('#campaign-progress').value = campaignStep + 1;
  $('#campaign-next').hidden = campaignStep === 4; $('#save-campaign').hidden = campaignStep !== 4; $('#campaign-back').hidden = campaignStep === 0;
  $('#campaign-next').disabled = campaignBusy; $('#campaign-back').disabled = campaignBusy; $('#cancel-campaign').disabled = campaignBusy;
  $('#campaign-keywords-field').hidden = !keywordsTriggerSelected();
  if (campaignStep === 4) renderCampaignReview();
  if (focus && campaignScreen === 'editor') focusStepHeading($(`#campaign-step-${campaignStep}`));
}
function renderCampaignReview() {
  const review = $('#campaign-review'); review.replaceChildren();
  const chosen = campaignMedia.find(media => media.id === $('#campaign-media').value);
  const add = (label, ...values) => { review.append(el('dt', '', label)); values.forEach(value => review.append(el('dd', '', value))); };
  add('Conta', `@${accountUsername()}`);
  add('Reels', allReelsSelected() ? 'Todos os Reels, atuais e futuros' : `Reel ${chosen?.shortcode || chosen?.id || 'por selecionar'}`);
  add('Comentários', keywordsTriggerSelected() && $('#campaign-keywords').value.trim() ? `Com as palavras: ${$('#campaign-keywords').value.trim()}` : 'Qualquer comentário novo');
  add('Primeira DM', $('#campaign-message').value);
  const replies = campaignReplyFields.map(field => field.value.trim()).filter(Boolean);
  if (replies.length) add('Resposta pública', ...replies);
}
function validCampaignStep(step) {
  const fail = (selector, message) => { $('#campaign-feedback').hidden = true; return fieldError(selector, message); };
  if (step === 0 && !allReelsSelected() && !campaignMedia.some(media => media.id === $('#campaign-media').value)) return fail('#campaign-media', campaignMediaState === 'ready' && campaignMedia.length ? 'Escolha um Reel da conta selecionada.' : 'Os Reels desta conta ainda não foram carregados. Atualize a lista em Automações.');
  if (step === 1 && keywordsTriggerSelected() && !$('#campaign-keywords').value.trim()) return fail('#campaign-keywords', 'Digite pelo menos uma palavra ou escolha qualquer comentário.');
  if (step === 2 && (!$('#campaign-message').value.trim() || campaignMessageSize() > 1000)) return fail('#campaign-message', 'Escreva a primeira DM dentro do limite de tamanho.');
  if (step === 2 && !campaignMessageHasLink()) return fail('#campaign-message', 'Inclua um link completo que comece com https://.');
  if (step === 3) { const invalid = campaignReplyFields.find(field => new TextEncoder().encode(field.value.trim()).length > 1000); if (invalid) { if (invalid.closest('details')) invalid.closest('details').open = true; return fail(invalid, 'Reduza esta resposta pública: ela passou do limite de tamanho.'); } }
  if (step === 4 && !$('#campaign-name').value.trim()) return fail('#campaign-name', 'Dê um nome para encontrar esta automação depois.');
  $('#campaign-feedback').hidden = true; return true;
}
function campaignMessageHasLink() {
  const links = $('#campaign-message').value.match(/https?:\/\/[^\s]+/g) || [];
  return links.length > 0 && links.every(link => { try { return new URL(link.replace(/[),.!?]+$/, '')).protocol === 'https:'; } catch { return false; } });
}
function renderCampaignEditorState() {
  const editing = campaigns.find(campaign => campaign.id === editingCampaignId);
  const running = editing && campaignStatus(editing).running === true;
  const allReels = allReelsSelected();
  $('#campaign-name').disabled = campaignBusy || running;
  $('#campaign-scope').disabled = campaignBusy || running;
  $('#campaign-media-field').hidden = allReels; $('#campaign-media-note').hidden = allReels;
  $('#campaign-media').required = !allReels;
  $('#campaign-media').disabled = allReels || campaignBusy || running || campaignMediaState !== 'ready' || !campaignMedia.length;
  $('#campaign-trigger').disabled = campaignBusy || running;
  $('#campaign-keywords').disabled = campaignBusy || running; $('#campaign-message').disabled = campaignBusy || running;
  $('#campaign-public-replies').hidden = false;
  campaignReplyFields.forEach(field => { field.disabled = campaignBusy || running; });
  $('#campaign-scope-note').textContent = allReels ? `Quando ativa, a automação cobre todos os Reels de @${accountUsername()}, atuais e futuros. Uma DM por comentário novo elegível; o mesmo comentário não recebe envios repetidos. Pode salvar a mensagem; ativação exige conexão válida e lista completa dos Reels.` : 'Escolha uma publicação da conta selecionada.';
  $('#campaign-review-note').textContent = allReels ? 'Revise a DM, o link HTTPS e as respostas públicas antes de salvar. Salvar não ativa o envio. A ativação protege os comentários anteriores em todos os Reels atuais; novos Reels entram automaticamente. Se configurada, a resposta pública é enviada após o aceite da DM pela Meta.' : 'Revise os textos e o link HTTPS antes de salvar. Salvar não ativa o envio. A ativação verifica a conta, o Reel e os comentários existentes para protegê-los.';
  $('#save-campaign').disabled = campaignBusy || running || campaignState !== 'ready' || (!allReels && (campaignMediaState !== 'ready' || !campaignMedia.length));
  $('#save-campaign').setAttribute('aria-busy', String(campaignBusy));
  renderCampaignScreen();
}
function campaignConflicts(campaign) {
  return campaigns.filter(other => other.id !== campaign.id && (other.enabled === true || campaignStatus(other).running === true) && (allReelsCampaign(campaign) || allReelsCampaign(other) || campaign.mediaId === other.mediaId));
}
// Status shown for an automation comes from the stored state, never from its copy.
function campaignStatusView(status) { return status.running ? ['success', 'Ativa'] : status.reviewReason ? ['warning', 'Precisa de atenção'] : ['neutral', 'Pausada']; }
function renderCampaignList() {
  const list = $('#campaign-list'); list.replaceChildren();
  if (!campaigns.length) {
    if (campaignState === 'loading' || campaignState === 'idle') list.append(stateBlock('loading', 'Buscando suas automações…'));
    else if (campaignState === 'unavailable') list.append(stateBlock('error', 'Não foi possível carregar as automações', 'Nada foi alterado. Confira a conexão e tente de novo.', { retry: () => loadCampaigns() }));
    else list.append(stateBlock('empty', 'Sua primeira conversa começa aqui', 'Envie um link por DM para quem comentar nos seus Reels.', { iconName: 'automation' }));
  }
  $('#campaign-source').classList.toggle('sr-only', !campaigns.length && campaignState !== 'ready');
  $('#refresh-campaigns .button-label').textContent = campaignState === 'loading' ? 'Atualizando…' : 'Atualizar';
  $('#refresh-campaigns').setAttribute('aria-busy', String(campaignState === 'loading'));
  for (const campaign of campaigns) {
    const status = campaignStatus(campaign); const item = el('button', 'choice campaign-summary'); item.type = 'button'; item.dataset.campaignId = campaign.id;
    const text = el('span', 'choice-text'); text.append(el('strong', '', campaign.name || 'Automação'), el('span', 'choice-meta', allReelsCampaign(campaign) ? 'Todos os Reels' : `Reel ${campaignShortcode(campaign) || campaign.mediaId}`));
    item.append(text, statusPill(...campaignStatusView(status)), icon('chevronRight', 'chevron'));
    item.addEventListener('click', () => { $('#campaign-feedback').hidden = true; selectedCampaignId = campaign.id; confirmingCampaignId = null; campaignScreen = 'detail'; renderCampaignDetail(); renderCampaignScreen(); $('#campaign-detail-title').focus(); }); list.append(item);
  }
  renderCampaignDetail(); renderCampaignScreen();
}
function renderCampaignDetail() {
  const campaign = campaigns.find(row => row.id === selectedCampaignId);
  const content = $('#campaign-detail-content'); const actions = $('#campaign-detail-actions');
  // The shared status region may live inside the actions; keep it attached while they are redrawn.
  actions.before($('#campaign-feedback'));
  content.replaceChildren(); actions.replaceChildren();
  if (!campaign) {
    if (campaignScreen === 'detail') content.append(campaignState === 'loading' ? stateBlock('loading', 'Atualizando a automação…') : stateBlock('error', 'Automação por verificar', 'Ela não apareceu na lista mais recente. Atualize antes de continuar.', { retry: () => loadCampaigns() }));
    if (campaignScreen === 'detail') actions.prepend($('#campaign-feedback'));
    return;
  }
  const status = campaignStatus(campaign); const running = status.running === true; const allReels = allReelsCampaign(campaign);
  const legacy = campaign.requiresRecovery === true;
  const legacyBlocked = legacy && !recoveryReady(currentConnection?.capabilities);
  const ownedMedia = campaignMediaState === 'ready' && (allReels ? campaignMediaComplete : campaignMedia.some(media => media.id === campaign.mediaId));
  const legacyRunning = currentConnection?.automation?.running === true;
  const conflicts = campaignConflicts(campaign);
  const title = el('h1', '', campaign.name || 'Automação'); title.id = 'campaign-detail-title'; title.setAttribute('tabindex', '-1'); content.append(title);
  const meta = el('p', 'detail-meta'); meta.append(el('span', '', `@${accountUsername()} · ${allReels ? 'Todos os Reels, atuais e futuros' : `Reel ${campaignShortcode(campaign) || campaign.mediaId}`}`), statusPill(...campaignStatusView(status))); content.append(meta);
  if (status.lastCheckAt) content.append(el('p', 'list-status', `Última consulta: ${fullTime(status.lastCheckAt)}`));
  const message = el('div', 'campaign-detail-card'); message.append(el('h2', '', 'Mensagem da DM'), el('p', 'message-preview', campaign.messageText || 'Mensagem por verificar')); content.append(message);
  if (campaign.publicReplies?.length) { const replies = el('div', 'campaign-detail-card'); replies.append(el('h2', '', 'Resposta no comentário')); campaign.publicReplies.forEach(reply => replies.append(el('p', 'message-preview', reply))); content.append(replies); }
  if (Number.isInteger(status.acceptedCount)) content.append(el('p', 'count-line', `${plural(status.acceptedCount, 'DM aceita', 'DMs aceitas')} pela Meta${Number.isInteger(status.unknownCount) ? ` · ${status.unknownCount} com resultado indeterminado` : ''}`));
  content.append(el('p', 'hint', 'Aceite pela Meta não confirma entrega nem leitura. A curtida no comentário é manual.'));
  const gate = running ? 'Os próximos comentários elegíveis serão atendidos automaticamente.' : legacyBlocked ? 'Verifique a proteção dos atendimentos anteriores em Ajustes → Recuperação.' : status.reviewReason ? `Revise esta pendência antes de ativar: ${status.reviewReason}.` : legacyRunning ? 'Pause o envio antigo em Ajustes → Recuperação antes de ativar esta automação.' : !currentConnection?.connected || !ownedMedia ? 'Verifique a conexão e atualize os Reels para ativar.' : 'Ao ativar, os comentários anteriores ficam protegidos. O envio começa nos próximos comentários elegíveis.';
  const gateKind = running ? 'info' : legacyBlocked || status.reviewReason || legacyRunning || !currentConnection?.connected || !ownedMedia ? 'warning' : 'info';
  const gateNode = el('p', 'hint', gate); gateNode.dataset.kind = gateKind; content.append(gateNode);
  const blocked = campaignBusy || campaignState !== 'ready' || !running && (!currentConnection?.connected || !ownedMedia || legacyBlocked || legacyRunning || Boolean(status.reviewReason));
  const pending = campaignBusy ? campaignPendingAction : null;
  if (confirmingCampaignId === campaign.id && !running) {
    actions.append(el('p', 'notice warning', `Ao ativar, estas automações serão pausadas porque atendem os mesmos Reels: ${conflicts.map(row => row.name).join(', ')}.`));
    const confirm = el('button', 'button primary wide', pending === 'start' ? 'Ativando…' : 'Pausar as anteriores e ativar'); confirm.type = 'button'; confirm.disabled = blocked; confirm.setAttribute('aria-busy', String(pending === 'start'));
    confirm.addEventListener('click', () => { confirmingCampaignId = null; return setCampaignRunning(campaign.id, 'start'); }); actions.append(confirm);
    const cancel = el('button', 'button ghost wide', 'Manter como está'); cancel.type = 'button'; cancel.disabled = campaignBusy; cancel.addEventListener('click', () => { confirmingCampaignId = null; renderCampaignDetail(); $('#campaign-detail-title').focus(); }); actions.append(cancel);
  } else {
    const action = el('button', 'button primary wide', pending === 'start' ? 'Ativando…' : pending === 'stop' ? 'Pausando…' : running ? 'Pausar automação' : 'Ativar automação'); action.type = 'button'; action.disabled = blocked; action.setAttribute('aria-busy', String(Boolean(pending)));
    action.addEventListener('click', () => { if (!running && conflicts.length) { confirmingCampaignId = campaign.id; renderCampaignDetail(); actions.querySelector('.button.primary')?.focus(); } else return setCampaignRunning(campaign.id, running ? 'stop' : 'start'); }); actions.append(action);
    if (!running && !campaign.fromPublication) { const edit = el('button', 'button wide', 'Editar mensagem e regras'); edit.type = 'button'; edit.disabled = campaignBusy; edit.addEventListener('click', () => editCampaign(campaign)); actions.append(edit); }
  }
  if (campaignScreen === 'detail') actions.prepend($('#campaign-feedback'));
}
function editCampaign(campaign) {
  editingCampaignId = campaign.id; campaignDraftOpen = true; campaignStep = 0; campaignScreen = 'editor';
  $('#campaign-form-title').textContent = 'Editar automação'; $('#campaign-name').value = campaign.name || ''; setRadioValue('#campaign-form', 'campaignScope', allReelsCampaign(campaign) ? 'all_reels' : 'reel'); $('#campaign-media').value = campaign.mediaId || ''; $('#campaign-keywords').value = Array.isArray(campaign.keywords) ? campaign.keywords.join(', ') : ''; setRadioValue('#campaign-form', 'campaignTrigger', campaign.keywords?.length ? 'keywords' : 'any'); $('#campaign-message').value = campaign.messageText || ''; setCampaignReplies(campaign.publicReplies); campaignMessageSize(); $('#campaign-feedback').hidden = true; renderCampaignEditorState(); renderCampaignScreen(true);
}
async function loadCampaigns() {
  const scope = accountScope();
  campaignState = 'loading'; campaignMediaState = 'loading'; campaignMediaComplete = false; $('#refresh-campaigns').disabled = true; renderCampaignList(); renderCampaignEditorState();
  const selectedMedia = $('#campaign-media').value;
  const [stored, media] = await Promise.allSettled([apiRead('/api/campaigns', scope), apiRead('/api/campaigns/media', scope)]);
  if (!currentScope(scope)) return;
  if (stored.status === 'fulfilled' && Array.isArray(stored.value.campaigns)) { campaigns = stored.value.campaigns; runningCampaignId = stored.value.runningCampaignId || null; campaignState = 'ready'; setHint('#campaign-source', 'neutral', `${plural(campaigns.length, 'automação cadastrada', 'automações cadastradas')} · salvar não ativa o envio.`); }
  else { campaignState = 'unavailable'; setHint('#campaign-source', 'warning', campaigns.length ? 'Não foi possível atualizar. As automações exibidas podem estar desatualizadas.' : 'Não foi possível carregar as automações.'); }
  const select = $('#campaign-media'); select.replaceChildren();
  if (media.status === 'fulfilled' && media.value.available !== false && Array.isArray(media.value.media)) {
    campaignMediaState = 'ready'; campaignMediaComplete = media.value.available === true && media.value.truncated === false; campaignMedia = media.value.media.filter(record => typeof record.id === 'string' && record.id);
    const placeholder = el('option', '', campaignMedia.length ? 'Selecione um Reel' : 'Nenhum Reel retornado pela API'); placeholder.value = ''; select.append(placeholder);
    for (const record of campaignMedia) { const option = el('option', '', `${record.shortcode || record.id}${record.mediaType ? ` · ${record.mediaType}` : ''}`); option.value = record.id; select.append(option); }
    select.value = selectedMedia;
    setHint('#campaign-media-note', media.value.truncated ? 'warning' : 'neutral', media.value.truncated ? 'A API retornou uma lista parcial. Somente os Reels confirmados abaixo podem ser selecionados.' : campaignMedia.length ? 'Publicações retornadas pela API da sua conta. Nenhum Reel de exemplo é exibido.' : 'Nenhum Reel foi retornado para esta conta. Publique um Reel ou escolha Todos os Reels.');
  } else { campaignMediaState = 'unavailable'; campaignMedia = []; const option = el('option', '', 'Verifique a conexão para listar seus Reels'); option.value = ''; select.append(option); setHint('#campaign-media-note', 'warning', 'A API ainda não confirmou as publicações. Verifique a conexão e atualize os Reels em Automações.'); }
  $('#refresh-campaigns').disabled = false; renderCampaignList(); renderCampaignEditorState();
}
async function setCampaignRunning(id, action) {
  const scope = accountScope();
  if (campaignBusy) return; campaignBusy = true; campaignPendingAction = action; renderCampaignList(); renderCampaignEditorState();
  showFeedback('#campaign-feedback', action === 'start' ? 'Verificando os comentários anteriores antes de ativar…' : 'Parando novos envios da automação…', 'progress');
  let confirmed = false;
  try { await apiWrite(`/api/campaigns/${encodeURIComponent(id)}/${action}`, {}, scope); assertScope(scope); confirmed = true; await loadCampaigns(); assertScope(scope); showFeedback('#campaign-feedback', action === 'start' ? 'Solicitação de ativação concluída. Confira o estado da automação acima.' : 'Novos envios pausados. Uma tentativa já iniciada pode concluir.', 'success'); }
  catch { confirmed = false; if (!currentScope(scope)) return; await loadCampaigns(); if (currentScope(scope)) showFeedback('#campaign-feedback', 'Não foi possível confirmar a operação. Confira o estado da automação e o diagnóstico antes de tentar novamente.', 'error'); }
  finally { if (currentScope(scope)) { campaignBusy = false; campaignPendingAction = null; renderCampaignList(); renderCampaignEditorState(); if (confirmed) flashSuccess($('#campaign-detail-content .detail-meta .status')); } }
}
$('#refresh-campaigns').addEventListener('click', () => loadCampaigns());
$('#new-campaign').addEventListener('click', () => { campaignDraftOpen = true; campaignScreen = 'editor'; $('#campaign-feedback').hidden = true; renderCampaignScreen(true); });
$('#campaign-detail-back').addEventListener('click', () => { const id = selectedCampaignId; campaignScreen = 'list'; confirmingCampaignId = null; $('#campaign-feedback').hidden = true; renderCampaignScreen(); const row = [...document.querySelectorAll('#campaign-list [data-campaign-id]')].find(item => item.dataset.campaignId === id); (row || $('#new-campaign')).focus(); });
$('#cancel-campaign').addEventListener('click', () => { campaignScreen = 'list'; $('#campaign-feedback').hidden = true; renderCampaignScreen(); $('#new-campaign').focus(); });
$('#campaign-next').addEventListener('click', () => { if (!campaignBusy && validCampaignStep(campaignStep)) { campaignStep = Math.min(4, campaignStep + 1); renderCampaignScreen(true); } });
$('#campaign-back').addEventListener('click', () => { campaignStep = Math.max(0, campaignStep - 1); $('#campaign-feedback').hidden = true; renderCampaignScreen(true); });
$('#campaign-trigger').addEventListener('change', () => { if (!keywordsTriggerSelected()) { $('#campaign-keywords').value = ''; clearFieldError($('#campaign-keywords')); } renderCampaignScreen(); });
$('#campaign-message').addEventListener('input', campaignMessageSize); $('#campaign-scope').addEventListener('change', () => { clearFieldError($('#campaign-media')); renderCampaignEditorState(); });
$('#campaign-form').addEventListener('input', event => clearFieldError(event.target));
$('#campaign-media').addEventListener('change', event => clearFieldError(event.target));
$('#campaign-form').addEventListener('submit', async event => {
  event.preventDefault(); if (campaignBusy || campaignState !== 'ready' || (!allReelsSelected() && campaignMediaState !== 'ready')) return;
  if (campaignStep !== 4) { if (validCampaignStep(campaignStep)) { campaignStep++; renderCampaignScreen(true); } return; }
  if (!validCampaignStep(4)) return;
  const scope = accountScope();
  const messageText = $('#campaign-message').value.trim(); const links = messageText.match(/https?:\/\/[^\s]+/g) || [];
  const validLinks = links.length && links.every(link => { try { return new URL(link.replace(/[),.!?]+$/, '')).protocol === 'https:'; } catch { return false; } });
  if (!messageText || campaignMessageSize() > 1000 || !validLinks) { campaignStep = 2; renderCampaignScreen(); fieldError('#campaign-message', 'A primeira DM precisa de um link HTTPS válido e caber no limite de tamanho.'); return; }
  const allReels = allReelsSelected();
  const invalidReply = campaignReplyFields.find(field => new TextEncoder().encode(field.value.trim()).length > 1000);
  if (invalidReply) { campaignStep = 3; renderCampaignScreen(); if (invalidReply.closest('details')) invalidReply.closest('details').open = true; fieldError(invalidReply, 'Cada resposta pública precisa caber no limite de tamanho. Reduza o texto antes de salvar.'); return; }
  const body = { name: $('#campaign-name').value.trim(), scope: allReels ? 'all_reels' : 'reel', mediaId: allReels ? null : $('#campaign-media').value, messageText, keywords: [...new Set($('#campaign-keywords').value.split(',').map(keyword => keyword.trim()).filter(Boolean))], publicReplies: campaignReplyFields.map(field => field.value.trim()).filter(Boolean) };
  if (!body.name) { fieldError('#campaign-name', 'Dê um nome para encontrar esta automação depois.'); return; }
  if (!allReels && !campaignMedia.some(media => media.id === body.mediaId)) { campaignStep = 0; renderCampaignScreen(); fieldError('#campaign-media', 'Selecione um Reel confirmado pela API.'); return; }
  campaignBusy = true; campaignPendingAction = 'save'; setButtonBusy($('#save-campaign'), true, 'Salvando…'); showFeedback('#campaign-feedback', 'Salvando a automação pausada…', 'progress'); renderCampaignEditorState(); renderCampaignList();
  let savedId = null;
  try { const result = await apiWrite(editingCampaignId ? `/api/campaigns/${encodeURIComponent(editingCampaignId)}` : '/api/campaigns', body, scope); assertScope(scope); savedId = result.campaign?.id || result.id || editingCampaignId; await loadCampaigns(); assertScope(scope); resetCampaignEditor(); selectedCampaignId = savedId; campaignScreen = campaigns.some(row => row.id === savedId) ? 'detail' : 'list'; renderCampaignList(); $('#campaign-feedback').hidden = true; toast('Automação salva e pausada. Ative quando estiver pronto.', 'success'); }
  catch { savedId = null; if (currentScope(scope)) showFeedback('#campaign-feedback', 'Não foi possível confirmar o salvamento. O texto continua no formulário.', 'error'); }
  finally {
    setButtonBusy($('#save-campaign'), false);
    if (currentScope(scope)) {
      campaignBusy = false; campaignPendingAction = null; renderCampaignEditorState(); renderCampaignList();
      if (savedId && campaignScreen === 'detail') { flashSuccess($('#campaign-detail-content .detail-meta .status')); $('#campaign-detail-title')?.focus(); }
    }
  }
});

// Campaigns group scheduled publications; comment automations keep their own controls.
let publishingData = { groups: [], jobs: [], available: false };
let publishingState = 'idle', publishingScreen = 'list', publishingGroupId = null;
let publishingStep = 0, publishingBusy = false, publishingDraftId = null, publishingGroupDraftId = null;
let publishingUploadedUrl = null, publishingCancelId = null;
const publicationStates = { scheduled: 'Agendado', creating: 'Preparando vídeo', processing: 'Processando na Meta', ready: 'Pronto para publicar', publishing: 'Publicação em andamento', published: 'Publicado · preparando DMs', active: 'Publicado', attention: 'Precisa de atenção', cancelled: 'Cancelado' };
// Visual kind for each scheduler state: the server enum decides it, never the label.
const publicationKinds = { scheduled: 'neutral', creating: 'progress', processing: 'progress', ready: 'progress', publishing: 'progress', published: 'info', active: 'success', attention: 'warning', cancelled: 'neutral' };
const publishingFields = ['publishing-file', 'publishing-video-url', 'publishing-reel-title', 'publishing-caption', 'publishing-at', 'publishing-dm-text', 'publishing-dm-link'];
let publishingAction = null, publishingCardError = null;
const publicationOpenCopies = new Set();
function renderPublishingFile() {
  const file = $('#publishing-file').files?.[0];
  $('#publishing-file-name').textContent = file ? file.name : 'Escolher vídeo MP4';
  $('#publishing-file-meta').textContent = file ? `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(file.size / (1024 * 1024))} MB · toque para trocar` : 'Até 100 MB';
  $('#publishing-file').closest('.file-drop').classList.toggle('has-file', Boolean(file));
}
function resetPublishingEditor() {
  for (const id of publishingFields) { $(`#${id}`).value = ''; clearFieldError($(`#${id}`)); }
  setRadioValue('#publishing-form', 'publishingVideoSource', 'file'); renderPublishingFile();
}
function resetPublishing() {
  publishingData = { groups: [], jobs: [], available: false }; publishingState = 'idle'; publishingScreen = 'list'; publishingGroupId = null; publishingBusy = false; publishingDraftId = null; publishingUploadedUrl = null; publishingCancelId = null; publishingAction = null; publishingCardError = null; publicationOpenCopies.clear();
  resetPublishingEditor(); $('#publishing-group-name').value = ''; clearFieldError($('#publishing-group-name'));
  $('#publishing-feedback').hidden = true; renderPublishing();
}
const publicationDate = value => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
function publicationTime() {
  // The input is explicitly São Paulo, regardless of the browser's timezone.
  const value = $('#publishing-at').value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
  return Date.parse(`${value}:00-03:00`);
}
function publicationDm() {
  let link = $('#publishing-dm-link').value.trim();
  if (publishingData.conversionReporting?.configured && publishingDraftId && publicationHttps(link)) {
    const attributed = new URL(link); attributed.searchParams.set('benion_campaign', publishingDraftId); link = attributed.href;
  }
  return `${$('#publishing-dm-text').value.trim()}\n\n${link}`;
}
function publicationHttps(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }
async function loadPublishing() {
  if (!selectedAccountId) { renderPublishing(); return; }
  if (!selectedAccountId) return;
  const scope = accountScope(); publishingState = 'loading'; renderPublishing();
  try {
    const data = await apiRead('/api/publishing', scope); assertScope(scope);
    if (!Array.isArray(data.groups) || !Array.isArray(data.jobs)) throw new Error('invalid-publishing');
    publishingData = data; publishingState = data.available ? 'ready' : 'unavailable';
  } catch { if (currentScope(scope)) publishingState = 'unavailable'; }
  finally { if (currentScope(scope)) renderPublishing(); }
}
function publishingFlowHost() { return $({ list: '#publishing-home .flow-actions', group: '#publishing-group-form .flow-actions', detail: '#publishing-detail .flow-actions', editor: '#publishing-form .flow-actions' }[publishingScreen]); }
function conversionSummary(jobs) {
  if (!publishingData.conversionReporting?.available) return 'Vendas indisponíveis · conecte o backend do produto';
  const purchases = jobs.reduce((sum, job) => sum + (job.conversions?.purchases ?? 0), 0);
  const refunds = jobs.reduce((sum, job) => sum + (job.conversions?.refunded ?? 0), 0);
  return `${plural(purchases, 'compra confirmada', 'compras confirmadas')} · ${plural(refunds, 'reembolso', 'reembolsos')}`;
}
function renderPublishing() {
  $('#publishing-home').hidden = publishingScreen !== 'list'; $('#publishing-group-form').hidden = publishingScreen !== 'group';
  $('#publishing-detail').hidden = publishingScreen !== 'detail'; $('#publishing-form').hidden = publishingScreen !== 'editor';
  placeFeedback($('#publishing-feedback'), publishingFlowHost());
  const ready = publishingState === 'ready';
  const accountMissing = !selectedAccountId && accountsState === 'unavailable';
  const firstAccount = !selectedAccountId && accountsState === 'ready';
  const loading = !firstAccount && !accountMissing && (publishingState === 'loading' || publishingState === 'idle');
  const groups = publishingData.groups;
  setHint('#publishing-status', firstAccount ? 'neutral' : loading ? 'progress' : !ready ? 'warning' : 'neutral', firstAccount ? 'Conecte sua primeira conta para criar campanhas.' : loading ? 'Atualizando campanhas…' : !ready ? (groups.length ? 'Não foi possível atualizar o agendador. Os dados exibidos podem estar desatualizados.' : 'Não foi possível consultar o agendador. Atualize para tentar novamente.') : groups.length ? `${plural(groups.length, 'campanha', 'campanhas')} nesta conta.` : 'Nenhuma campanha nesta conta ainda.');
  $('#publishing-status').classList.toggle('sr-only', !groups.length);
  for (const id of ['publishing-new-group', 'publishing-create-group', 'publishing-add-reel', 'publishing-submit']) $(`#${id}`).disabled = publishingBusy || !ready;
  for (const id of ['publishing-group-back', 'publishing-detail-back', 'publishing-cancel-editor', 'publishing-back', 'publishing-next']) $(`#${id}`).disabled = publishingBusy;
  for (const id of ['publishing-refresh', 'publishing-detail-refresh']) {
    const button = $(`#${id}`); button.disabled = publishingBusy || publishingState === 'loading'; button.setAttribute('aria-busy', String(publishingState === 'loading'));
    button.querySelector('.button-label').textContent = publishingState === 'loading' ? 'Atualizando…' : id === 'publishing-refresh' ? 'Atualizar' : 'Atualizar resultados';
  }
  $('#publishing-create-group').textContent = publishingBusy && publishingAction === 'group' ? 'Criando…' : 'Criar campanha';
  $('#publishing-create-group').setAttribute('aria-busy', String(publishingBusy && publishingAction === 'group'));
  $('#publishing-submit').textContent = publishingBusy && publishingAction === 'schedule' ? 'Agendando…' : 'Confirmar agendamento';
  $('#publishing-submit').setAttribute('aria-busy', String(publishingBusy && publishingAction === 'schedule'));
  const list = $('#publishing-groups');
  const focusedGroup = document.activeElement?.closest?.('#publishing-groups [data-group-id]')?.dataset.groupId;
  list.replaceChildren();
  if (!groups.length) {
    if (firstAccount) list.append(stateBlock('empty', 'Conecte seu Instagram para começar', 'Use sua própria conta profissional e seu app da Meta. Depois crie campanhas e agende Reels.', { retry: openConnection }));
    else if (accountMissing) list.append(stateBlock('error', 'Conta por verificar', 'A lista de contas não foi confirmada. Tente de novo para carregar as campanhas desta conta.', { retry: () => loadAccounts() }));
    else if (loading) list.append(stateBlock('loading', 'Carregando campanhas…'));
    else if (!ready) list.append(stateBlock('error', 'Agendador indisponível', 'Nada foi publicado nem alterado. Tente de novo em instantes.', { retry: () => loadPublishing() }));
    else list.append(stateBlock('empty', 'Sua primeira campanha começa com uma ideia', 'Crie uma campanha e depois adicione quantos Reels quiser.', { iconName: 'publishing' }));
  }
  for (const group of groups) {
    const jobs = publishingData.jobs.filter(j => j.groupId === group.id);
    const button = el('button', 'choice'); button.type = 'button'; button.dataset.groupId = group.id;
    const text = el('span', 'choice-text'); text.append(el('strong', '', group.name), el('span', 'choice-meta', `${plural(jobs.length, 'Reel', 'Reels')} · ${conversionSummary(jobs)}`));
    button.append(text, icon('chevronRight', 'chevron'));
    button.disabled = publishingBusy; button.addEventListener('click', () => { publishingGroupId = group.id; publishingScreen = 'detail'; publishingCancelId = null; publishingCardError = null; $('#publishing-feedback').hidden = true; renderPublishing(); $('#publishing-group-title').focus(); }); list.append(button);
    if (focusedGroup === group.id && !button.disabled) queueMicrotask(() => button.focus());
  }
  const group = groups.find(g => g.id === publishingGroupId);
  if (group && publishingScreen === 'detail') {
    $('#publishing-group-title').textContent = group.name; $('#publishing-group-title').setAttribute('tabindex', '-1');
    const jobs = publishingData.jobs.filter(j => j.groupId === group.id);
    const known = jobs.filter(j => j.mediaId && j.metrics);
    const accepted = known.reduce((sum, j) => sum + j.metrics.accepted, 0);
    $('#publishing-group-summary').textContent = `${plural(jobs.length, 'Reel', 'Reels')} · ${plural(accepted, 'DM aceita', 'DMs aceitas')} · ${conversionSummary(jobs)}${jobs.some(j => j.mediaId && !j.metrics) ? ' · alguns resultados estão indisponíveis' : ''}${ready || loading ? '' : ' · dados podem estar desatualizados'}`;
    const results = $('#publishing-results');
    // Refreshing keeps open previews, scroll position and keyboard focus.
    const focusKey = document.activeElement?.closest?.('#publishing-results [data-focus-key]')?.dataset.focusKey;
    results.replaceChildren();
    if (!jobs.length) results.append(stateBlock('empty', 'Nenhum Reel nesta campanha ainda', 'Agende o primeiro Reel. A mensagem e o link da DM ficam prontos junto com ele.', { iconName: 'publishing' }));
    const ranked = [...jobs].sort((a, b) => (b.metrics?.accepted ?? -1) - (a.metrics?.accepted ?? -1) || Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
    for (const job of ranked) results.append(publicationCard(job, ready));
    if (focusKey) [...results.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey)?.focus();
  }
  for (let step = 0; step < 4; step++) $(`#publishing-step-${step}`).hidden = publishingStep !== step;
  $('#publishing-step-label').textContent = `Passo ${publishingStep + 1} de 4`; $('#publishing-progress').value = publishingStep + 1;
  $('#publishing-flow-label').textContent = group ? `Agendar Reel · ${group.name}` : 'Agendar Reel';
  $('#publishing-next').hidden = publishingStep === 3; $('#publishing-submit').hidden = publishingStep !== 3; $('#publishing-back').hidden = publishingStep === 0;
  const file = radioValue('#publishing-form', 'publishingVideoSource') !== 'url'; $('#publishing-file-field').hidden = !file; $('#publishing-url-field').hidden = file;
  sizeNote('#publishing-dm-size', new TextEncoder().encode(publicationDm()).length);
  if (publishingScreen === 'editor' && publishingStep === 3) {
    const review = $('#publishing-review'); review.replaceChildren();
    for (const [label, value] of [['Conta', `@${accountUsername()}`], ['Campanha', group?.name], ['Reel', $('#publishing-reel-title').value], ['Horário em São Paulo', Number.isFinite(publicationTime()) ? publicationDate(publicationTime()) : 'Revise o horário'], ['Legenda', $('#publishing-caption').value || 'Sem legenda'], ['DM para qualquer comentário', publicationDm()], ['Resposta pública', 'Joguinho de personagens e raridades · automático']]) review.append(el('dt', '', label), el('dd', '', value || ''));
  }
}
function publicationCard(job, ready) {
  const card = el('article', 'publication-card'); card.dataset.jobId = job.id;
  const top = el('div', 'publication-card-top'); top.append(el('h2', '', job.title), statusPill(publicationKinds[job.state] || 'warning', publicationStates[job.state] || 'Estado por verificar'));
  card.append(top, el('p', 'list-status', `${publicationDate(job.scheduledAt)} · São Paulo`));
  if (job.mediaId) {
    const metrics = el('dl', 'publication-metrics');
    for (const [label, value] of [['DMs aceitas', job.metrics?.accepted], ['Indeterminadas', job.metrics?.unknown], ['Respostas públicas', job.metrics?.publicAccepted], ['Compras confirmadas', job.conversions?.purchases], ['Reembolsos', job.conversions?.refunded], ['Compras com cupom', job.conversions?.couponPurchases]]) { const item = el('div', ''); item.append(el('dt', '', label), el('dd', '', value == null ? '—' : String(value))); metrics.append(item); } card.append(metrics);
    card.append(el('p', 'list-status', job.conversions?.available ? 'Compras informadas pelo backend do produto. Atribuição por link compartilhável; cliques não são medidos.' : 'Vendas indisponíveis até receber uma confirmação autenticada do backend do produto.'));
    if (job.automation) card.append(statusPill(job.automation.running ? 'success' : job.automation.enabled ? 'warning' : 'neutral', job.automation.running ? 'Automação de comentários ativa' : job.automation.enabled ? 'Automação de comentários precisa de atenção' : 'Automação de comentários pausada'));
    if (job.permalink) { const link = el('a', 'button ghost', 'Ver Reel no Instagram'); link.href = job.permalink; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.focusKey = `link-${job.id}`; link.append(icon('external'), el('span', 'sr-only', ' (abre em nova aba)')); card.append(link); }
  }
  if (job.reason) {
    const reasons = { PUBLISH_OUTCOME_UNKNOWN: 'A Meta não confirmou o resultado. Confira o Instagram antes de tentar outra publicação; o Benion bloqueou a repetição.', CONTAINER_OUTCOME_UNKNOWN: 'A preparação não foi confirmada. Nenhuma publicação foi iniciada.', PUBLICATION_REJECTED: 'A Meta recusou a publicação. Confira o vídeo e os acessos da conta.', PUBLICATION_WINDOW_MISSED: 'O horário passou há mais de uma hora. O Benion não publicou fora dessa janela.', PUBLICATION_DM_PENDING: 'O Reel já foi publicado. O Benion está tentando concluir a automação de DM.', CONTAINER_ERROR: 'A Meta não conseguiu processar este vídeo. Confira o formato e o arquivo.', CONTAINER_EXPIRED: 'O vídeo preparado expirou na Meta.' };
    card.append(el('p', 'notice warning', reasons[job.reason] || 'O servidor está tentando recuperar esta etapa. Se persistir, confira a conexão da conta.'));
  }
  const preview = el('details', 'disclosure publication-copy'); const summary = el('summary'); summary.dataset.focusKey = `copy-${job.id}`; summary.append(icon('chevronRight'), document.createTextNode('Ver legenda e DM'));
  preview.open = publicationOpenCopies.has(job.id);
  preview.addEventListener('toggle', () => { if (preview.open) publicationOpenCopies.add(job.id); else publicationOpenCopies.delete(job.id); });
  preview.append(summary, el('h3', '', 'Legenda'), el('p', 'preserve-lines', job.caption || 'Sem legenda'), el('h3', '', 'DM'), el('p', 'preserve-lines', `${job.dmText}\n\n${job.deliveryDmLink ?? job.dmLink}`)); card.append(preview);
  if (['scheduled', 'processing', 'ready'].includes(job.state)) {
    const cancelling = publishingBusy && publishingAction === 'cancel' && publishingCancelId === job.id;
    if (publishingCancelId === job.id) {
      // Two-step cancellation: the confirm sits next to the card it affects, with a calm way back.
      const confirmBox = el('div', 'cancel-confirm');
      confirmBox.append(el('p', 'notice warning', 'Cancelar este agendamento? O Reel não será publicado.'));
      const confirm = el('button', 'button danger wide', cancelling ? 'Cancelando…' : 'Sim, cancelar agendamento'); confirm.type = 'button'; confirm.disabled = publishingBusy || !ready; confirm.dataset.focusKey = `confirm-${job.id}`; confirm.setAttribute('aria-busy', String(cancelling));
      confirm.addEventListener('click', () => cancelPublication(job.id));
      const keep = el('button', 'button ghost wide', 'Manter agendamento'); keep.type = 'button'; keep.disabled = publishingBusy; keep.dataset.focusKey = `keep-${job.id}`;
      keep.addEventListener('click', () => { publishingCancelId = null; publishingCardError = null; renderPublishing(); [...document.querySelectorAll('#publishing-results [data-focus-key]')].find(node => node.dataset.focusKey === `cancel-${job.id}`)?.focus(); });
      confirmBox.append(confirm, keep);
      card.append(confirmBox);
    } else {
      const cancel = el('button', 'button ghost danger', 'Cancelar agendamento'); cancel.type = 'button'; cancel.disabled = publishingBusy || !ready; cancel.dataset.focusKey = `cancel-${job.id}`;
      cancel.addEventListener('click', () => { publishingCancelId = job.id; publishingCardError = null; renderPublishing(); [...document.querySelectorAll('#publishing-results [data-focus-key]')].find(node => node.dataset.focusKey === `keep-${job.id}`)?.focus(); });
      card.append(cancel);
    }
  }
  if (publishingCardError?.jobId === job.id) card.append(el('p', 'notice error', publishingCardError.text));
  return card;
}
function validatePublicationStep(step) {
  let field = null, message = '';
  const source = radioValue('#publishing-form', 'publishingVideoSource');
  if (step === 0) {
    if (!$('#publishing-reel-title').value.trim()) { field = '#publishing-reel-title'; message = 'Dê um nome para identificar o Reel.'; }
    else if (source === 'url' && !publicationHttps($('#publishing-video-url').value.trim())) { field = '#publishing-video-url'; message = 'Informe um link direto HTTPS para o vídeo.'; }
    else if (source !== 'url' && (!$('#publishing-file').files?.[0] || $('#publishing-file').files[0].size > 100 * 1024 * 1024)) { field = '#publishing-file'; message = 'Escolha um MP4 de até 100 MB.'; }
    else if ([...$('#publishing-caption').value].length > 2200) { field = '#publishing-caption'; message = 'A legenda pode ter até 2200 caracteres.'; }
  }
  if (step === 1 && (!Number.isFinite(publicationTime()) || publicationTime() < Date.now() + 60000)) { field = '#publishing-at'; message = 'Escolha um horário futuro, com pelo menos um minuto de antecedência.'; }
  if (step === 2) {
    if (!$('#publishing-dm-text').value.trim()) { field = '#publishing-dm-text'; message = 'Escreva a mensagem da DM.'; }
    else if (!publicationHttps($('#publishing-dm-link').value.trim())) { field = '#publishing-dm-link'; message = 'Informe um link HTTPS para enviar na DM.'; }
    else if (new TextEncoder().encode(publicationDm()).length > 1000) { field = '#publishing-dm-text'; message = 'Reduza a mensagem: ela e o link passaram do limite de tamanho.'; }
  }
  $('#publishing-feedback').hidden = true;
  if (field) return fieldError(field, message);
  return true;
}
function movePublicationStep(step, focusField = null) {
  publishingStep = step; renderPublishing();
  if (!focusField) focusStepHeading($(`#publishing-step-${step}`));
}
$('#publishing-refresh').addEventListener('click', () => loadPublishing());
$('#publishing-detail-refresh').addEventListener('click', () => loadPublishing());
$('#publishing-new-group').addEventListener('click', () => { publishingGroupDraftId = crypto.randomUUID(); publishingScreen = 'group'; $('#publishing-group-name').value = ''; clearFieldError($('#publishing-group-name')); $('#publishing-feedback').hidden = true; renderPublishing(); $('#publishing-group-name').focus(); });
for (const id of ['publishing-group-back', 'publishing-detail-back']) $(`#${id}`).addEventListener('click', () => {
  const groupId = publishingGroupId; const fromDetail = publishingScreen === 'detail';
  publishingScreen = 'list'; publishingCancelId = null; publishingCardError = null; $('#publishing-feedback').hidden = true; renderPublishing();
  const row = fromDetail ? [...document.querySelectorAll('#publishing-groups [data-group-id]')].find(item => item.dataset.groupId === groupId) : null;
  (row || $('#publishing-new-group')).focus();
});
$('#publishing-group-name').addEventListener('input', event => clearFieldError(event.target));
$('#publishing-group-form').addEventListener('submit', async event => {
  event.preventDefault(); if (publishingBusy) return;
  if (!$('#publishing-group-name').value.trim()) { $('#publishing-feedback').hidden = true; fieldError('#publishing-group-name', 'Dê um nome para esta campanha.'); return; }
  const scope = accountScope(); publishingBusy = true; publishingAction = 'group'; showFeedback('#publishing-feedback', 'Criando a campanha…', 'progress'); renderPublishing();
  try { const group = await apiWrite('/api/publishing/groups', { id: publishingGroupDraftId, name: $('#publishing-group-name').value.trim() }, scope); await loadPublishing(); assertScope(scope); publishingGroupId = group.id; publishingScreen = 'detail'; $('#publishing-feedback').hidden = true; toast('Campanha criada. Agora adicione seu primeiro Reel.', 'success'); }
  catch { if (currentScope(scope)) showFeedback('#publishing-feedback', 'Não foi possível confirmar a campanha. Seu nome continua aqui; tente novamente.', 'error'); }
  finally { if (currentScope(scope)) { publishingBusy = false; publishingAction = null; renderPublishing(); if (publishingScreen === 'detail') $('#publishing-group-title').focus(); } }
});
$('#publishing-add-reel').addEventListener('click', () => {
  publishingScreen = 'editor'; publishingStep = 0; publishingDraftId = crypto.randomUUID(); publishingUploadedUrl = null;
  resetPublishingEditor(); $('#publishing-feedback').hidden = true; movePublicationStep(0);
});
$('#publishing-cancel-editor').addEventListener('click', () => { publishingScreen = 'detail'; $('#publishing-feedback').hidden = true; renderPublishing(); $('#publishing-add-reel').focus(); });
$('#publishing-video-source').addEventListener('change', () => { clearFieldError($('#publishing-file')); clearFieldError($('#publishing-video-url')); renderPublishing(); });
$('#publishing-file').addEventListener('change', () => { publishingUploadedUrl = null; clearFieldError($('#publishing-file')); renderPublishingFile(); });
for (const id of ['publishing-dm-text', 'publishing-dm-link']) $(`#${id}`).addEventListener('input', renderPublishing);
$('#publishing-form').addEventListener('input', event => clearFieldError(event.target));
$('#publishing-next').addEventListener('click', () => { if (!publishingBusy && validatePublicationStep(publishingStep)) movePublicationStep(publishingStep + 1); });
$('#publishing-back').addEventListener('click', () => { if (!publishingBusy) { $('#publishing-feedback').hidden = true; movePublicationStep(Math.max(0, publishingStep - 1)); } });
async function uploadPublicationVideo(scope) {
  if (publishingUploadedUrl) return publishingUploadedUrl;
  const csrf = await apiRead('/api/csrf', scope); assertScope(scope);
  const response = await fetch('/api/publishing/video', { method: 'POST', credentials: 'same-origin', headers: scopedHeaders(scope, { 'X-Benion-CSRF': csrf.nonce, 'Content-Type': 'video/mp4' }), body: $('#publishing-file').files[0] });
  const result = await response.json(); assertScope(scope);
  if (!response.ok || !publicationHttps(result.videoUrl)) throw Object.assign(new Error('upload-failed'), { code: result.error });
  publishingUploadedUrl = result.videoUrl; return result.videoUrl;
}
$('#publishing-form').addEventListener('submit', async event => {
  event.preventDefault(); if (publishingBusy) return;
  if (publishingStep !== 3) { if (validatePublicationStep(publishingStep)) movePublicationStep(publishingStep + 1); return; }
  // Show the step with the problem before validating it, so the inline error and focus land on a visible field.
  for (let step = 0; step < 3; step++) { publishingStep = step; renderPublishing(); if (!validatePublicationStep(step)) return; }
  publishingStep = 3;
  const scope = accountScope(); const draftId = publishingDraftId; let scheduled = false;
  publishingBusy = true; publishingAction = 'schedule'; renderPublishing(); showFeedback('#publishing-feedback', 'Salvando vídeo e agendamento…', 'progress');
  try {
    const videoUrl = radioValue('#publishing-form', 'publishingVideoSource') === 'url' ? $('#publishing-video-url').value.trim() : await uploadPublicationVideo(scope); assertScope(scope);
    await apiWrite('/api/publishing/reels', { id: publishingDraftId, groupId: publishingGroupId, title: $('#publishing-reel-title').value.trim(), videoUrl, caption: $('#publishing-caption').value,
      scheduledAt: new Date(publicationTime()).toISOString(), dmText: $('#publishing-dm-text').value.trim(), dmLink: $('#publishing-dm-link').value.trim() }, scope);
    scheduled = true; await loadPublishing(); assertScope(scope); publishingScreen = 'detail'; $('#publishing-feedback').hidden = true; toast('Reel agendado. A DM e o joguinho serão ativados após a publicação.', 'success');
  } catch (error) {
    if (currentScope(scope)) { const known = { SCHEDULE_IN_PAST: 'O horário ficou muito próximo. Escolha um novo horário.', VIDEO_UPLOAD_INVALID: 'Use um arquivo MP4 válido de até 100 MB.', VIDEO_STORAGE_FULL: 'O espaço para vídeos está cheio. Use um link direto HTTPS.', PUBLISHING_CONNECTION_REQUIRED: 'Renove a conexão desta conta antes de agendar.' }; showFeedback('#publishing-feedback', known[error.code] || 'Não foi possível confirmar o agendamento. O rascunho continua aqui. Tentar novamente não duplica o Reel.', 'error'); }
  } finally {
    if (currentScope(scope)) {
      publishingBusy = false; publishingAction = null; renderPublishing();
      if (scheduled && publishingScreen === 'detail') { const card = [...document.querySelectorAll('#publishing-results [data-job-id]')].find(item => item.dataset.jobId === draftId); flashSuccess(card); $('#publishing-group-title').focus(); }
    }
  }
});
async function cancelPublication(id) {
  const scope = accountScope(); publishingBusy = true; publishingAction = 'cancel'; publishingCardError = null; renderPublishing();
  try { await apiWrite(`/api/publishing/reels/${id}/cancel`, {}, scope); await loadPublishing(); assertScope(scope); $('#publishing-feedback').hidden = true; toast('Agendamento cancelado. O Reel não será publicado.', 'success'); }
  catch { if (currentScope(scope)) publishingCardError = { jobId: id, text: 'Não foi possível cancelar. Atualize o estado: a publicação pode já ter começado.' }; }
  finally {
    if (currentScope(scope)) {
      publishingBusy = false; publishingAction = null; publishingCancelId = null; renderPublishing();
      const card = [...document.querySelectorAll('#publishing-results [data-job-id]')].find(item => item.dataset.jobId === id);
      (card?.querySelector('[data-focus-key^="cancel-"]') || card?.querySelector('[data-focus-key]') || $('#publishing-group-title')).focus();
    }
  }
}

let assistantPreviewHistory = [];
let assistantPreviewBusy = false;
function renderAssistantPreview() {
  const log = $('#assistant-preview-log'); log.replaceChildren();
  if (!assistantPreviewHistory.length) log.append(stateBlock('empty', 'Nenhum teste ainda', 'Envie uma pergunta para ver como o assistente responderia.', { inset: true }));
  for (const entry of assistantPreviewHistory) {
    if (entry.direction === 'system') { log.append(el('p', 'hint preview-system', entry.text)); continue; }
    const item = el('div', `chat-event ${entry.direction === 'inbound' ? 'incoming' : 'outgoing'}`); item.append(el('div', 'bubble', entry.placeholder ? 'Menção em Story sem texto' : entry.text), el('time', '', 'Simulação · nenhuma DM é enviada')); log.append(item);
  }
  log.scrollTop = log.scrollHeight;
}
function updateAssistantPreviewKind() {
  const mention = $('#assistant-preview-kind').value === 'story_mention';
  $('#assistant-preview-text').required = !mention;
  $('#assistant-preview-text').placeholder = mention ? 'Texto da menção — opcional' : 'Quanto custa o produto?';
}
$('#assistant-preview-kind').addEventListener('change', updateAssistantPreviewKind);
$('#clear-assistant-preview').addEventListener('click', () => { if (assistantPreviewBusy) return; assistantPreviewHistory = []; renderAssistantPreview(); $('#assistant-preview-feedback').hidden = true; });
$('#assistant-preview-form').addEventListener('submit', async event => {
  event.preventDefault(); if (assistantPreviewBusy) return;
  const scope = accountScope();
  const text = $('#assistant-preview-text').value.trim(); const kind = $('#assistant-preview-kind').value;
  if (!['message', 'story_reply', 'story_mention'].includes(kind) || (!text && kind !== 'story_mention') || new TextEncoder().encode(text).length > 1000) { $('#assistant-preview-feedback').hidden = true; fieldError('#assistant-preview-text', text ? 'A mensagem de teste passou do limite de tamanho.' : 'Escreva uma mensagem de teste.'); return; }
  clearFieldError($('#assistant-preview-text'));
  const history = assistantPreviewHistory.filter(entry => entry.direction !== 'system' && !entry.placeholder).slice(-20).map(({ direction, text }) => ({ direction, text }));
  assistantPreviewBusy = true; setButtonBusy($('#send-assistant-preview'), true, 'Testando…'); $('#clear-assistant-preview').disabled = true; assistantPreviewHistory.push({ direction: 'inbound', text, ...(kind === 'story_mention' && !text ? { placeholder: true } : {}) }); renderAssistantPreview(); showFeedback('#assistant-preview-feedback', 'Testando com o catálogo salvo…', 'progress');
  try {
    const result = await apiWrite('/api/assistant/preview', { text, history, kind }, scope); assertScope(scope);
    if (result.mode !== 'simulation' || !['reply', 'handoff', 'optout', 'ignore'].includes(result.action)) throw new Error('invalid-preview');
    if (typeof result.text === 'string' && result.text) assistantPreviewHistory.push({ direction: 'outbound', text: result.text });
    const outcomes = { reply: 'Resposta sugerida pelo atendimento de teste.', handoff: 'Atendimento humano sugerido. O assistente respeitou um limite da resposta.', optout: 'Pedido para parar reconhecido no teste. Nenhuma alteração foi feita na Inbox.', ignore: 'Interação sem resposta neste teste.' };
    const handoffReasons = { PRICE_NOT_CONFIRMED: 'Preço não cadastrado. Atendimento humano sugerido.', FACT_NOT_CONFIRMED: 'O catálogo não confirma essa informação. Atendimento humano sugerido.', CATALOG_EMPTY: 'Cadastre seus produtos antes de testar.' };
    const outcome = result.action === 'handoff' && Object.hasOwn(handoffReasons, result.reason) ? handoffReasons[result.reason] : outcomes[result.action];
    assistantPreviewHistory.push({ direction: 'system', text: outcome }); $('#assistant-preview-text').value = ''; renderAssistantPreview(); showFeedback('#assistant-preview-feedback', 'Teste concluído. Simulação apenas; nenhuma DM foi enviada.', 'success');
  } catch { if (currentScope(scope)) showFeedback('#assistant-preview-feedback', 'O teste não pôde ser concluído. Confira o catálogo e a configuração do serviço. Nenhuma DM foi enviada.', 'error'); }
  finally { setButtonBusy($('#send-assistant-preview'), false); if (currentScope(scope)) { assistantPreviewBusy = false; $('#send-assistant-preview').disabled = false; $('#clear-assistant-preview').disabled = false; } }
});
$('#assistant-preview-text').addEventListener('input', event => clearFieldError(event.target));

renderNetwork(); renderForm(); renderRecovery(); renderSimulation(); renderInboxList(); renderCatalog(); renderAssistantConfig(); renderProvider(); resetCampaignEditor(); renderCampaignList(); updateAssistantPreviewKind(); renderAssistantPreview(); renderAccounts(); renderPublishing(); route(); loadAccounts();
