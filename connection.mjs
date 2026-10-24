import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { GraphClient, SendLedger, refreshInstagramToken } from './integrations/meta.mjs';
import { parseLegacyRecovery, validLegacy } from './owner-config.mjs';

const MAX_BODY = 12 * 1024;
const MAX_CONNECTION_FILE = 24 * 1024;
const NONCE_TTL = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const REFRESH_STATES = new Set(['waiting', 'scheduled', 'retrying', 'reauthorization_required']);
const REFRESH_CODES = new Set(['TOKEN_EXPIRED', 'TOKEN_REJECTED', 'REFRESH_REJECTED', 'IDENTITY_UNVERIFIED', 'WRONG_ACCOUNT', 'NETWORK_ERROR', 'NETWORK_TIMEOUT', 'TOKEN_RESPONSE_INVALID']);
const errors = {
  ACCESS_DENIED: [403, 'A conexão só pode ser configurada nesta página local.'],
  CSRF_INVALID: [403, 'Esta tentativa expirou. Reabra a conexão e tente novamente.'],
  INVALID_BODY: [400, 'Informe um token de acesso e uma versão de API válidos.'],
  BODY_TOO_LARGE: [413, 'O conteúdo informado excede o limite permitido.'],
  WRONG_ACCOUNT: [422, 'O token precisa pertencer à conta selecionada.'],
  IDENTITY_UNVERIFIED: [422, 'Não foi possível confirmar a identidade da conta.'],
  TOKEN_VALIDATION_FAILED: [422, 'Não foi possível validar o token na Meta. Confira a autorização oficial.'],
  PRIVATE_STORE_FAILED: [500, 'Não foi possível salvar a conexão no armazenamento privado.'],
  CONNECTION_REQUIRED: [404, 'Valide um token oficial antes de verificar os acessos.'],
  PRIVATE_STORE_INVALID: [400, 'A conexão salva precisa ser validada novamente pelo formulário.'],
  RECOVERY_INVALID: [400, 'O registro de recuperação não corresponde à publicação configurada.'],
  PREFLIGHT_REQUIRED: [409, 'Verifique os acessos e a proteção dos comentários já atendidos antes de ativar.'],
  INVALID_MESSAGE: [400, 'A primeira DM precisa conter os links obrigatórios e até 1000 bytes de texto.'],
  AUTOMATION_UNAVAILABLE: [503, 'O serviço de envio automático ainda não está pronto.'],
  AUTOMATION_START_FAILED: [422, 'A ativação foi bloqueada. Verifique os acessos e o registro de proteção.'],
  BUSY: [409, 'Já existe uma validação em andamento. Aguarde e tente novamente.'],
  INTERNAL_ERROR: [500, 'Não foi possível concluir a conexão.'],
};

