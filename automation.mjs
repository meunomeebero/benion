import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const DAY = 86400000;
const CONTACT_STATES = new Set(['protected', 'inflight', 'accepted', 'unknown', 'rejected']);
const PUBLIC_INTENT_STATES = new Set(['pending', 'inflight', 'accepted', 'unknown', 'rejected', 'cancelled']);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const numericId = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const username = value => typeof value === 'string' && /^[a-zA-Z0-9._]{1,30}$/.test(value) ? value.toLowerCase() : null;
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'AUTOMATION_ERROR';
const retryableRead = error => error?.outcome === 'none' && ![10, 190, 200].includes(error.graphCode) &&
  (['NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(error.code) || error.httpStatus >= 500 || error.isTransient === true);

export class AutomationError extends Error {
  constructor(code, message) { super(message); this.name = 'AutomationError'; this.code = code; }
}

export function normalizeCampaignKeywords(values = []) {
  if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 60)) {
    throw new AutomationError('AUTOMATION_KEYWORDS_INVALID', 'Use até 20 palavras ou frases, com até 60 caracteres cada.');
  }
  return [...new Set(values.map(value => value.trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()))];
}

// One account/service shares this rolling private-send budget across its media
// and campaign switches. Public work retains its separate existing budget.
export class CampaignSendBudget {
  #clock; #attempts = [];
  constructor({ clock = Date.now } = {}) {
    if (typeof clock !== 'function') throw new AutomationError('AUTOMATION_LIMITS_INVALID', 'Configure o relógio da campanha.');
    this.#clock = clock;
  }
  available() {
    const now = this.#clock(); this.#attempts = this.#attempts.filter(at => now - at < 60000);
    return this.#attempts.length < 5;
  }
  take() {
    if (!this.available()) return false;
    this.#attempts.push(this.#clock()); return true;
  }
}

