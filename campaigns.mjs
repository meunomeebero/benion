// Server-only campaign configuration. Construction/import perform no I/O or sends.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, chmod, lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AllReelsCommentAutomation, CampaignCommentLedger, CampaignContactLedger, CampaignSendBudget, LocalCommentAutomation, normalizeCampaignKeywords } from './automation.mjs';
import { SendLedger } from './integrations/meta.mjs';

// Reusable public reply templates. Scheduled Reels use them; other campaigns
// start with [] and only change through an explicit update.
export const DEFAULT_PUBLIC_REPLIES = Object.freeze([
  '🦀🧀 caranqueijo [raro] te enviou o link na dm',
  '🪳🍩 barata na rosquinha [comum] te enviou o link',
  '🍄🛹 cogumelo skatista [comum] te enviou o link na dm',
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const numeric = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const safeCode = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code || '') ? error.code : 'CAMPAIGN_OPERATION_FAILED';
const FIELDS = new Set(['name', 'scope', 'mediaId', 'messageText', 'keywords', 'publicReplies']);
const exactFields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const timestamp = value => value === null || Number.isSafeInteger(value) && value >= 0;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const code = value => value === null || typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value);

export class CampaignError extends Error {
  constructor(code, message) { super(message); this.name = 'CampaignError'; this.code = code; }
}
function fail(code, message) { throw new CampaignError(code, message); }
function hasLink(text) {
  return (text.match(/https:\/\/[^\s<>]+/gi) || []).some(value => {
    try {
      const url = new URL(value.replace(/[.,!?;:)}\]]+$/, ''));
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
    } catch { return false; }
  });
}
function configuration(body, previous = null) {
  if (!object(body) || Object.keys(body).some(key => !FIELDS.has(key))) fail('CAMPAIGN_CONFIG_INVALID', 'Revise os campos da campanha.');
  const value = { ...(previous || {}), ...body };
  const scope = Object.hasOwn(value, 'scope') ? value.scope : 'reel';
  if (!['reel', 'all_reels'].includes(scope) || (scope === 'all_reels' && value.mediaId != null)) {
    fail('CAMPAIGN_CONFIG_INVALID', 'Selecione um Reel ou todos os Reels da conta.');
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 ||
      (scope === 'reel' && !numeric(value.mediaId)) || typeof value.messageText !== 'string' || !value.messageText.trim() ||
      Buffer.byteLength(value.messageText, 'utf8') > 1000 || !hasLink(value.messageText)) {
    fail('CAMPAIGN_CONFIG_INVALID', 'Informe nome, Reel e uma mensagem de até 1000 bytes com um link HTTPS.');
  }
  let keywords;
  try { keywords = normalizeCampaignKeywords(value.keywords); }
  catch { fail('CAMPAIGN_KEYWORDS_INVALID', 'Use até 20 palavras ou frases, com até 60 caracteres cada.'); }
  const publicReplies = Object.hasOwn(value, 'publicReplies') ? value.publicReplies : [];
  if (!Array.isArray(publicReplies) || publicReplies.length > 3 || publicReplies.some(text =>
    typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))) {
    fail('CAMPAIGN_PUBLIC_REPLIES_INVALID', 'Use até três respostas públicas com texto de até 1000 bytes cada.');
  }
  return { name: value.name.trim(), scope, mediaId: scope === 'all_reels' ? null : value.mediaId, messageText: value.messageText.trim(), keywords,
    publicReplies: publicReplies.map(text => text.trim()) };
}
function reelMetadata(item) {
  if (!numeric(item?.id) || typeof item.shortcode !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.shortcode)) return null;
  let url;
  try { url = new URL(item.permalink); } catch { return null; }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || !['www.instagram.com', 'instagram.com'].includes(url.hostname) ||
      url.username || url.password || url.port || parts.length !== 2 || parts[0] !== 'reel' || parts[1] !== item.shortcode) return null;
  if (item.commentsCount !== undefined && (!Number.isSafeInteger(item.commentsCount) || item.commentsCount < 0)) return null;
  return { id: item.id, shortcode: item.shortcode, permalink: `${url.origin}/reel/${item.shortcode}/`, mediaType: 'REELS',
    ...(item.commentsCount !== undefined ? { commentsCount: item.commentsCount } : {}) };
}
function emptyStatus(state = 'disabled', reviewReason = null) {
  return { running: false, state, reviewReason, lastCheckAt: null, nextCheckAt: null,
    baselineCount: 0, acceptedCount: 0, unknownCount: 0, rejectedCount: 0,
    skippedCount: 0, publicAcceptedCount: 0, records: [] };
}
function validStatus(status) {
  const counters = ['baselineCount', 'acceptedCount', 'unknownCount', 'rejectedCount', 'skippedCount', 'publicAcceptedCount'];
  if (!exactFields(status, ['running', 'state', 'reviewReason', 'lastCheckAt', 'nextCheckAt', 'activatedAt', 'resumeCutoff', 'monitoredReelCount', ...counters, 'records']) ||
      typeof status.running !== 'boolean' || !['disabled', 'starting', 'running', 'stopped', 'review'].includes(status.state) ||
      status.running !== (status.state === 'running') || !code(status.reviewReason) ||
      !timestamp(status.lastCheckAt) || !timestamp(status.nextCheckAt) || !counters.every(key => counter(status[key])) ||
      !Array.isArray(status.records) || status.records.length > 100) return false;
  if ((Object.hasOwn(status, 'activatedAt') && !timestamp(status.activatedAt)) ||
      (Object.hasOwn(status, 'resumeCutoff') && (!timestamp(status.resumeCutoff) || status.resumeCutoff === null)) ||
      (Object.hasOwn(status, 'monitoredReelCount') && !counter(status.monitoredReelCount))) return false;
  return status.records.every(record => exactFields(record, ['at', 'kind', 'commentId', 'username', 'messageId', 'recipientId', 'commentReplyId', 'code']) &&
    typeof record.at === 'string' && Number.isFinite(Date.parse(record.at)) &&
    ['accepted', 'unknown', 'rejected', 'blocked', 'review', 'read_retry', 'public_accepted', 'public_error'].includes(record.kind) &&
    ['commentId', 'recipientId', 'commentReplyId'].every(key => record[key] === undefined || numeric(record[key])) &&
    (record.username === undefined || typeof record.username === 'string' && /^[a-zA-Z0-9._]{1,30}$/.test(record.username)) &&
    (record.messageId === undefined || typeof record.messageId === 'string' && record.messageId.length > 0 && record.messageId.length <= 512 && !/[\x00-\x1f]/.test(record.messageId)) &&
    (record.code === undefined || code(record.code)));
}
function validateState(state, accountId) {
  if (!exactFields(state, ['version', 'accountId', 'campaigns']) || state.version !== 1 || state.accountId !== accountId || !Array.isArray(state.campaigns) || state.campaigns.length > 100) return false;
  const ids = new Set();
  for (const row of state.campaigns) {
    try {
      const scope = Object.hasOwn(row, 'scope') ? row.scope : 'reel';
      if (!exactFields(row, ['id', 'name', 'scope', 'mediaId', 'messageText', 'keywords', 'publicReplies', 'reel', 'createdAt', 'updatedAt', 'status', 'enabled', 'fromPublication']) ||
          (row.fromPublication !== undefined && row.fromPublication !== true) ||
          (Object.hasOwn(row, 'enabled') && typeof row.enabled !== 'boolean') ||
          !UUID.test(row.id || '') || ids.has(row.id) ||
          (scope === 'all_reels' ? row.reel !== null || row.mediaId !== null :
            !exactFields(row.reel, ['id', 'shortcode', 'permalink', 'mediaType', 'commentsCount']) || !reelMetadata(row.reel) || row.reel.id !== row.mediaId) ||
          !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt)) ||
          !validStatus(row.status)) return false;
      configuration({ name: row.name, scope, mediaId: row.mediaId, messageText: row.messageText, keywords: row.keywords,
        ...(Object.hasOwn(row, 'publicReplies') ? { publicReplies: row.publicReplies } : {}) });
      ids.add(row.id);
    } catch { return false; }
  }
  return true;
}