class ConnectionError extends Error {
  constructor(code) { super(errors[code][1]); this.code = code; }
}
function isWithin(directory, root) {
  const relative = path.relative(root, directory);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function safeEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function initialRefresh(now) {
  return { state: 'waiting', firstSeenAt: now, expiresAt: null, nextAttemptAt: now + DAY, lastAttemptAt: null, lastSuccessAt: null, code: null };
}
function validRefresh(value) {
  return value && REFRESH_STATES.has(value.state) && Number.isSafeInteger(value.firstSeenAt) && value.firstSeenAt >= 0 && value.firstSeenAt <= 8.64e15 &&
    ['expiresAt', 'nextAttemptAt', 'lastAttemptAt', 'lastSuccessAt'].every(key => value[key] === null || Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 8.64e15) &&
    (value.code === null || REFRESH_CODES.has(value.code));
}
function publicRefresh(value) {
  const date = key => value[key] === null ? null : new Date(value[key]).toISOString();
  return { state: value.state, expiresAt: date('expiresAt'), nextAttemptAt: date('nextAttemptAt'), lastAttemptAt: date('lastAttemptAt'), lastSuccessAt: date('lastSuccessAt'), code: value.code,
    action: value.state === 'reauthorization_required' ? 'reconnect' : value.state === 'retrying' ? 'automatic_retry' : 'none' };
}

// Import/constructor perform no I/O. Credentials are read by protected connection
// operations or the server's approved messaging worker; status never reads them.
export class ConnectionService {
  #privateDirectory;
  #servedRoot;
  #inspect;
  #clock;
  #expectedUsername;
  #expectedUserId;
  #legacy;
  #fetch;
  #preflight = null;
  #automation = null;
  #busy = false;
  #status = { connected: false, identity: null, checkedAt: null, permissionsVerified: false };

  // legacy is null, or the owner's legacy config plus its private `recovery` record.
  constructor({ privateDirectory, servedRoot, inspectToken, fetchImpl = globalThis.fetch, clock = Date.now, expectedUsername, expectedUserId, legacy = null }) {
    if (!path.isAbsolute(privateDirectory) || !path.isAbsolute(servedRoot) || isWithin(privateDirectory, servedRoot) || typeof inspectToken !== 'function') throw new ConnectionError('PRIVATE_STORE_FAILED');
    if (typeof expectedUsername !== 'string' || !/^[a-z0-9_.]{1,30}$/.test(expectedUsername) || typeof expectedUserId !== 'string' || !/^\d{1,40}$/.test(expectedUserId)) throw new ConnectionError('IDENTITY_UNVERIFIED');
    if (legacy !== null) {
      const { recovery, ...config } = legacy ?? {};
      if (!validLegacy(config) || recovery === null || typeof recovery !== 'object') throw new ConnectionError('RECOVERY_INVALID');
    }
    this.#privateDirectory = path.resolve(privateDirectory);
    this.#servedRoot = path.resolve(servedRoot);
    this.#inspect = inspectToken;
    this.#clock = clock;
    this.#expectedUsername = expectedUsername;
    this.#expectedUserId = expectedUserId;
    this.#legacy = legacy;
    this.#fetch = fetchImpl;
  }

  status() {
    const status = structuredClone(this.#status);
    if (this.#automation) status.automation = this.#automation.status();
    return status;
  }

  async #directory(directory) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      const actual = await realpath(directory);
      const served = await realpath(this.#servedRoot);
      if (isWithin(actual, served)) throw new Error();
      await chmod(directory, 0o700);
    } catch { throw new ConnectionError('PRIVATE_STORE_FAILED'); }
  }

  async #persist(record, basename = 'connection.json') {
    let temporary;
    try {
      await this.#directory(this.#privateDirectory);
      await this.#directory(path.join(this.#privateDirectory, 'ledger'));
      const destination = path.join(this.#privateDirectory, basename);
      try {
        const stat = await lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new ConnectionError('PRIVATE_STORE_FAILED');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      temporary = path.join(this.#privateDirectory, `.${basename}-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, destination);
      temporary = null;
    } catch {
      if (temporary) await unlink(temporary).catch(() => {});
      throw new ConnectionError('PRIVATE_STORE_FAILED');
    }
  }

  async #savedConnection() {
    let handle;
    try {
      const directory = await lstat(this.#privateDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700) throw new Error();
      if (isWithin(await realpath(this.#privateDirectory), await realpath(this.#servedRoot))) throw new Error();
      const filename = path.join(this.#privateDirectory, 'connection.json');
      const file = await lstat(filename);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_CONNECTION_FILE || (file.mode & 0o777) !== 0o600) throw new Error();
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const actual = await handle.stat();
      if (!actual.isFile() || actual.size > MAX_CONNECTION_FILE || (actual.mode & 0o777) !== 0o600) throw new Error();
      const record = JSON.parse(await handle.readFile('utf8'));
      if (record.schemaVersion !== 1 || typeof record.accessToken !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(record.accessToken) || typeof record.apiVersion !== 'string' || !/^v\d{1,3}\.0$/.test(record.apiVersion) || record.identity?.username?.toLowerCase() !== this.#expectedUsername || record.identity?.userId !== this.#expectedUserId) throw new Error();
      if (record.tokenRefresh !== undefined && !validRefresh(record.tokenRefresh)) throw new Error();
      if (record.pendingRefresh !== undefined && (typeof record.pendingRefresh?.accessToken !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(record.pendingRefresh.accessToken) ||
          !Number.isSafeInteger(record.pendingRefresh.issuedAt) || record.pendingRefresh.issuedAt < 0 || !Number.isSafeInteger(record.pendingRefresh.expiresAt) ||
          record.pendingRefresh.expiresAt <= record.pendingRefresh.issuedAt || record.pendingRefresh.expiresAt > record.pendingRefresh.issuedAt + 60 * DAY)) throw new Error();
      return record;
    } catch (error) {
      throw new ConnectionError(error.code === 'ENOENT' ? 'CONNECTION_REQUIRED' : 'PRIVATE_STORE_INVALID');
    } finally { await handle?.close(); }
  }

  #recovery() {
    try { return parseLegacyRecovery(this.#legacy.recovery, { account: this.#expectedUsername, legacy: this.#legacy }); }
    catch { throw new ConnectionError('RECOVERY_INVALID'); }
  }

  async verifyAccess(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ConnectionError('INVALID_BODY');
    if (this.#busy || this.#automation?.status().running) throw new ConnectionError('BUSY');
    this.#busy = true;
    this.#preflight = null;
    let saved;
    try {
      saved = await this.#savedConnection();
      let result;
      try { result = await this.#inspect({ accessToken: saved.accessToken, apiVersion: saved.apiVersion }); }
      catch { this.#status = { connected: false, identity: null, checkedAt: null, permissionsVerified: false, ...(saved.tokenRefresh ? { tokenRefresh: publicRefresh(saved.tokenRefresh) } : {}) }; throw new ConnectionError('TOKEN_VALIDATION_FAILED'); }
      if (result?.username?.toLowerCase() !== this.#expectedUsername || result.userId !== this.#expectedUserId) {
        this.#status = { connected: false, identity: null, checkedAt: null, permissionsVerified: false, ...(saved.tokenRefresh ? { tokenRefresh: publicRefresh(saved.tokenRefresh) } : {}) };
        throw new ConnectionError('WRONG_ACCOUNT');
      }
      const checkedAt = new Date(this.#clock()).toISOString();
      const identity = { username: result.username, userId: result.userId };
      await this.#persist({ ...saved, identity, checkedAt, permissionsVerified: result.permissionsVerified === true });
      this.#status = { connected: true, identity, checkedAt, permissionsVerified: result.permissionsVerified === true, ...(saved.tokenRefresh ? { tokenRefresh: publicRefresh(saved.tokenRefresh) } : {}) };
      if (!this.#legacy) {
        const ledger = new SendLedger({ directory: path.join(this.#privateDirectory, 'ledger'), clock: this.#clock });
        const client = new GraphClient({ accessToken: saved.accessToken, apiVersion: saved.apiVersion, accountId: identity.userId, ledger, fetchImpl: this.#fetch, clock: this.#clock });
        const reads = await Promise.allSettled([client.listMedia(identity.userId, { maxPages: 10, pageSize: 50 }), client.listConversations(identity.userId, { pageSize: 1 })]);
        const safeRead = result => result.status === 'fulfilled' ? { status: 'accepted', count: result.value.media?.length ?? result.value.count, truncated: result.value.truncated } : { status: 'blocked', code: /^[A-Z0-9_]{1,64}$/.test(result.reason?.code || '') ? result.reason.code : 'READ_FAILED' };
        this.#status.capabilities = { checkedAt, reads: { media: safeRead(reads[0]), conversations: safeRead(reads[1]) }, recovery: { expected: 0, protected: 0 }, legacyRecovery: false };
        await this.#persist({ schemaVersion: 1, accountId: identity.userId, capabilities: this.#status.capabilities }, 'capabilities.json');
        return this.status();
      }
      const recovery = this.#recovery();
      const ledger = new SendLedger({ directory: path.join(this.#privateDirectory, 'ledger'), clock: this.#clock });
      const client = new GraphClient({ accessToken: saved.accessToken, apiVersion: saved.apiVersion, accountId: identity.userId, ledger, fetchImpl: this.#fetch, clock: this.#clock });
      const capabilities = { checkedAt, reads: {}, recovery: { expected: recovery.sent.length, matched: 0, protected: 0, blocked: recovery.sent.length, excluded: recovery.excludedIds.size, unmatched: recovery.sent.length }, diagnosticComplete: false, futureOnlyReady: false, futureOnlyNote: null };
      const safeFailure = error => ({ status: 'blocked', code: ['GRAPH_REJECTED', 'NETWORK_TIMEOUT', 'NETWORK_ERROR', 'INVALID_GRAPH_RESPONSE', 'INVALID_PAGINATION'].includes(error?.code) ? error.code : 'READ_FAILED', ...(Number.isInteger(error?.graphCode) ? { graphCode: error.graphCode } : {}), ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) });
      const reads = await Promise.allSettled([
        client.listMedia(identity.userId, { maxPages: 10, pageSize: 50 }),
        client.listConversations(identity.userId, { pageSize: 1 }),
      ]);
      const mediaRead = reads[0];
      const conversationsRead = reads[1];
      capabilities.reads.media = mediaRead.status === 'fulfilled' ? { status: 'accepted', count: mediaRead.value.media.length, truncated: mediaRead.value.truncated } : safeFailure(mediaRead.reason);
      capabilities.reads.conversations = conversationsRead.status === 'fulfilled' ? { status: 'accepted', count: conversationsRead.value.count, truncated: conversationsRead.value.truncated } : safeFailure(conversationsRead.reason);
      let media = null;
      if (mediaRead.status === 'fulfilled') {
        const candidates = mediaRead.value.media.filter(item => item.shortcode === this.#legacy.shortcode);
        if (candidates.length === 1) media = candidates[0];
      }
      let apiComments = [];
      if (media) {
        try {
          const comments = await client.listComments(media.id, { maxPages: 10, pageSize: 50 });
          apiComments = comments.comments;
          capabilities.reads.comments = { status: 'accepted', count: apiComments.length, truncated: comments.truncated };
        } catch (error) { capabilities.reads.comments = safeFailure(error); }
      } else capabilities.reads.comments = { status: 'not_checked', code: 'REEL_NOT_CONFIRMED' };
      const reconciliation = recovery.sent.map(comment => {
        const api = apiComments.find(item => item.id === comment.commentId);
        const username = api?.username || api?.fromUsername;
        const matches = !recovery.excludedIds.has(comment.commentId) && api && !Object.hasOwn(api, 'parentId') && typeof username === 'string' && username.toLowerCase() === comment.username.toLowerCase() && (!api.username || !api.fromUsername || api.username.toLowerCase() === api.fromUsername.toLowerCase());
        return { commentId: comment.commentId, username: comment.username, ...(matches && typeof api.fromId === 'string' ? { fromId: api.fromId } : {}), state: matches ? 'matched' : 'blocked', reason: matches ? 'canonical_id_and_username_confirmed' : 'canonical_match_not_confirmed' };
      });
      const matched = reconciliation.filter(item => item.state === 'matched');
      capabilities.recovery.matched = matched.length;
      // The manual recovery is evidence for these exact IDs, independently of
      // API visibility. Importing never manufactures API acceptance or an author ID.
      if (media) await ledger.importHandledComments(identity.userId, recovery.sent.map(item => ({ commentId: item.commentId, status: 'sent', source: 'manual_recovery_ui_confirmed' })));
      for (const item of reconciliation) {
        const record = await ledger.get(identity.userId, 'private', item.commentId);
        item.protected = record?.outcome === 'external_handled' && record.status === 'sent';
        if (item.state === 'matched') {
          item.state = item.protected ? 'external_handled' : 'blocked';
          item.reason = item.protected ? 'manual_recovery_ui_confirmed' : 'existing_ledger_requires_review';
        }
      }
      capabilities.recovery.protected = reconciliation.filter(item => item.protected).length;
      capabilities.recovery.blocked = capabilities.recovery.expected - capabilities.recovery.protected;
      capabilities.recovery.unmatched = capabilities.recovery.expected - capabilities.recovery.matched;
      const completeReads = Object.values(capabilities.reads).every(read => read.status === 'accepted') && capabilities.reads.comments.truncated === false;
      capabilities.diagnosticComplete = completeReads && capabilities.recovery.blocked === 0 && capabilities.recovery.unmatched === 0;
      // An empty response cannot establish visibility for this known nonempty Reel.
      capabilities.futureOnlyReady = completeReads && apiComments.length > 0 && capabilities.recovery.blocked === 0;
      if (capabilities.futureOnlyReady && capabilities.recovery.unmatched) capabilities.futureOnlyNote = `Somente comentários futuros, sem recuperar os antigos. Os ${capabilities.recovery.expected} IDs históricos estão bloqueados. Um autor histórico sem ID canônico fica protegido pelo username registrado; essa proteção pode não reconhecê-lo após uma mudança de nome.`;
      await this.#persist({ schemaVersion: 1, accountId: identity.userId, mediaId: media?.id || null, capabilities, reconciliation }, 'capabilities.json');
      this.#status.capabilities = capabilities;
      if (capabilities.diagnosticComplete || capabilities.futureOnlyReady) this.#preflight = { checkedAt: this.#clock(), accountId: identity.userId, mediaId: media.id, diagnosticComplete: capabilities.diagnosticComplete, futureOnlyReady: capabilities.futureOnlyReady, futureOnlyNote: capabilities.futureOnlyNote, reconciledComments: reconciliation.map(({ commentId, username, fromId }) => ({ commentId, username, ...(fromId ? { fromId } : {}) })) };
      return this.status();
    } finally { if (saved) saved.accessToken = undefined; this.#busy = false; }
  }

  assertAutomationStart(body) {
    if (!this.#legacy) throw new ConnectionError('AUTOMATION_UNAVAILABLE');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.messageText !== 'string' || !body.messageText.trim() || Buffer.byteLength(body.messageText, 'utf8') > 1000 || !this.#legacy.requiredLinks.every(link => body.messageText.includes(link))) throw new ConnectionError('INVALID_MESSAGE');
    if (this.#busy || this.#automation?.status().running) throw new ConnectionError('BUSY');
    const preflight = this.#preflight;
    if (!this.#status.connected || !(this.#status.capabilities?.diagnosticComplete || this.#status.capabilities?.futureOnlyReady) || this.#status.capabilities.recovery.protected !== this.#legacy.protectedCount || !preflight || preflight.checkedAt > this.#clock() || this.#clock() - preflight.checkedAt > 15 * 60 * 1000) throw new ConnectionError('PREFLIGHT_REQUIRED');
  }

  async startAutomation(body) {
    this.assertAutomationStart(body);
    const preflight = this.#preflight;
    this.#busy = true;
    let saved;
    try {
      let engine;
      try { engine = await import('./automation.mjs'); }
      catch { throw new ConnectionError('AUTOMATION_UNAVAILABLE'); }
      saved = await this.#savedConnection();
      let identity;
      try { identity = await this.#inspect({ accessToken: saved.accessToken, apiVersion: saved.apiVersion }); }
      catch { throw new ConnectionError('TOKEN_VALIDATION_FAILED'); }
      if (identity?.userId !== this.#expectedUserId || identity?.username?.toLowerCase() !== this.#expectedUsername) throw new ConnectionError('WRONG_ACCOUNT');
      await this.#directory(path.join(this.#privateDirectory, 'contact-ledger'));
      const ledger = new SendLedger({ directory: path.join(this.#privateDirectory, 'ledger'), clock: this.#clock });
      const client = new GraphClient({ accessToken: saved.accessToken, accessTokenProvider: () => this.#currentAccessToken(), apiVersion: saved.apiVersion, accountId: identity.userId, ledger, fetchImpl: this.#fetch, clock: this.#clock });
      const contactLedger = new engine.CampaignContactLedger({ directory: path.join(this.#privateDirectory, 'contact-ledger') });
      const automation = new engine.LocalCommentAutomation({ client, ledger, contactLedger, accountId: identity.userId, accountUsername: identity.username, mediaId: preflight.mediaId, messageText: body.messageText, publicReplies: [], reconciledComments: preflight.reconciledComments, preflight: { ...preflight, protectedCount: this.#legacy.protectedCount }, clock: this.#clock, requireReconciled: true });
      this.#automation = automation;
      try {
        const started = await automation.start();
        if (started.running !== true) throw new ConnectionError('AUTOMATION_START_FAILED');
      } catch { if (automation.status().running) automation.stop(); throw new ConnectionError('AUTOMATION_START_FAILED'); }
      return this.status();
    } finally { if (saved) saved.accessToken = undefined; this.#busy = false; }
  }

  stopAutomation(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ConnectionError('INVALID_BODY');
    if (this.#busy) throw new ConnectionError('BUSY');
    this.#automation?.stop();
    return this.status();
  }

  async stopAutomationAndDrain(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new ConnectionError('INVALID_BODY');
    if (this.#busy) throw new ConnectionError('BUSY');
    const pending = this.#automation?.pollOnce();
    this.#automation?.stop();
    await pending;
    return this.status();
  }

  // Server-only protection for a campaign on the configured legacy Reel.
  campaignRecovery({accountId,mediaId}) {
    if (!this.#legacy) throw new ConnectionError('PREFLIGHT_REQUIRED');
    const preflight=this.#preflight;const expected=this.#legacy.protectedCount;
    if(accountId!==this.#expectedUserId||!preflight||preflight.accountId!==accountId||preflight.mediaId!==mediaId||
      !(this.#status.capabilities?.diagnosticComplete||this.#status.capabilities?.futureOnlyReady)||this.#status.capabilities.recovery.protected!==expected||
      preflight.checkedAt>this.#clock()||this.#clock()-preflight.checkedAt>15*60*1000)throw new ConnectionError('PREFLIGHT_REQUIRED');
    return {...structuredClone(preflight),protectedCount:expected};
  }

  async connect(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['accessToken', 'apiVersion'].includes(key)) || typeof body.accessToken !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(body.accessToken) || typeof body.apiVersion !== 'string' || !/^v\d{1,3}\.0$/.test(body.apiVersion)) throw new ConnectionError('INVALID_BODY');
    if (this.#busy || this.#automation?.status().running) throw new ConnectionError('BUSY');
    this.#busy = true;
    try {
      let result;
      try { result = await this.#inspect({ accessToken: body.accessToken, apiVersion: body.apiVersion }); }
      catch { throw new ConnectionError('TOKEN_VALIDATION_FAILED'); }
      if (!result || typeof result.username !== 'string' || !/^[\w.]{1,30}$/.test(result.username) || typeof result.userId !== 'string' || !/^\d{1,40}$/.test(result.userId)) throw new ConnectionError('IDENTITY_UNVERIFIED');
      if (result.username.toLowerCase() !== this.#expectedUsername || result.userId !== this.#expectedUserId) throw new ConnectionError('WRONG_ACCOUNT');
      const identity = { userId: result.userId, username: result.username };
      const checkedAt = new Date(this.#clock()).toISOString();
      const permissionsVerified = result.permissionsVerified === true;
      const tokenRefresh = initialRefresh(this.#clock());
      await this.#persist({ schemaVersion: 1, accessToken: body.accessToken, apiVersion: body.apiVersion, identity, checkedAt, permissionsVerified, tokenRefresh });
      this.#status = { connected: true, identity, checkedAt, permissionsVerified, tokenRefresh: publicRefresh(tokenRefresh) };
      this.#preflight = null;
      return this.status();
    } finally { this.#busy = false; }
  }

  // Called by the hosted worker. Imported tokens have unknown expiry until Meta confirms a refresh.
  async refreshIfDue() {
    if (this.#busy) return { state: 'busy', refreshed: false };
    this.#busy = true;
    let saved;
    let renewed;
    try {
      saved = await this.#savedConnection();
      const now = this.#clock();
      if (!saved.tokenRefresh) {
        saved.tokenRefresh = initialRefresh(now);
        await this.#persist(saved);
      }
      let refresh = saved.tokenRefresh;
      const expose = () => {
        this.#status.tokenRefresh = publicRefresh(refresh);
        return { ...this.#status.tokenRefresh, refreshed: false };
      };
      if (refresh.state === 'reauthorization_required') return expose();
      if ((saved.pendingRefresh?.expiresAt ?? refresh.expiresAt) !== null && (saved.pendingRefresh?.expiresAt ?? refresh.expiresAt) <= now) {
        refresh = { ...refresh, state: 'reauthorization_required', code: 'TOKEN_EXPIRED', nextAttemptAt: null };
        await this.#persist({ ...saved, tokenRefresh: refresh });
        return expose();
      }
      if (now < refresh.firstSeenAt + DAY || refresh.nextAttemptAt !== null && now < refresh.nextAttemptAt) return expose();
      // Persist the attempt before the request so a restart cannot repeatedly refresh a token younger than 24h.
      refresh = { ...refresh, state: 'retrying', lastAttemptAt: now, nextAttemptAt: now + DAY, code: null };
      await this.#persist({ ...saved, tokenRefresh: refresh });
      try {
        if (!saved.pendingRefresh) {
          const previous = await this.#inspect({ accessToken: saved.accessToken, apiVersion: saved.apiVersion });
          if (previous?.userId !== this.#expectedUserId || previous?.username?.toLowerCase() !== this.#expectedUsername) throw new ConnectionError('WRONG_ACCOUNT');
          renewed = await refreshInstagramToken({ accessToken: saved.accessToken, fetchImpl: this.#fetch });
          const issuedAt = this.#clock();
          // Keep an unverified replacement private and inactive if identity verification is interrupted.
          saved.pendingRefresh = { accessToken: renewed.accessToken, issuedAt, expiresAt: issuedAt + renewed.expiresIn * 1000 };
          await this.#persist({ ...saved, tokenRefresh: refresh });
        }
        const identity = await this.#inspect({ accessToken: saved.pendingRefresh.accessToken, apiVersion: saved.apiVersion });
        if (identity?.userId !== this.#expectedUserId || identity?.username?.toLowerCase() !== this.#expectedUsername) throw new ConnectionError('WRONG_ACCOUNT');
        const completedAt = this.#clock();
        const { pendingRefresh, ...active } = saved;
        const { expiresAt, issuedAt } = pendingRefresh;
        refresh = { state: 'scheduled', firstSeenAt: issuedAt, expiresAt, nextAttemptAt: Math.max(issuedAt + DAY, expiresAt - 7 * DAY), lastAttemptAt: now, lastSuccessAt: completedAt, code: null };
        await this.#persist({ ...active, accessToken: pendingRefresh.accessToken, checkedAt: new Date(completedAt).toISOString(), tokenRefresh: refresh });
        this.#status = { ...this.#status, connected: true, identity: saved.identity, checkedAt: new Date(completedAt).toISOString(), tokenRefresh: publicRefresh(refresh) };
        return { ...this.#status.tokenRefresh, refreshed: true };
      } catch (error) {
        if (error.code === 'PRIVATE_STORE_FAILED') throw error;
        const transient = ['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code) || error.isTransient === true || error.httpStatus === 429 || error.httpStatus >= 500;
        const code = error.code === 'WRONG_ACCOUNT' ? 'WRONG_ACCOUNT' : error.graphCode === 190 ? 'TOKEN_REJECTED' : error.code === 'GRAPH_REJECTED' ? 'REFRESH_REJECTED' : REFRESH_CODES.has(error.code) ? error.code : 'IDENTITY_UNVERIFIED';
        refresh = { ...refresh, state: transient ? 'retrying' : 'reauthorization_required', nextAttemptAt: transient ? now + DAY : null, code };
        await this.#persist({ ...saved, tokenRefresh: refresh });
        return expose();
      }
    } finally {
      if (saved) saved.accessToken = undefined;
      if (renewed) renewed.accessToken = undefined;
      this.#busy = false;
    }
  }

  async #currentAccessToken() {
    const saved = await this.#savedConnection();
    return saved.accessToken;
  }

  // Available only to the authenticated server. Neither this client nor the
  // stored credential is included in HTTP status responses.
  async messagingContext() {
    const saved = await this.#savedConnection();
    try {
      let identity;
      try{identity=await this.#inspect({accessToken:saved.accessToken,apiVersion:saved.apiVersion});}
      catch(error){
        if(error?.outcome==='none'&&['NETWORK_ERROR','NETWORK_TIMEOUT'].includes(error.code))throw error;
        this.#status={connected:false,identity:null,checkedAt:null,permissionsVerified:false,...(saved.tokenRefresh?{tokenRefresh:publicRefresh(saved.tokenRefresh)}:{})};this.#preflight=null;throw new ConnectionError('TOKEN_VALIDATION_FAILED');
      }
      if(identity?.userId!==this.#expectedUserId||identity?.username?.toLowerCase()!==this.#expectedUsername){this.#status={connected:false,identity:null,checkedAt:null,permissionsVerified:false,...(saved.tokenRefresh?{tokenRefresh:publicRefresh(saved.tokenRefresh)}:{})};this.#preflight=null;throw new ConnectionError('WRONG_ACCOUNT');}
      this.#status={...this.#status,connected:true,identity:{userId:identity.userId,username:identity.username},checkedAt:new Date(this.#clock()).toISOString(),permissionsVerified:identity.permissionsVerified===true,...(saved.tokenRefresh?{tokenRefresh:publicRefresh(saved.tokenRefresh)}:{})};
      const ledger = new SendLedger({directory:path.join(this.#privateDirectory,'ledger'),clock:this.#clock});
      const client = new GraphClient({accessToken:saved.accessToken,accessTokenProvider:()=>this.#currentAccessToken(),apiVersion:saved.apiVersion,accountId:identity.userId,ledger,fetchImpl:this.#fetch,clock:this.#clock});
      return {client,ledger,identity:{userId:identity.userId,username:identity.username}};
    } finally {saved.accessToken=undefined;}
  }
}

function sendJSON(response, status, object, extraHeaders = {}) {
  const cookies=extraHeaders['Set-Cookie'];const existing=response.getHeader('Set-Cookie');
  // Keep the connection nonce first for existing clients, alongside admin renewal.
  if(cookies&&existing)extraHeaders={...extraHeaders,'Set-Cookie':[...(Array.isArray(cookies)?cookies:[cookies]),...(Array.isArray(existing)?existing:[existing])]};
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  response.end(JSON.stringify(object));
}

async function readBody(request) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY) { request.resume(); throw new ConnectionError('BODY_TOO_LARGE'); }
  return new Promise((resolve, reject) => {
    let size = 0;
    let oversized = false;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { oversized = true; chunks.length = 0; }
      else if (!oversized) chunks.push(chunk);
    });
    request.on('end', () => {
      if (oversized) { reject(new ConnectionError('BODY_TOO_LARGE')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ConnectionError('INVALID_BODY')); }
    });
    request.on('error', () => reject(new ConnectionError('INVALID_BODY')));
    request.on('aborted', () => reject(new ConnectionError('INVALID_BODY')));
  });
}

// No CORS. Mutation requires an exact canonical Origin, JSON, one-use CSRF
// nonce and same-origin HttpOnly session cookie. Host and peer guard DNS rebinding.
export function createConnectionHandler({ service, origin, clock = Date.now, allowRemote = false }) {
  const expected = new URL(origin);
  if (allowRemote ? expected.protocol !== 'https:' : expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1') throw new ConnectionError('ACCESS_DENIED');
  const nonces = new Map();
  function guard(request, mutation) {
    const peer = request.socket.remoteAddress;
    if ((allowRemote ? request.benionAuthenticated !== true : !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(peer)) || request.headers.host !== expected.host) throw new ConnectionError('ACCESS_DENIED');
    const requestOrigin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if (request.headers['x-benion-request'] !== '1' || (requestOrigin !== undefined && requestOrigin !== origin) || (fetchSite !== undefined && fetchSite !== 'same-origin')) throw new ConnectionError('ACCESS_DENIED');
    if (mutation && (requestOrigin !== origin || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || ''))) throw new ConnectionError('ACCESS_DENIED');
    if (!mutation && requestOrigin === undefined && fetchSite !== 'same-origin') throw new ConnectionError('ACCESS_DENIED');
  }
  function cookieSession(request) {
    const entries = String(request.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith('benion_csrf='));
    return entries.length === 1 && /^benion_csrf=[a-f0-9]{64}$/.test(entries[0]) ? entries[0].slice('benion_csrf='.length) : null;
  }
  return async function handle(request, response) {
    let url;
    try { url = new URL(request.url, origin); }
    catch { sendJSON(response, 400, { error: 'INVALID_BODY', message: errors.INVALID_BODY[1] }); return true; }
    if (!url.pathname.startsWith('/api/connection')) return false;
    try {
      guard(request, request.method === 'POST');
      if (url.search) throw new ConnectionError('ACCESS_DENIED');
      if (request.method === 'GET' && url.pathname === '/api/connection/status') { sendJSON(response, 200, service.status()); return true; }
      if (request.method === 'GET' && url.pathname === '/api/connection/csrf') {
        for (const [nonce, record] of nonces) if (record.expiresAt <= clock()) nonces.delete(nonce);
        const session = cookieSession(request) || randomBytes(32).toString('hex');
        for (const [nonce, record] of nonces) if (record.session === session) nonces.delete(nonce);
        while (nonces.size >= 64) nonces.delete(nonces.keys().next().value);
        const nonce = randomBytes(32).toString('hex');
        nonces.set(nonce, { session, expiresAt: clock() + NONCE_TTL });
        sendJSON(response, 200, { nonce }, { 'Set-Cookie': `benion_csrf=${session}; HttpOnly; SameSite=Strict; Path=/api/connection; Max-Age=300${allowRemote ? '; Secure' : ''}` }); return true;
      }
      if (request.method === 'POST' && ['/api/connection', '/api/connection/verify', '/api/connection/start', '/api/connection/stop'].includes(url.pathname)) {
        const nonce = request.headers['x-benion-csrf'];
        const session = cookieSession(request);
        const record = typeof nonce === 'string' && /^[a-f0-9]{64}$/.test(nonce) ? nonces.get(nonce) : null;
        if (!record || record.expiresAt <= clock() || !safeEqual(session, record.session)) throw new ConnectionError('CSRF_INVALID');
        nonces.delete(nonce);
        const body = await readBody(request);
        try {
          const result = url.pathname === '/api/connection/verify' ? await service.verifyAccess(body)
            : url.pathname === '/api/connection/start' ? await service.startAutomation(body)
              : url.pathname === '/api/connection/stop' ? service.stopAutomation(body)
                : await service.connect(body);
          sendJSON(response, 200, result);
        }
        finally { if (body && typeof body === 'object') body.accessToken = undefined; }
        return true;
      }
      sendJSON(response, request.method === 'GET' || request.method === 'POST' ? 404 : 405, { error: 'UNAVAILABLE', message: 'Este endpoint não está disponível.' });
    } catch (error) {
      const code = error instanceof ConnectionError && Object.hasOwn(errors, error.code) ? error.code : 'INTERNAL_ERROR';
      sendJSON(response, errors[code][0], { error: code, message: errors[code][1] });
    }
    return true;
  };
}