// Account/comment identity, deliberately independent of author aliases. A
// reserved or uncertain attempt is never expired or replayed automatically.
export class CampaignCommentLedger {
  #directory; #clock; #records = new Map();
  get persistent() { return this.#directory !== null; }
  constructor({ directory = null, clock = Date.now } = {}) {
    if (directory !== null && (typeof directory !== 'string' || !path.isAbsolute(directory))) throw new AutomationError('COMMENT_LEDGER_PATH_INVALID', 'Configure o diretório privado dos comentários.');
    if (typeof clock !== 'function') throw new AutomationError('AUTOMATION_LIMITS_INVALID', 'Configure o relógio da campanha.');
    this.#directory = directory; this.#clock = clock;
  }
  #key(accountId, commentId) {
    if (![accountId, commentId].every(numericId)) throw new AutomationError('COMMENT_IDENTITY_INVALID', 'Revise a identificação do comentário.');
    return createHash('sha256').update(JSON.stringify([accountId, commentId])).digest('hex');
  }
  #file(key) { return path.join(this.#directory, `${key}.json`); }
  #validate(record, accountId, commentId) {
    if (!record || record.version !== 1 || record.accountId !== accountId || record.commentId !== commentId ||
        !numericId(record.mediaId) || !CONTACT_STATES.has(record.status) || typeof record.attemptId !== 'string' ||
        !Number.isFinite(Date.parse(record.reservedAt))) throw new AutomationError('COMMENT_LEDGER_INVALID', 'O registro do comentário precisa de revisão.');
    return structuredClone(record);
  }
  async get(accountId, commentId) {
    const key = this.#key(accountId, commentId);
    if (!this.#directory) { const record = this.#records.get(key); return record ? this.#validate(record, accountId, commentId) : null; }
    let handle;
    try {
      handle = await open(this.#file(key), constants.O_RDONLY | constants.O_NOFOLLOW); const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192) throw new Error();
      return this.#validate(JSON.parse(await handle.readFile('utf8')), accountId, commentId);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof AutomationError) throw error;
      throw new AutomationError('COMMENT_LEDGER_UNREADABLE', 'Não foi possível verificar o comentário.');
    } finally { await handle?.close(); }
  }
  async #write(file, record) {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  }
  async reserve(accountId, mediaId, commentId) {
    if (!numericId(mediaId)) throw new AutomationError('COMMENT_IDENTITY_INVALID', 'Revise a identificação do Reel.');
    const key = this.#key(accountId, commentId);
    const record = { version: 1, accountId, mediaId, commentId, attemptId: randomUUID(), status: 'inflight', reservedAt: new Date(this.#clock()).toISOString() };
    if (!this.#directory) {
      if (this.#records.has(key)) throw new AutomationError('COMMENT_ALREADY_ATTEMPTED', 'O comentário já possui uma tentativa protegida.');
      this.#records.set(key, record);
    } else {
      try {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const directory = await lstat(this.#directory);
        if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077) throw new Error();
        await this.#write(this.#file(key), record);
      } catch (error) {
        if (error.code === 'EEXIST') throw new AutomationError('COMMENT_ALREADY_ATTEMPTED', 'O comentário já possui uma tentativa protegida.');
        throw new AutomationError('COMMENT_LEDGER_UNWRITABLE', 'Não foi possível proteger o comentário antes do envio.');
      }
    }
    return structuredClone(record);
  }
  async finish(reservation, status, result = {}) {
    if (!CONTACT_STATES.has(status) || status === 'inflight') throw new AutomationError('COMMENT_RESULT_INVALID', 'Revise o resultado da tentativa.');
    const existing = await this.get(reservation.accountId, reservation.commentId);
    if (!existing || existing.attemptId !== reservation.attemptId || existing.status !== 'inflight') throw new AutomationError('COMMENT_LEDGER_CONFLICT', 'O registro do comentário precisa de revisão.');
    const record = { ...existing, status, finishedAt: new Date(this.#clock()).toISOString() };
    for (const field of ['messageId', 'recipientId', 'errorCode']) if (result[field] !== undefined) record[field] = result[field];
    const key = this.#key(record.accountId, record.commentId);
    if (!this.#directory) this.#records.set(key, record);
    else {
      const temporary = `${this.#file(key)}.${record.attemptId}.tmp`;
      try { await this.#write(temporary, record); await rename(temporary, this.#file(key)); }
      catch { await unlink(temporary).catch(() => {}); throw new AutomationError('COMMENT_LEDGER_UNWRITABLE', 'O resultado não foi persistido; a tentativa permanece protegida.'); }
    }
  }
}

function aliases(person) {
  const values = [];
  if (numericId(person.fromId)) values.push(`id:${person.fromId}`);
  const name = username(person.username || person.fromUsername);
  if (name) values.push(`username:${name}`);
  if (!values.length) throw new AutomationError('AUTHOR_UNVERIFIED', 'O comentário não tem uma identidade pública confiável.');
  return values;
}

// Separate from the message ledger. Every alias is reserved before sending.
// Collisions, crashes and partial writes keep aliases blocked; no automatic expiry.
export class CampaignContactLedger {
  #directory;
  #records = new Map();
  #publicRecords = new Map();
  #clock;
  get persistent() { return this.#directory !== null; }

  constructor({ directory = null, clock = Date.now } = {}) {
    if (directory !== null && (typeof directory !== 'string' || !path.isAbsolute(directory))) {
      throw new AutomationError('CONTACT_LEDGER_PATH_INVALID', 'Configure um diretório privado absoluto para os contatos.');
    }
    this.#directory = directory;
    this.#clock = clock;
  }

  #key(accountId, mediaId, alias) {
    if (!numericId(accountId) || !numericId(mediaId) || !/^(id:\d{1,40}|username:[a-z0-9._]{1,30})$/.test(alias)) {
      throw new AutomationError('CONTACT_IDENTITY_INVALID', 'Identificação de contato inválida.');
    }
    return createHash('sha256').update(JSON.stringify([accountId, mediaId, alias])).digest('hex');
  }

  #file(key) { return path.join(this.#directory, `${key}.json`); }

  async #write(file, record) {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
  }

  async #get(accountId, mediaId, alias) {
    const key = this.#key(accountId, mediaId, alias);
    let record;
    if (!this.#directory) record = this.#records.get(key);
    else {
      try { record = JSON.parse(await readFile(this.#file(key), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new AutomationError('CONTACT_LEDGER_UNREADABLE', 'O registro de contato precisa de revisão.');
      }
    }
    if (!record) return null;
    if (record.version !== 1 || record.accountId !== accountId || record.mediaId !== mediaId ||
        record.alias !== alias || !CONTACT_STATES.has(record.status)) {
      throw new AutomationError('CONTACT_LEDGER_INVALID', 'O registro de contato precisa de revisão.');
    }
    return structuredClone(record);
  }

  async #create(record) {
    const key = this.#key(record.accountId, record.mediaId, record.alias);
    if (!this.#directory) {
      if (this.#records.has(key)) throw new AutomationError('CONTACT_ALREADY_PROTECTED', 'A pessoa já tem registro nesta campanha.');
      this.#records.set(key, record);
    } else {
      try {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        await this.#write(this.#file(key), record);
      } catch (error) {
        if (error.code === 'EEXIST') throw new AutomationError('CONTACT_ALREADY_PROTECTED', 'A pessoa já tem registro nesta campanha.');
        throw new AutomationError('CONTACT_LEDGER_UNWRITABLE', 'Não foi possível proteger o contato antes do envio.');
      }
    }
  }

  async protect(accountId, mediaId, person) {
    for (const alias of aliases(person)) {
      try {
        await this.#create({ version: 1, accountId, mediaId, alias, commentId: person.commentId,
          attemptId: randomUUID(), status: 'protected', reservedAt: new Date(this.#clock()).toISOString() });
      } catch (error) { if (error.code !== 'CONTACT_ALREADY_PROTECTED') throw error; }
    }
  }

  async reserve(accountId, mediaId, person) {
    const personAliases = aliases(person);
    for (const alias of personAliases) {
      if (await this.#get(accountId, mediaId, alias)) {
        throw new AutomationError('CONTACT_ALREADY_PROTECTED', 'A pessoa já tem registro nesta campanha.');
      }
    }
    const reservation = { accountId, mediaId, commentId: person.commentId, attemptId: randomUUID(), aliases: [] };
    for (const alias of personAliases) {
      await this.#create({ version: 1, accountId, mediaId, alias, commentId: person.commentId,
        attemptId: reservation.attemptId, status: 'inflight', reservedAt: new Date(this.#clock()).toISOString() });
      reservation.aliases.push(alias);
    }
    return reservation;
  }

  async finish(reservation, status, result = {}) {
    if (!CONTACT_STATES.has(status) || status === 'inflight') {
      throw new AutomationError('CONTACT_RESULT_INVALID', 'Resultado de contato inválido.');
    }
    for (const alias of reservation.aliases) {
      const { accountId, mediaId, attemptId } = reservation;
      const existing = await this.#get(accountId, mediaId, alias);
      if (!existing || existing.attemptId !== attemptId || existing.status !== 'inflight') {
        throw new AutomationError('CONTACT_LEDGER_CONFLICT', 'O registro de contato precisa de revisão.');
      }
      const record = { ...existing, status, finishedAt: new Date(this.#clock()).toISOString() };
      for (const field of ['messageId', 'recipientId', 'errorCode']) {
        if (result[field] !== undefined) record[field] = result[field];
      }
      const key = this.#key(accountId, mediaId, alias);
      if (!this.#directory) this.#records.set(key, record);
      else {
        const temporary = `${this.#file(key)}.${attemptId}.tmp`;
        try { await this.#write(temporary, record); await rename(temporary, this.#file(key)); }
        catch {
          await unlink(temporary).catch(() => {});
          throw new AutomationError('CONTACT_LEDGER_UNWRITABLE', 'O resultado do contato não foi persistido; o bloqueio permanece.');
        }
      }
    }
  }

  #publicKey(accountId, mediaId, commentId) {
    if (![accountId, mediaId, commentId].every(numericId)) throw new AutomationError('PUBLIC_INTENT_INVALID', 'Revise a identificação da resposta pública.');
    return createHash('sha256').update(JSON.stringify([accountId, mediaId, commentId])).digest('hex');
  }

  #publicFile(key) { return path.join(this.#directory, `public-${key}.json`); }

  #validatePublic(record, accountId, mediaId) {
    if (!record || record.version !== 1 || record.kind !== 'public_reply_intent' || record.accountId !== accountId || record.mediaId !== mediaId ||
        !numericId(record.commentId) || typeof record.text !== 'string' || !record.text.trim() || Buffer.byteLength(record.text, 'utf8') > 1000 ||
        !PUBLIC_INTENT_STATES.has(record.status) || typeof record.attemptId !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
      throw new AutomationError('PUBLIC_INTENT_INVALID', 'A intenção de resposta pública precisa de revisão.');
    }
    return structuredClone(record);
  }

  async #readPublic(key, accountId, mediaId) {
    if (!this.#directory) {
      const record = this.#publicRecords.get(key);
      return record ? this.#validatePublic(record, accountId, mediaId) : null;
    }
    let handle;
    try {
      const filename = this.#publicFile(key);
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 12 * 1024) throw new Error();
      const record = this.#validatePublic(JSON.parse(await handle.readFile('utf8')), accountId, mediaId);
      if (this.#publicKey(accountId, mediaId, record.commentId) !== key) throw new Error();
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof AutomationError) throw error;
      throw new AutomationError('PUBLIC_INTENT_UNREADABLE', 'A intenção de resposta pública precisa de revisão.');
    } finally { await handle?.close(); }
  }

  // This separate intent is committed before the private POST. It contains only
  // the chosen public text and never authorizes a private replay.
  async reservePublicReply(accountId, mediaId, commentId, text) {
    const key = this.#publicKey(accountId, mediaId, commentId);
    const record = this.#validatePublic({ version: 1, kind: 'public_reply_intent', accountId, mediaId, commentId, text,
      attemptId: randomUUID(), status: 'pending', createdAt: new Date(this.#clock()).toISOString() }, accountId, mediaId);
    if (!this.#directory) {
      if (this.#publicRecords.has(key)) throw new AutomationError('PUBLIC_INTENT_EXISTS', 'A resposta pública já está reservada.');
      this.#publicRecords.set(key, record);
    } else {
      try { await mkdir(this.#directory, { recursive: true, mode: 0o700 }); await this.#write(this.#publicFile(key), record); }
      catch (error) {
        throw new AutomationError(error.code === 'EEXIST' ? 'PUBLIC_INTENT_EXISTS' : 'PUBLIC_INTENT_UNWRITABLE', 'Não foi possível reservar a resposta pública antes da DM.');
      }
    }
    return structuredClone(record);
  }

  async listPublicReplies(accountId, mediaId) {
    if (![accountId, mediaId].every(numericId)) throw new AutomationError('PUBLIC_INTENT_INVALID', 'Revise a identificação da campanha.');
    if (!this.#directory) return [...this.#publicRecords.values()].filter(record => record.accountId === accountId && record.mediaId === mediaId).map(record => this.#validatePublic(record, accountId, mediaId));
    let files;
    try { files = await readdir(this.#directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new AutomationError('PUBLIC_INTENT_UNREADABLE', 'Não foi possível ler as respostas públicas pendentes.'); }
    const result = [];
    for (const file of files.filter(file => /^public-[a-f0-9]{64}\.json$/.test(file))) {
      // Read the header in private storage to select this exact account/media.
      let raw;
      let handle;
      try {
        handle = await open(path.join(this.#directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 12 * 1024) throw new Error();
        raw = JSON.parse(await handle.readFile('utf8'));
      } catch { throw new AutomationError('PUBLIC_INTENT_UNREADABLE', 'Uma intenção pública precisa de revisão.'); }
      finally { await handle?.close(); }
      if (raw.accountId !== accountId || raw.mediaId !== mediaId) continue;
      result.push(await this.#readPublic(file.slice(7, -5), accountId, mediaId));
    }
    return result;
  }

  async finishPublicReply(intent, status, result = {}) {
    if (!PUBLIC_INTENT_STATES.has(status)) throw new AutomationError('PUBLIC_INTENT_INVALID', 'Resultado público inválido.');
    const key = this.#publicKey(intent.accountId, intent.mediaId, intent.commentId);
    let lock;
    const lockFile = this.#directory ? `${this.#publicFile(key)}.lock` : null;
    try {
      if (lockFile) {
        try { lock = await open(lockFile, 'wx', 0o600); }
        catch { throw new AutomationError('PUBLIC_INTENT_BUSY', 'Uma resposta pública em andamento precisa de revisão.'); }
      }
      const existing = await this.#readPublic(key, intent.accountId, intent.mediaId);
      if (!existing || existing.attemptId !== intent.attemptId || existing.status !== intent.status || !['pending', 'inflight'].includes(existing.status) ||
          (status === 'inflight' && existing.status !== 'pending') ||
          (status === 'pending' && existing.status !== 'inflight')) throw new AutomationError('PUBLIC_INTENT_CONFLICT', 'A intenção pública precisa de revisão.');
      const record = { ...existing, status, updatedAt: new Date(this.#clock()).toISOString() };
      if (numericId(result.commentReplyId)) record.commentReplyId = result.commentReplyId;
      if (result.errorCode) record.errorCode = safeCode({ code: result.errorCode });
      if (!this.#directory) this.#publicRecords.set(key, record);
      else {
        const temporary = `${this.#publicFile(key)}.${randomUUID()}.tmp`;
        try { await this.#write(temporary, record); await rename(temporary, this.#publicFile(key)); }
        catch { await unlink(temporary).catch(() => {}); throw new AutomationError('PUBLIC_INTENT_UNWRITABLE', 'O resultado público não foi persistido; não repita o envio.'); }
      }
      return structuredClone(record);
    } finally {
      if (lock) { await lock.close(); await unlink(lockFile).catch(() => {}); }
    }
  }
}

export class LocalCommentAutomation {
  #client; #ledger; #contacts; #accountId; #mediaId; #messageText; #publicReplies;
  #reconciled; #preflight; #clock; #intervalMs; #maxSends; #allowInMemory; #accountUsername; #keywords;
  #running = false; #state = 'disabled'; #generation = 0; #timer = null; #startPromise = null; #pollPromise = null;
  #baseline = new Set(); #seen = new Set(); #activatedAt = null; #lastCheckAt = null; #nextCheckAt = null;
  #acceptedCount = 0; #unknownCount = 0; #rejectedCount = 0; #skippedCount = 0; #publicAcceptedCount = 0;
  #reviewReason = null; #records = []; #scheduledPoll; #scheduledWork = null; #sendBudget; #activationCutoff;

  constructor({ client, ledger, contactLedger, accountId, mediaId, messageText, publicReplies = [], reconciledComments = [],
    preflight = {}, clock = Date.now, intervalMs = 60000, maxSendsPerPoll = 5, allowInMemory = false, accountUsername = null, keywords = [], scheduledPoll = null, sendBudget = null, activationCutoff = null,
    requireReconciled = false } = {}) {
    if (!numericId(accountId) || !numericId(mediaId) || typeof client?.listComments !== 'function' ||
        typeof client?.sendPrivateReply !== 'function' || typeof ledger?.get !== 'function' ||
        !(contactLedger instanceof CampaignContactLedger) || (scheduledPoll !== null && typeof scheduledPoll !== 'function') ||
        (sendBudget !== null && !(sendBudget instanceof CampaignSendBudget))) {
      throw new AutomationError('AUTOMATION_CONFIG_INVALID', 'Configure conta, Reel, cliente e registros privados antes de iniciar.');
    }
    const validText = text => typeof text === 'string' && text.trim() && Buffer.byteLength(text, 'utf8') <= 1000;
    if (!validText(messageText) || !Array.isArray(publicReplies) || !publicReplies.every(validText) ||
        (publicReplies.length && typeof client.sendPublicReply !== 'function')) {
      throw new AutomationError('AUTOMATION_MESSAGE_INVALID', 'Revise o texto das mensagens antes de iniciar.');
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 60000 || !Number.isInteger(maxSendsPerPoll) || maxSendsPerPoll < 1 || maxSendsPerPoll > 5 ||
        !Array.isArray(reconciledComments) || (!reconciledComments.length && (requireReconciled === true || preflight.ownershipVerified !== true)) ||
        reconciledComments.some(item => !numericId(item.commentId) || !username(item.username) || (item.fromId !== undefined && !numericId(item.fromId))) ||
        new Set(reconciledComments.map(item => item.commentId)).size !== reconciledComments.length) {
      throw new AutomationError('AUTOMATION_LIMITS_INVALID', 'Revise a recuperação e os limites de execução.');
    }
    this.#client = client; this.#ledger = ledger; this.#contacts = contactLedger; this.#accountId = accountId; this.#mediaId = mediaId;
    this.#messageText = messageText; this.#publicReplies = [...publicReplies]; this.#reconciled = structuredClone(reconciledComments);
    this.#preflight = structuredClone(preflight); this.#clock = clock; this.#intervalMs = intervalMs; this.#maxSends = maxSendsPerPoll;
    this.#allowInMemory = allowInMemory; this.#accountUsername = username(accountUsername);
    this.#keywords = normalizeCampaignKeywords(keywords);
    this.#scheduledPoll = scheduledPoll;
    this.#sendBudget = sendBudget || new CampaignSendBudget({ clock });
    if (activationCutoff !== null && (!Number.isSafeInteger(activationCutoff) || activationCutoff < 0 || activationCutoff > clock())) throw new AutomationError('AUTOMATION_LIMITS_INVALID', 'Revise o corte de retomada da campanha.');
    this.#activationCutoff = activationCutoff;
  }

  #record(kind, fields = {}) {
    const record = { at: new Date(this.#clock()).toISOString(), kind };
    for (const field of ['commentId', 'username', 'messageId', 'recipientId', 'commentReplyId', 'code']) {
      if (fields[field] !== undefined) record[field] = fields[field];
    }
    this.#records.push(record);
    if (this.#records.length > 100) this.#records.shift();
  }

  #review(code) {
    this.#running = false; this.#state = 'review'; this.#reviewReason = code; this.#nextCheckAt = null;
    clearTimeout(this.#timer); this.#timer = null;
    this.#record('review', { code });
  }

  status() {
    return structuredClone({ running: this.#running, state: this.#state, lastCheckAt: this.#lastCheckAt,
      nextCheckAt: this.#nextCheckAt, activatedAt: this.#activatedAt, baselineCount: this.#baseline.size, acceptedCount: this.#acceptedCount,
      unknownCount: this.#unknownCount, rejectedCount: this.#rejectedCount, skippedCount: this.#skippedCount,
      publicAcceptedCount: this.#publicAcceptedCount, reviewReason: this.#reviewReason, records: this.#records });
  }

  stop({ preserveReview = false } = {}) {
    this.#generation++; this.#running = false; if (!preserveReview || this.#state !== 'review') this.#state = 'stopped'; this.#nextCheckAt = null;
    clearTimeout(this.#timer); this.#timer = null;
    return this.status();
  }
  pauseForReview(code) {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) throw new AutomationError('AUTOMATION_REVIEW_INVALID', 'Use um motivo de revisão conhecido.');
    this.#generation++; this.#review(code);
    return this.status();
  }

  #schedule() {
    if (!this.#running || this.#timer || this.#scheduledWork) return;
    this.#nextCheckAt = this.#clock() + this.#intervalMs;
    this.#timer = setTimeout(() => {
      this.#timer = null; this.#nextCheckAt = null;
      // The enclosing campaign can persist the completed poll before another
      // timer is armed. Direct automation users retain the existing poll path.
      this.#scheduledWork = Promise.resolve().then(() => this.#scheduledPoll ? this.#scheduledPoll() : this.pollOnce())
        .catch(() => { if (this.#running) this.pauseForReview('SCHEDULED_POLL_FAILED'); })
        .finally(() => { this.#scheduledWork = null; this.#schedule(); });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  #snapshot(result) {
    if (result?.truncated !== false || !Array.isArray(result.comments) || result.comments.length > 500) {
      throw new AutomationError('SNAPSHOT_INCOMPLETE', 'A leitura completa dos comentários precisa de revisão.');
    }
    const rows = new Map();
    for (const item of result.comments) {
      if (!numericId(item?.id) || !Number.isFinite(Date.parse(item.timestamp))) {
        throw new AutomationError('COMMENT_RESPONSE_INVALID', 'Um comentário não possui ID e data verificáveis.');
      }
      rows.set(item.id, { id: item.id, timestamp: item.timestamp,
        ...(typeof item.text === 'string' ? { text: item.text } : {}),
        username: username(item.username || item.fromUsername),
        ...(numericId(item.fromId) ? { fromId: item.fromId } : {}),
        ...(item.parentId ? { parentId: item.parentId } : {}),
      });
    }
    return [...rows.values()];
  }

  async start() {
    if (this.#running) return this.status();
    if (this.#startPromise) return this.#startPromise;
    if (this.#pollPromise) throw new AutomationError('AUTOMATION_BUSY', 'A tentativa em andamento precisa terminar antes de reiniciar.');
    const generation = ++this.#generation;
    this.#state = 'starting'; this.#reviewReason = null;
    this.#startPromise = (async () => {
      try {
        if (!this.#contacts.persistent && !this.#allowInMemory) throw new AutomationError('AUTOMATION_STORAGE_REQUIRED', 'Configure a proteção persistente de contatos.');
        const futureOnly = this.#preflight.futureOnlyReady === true;
        if (!(this.#preflight.diagnosticComplete === true || futureOnly) || this.#preflight.accountId !== this.#accountId ||
            this.#preflight.mediaId !== this.#mediaId || !Number.isInteger(this.#preflight.protectedCount) ||
            this.#preflight.protectedCount < this.#reconciled.length || (futureOnly &&
              (!this.#reconciled.length || this.#reconciled.length !== this.#preflight.protectedCount || !Number.isFinite(this.#preflight.checkedAt) ||
               this.#preflight.checkedAt > this.#clock() || this.#clock() - this.#preflight.checkedAt > 15 * 60000))) {
          throw new AutomationError('PREFLIGHT_REQUIRED', 'Conclua o diagnóstico e proteja a recuperação antes de iniciar.');
        }
        for (const item of this.#reconciled) {
          const previous = await this.#ledger.get(this.#accountId, 'private', item.commentId);
          if (previous?.status !== 'sent' || (futureOnly && previous.outcome !== 'external_handled')) throw new AutomationError('RECOVERY_UNPROTECTED', 'Há um comentário recuperado sem proteção confirmada.');
        }
        const rows = this.#snapshot(await this.#client.listComments(this.#mediaId, { pageSize: 50, maxPages: 10 }));
        if (generation !== this.#generation) return this.status();
        if (futureOnly && !rows.length) throw new AutomationError('COMMENT_VISIBILITY_UNVERIFIED', 'A leitura atual ainda não confirma a visibilidade deste Reel.');
        if (!this.#reconciled.length) {
          const count = this.#preflight.commentsCount;
          if (!rows.length && count !== 0) {
            throw new AutomationError(Number.isSafeInteger(count) && count > 0 ? 'COMMENT_COUNT_MISMATCH' : 'COMMENT_VISIBILITY_UNVERIFIED', 'A contagem independente da mídia ainda não confirma a leitura dos comentários.');
          }
          if (Number.isSafeInteger(count) && count < rows.filter(row => !row.parentId).length) {
            throw new AutomationError('COMMENT_COUNT_MISMATCH', 'A contagem independente da mídia precisa de revisão.');
          }
        }
        this.#lastCheckAt = this.#clock();
        for (const item of this.#reconciled) {
          const found = rows.find(row => row.id === item.commentId && !row.parentId && row.username === username(item.username));
          if (!futureOnly && !found) throw new AutomationError('RECOVERY_NOT_VISIBLE', 'A API ainda não confirma todos os comentários recuperados.');
          if (numericId(item.fromId) && numericId(found?.fromId) && item.fromId !== found.fromId) throw new AutomationError('AUTHOR_IDENTITY_CONFLICT', 'A identidade canônica de um autor precisa de revisão.');
          // Never take an author ID from another comment with the same username.
          const fromId = numericId(item.fromId) ? item.fromId : found?.fromId;
          await this.#contacts.protect(this.#accountId, this.#mediaId, { commentId: item.commentId, username: item.username,
            ...(numericId(fromId) ? { fromId } : {}) });
        }
        if (generation !== this.#generation) return this.status();
        this.#activatedAt = this.#activationCutoff ?? this.#clock();
        this.#baseline = new Set(rows.filter(row => Date.parse(row.timestamp) <= this.#activatedAt).map(row => row.id)); this.#seen = new Set(this.#baseline);
        this.#running = true; this.#state = 'running';
        this.#schedule();
      } catch (error) { if (generation === this.#generation) this.#review(safeCode(error)); }
      return this.status();
    })();
    try { return await this.#startPromise; } finally { this.#startPromise = null; }
  }

  async pollOnce() {
    if (!this.#running) return this.status();
    if (this.#pollPromise) return this.#pollPromise;
    if (this.#lastCheckAt !== null && this.#clock() - this.#lastCheckAt < this.#intervalMs) return this.status();
    clearTimeout(this.#timer); this.#timer = null;
    const generation = this.#generation;
    this.#pollPromise = this.#poll(generation);
    try { return await this.#pollPromise; }
    finally { this.#pollPromise = null; this.#schedule(); }
  }

  #privateAccepted(record) {
    return record?.status === 'sent' && record.outcome === 'accepted' && typeof record.messageId === 'string' &&
      record.messageId.trim() && record.messageId.length <= 512 && !/[\x00-\x1f]/.test(record.messageId) && numericId(record.recipientId);
  }

  async #completePublicReplies(generation, selected = null, budget = { remaining: this.#maxSends }) {
    if (!this.#publicReplies.length) return;
    const intents = selected || await this.#contacts.listPublicReplies(this.#accountId, this.#mediaId);
    for (let intent of intents) {
      if (!this.#running || generation !== this.#generation || budget.remaining <= 0) break;
      if (!['pending', 'inflight'].includes(intent.status)) continue;
      const privateReply = await this.#ledger.get(this.#accountId, 'private', intent.commentId);
      if (!this.#privateAccepted(privateReply)) continue;
      const priorPublic = await this.#ledger.get(this.#accountId, 'public', intent.commentId);
      if (priorPublic?.status === 'sent' && priorPublic.outcome === 'accepted' && numericId(priorPublic.commentReplyId)) {
        await this.#contacts.finishPublicReply(intent, 'accepted', { commentReplyId: priorPublic.commentReplyId });
        this.#publicAcceptedCount++;
        this.#record('public_accepted', { commentId: intent.commentId, commentReplyId: priorPublic.commentReplyId });
        continue;
      }
      // A public attempt that might already have happened is never replayed.
      if (priorPublic || intent.status === 'inflight') {
        await this.#contacts.finishPublicReply(intent, priorPublic?.status === 'rejected' ? 'rejected' : 'unknown', { errorCode: 'PUBLIC_PRIOR_ATTEMPT' });
        this.#record('public_error', { commentId: intent.commentId, code: 'PUBLIC_PRIOR_ATTEMPT' });
        this.#review('PUBLIC_REPLY_REQUIRES_REVIEW');
        break;
      }
      if (typeof this.#client.sendPublicReply !== 'function') throw new AutomationError('PUBLIC_CLIENT_UNAVAILABLE', 'O envio público precisa de configuração.');
      intent = await this.#contacts.finishPublicReply(intent, 'inflight');
      if (!this.#running || generation !== this.#generation) {
        // The provider has not been called. Preserve the pending reply on pause;
        // a crash without this proof still remains inflight and cannot be replayed.
        await this.#contacts.finishPublicReply(intent, 'pending'); break;
      }
      budget.remaining--;
      let publicResult;
      try {
        publicResult = await this.#client.sendPublicReply(this.#accountId, intent.commentId, intent.text);
        if (publicResult?.outcome !== 'accepted' || !numericId(publicResult.commentReplyId)) throw new AutomationError('PUBLIC_ACK_INVALID', 'A resposta pública não retornou um aceite válido.');
      } catch (error) {
        await this.#contacts.finishPublicReply(intent, error?.outcome === 'rejected' ? 'rejected' : 'unknown', { errorCode: safeCode(error) });
        this.#record('public_error', { commentId: intent.commentId, code: safeCode(error) });
        if (this.#running && generation === this.#generation) this.#review('PUBLIC_REPLY_REQUIRES_REVIEW');
        break;
      }
      await this.#contacts.finishPublicReply(intent, 'accepted', { commentReplyId: publicResult.commentReplyId });
      this.#publicAcceptedCount++;
      this.#record('public_accepted', { commentId: intent.commentId, commentReplyId: publicResult.commentReplyId });
    }
  }

  async #poll(generation) {
    try {
      let rows;
      try { rows = this.#snapshot(await this.#client.listComments(this.#mediaId, { pageSize: 50, maxPages: 10 })); }
      catch (error) {
        // Only failed reads return to the normal timer. POST failures still use
        // the durable unknown/rejected handling below and are never replayed.
        if (this.#running && generation === this.#generation && retryableRead(error)) {
          this.#record('read_retry', { code: safeCode(error) }); return this.status();
        }
        throw error;
      }
      this.#lastCheckAt = this.#clock();
      if (this.#baseline.size && rows.length === 0) {
        throw new AutomationError('COMMENT_VISIBILITY_DEGRADED', 'A API deixou de mostrar os comentários confirmados; revise o acesso.');
      }
      // Restart alone does not execute this path. A campaign must be explicitly
      // activated again, and only accepted private sends can finish public work.
      const publicBudget = { remaining: this.#maxSends };
      await this.#completePublicReplies(generation, null, publicBudget);
      let attempts = 0;
      for (const item of rows) {
        if (!this.#running || generation !== this.#generation || attempts >= this.#maxSends || !this.#sendBudget.available()) break;
        if (this.#seen.has(item.id)) continue;
        const createdAt = Date.parse(item.timestamp);
        if (item.parentId || item.fromId === this.#accountId || (this.#accountUsername && item.username === this.#accountUsername) ||
            createdAt <= this.#activatedAt || createdAt > this.#clock() || this.#clock() - createdAt > 7 * DAY) {
          this.#seen.add(item.id); this.#skippedCount++; continue;
        }
        if (this.#keywords.length && (typeof item.text !== 'string' || !this.#keywords.some(word => item.text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().includes(word)))) {
          this.#seen.add(item.id); this.#skippedCount++; continue;
        }
        let reservation;
        try {
          if (await this.#ledger.get(this.#accountId, 'private', item.id)) {
            this.#seen.add(item.id); this.#skippedCount++; continue;
          }
          if (!this.#sendBudget.take()) break;
          reservation = await this.#contacts.reserve(this.#accountId, this.#mediaId, { ...item, commentId: item.id });
        } catch (error) {
          if (['CONTACT_ALREADY_PROTECTED', 'AUTHOR_UNVERIFIED'].includes(safeCode(error))) {
            this.#seen.add(item.id); this.#skippedCount++;
            this.#record('blocked', { commentId: item.id, ...(item.username ? { username: item.username } : {}), code: safeCode(error) });
            continue;
          }
          throw error;
        }
        if (!this.#running || generation !== this.#generation) {
          await this.#contacts.finish(reservation, 'protected'); break;
        }
        const publicIntent = this.#publicReplies.length ? await this.#contacts.reservePublicReply(this.#accountId, this.#mediaId, item.id,
          this.#publicReplies[this.#acceptedCount % this.#publicReplies.length]) : null;
        if (!this.#running || generation !== this.#generation) {
          await this.#contacts.finish(reservation, 'protected'); break;
        }
        this.#seen.add(item.id); attempts++;
        let result;
        try {
          result = await this.#client.sendPrivateReply(this.#accountId, item.id, this.#messageText, { commentCreatedAt: createdAt });
          if (result?.outcome !== 'accepted' || typeof result.messageId !== 'string' || !result.messageId.trim() || !numericId(result.recipientId)) {
            throw new AutomationError('SEND_ACK_INVALID', 'O envio não retornou IDs de aceite válidos.');
          }
        } catch (error) {
          const outcome = error?.outcome === 'rejected' ? 'rejected' : 'unknown';
          if (outcome === 'rejected') this.#rejectedCount++; else this.#unknownCount++;
          await this.#contacts.finish(reservation, outcome, { errorCode: safeCode(error) });
          if (publicIntent) await this.#contacts.finishPublicReply(publicIntent, 'cancelled', { errorCode: safeCode(error) });
          this.#record(outcome, { commentId: item.id, ...(item.username ? { username: item.username } : {}), code: safeCode(error) });
          if (outcome === 'unknown' || RATE_LIMIT_CODES.has(error?.graphCode) || [10, 190, 200].includes(error?.graphCode)) {
            if (this.#running && generation === this.#generation) this.#review(RATE_LIMIT_CODES.has(error?.graphCode)
              ? 'RATE_LIMIT_REJECTED' : outcome === 'unknown' ? 'SEND_OUTCOME_UNKNOWN' : 'PERMISSION_OR_TOKEN_REJECTED');
            break;
          }
          continue;
        }
        this.#acceptedCount++;
        this.#record('accepted', { commentId: item.id, ...(item.username ? { username: item.username } : {}), messageId: result.messageId, recipientId: result.recipientId });
        await this.#contacts.finish(reservation, 'accepted', { messageId: result.messageId, recipientId: result.recipientId });
        if (publicIntent && this.#running && generation === this.#generation) await this.#completePublicReplies(generation, [publicIntent], publicBudget);
      }
    } catch (error) { if (this.#running && generation === this.#generation) this.#review(safeCode(error)); }
    return this.status();
  }
}

// One serialized account-wide worker. Discovery never starts child workers:
// every Reel uses the same activation cutoff, drain and rolling send budget.
export class AllReelsCommentAutomation {
  #mediaEligibility;
  #client; #ledger; #comments; #accountId; #accountUsername; #messageText; #keywords; #clock; #sendBudget;
  #contacts; #publicReplies; #publicSendBudget; #publicAcceptedCount = 0;
  #activationCutoff;
  #scheduledPoll; #scheduledWork = null; #timer = null; #startPromise = null; #pollPromise = null;
  #generation = 0; #running = false; #state = 'disabled'; #reviewReason = null; #allowInMemory;
  #activatedAt = null; #lastCheckAt = null; #nextCheckAt = null; #baseline = new Set(); #seen = new Set();
  #visibleCounts = new Map(); #monitoredReelCount = 0; #records = [];
  #acceptedCount = 0; #unknownCount = 0; #rejectedCount = 0; #skippedCount = 0;
  constructor({ client, ledger, commentLedger, contactLedger = null, accountId, accountUsername, messageText, publicReplies = [], keywords = [], clock = Date.now,
    scheduledPoll = null, sendBudget = null, publicSendBudget = null, activationCutoff = null, allowInMemory = false, mediaEligibility = async () => true } = {}) {
    if (!numericId(accountId) || !username(accountUsername) || typeof client?.listMedia !== 'function' ||
        typeof client?.listComments !== 'function' || typeof client?.sendPrivateReply !== 'function' || typeof ledger?.get !== 'function' ||
        !(commentLedger instanceof CampaignCommentLedger) || typeof clock !== 'function' ||
        (scheduledPoll !== null && typeof scheduledPoll !== 'function') || (sendBudget !== null && !(sendBudget instanceof CampaignSendBudget)) ||
        (publicSendBudget !== null && !(publicSendBudget instanceof CampaignSendBudget)) ||
        (contactLedger !== null && !(contactLedger instanceof CampaignContactLedger))) {
      throw new AutomationError('AUTOMATION_CONFIG_INVALID', 'Configure a conta, o cliente e os registros privados antes de iniciar.');
    }
    if (typeof messageText !== 'string' || !messageText.trim() || Buffer.byteLength(messageText, 'utf8') > 1000) throw new AutomationError('AUTOMATION_MESSAGE_INVALID', 'Revise o texto da mensagem antes de iniciar.');
    if (!Array.isArray(publicReplies) || publicReplies.length > 3 || publicReplies.some(text => typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 1000) ||
        (publicReplies.length && (!(contactLedger instanceof CampaignContactLedger) || typeof client.sendPublicReply !== 'function'))) throw new AutomationError('AUTOMATION_MESSAGE_INVALID', 'Revise as respostas públicas antes de iniciar.');
    if (activationCutoff !== null && (!Number.isSafeInteger(activationCutoff) || activationCutoff < 0 || activationCutoff > clock())) throw new AutomationError('AUTOMATION_LIMITS_INVALID', 'Revise o corte de retomada da campanha.');
    this.#client = client; this.#ledger = ledger; this.#comments = commentLedger; this.#accountId = accountId;
    this.#accountUsername = username(accountUsername); this.#messageText = messageText; this.#keywords = normalizeCampaignKeywords(keywords);
    this.#clock = clock; this.#scheduledPoll = scheduledPoll; this.#sendBudget = sendBudget || new CampaignSendBudget({ clock }); this.#allowInMemory = allowInMemory;
    this.#contacts = contactLedger; this.#publicReplies = [...publicReplies]; this.#publicSendBudget = publicSendBudget || new CampaignSendBudget({ clock });
    this.#activationCutoff = activationCutoff;
    this.#mediaEligibility = mediaEligibility;
  }
  #record(kind, fields = {}) {
    const record = { at: new Date(this.#clock()).toISOString(), kind };
    for (const field of ['commentId', 'username', 'messageId', 'recipientId', 'commentReplyId', 'code']) if (fields[field] !== undefined) record[field] = fields[field];
    this.#records.push(record); if (this.#records.length > 100) this.#records.shift();
  }
  #review(code) {
    this.#running = false; this.#state = 'review'; this.#reviewReason = code; this.#nextCheckAt = null;
    clearTimeout(this.#timer); this.#timer = null; this.#record('review', { code });
  }
  status() {
    return structuredClone({ running: this.#running, state: this.#state, reviewReason: this.#reviewReason,
      lastCheckAt: this.#lastCheckAt, nextCheckAt: this.#nextCheckAt, activatedAt: this.#activatedAt,
      monitoredReelCount: this.#monitoredReelCount, baselineCount: this.#baseline.size, acceptedCount: this.#acceptedCount,
      unknownCount: this.#unknownCount, rejectedCount: this.#rejectedCount, skippedCount: this.#skippedCount,
      publicAcceptedCount: this.#publicAcceptedCount, records: this.#records });
  }
  stop({ preserveReview = false } = {}) {
    this.#generation++; this.#running = false; if (!preserveReview || this.#state !== 'review') this.#state = 'stopped';
    this.#nextCheckAt = null; clearTimeout(this.#timer); this.#timer = null; return this.status();
  }
  pauseForReview(code) {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) throw new AutomationError('AUTOMATION_REVIEW_INVALID', 'Use um motivo de revisão conhecido.');
    this.#generation++; this.#review(code); return this.status();
  }
  #schedule() {
    if (!this.#running || this.#timer || this.#scheduledWork) return;
    this.#nextCheckAt = this.#clock() + 60000;
    this.#timer = setTimeout(() => {
      this.#timer = null; this.#nextCheckAt = null;
      this.#scheduledWork = Promise.resolve().then(() => this.#scheduledPoll ? this.#scheduledPoll() : this.pollOnce())
        .catch(() => { if (this.#running) this.pauseForReview('SCHEDULED_POLL_FAILED'); })
        .finally(() => { this.#scheduledWork = null; this.#schedule(); });
    }, 60000);
    this.#timer.unref?.();
  }
  #mediaSnapshot(result) {
    if (result?.truncated !== false || !Array.isArray(result.media) || result.media.length > 500) throw new AutomationError('MEDIA_SNAPSHOT_INCOMPLETE', 'A lista completa de mídias precisa de revisão.');
    const seen = new Set(); const reels = [];
    for (const item of result.media) {
      let url;
      try { url = new URL(item?.permalink); } catch { throw new AutomationError('MEDIA_RESPONSE_INVALID', 'Uma mídia não tem um permalink verificável.'); }
      const parts = url.pathname.split('/').filter(Boolean);
      if (!numericId(item?.id) || seen.has(item.id) || typeof item.shortcode !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.shortcode) ||
          url.protocol !== 'https:' || !['www.instagram.com', 'instagram.com'].includes(url.hostname) || url.username || url.password || url.port ||
          parts.length !== 2 || !['reel', 'p', 'tv'].includes(parts[0]) || parts[1] !== item.shortcode ||
          (item.commentsCount !== undefined && (!Number.isSafeInteger(item.commentsCount) || item.commentsCount < 0))) throw new AutomationError('MEDIA_RESPONSE_INVALID', 'Uma mídia não tem identificação verificável.');
      seen.add(item.id); if (parts[0] === 'reel') reels.push({ id: item.id, commentsCount: item.commentsCount });
    }
    return reels;
  }
  #commentSnapshot(result, media, initial) {
    if (result?.truncated !== false || !Array.isArray(result.comments) || result.comments.length > 500) throw new AutomationError('SNAPSHOT_INCOMPLETE', 'A leitura completa dos comentários precisa de revisão.');
    const rows = new Map();
    for (const item of result.comments) {
      if (!numericId(item?.id) || !Number.isFinite(Date.parse(item.timestamp)) ||
          (item.parentId !== undefined && !numericId(item.parentId))) throw new AutomationError('COMMENT_RESPONSE_INVALID', 'Um comentário não tem ID e data verificáveis.');
      if (rows.has(item.id)) throw new AutomationError('COMMENT_RESPONSE_INVALID', 'Um comentário apareceu repetido na leitura.');
      rows.set(item.id, { id: item.id, mediaId: media.id, timestamp: item.timestamp,
        username: username(item.username || item.fromUsername),
        ...(numericId(item.fromId) ? { fromId: item.fromId } : {}), ...(item.parentId ? { parentId: item.parentId } : {}),
        ...(typeof item.text === 'string' ? { text: item.text } : {}) });
    }
    if (!rows.size && media.commentsCount !== 0) throw new AutomationError(Number.isSafeInteger(media.commentsCount) && media.commentsCount > 0 ? 'COMMENT_COUNT_MISMATCH' : 'COMMENT_VISIBILITY_UNVERIFIED', 'A contagem independente não confirma a leitura dos comentários.');
    // Active comments can arrive after the media count was read. The complete
    // canonical comment snapshot is authoritative for those new rows.
    if (initial && Number.isSafeInteger(media.commentsCount) && media.commentsCount < [...rows.values()].filter(row => !row.parentId).length) throw new AutomationError('COMMENT_COUNT_MISMATCH', 'A contagem da mídia precisa de revisão.');
    return [...rows.values()];
  }
  async #snapshot(generation) {
    const reels = this.#mediaSnapshot(await this.#client.listMedia(this.#accountId, { pageSize: 50, maxPages: 10 }));
    const rows = []; const ids = new Set(); const visible = new Map();
    for (const media of reels) {
      if (generation !== this.#generation) return null;
      if (!await this.#mediaEligibility(media.id)) continue;
      const comments = this.#commentSnapshot(await this.#client.listComments(media.id, { pageSize: 50, maxPages: 10 }), media, this.#state === 'starting');
      if (this.#visibleCounts.get(media.id) > 0 && comments.length === 0) throw new AutomationError('COMMENT_VISIBILITY_DEGRADED', 'A API deixou de mostrar comentários confirmados.');
      visible.set(media.id, comments.length);
      for (const comment of comments) {
        if (ids.has(comment.id)) throw new AutomationError('COMMENT_MEDIA_CONFLICT', 'O mesmo comentário apareceu em mais de uma mídia.');
        ids.add(comment.id); rows.push(comment);
      }
    }
    if (generation !== this.#generation) return null;
    this.#visibleCounts = visible; this.#monitoredReelCount = reels.length;
    return rows;
  }
  async start() {
    if (this.#running) return this.status(); if (this.#startPromise) return this.#startPromise;
    if (this.#pollPromise) throw new AutomationError('AUTOMATION_BUSY', 'A tentativa precisa terminar antes de reiniciar.');
    const generation = ++this.#generation; this.#state = 'starting'; this.#reviewReason = null;
    this.#startPromise = (async () => {
      try {
        if ((!this.#comments.persistent || (this.#publicReplies.length && !this.#contacts.persistent)) && !this.#allowInMemory) throw new AutomationError('AUTOMATION_STORAGE_REQUIRED', 'Configure a proteção persistente dos comentários e respostas.');
        if (this.#activationCutoff !== null) this.#activatedAt = this.#activationCutoff;
        this.#visibleCounts = new Map();
        const rows = await this.#snapshot(generation); if (!rows) return this.status();
        this.#activatedAt = this.#activationCutoff ?? this.#clock();
        this.#baseline = new Set((this.#activationCutoff === null ? rows : rows.filter(row => Date.parse(row.timestamp) <= this.#activatedAt)).map(row => row.id)); this.#seen = new Set(this.#baseline);
        this.#lastCheckAt = this.#clock(); this.#running = true; this.#state = 'running'; this.#schedule();
      } catch (error) { if (generation === this.#generation) this.#review(safeCode(error)); }
      return this.status();
    })();
    try { return await this.#startPromise; } finally { this.#startPromise = null; }
  }
  async pollOnce() {
    if (!this.#running) return this.status(); if (this.#pollPromise) return this.#pollPromise;
    if (this.#lastCheckAt !== null && this.#clock() - this.#lastCheckAt < 60000) return this.status();
    clearTimeout(this.#timer); this.#timer = null; const generation = this.#generation;
    this.#pollPromise = this.#poll(generation);
    try { return await this.#pollPromise; } finally { this.#pollPromise = null; this.#schedule(); }
  }
  async #poll(generation) {
    try {
      let rows;
      try { rows = await this.#snapshot(generation); }
      catch (error) {
        if (this.#running && generation === this.#generation && retryableRead(error)) {
          this.#record('read_retry', { code: safeCode(error) }); return this.status();
        }
        throw error;
      }
      if (!rows) return this.status(); this.#lastCheckAt = this.#clock();
      await this.#completePublicReplies(generation, rows);
      // Stable ordering across media prevents discovery order from changing which
      // eligible comments use a bounded cycle's remaining budget.
      rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
      for (const item of rows) {
        if (!this.#running || generation !== this.#generation || !this.#sendBudget.available()) break;
        if (this.#seen.has(item.id)) continue;
        const createdAt = Date.parse(item.timestamp);
        if (item.parentId || item.fromId === this.#accountId || item.username === this.#accountUsername ||
            createdAt <= this.#activatedAt || createdAt > this.#clock() || this.#clock() - createdAt > 7 * DAY ||
            (!item.username && !item.fromId) || this.#keywords.length && (typeof item.text !== 'string' ||
              !this.#keywords.some(word => item.text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().includes(word)))) {
          this.#seen.add(item.id); this.#skippedCount++; continue;
        }
        if (await this.#ledger.get(this.#accountId, 'private', item.id) || await this.#comments.get(this.#accountId, item.id)) {
          this.#seen.add(item.id); this.#skippedCount++; continue;
        }
        if (!this.#running || generation !== this.#generation || !this.#sendBudget.take()) break;
        let reservation;
        try { reservation = await this.#comments.reserve(this.#accountId, item.mediaId, item.id); }
        catch (error) {
          if (error.code === 'COMMENT_ALREADY_ATTEMPTED') { this.#seen.add(item.id); this.#skippedCount++; continue; }
          throw error;
        }
        if (!this.#running || generation !== this.#generation) { await this.#comments.finish(reservation, 'protected'); break; }
        const publicIntent = this.#publicReplies.length ? await this.#contacts.reservePublicReply(this.#accountId, item.mediaId, item.id,
          this.#publicReplies[this.#acceptedCount % this.#publicReplies.length]) : null;
        if (!this.#running || generation !== this.#generation) {
          await this.#comments.finish(reservation, 'protected');
          if (publicIntent) await this.#contacts.finishPublicReply(publicIntent, 'cancelled', { errorCode: 'SEND_GATE_CHANGED' });
          break;
        }
        this.#seen.add(item.id);
        let result;
        try {
          result = await this.#client.sendPrivateReply(this.#accountId, item.id, this.#messageText, { commentCreatedAt: createdAt,
            beforeSend: () => {
              if (!this.#running || generation !== this.#generation || createdAt > this.#clock() || this.#clock() - createdAt > 7 * DAY) {
                throw new AutomationError('SEND_GATE_CHANGED', 'A campanha ou a janela de envio mudou antes da solicitação.');
              }
            } });
          if (result?.outcome !== 'accepted' || typeof result.messageId !== 'string' || !result.messageId.trim() || result.messageId.length > 512 ||
              /[\x00-\x1f]/.test(result.messageId) || !numericId(result.recipientId)) throw new AutomationError('SEND_ACK_INVALID', 'O envio não retornou IDs de aceite válidos.');
        } catch (error) {
          const outcome = error?.outcome === 'rejected' ? 'rejected' : 'unknown';
          if (outcome === 'rejected') this.#rejectedCount++; else this.#unknownCount++;
          await this.#comments.finish(reservation, outcome, { errorCode: safeCode(error) });
          if (publicIntent) await this.#contacts.finishPublicReply(publicIntent, 'cancelled', { errorCode: safeCode(error) });
          this.#record(outcome, { commentId: item.id, ...(item.username ? { username: item.username } : {}), code: safeCode(error) });
          if (outcome === 'unknown' || error?.code === 'SEND_GATE_CHANGED' || RATE_LIMIT_CODES.has(error?.graphCode) || [10, 190, 200].includes(error?.graphCode)) {
            if (this.#running && generation === this.#generation) this.#review(error?.code === 'SEND_GATE_CHANGED' ? 'SEND_GATE_CHANGED' : RATE_LIMIT_CODES.has(error?.graphCode) ? 'RATE_LIMIT_REJECTED' : outcome === 'unknown' ? 'SEND_OUTCOME_UNKNOWN' : 'PERMISSION_OR_TOKEN_REJECTED');
            break;
          }
          continue;
        }
        this.#acceptedCount++; this.#record('accepted', { commentId: item.id, ...(item.username ? { username: item.username } : {}), messageId: result.messageId, recipientId: result.recipientId });
        await this.#comments.finish(reservation, 'accepted', { messageId: result.messageId, recipientId: result.recipientId });
        if (publicIntent && this.#running && generation === this.#generation) await this.#completePublicReplies(generation, rows, [publicIntent]);
      }
    } catch (error) { if (this.#running && generation === this.#generation) this.#review(safeCode(error)); }
    return this.status();
  }

  #privateAccepted(record) {
    return record?.status === 'sent' && record.outcome === 'accepted' && typeof record.messageId === 'string' &&
      record.messageId.trim() && record.messageId.length <= 512 && !/[\x00-\x1f]/.test(record.messageId) && numericId(record.recipientId);
  }
  async #completePublicReplies(generation, rows, selected = null) {
    if (!this.#publicReplies.length) return;
    const canonical = new Map(rows.map(row => [row.id, row]));
    const intents = selected || (await Promise.all([...this.#visibleCounts.keys()].map(mediaId => this.#contacts.listPublicReplies(this.#accountId, mediaId)))).flat();
    for (let intent of intents) {
      if (!this.#running || generation !== this.#generation || !this.#publicSendBudget.available()) break;
      if (!['pending', 'inflight'].includes(intent.status)) continue;
      const comment = canonical.get(intent.commentId);
      if (!comment || comment.mediaId !== intent.mediaId || comment.parentId || comment.fromId === this.#accountId ||
          comment.username === this.#accountUsername || (!comment.username && !comment.fromId)) continue;
      // Only accepted account-wide DM attempts may resume this public step.
      // A legacy/manual private record or an orphan intent does not authorize it.
      const ownAttempt = await this.#comments.get(this.#accountId, intent.commentId);
      const privateReply = await this.#ledger.get(this.#accountId, 'private', intent.commentId);
      if (!['accepted', 'inflight'].includes(ownAttempt?.status) || ownAttempt.mediaId !== intent.mediaId || !this.#privateAccepted(privateReply)) continue;
      // Graph acceptance can be durable just before a crash prevents the local
      // attempt's final write. Reconcile that gap using acknowledgement IDs,
      // without ever repeating the private request.
      if (ownAttempt.status === 'inflight') await this.#comments.finish(ownAttempt, 'accepted', { messageId: privateReply.messageId, recipientId: privateReply.recipientId });
      const prior = await this.#ledger.get(this.#accountId, 'public', intent.commentId);
      if (prior?.status === 'sent' && prior.outcome === 'accepted' && numericId(prior.commentReplyId)) {
        await this.#contacts.finishPublicReply(intent, 'accepted', { commentReplyId: prior.commentReplyId });
        this.#publicAcceptedCount++; this.#record('public_accepted', { commentId: intent.commentId, commentReplyId: prior.commentReplyId }); continue;
      }
      if (prior || intent.status === 'inflight') {
        await this.#contacts.finishPublicReply(intent, prior?.status === 'rejected' ? 'rejected' : 'unknown', { errorCode: 'PUBLIC_PRIOR_ATTEMPT' });
        this.#record('public_error', { commentId: intent.commentId, code: 'PUBLIC_PRIOR_ATTEMPT' });
        if (this.#running && generation === this.#generation) this.#review('PUBLIC_REPLY_REQUIRES_REVIEW');
        break;
      }
      if (!this.#running || generation !== this.#generation || !this.#publicSendBudget.take()) break;
      intent = await this.#contacts.finishPublicReply(intent, 'inflight');
      if (!this.#running || generation !== this.#generation) {
        await this.#contacts.finishPublicReply(intent, 'pending'); break;
      }
      let result;
      try {
        result = await this.#client.sendPublicReply(this.#accountId, intent.commentId, intent.text, { beforeSend: () => {
          if (!this.#running || generation !== this.#generation) throw new AutomationError('SEND_GATE_CHANGED', 'A campanha mudou antes da resposta pública.');
        } });
        if (result?.outcome !== 'accepted' || !numericId(result.commentReplyId)) throw new AutomationError('PUBLIC_ACK_INVALID', 'A resposta pública não retornou um aceite válido.');
      } catch (error) {
        await this.#contacts.finishPublicReply(intent, error?.outcome === 'rejected' ? 'rejected' : 'unknown', { errorCode: safeCode(error) });
        this.#record('public_error', { commentId: intent.commentId, code: safeCode(error) });
        if (this.#running && generation === this.#generation) this.#review('PUBLIC_REPLY_REQUIRES_REVIEW');
        break;
      }
      await this.#contacts.finishPublicReply(intent, 'accepted', { commentReplyId: result.commentReplyId });
      this.#publicAcceptedCount++; this.#record('public_accepted', { commentId: intent.commentId, commentReplyId: result.commentReplyId });
    }
  }
}