export class CampaignService {
  #directory; #filename; #clientProvider; #recoveryProvider; #clock; #accountId; #accountUsername; #legacy;
  #controlQueue = Promise.resolve(); #storeQueue = Promise.resolve();
  #engines = new Map(); #activeId = null; #closing = false; #restorePromise = null;
  #sendBudget;
  #publicSendBudget;
  #mediaEligibility;

  // legacy: { mediaId, shortcode, protectedCount } of the one Reel whose manual
  // recovery must be reverified before any automation, or null.
  constructor({ dataDir, clientProvider, recoveryProvider = null, clock = Date.now, accountId, accountUsername, legacy = null, mediaEligibility = async () => true } = {}) {
    if (!numeric(accountId) || typeof accountUsername !== 'string' || !/^[a-z0-9_.]{1,30}$/.test(accountUsername) || typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof clientProvider !== 'function' ||
        (recoveryProvider !== null && typeof recoveryProvider !== 'function') || typeof clock !== 'function' ||
        (legacy !== null && (!numeric(legacy?.mediaId) || typeof legacy.shortcode !== 'string' || !legacy.shortcode ||
          !Number.isSafeInteger(legacy.protectedCount) || legacy.protectedCount < 1))) {
      fail('CAMPAIGN_SERVICE_INVALID', 'Configure o diretório privado e o provedor autenticado da conta.');
    }
    this.#directory = path.resolve(dataDir); this.#filename = path.join(this.#directory, 'campaigns.json');
    this.#clientProvider = clientProvider; this.#recoveryProvider = recoveryProvider; this.#clock = clock; this.#accountId = accountId; this.#accountUsername = accountUsername;
    this.#legacy = legacy && { mediaId: legacy.mediaId, shortcode: legacy.shortcode, protectedCount: legacy.protectedCount };
    this.#sendBudget = new CampaignSendBudget({ clock });
    this.#publicSendBudget = new CampaignSendBudget({ clock });
    this.#mediaEligibility = mediaEligibility;
  }
  #isLegacy(reel) {
    return this.#legacy !== null && reel != null && (reel.id === this.#legacy.mediaId || reel.shortcode === this.#legacy.shortcode);
  }
  #serial(work, allowClosing = false) {
    const result = this.#controlQueue.then(() => {
      if (this.#closing && !allowClosing) fail('CAMPAIGN_SERVICE_STOPPED', 'O servidor está encerrando as campanhas.');
      return work();
    });
    this.#controlQueue = result.catch(() => {}); return result;
  }
  async #read() {
    let handle;
    try {
      const directory = await lstat(this.#directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077) fail('CAMPAIGN_STORE_INVALID', 'O diretório privado precisa de revisão.');
      handle = await open(this.#filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1_000_000 || stat.mode & 0o077) fail('CAMPAIGN_STORE_INVALID', 'O arquivo de campanhas precisa de revisão.');
      const state = JSON.parse(await handle.readFile('utf8'));
      if (!validateState(state, this.#accountId)) fail('CAMPAIGN_STORE_INVALID', 'O registro de campanhas precisa de revisão.');
      // Upgrade version-1 rows in memory; the next explicit write persists the empty list.
      for (const row of state.campaigns) {
        if (!Object.hasOwn(row, 'publicReplies')) row.publicReplies = [];
        if (!Object.hasOwn(row, 'scope')) row.scope = 'reel';
        if (!Object.hasOwn(row, 'enabled')) row.enabled = row.status.running;
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, accountId: this.#accountId, campaigns: [] };
      if (error instanceof CampaignError) throw error;
      fail('CAMPAIGN_STORE_UNREADABLE', 'Não foi possível ler as campanhas privadas.');
    } finally { await handle?.close(); }
  }
  #edit(mutate) {
    const work = async () => {
      let lock; let temporary; let owned = false;
      const lockFile = `${this.#filename}.lock`;
      try {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const directory = await lstat(this.#directory);
        if (!directory.isDirectory() || directory.isSymbolicLink()) fail('CAMPAIGN_STORE_INVALID', 'O diretório privado precisa de revisão.');
        await chmod(this.#directory, 0o700);
        try { lock = await open(lockFile, 'wx', 0o600); owned = true; }
        catch (error) { if (error.code === 'EEXIST') fail('CAMPAIGN_STORE_BUSY', 'Uma gravação de campanhas precisa terminar ou ser revisada.'); throw error; }
        const state = await this.#read();
        const result = await mutate(state);
        if (!validateState(state, this.#accountId)) fail('CAMPAIGN_STORE_INVALID', 'A atualização das campanhas é inválida.');
        const encoded = JSON.stringify(state);
        if (Buffer.byteLength(encoded) > 1_000_000) fail('CAMPAIGN_STORE_FULL', 'O registro de campanhas atingiu o limite.');
        temporary = `${this.#filename}.${randomUUID()}.tmp`;
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.#filename); temporary = null;
        return clone(result);
      } catch (error) {
        if (error instanceof CampaignError) throw error;
        fail('CAMPAIGN_STORE_UNWRITABLE', 'Não foi possível salvar as campanhas privadas.');
      } finally {
        await lock?.close();
        if (temporary) await unlink(temporary).catch(() => {});
        if (owned) await unlink(lockFile).catch(() => {});
      }
    };
    const result = this.#storeQueue.then(work); this.#storeQueue = result.catch(() => {}); return result;
  }
  #row(state, id) {
    if (!UUID.test(id || '')) fail('CAMPAIGN_NOT_FOUND', 'Campanha não encontrada.');
    const row = state.campaigns.find(item => item.id === id);
    if (!row) fail('CAMPAIGN_NOT_FOUND', 'Campanha não encontrada.');
    return row;
  }
  #dto(row) {
    const status = clone(this.#engines.get(row.id)?.status() || row.status);
    if (status.state === 'review' && row.status.resumeCutoff !== undefined) status.resumeCutoff = row.status.resumeCutoff;
    if (!this.#engines.has(row.id) && status.running) {
      status.running = false; status.state = 'stopped'; status.nextCheckAt = null; status.reviewReason = 'PROCESS_RESTARTED';
    }
    return { id: row.id, name: row.name, scope: row.scope ?? 'reel', mediaId: row.mediaId, messageText: row.messageText, keywords: clone(row.keywords), publicReplies: clone(row.publicReplies),
      reel: row.reel === null ? null : reelMetadata(row.reel), createdAt: row.createdAt, updatedAt: row.updatedAt,
      shortcode: row.reel?.shortcode ?? null, requiresRecovery: this.#isLegacy(row.reel), status,
      enabled: row.enabled, running: status.running, state: status.state, reviewReason: status.reviewReason, fromPublication: row.fromPublication === true };
  }
  async #context() {
    const context = await this.#clientProvider();
    if (context?.identity?.userId !== this.#accountId || context.identity.username?.toLowerCase() !== this.#accountUsername) fail('WRONG_ACCOUNT', 'O acesso precisa pertencer à conta selecionada.');
    if (typeof context.client?.listMedia !== 'function' || typeof context.client?.listComments !== 'function' ||
        typeof context.client?.sendPrivateReply !== 'function' || typeof context.ledger?.get !== 'function') fail('CAMPAIGN_CLIENT_UNAVAILABLE', 'O acesso da conta precisa de configuração.');
    return context;
  }
  async #owned(context) {
    const result = await context.client.listMedia(this.#accountId, { pageSize: 50, maxPages: 10 });
    if (!Array.isArray(result?.media) || typeof result.truncated !== 'boolean' || result.media.length > 500) fail('OWNERSHIP_UNVERIFIED', 'A lista de Reels precisa de revisão.');
    const media = result.media.map(reelMetadata).filter(Boolean);
    if (new Set(media.map(row => row.id)).size !== media.length) fail('OWNERSHIP_UNVERIFIED', 'A lista de Reels precisa de revisão.');
    return { media, truncated: result.truncated };
  }
  async #confirmedReel(context, mediaId) {
    const owned = await this.#owned(context);
    const reel = owned.media.find(row => row.id === mediaId);
    if (!reel) fail('OWNERSHIP_UNVERIFIED', 'Selecione um Reel retornado pela API desta conta.');
    return reel;
  }
  async #completeOwned(context) {
    const owned = await this.#owned(context);
    if (owned.truncated) fail('MEDIA_SNAPSHOT_INCOMPLETE', 'A lista completa de Reels precisa de revisão.');
    return null;
  }
  async listMedia() {
    try {
      const context = await this.#context(); const owned = await this.#owned(context);
      return { ...owned, available: true, account: { userId: this.#accountId, username: this.#accountUsername } };
    } catch (error) { return { media: [], truncated: false, available: false, account: null, reason: safeCode(error) }; }
  }
  async list() {
    const state = await this.#read();
    const campaigns = state.campaigns.map(row => this.#dto(row));
    return { campaigns, runningCampaignId: campaigns.find(row => row.status.running)?.id || null };
  }
  async status(id) { return this.#dto(this.#row(await this.#read(), id)); }
  async mediaMetrics(mediaId) {
    if (!numeric(mediaId)) fail('INVALID_MEDIA_ID', 'Reel inválido.');
    const contacts = new CampaignContactLedger({ directory: path.join(this.#directory, 'contact-ledger'), clock: this.#clock });
    const ledger = new SendLedger({ directory: path.join(this.#directory, 'ledger'), clock: this.#clock });
    const intents = await contacts.listPublicReplies(this.#accountId, mediaId);
    const counts = { accepted: 0, unknown: 0, rejected: 0, publicAccepted: 0 };
    for (const intent of intents) {
      const record = await ledger.get(this.#accountId, 'private', intent.commentId);
      if (record?.status === 'sent' && record.outcome === 'accepted') counts.accepted++;
      if (['unknown', 'inflight'].includes(record?.status)) counts.unknown++;
      if (record?.status === 'rejected') counts.rejected++;
      const reply = await ledger.get(this.#accountId, 'public', intent.commentId);
      if (reply?.status === 'sent' && reply.outcome === 'accepted') counts.publicAccepted++;
    }
    return counts;
  }
  async createFromPublication({ id, mediaId, name, messageText, cutoff }) {
    await this.#serial(async () => {
      if (!UUID.test(id || '') || !Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > this.#clock()) fail('PUBLICATION_INVALID', 'Publicação inválida.');
      const state = await this.#read(); const existing = state.campaigns.find(row => row.id === id);
      if (existing) { if (!existing.fromPublication || existing.mediaId !== mediaId) fail('PUBLICATION_CONFLICT', 'Revise o Reel associado.'); return; }
      const values = configuration({ name, mediaId, scope: 'reel', messageText, keywords: [], publicReplies: [...DEFAULT_PUBLIC_REPLIES] });
      const reel = await this.#confirmedReel(await this.#context(), mediaId);
      const now = new Date(this.#clock()).toISOString();
      await this.#edit(current => {
        if (current.campaigns.length >= 100) fail('CAMPAIGN_LIMIT_REACHED', 'O limite de automações foi atingido.');
        current.campaigns.push({ id, ...values, enabled: true, fromPublication: true, reel, createdAt: now, updatedAt: now,
          status: { ...emptyStatus(), resumeCutoff: cutoff } }); return null;
      });
    });
    return this.start(id, { resume: true });
  }
  create(body) {
    return this.#serial(async () => {
      const { id = randomUUID(), ...input } = body || {};
      if (!UUID.test(id)) fail('CAMPAIGN_CONFIG_INVALID', 'Identificador inválido.');
      const values = configuration(input);
      const existing = (await this.#read()).campaigns.find(row => row.id === id);
      if (existing) {
        const previous = configuration(Object.fromEntries([...FIELDS].map(key => [key, key === 'publicReplies' ? existing[key] ?? [] : existing[key]])));
        if (existing.fromPublication || JSON.stringify(previous) !== JSON.stringify(values)) fail('CAMPAIGN_CONFLICT', 'O identificador já pertence a outra configuração.');
        return this.#dto(existing);
      }
      const reel = values.scope === 'all_reels' ? null : await this.#confirmedReel(await this.#context(), values.mediaId);
      const now = new Date(this.#clock()).toISOString();
      const row = { id, ...values, enabled: false, reel, createdAt: now, updatedAt: now, status: emptyStatus() };
      await this.#edit(state => { if (state.campaigns.length >= 100) fail('CAMPAIGN_LIMIT_REACHED', 'O limite de campanhas foi atingido.'); state.campaigns.push(row); return row; });
      return this.#dto(row);
    });
  }
  update(id, body) {
    return this.#serial(async () => {
      const previous = this.#row(await this.#read(), id);
      if (previous.fromPublication) fail('PUBLICATION_RULES_FIXED', 'Os Reels agendados usam a mensagem aprovada no agendamento e o joguinho fixo.');
      if (this.#engines.get(id)?.status().running) fail('CAMPAIGN_RUNNING', 'Pause a campanha antes de alterá-la.');
      const values = configuration(body, previous);
      const reel = values.scope === 'all_reels' ? null : await this.#confirmedReel(await this.#context(), values.mediaId);
      const previousCutoff = previous.status.activatedAt !== null && timestamp(previous.status.activatedAt) ? previous.status.activatedAt :
        previous.status.resumeCutoff !== null && timestamp(previous.status.resumeCutoff) ? previous.status.resumeCutoff : null;
      const copyOnly = Object.keys(body).length > 0 && Object.keys(body).every(key => key === 'messageText' || key === 'publicReplies');
      const resumeCutoff = previous.scope === 'all_reels' && copyOnly ? previousCutoff : null;
      const row = await this.#edit(state => {
        const target = this.#row(state, id);
        Object.assign(target, values, { enabled: false, reel, updatedAt: new Date(this.#clock()).toISOString(),
          status: { ...emptyStatus(), ...(resumeCutoff !== null ? { resumeCutoff } : {}) } });
        return target;
      });
      this.#engines.delete(id); return this.#dto(row);
    });
  }
  async #saveStatus(id, engine) {
    if (this.#engines.get(id) !== engine) return;
    await this.#edit(state => {
      const row = this.#row(state, id); const status = engine.status();
      if (row.status.resumeCutoff !== undefined && status.state === 'review' && !status.running) status.resumeCutoff = row.status.resumeCutoff;
      row.status = status; return row;
    });
  }
  async #halt(id) {
    const engine = this.#engines.get(id);
    // Commit the manual pause before draining, so a crash cannot re-arm it.
    await this.#edit(state => { this.#row(state, id).enabled = false; return null; });
    if (engine) {
      // Capture an active poll before stop(), so an accepted in-flight send finishes
      // and is persisted before a different Reel can start.
      const drained = engine.pollOnce(); engine.stop({ preserveReview: true }); await drained;
      await this.#saveStatus(id, engine);
    }
    if (this.#activeId === id) this.#activeId = null;
  }
  async #enable(row) {
    // Different Reels may run together; overlapping scopes still drain first.
    const conflicts = (await this.#read()).campaigns.filter(item => item.id !== row.id &&
      (item.enabled || this.#engines.get(item.id)?.status().running) &&
      // Scheduled Reels override the general rule; they do not pause other Reels.
      !(row.fromPublication && item.scope === 'all_reels' || item.fromPublication && row.scope === 'all_reels') &&
      (row.scope === 'all_reels' || item.scope === 'all_reels' || item.mediaId === row.mediaId));
    for (const item of conflicts) await this.#halt(item.id);
    await this.#edit(state => { this.#row(state, row.id).enabled = true; return null; });
  }
  start(id, { resume = false } = {}) {
    return this.#serial(async () => {
      const row = this.#row(await this.#read(), id);
      if (resume && !row.enabled) return this.#dto(row);
      if (this.#engines.get(id)?.status().running) return this.#dto(row);
      const activationCutoff = row.status.resumeCutoff ??
        (resume || row.status.state === 'review' && ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(row.status.reviewReason) ? row.status.activatedAt ?? null : null);
      let engine;
      try {
        if (resume && activationCutoff === null) fail('RESUME_CUTOFF_MISSING', 'O corte original precisa de revisão antes da retomada.');
        const context = await this.#context();
        if (row.scope === 'all_reels') {
          await this.#completeOwned(context);
          if (this.#closing) fail('CAMPAIGN_SERVICE_STOPPED', 'O servidor está encerrando as campanhas.');
          await this.#enable(row);
          engine = new AllReelsCommentAutomation({ client: context.client, ledger: context.ledger, mediaEligibility: this.#mediaEligibility,
            commentLedger: new CampaignCommentLedger({ directory: path.join(this.#directory, 'comment-ledger'), clock: this.#clock }),
            contactLedger: new CampaignContactLedger({ directory: path.join(this.#directory, 'contact-ledger'), clock: this.#clock }),
            accountId: this.#accountId, accountUsername: this.#accountUsername, messageText: row.messageText,
            publicReplies: row.publicReplies, keywords: row.keywords, clock: this.#clock, scheduledPoll: () => this.pollOnce(id),
            sendBudget: this.#sendBudget, publicSendBudget: this.#publicSendBudget, activationCutoff });
          this.#engines.set(id, engine);
          await engine.start();
          if (this.#closing) fail('CAMPAIGN_SERVICE_STOPPED', 'O servidor está encerrando as campanhas.');
          await this.#saveStatus(id, engine);
          this.#activeId = engine.status().running ? id : null;
          return this.#dto(row);
        }
        const reel = await this.#confirmedReel(context, row.mediaId);
        let reconciledComments = [];
        let preflight = { diagnosticComplete: true, accountId: this.#accountId, mediaId: reel.id, protectedCount: 0, ownershipVerified: true,
          ...(reel.commentsCount !== undefined ? { commentsCount: reel.commentsCount } : {}) };
        const legacyReel = this.#isLegacy(reel);
        if (legacyReel) {
          const expected = this.#legacy.protectedCount;
          if (!this.#recoveryProvider) fail('PREFLIGHT_REQUIRED', 'Proteja os comentários já atendidos antes de ativar este Reel.');
          const recovery = await this.#recoveryProvider({ accountId: this.#accountId, mediaId: reel.id, ledger: context.ledger, client: context.client });
          if ((recovery?.diagnosticComplete !== true && recovery?.futureOnlyReady !== true) || recovery.accountId !== this.#accountId || recovery.mediaId !== reel.id ||
              recovery.protectedCount !== expected || !Array.isArray(recovery.reconciledComments) || recovery.reconciledComments.length !== expected ||
              !Number.isFinite(recovery.checkedAt) || recovery.checkedAt > this.#clock() || this.#clock() - recovery.checkedAt > 15 * 60000) {
            fail('PREFLIGHT_REQUIRED', 'Proteja os comentários já atendidos antes de ativar este Reel.');
          }
          reconciledComments = clone(recovery.reconciledComments); preflight = { ...preflight, ...recovery };
        }
        if (this.#closing) fail('CAMPAIGN_SERVICE_STOPPED', 'O servidor está encerrando as campanhas.');
        await this.#enable(row);
        const contacts = new CampaignContactLedger({ directory: path.join(this.#directory, 'contact-ledger'), clock: this.#clock });
        engine = new LocalCommentAutomation({ client: context.client, ledger: context.ledger, contactLedger: contacts,
          accountId: this.#accountId, accountUsername: this.#accountUsername, mediaId: reel.id,
          messageText: row.messageText, keywords: row.keywords, publicReplies: row.publicReplies, reconciledComments, preflight, clock: this.#clock,
          scheduledPoll: () => this.pollOnce(id), sendBudget: this.#sendBudget, activationCutoff, requireReconciled: legacyReel });
        this.#engines.set(id, engine);
        await engine.start();
        if (this.#closing) fail('CAMPAIGN_SERVICE_STOPPED', 'O servidor está encerrando as campanhas.');
        await this.#saveStatus(id, engine);
        this.#activeId = engine.status().running ? id : null;
        return this.#dto(row);
      } catch (error) {
        engine?.stop();
        this.#engines.delete(id);
        if (this.#activeId === id) this.#activeId = null;
        const code = safeCode(error);
        await this.#edit(state => {
          this.#row(state, id).status = { ...emptyStatus('review', code),
            ...(activationCutoff !== null ? { resumeCutoff: activationCutoff } : {}) };
          return null;
        });
        throw new CampaignError(code, 'A campanha não foi ativada. Confira os acessos e a proteção dos comentários.');
      }
    });
  }
  stop(id = null) {
    return this.#serial(async () => {
      if (!id) {
        for (const row of (await this.#read()).campaigns) {
          if (row.enabled || this.#engines.get(row.id)?.status().running) await this.#halt(row.id);
        }
        return this.list();
      }
      this.#row(await this.#read(), id);
      await this.#halt(id);
      await this.#edit(state => { const row = this.#row(state, id); row.enabled = false; if (!this.#engines.has(id)) row.status = emptyStatus('stopped'); return null; });
      return this.status(id);
    });
  }
  async pollOnce(id = null) {
    if (!id) {
      for (const [key, engine] of this.#engines) if (engine.status().running) await this.pollOnce(key);
      return this.list();
    }
    const engine = this.#engines.get(id);
    if (engine) {
      await engine.pollOnce();
      try { await this.#saveStatus(id, engine); }
      catch {
        engine.pauseForReview('CAMPAIGN_STATUS_PERSISTENCE_FAILED');
        throw new CampaignError('CAMPAIGN_STATUS_PERSISTENCE_FAILED', 'A campanha foi pausada porque o estado não pôde ser salvo. Revise o armazenamento antes de ativar.');
      }
    }
    return this.status(id);
  }
  restoreRunning() {
    if (this.#closing) return Promise.resolve(null);
    if (this.#restorePromise) return this.#restorePromise;
    this.#restorePromise = (async () => {
      const rows = (await this.#read()).campaigns.filter(row => row.enabled);
      for (const row of rows) {
        const status = this.#engines.get(row.id)?.status() || row.status;
        if (status.running && this.#engines.has(row.id)) continue;
        // Unknown POST outcomes, authentication and storage errors require review.
        if (status.state === 'review' && !['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(status.reviewReason)) continue;
        try { await this.start(row.id, { resume: true }); } catch {}
      }
      return this.list();
    })().finally(() => { this.#restorePromise = null; });
    return this.#restorePromise;
  }
  shutdown() {
    this.#closing = true;
    const drained = [...this.#engines.values()].map(engine => { const poll = engine.pollOnce(); engine.stop({ preserveReview: true }); return poll; });
    this.#activeId = null;
    return this.#serial(async () => {
      await Promise.all(drained);
      for (const [id, engine] of this.#engines) await this.#saveStatus(id, engine);
      return this.list();
    }, true);
  }
}
