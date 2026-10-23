// Server-only inbox. Importing performs no I/O. Only verified webhooks open a reply window.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, chmod, lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d{1,40}$/;
const MESSAGE_ID = /^[A-Za-z0-9_:./+=-]{1,512}$/;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);

export class InboxError extends Error {
  constructor(code, message) { super(message); this.name = 'InboxError'; this.code = code; }
}

function fail(code, message) { throw new InboxError(code, message); }
function numeric(value) { return typeof value === 'string' && NUMERIC_ID.test(value); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function boundedText(value, maximum = 4000, allowEmpty = false) {
  return typeof value === 'string' && (allowEmpty || value.trim()) && Buffer.byteLength(value, 'utf8') <= maximum;
}
function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'INBOX_OPERATION_FAILED';
}
// Exact whole-message stop commands only. Any other wording is interpreted by the
// model, which can return optout; no keyword or substring guessing happens here.
const OPT_OUT_COMMANDS = new Set(['stop', 'parar', 'pare', 'sair', 'cancelar', 'nao quero', 'não quero', 'nao me envie', 'não me envie', 'unsubscribe'].flatMap(command => [command, `${command}.`, `${command}!`]));
export function isOptOutCommand(text) {
  return typeof text === 'string' && OPT_OUT_COMMANDS.has(text.normalize('NFC').toLowerCase().trim());
}
// A model counts as ready only after its OpenRouter key was verified by this server.
export function modelReady(status) {
  return status?.configured === true && status.name === 'openrouter' && typeof status.model === 'string' && status.model.length > 0 &&
    Number.isFinite(Date.parse(status.verifiedAt));
}
function automaticEligible(config, kind, feature) {
  if (config?.providerRequired && !modelReady(config.provider)) return false;
  if (!config?.enabled || (kind?.startsWith('story_') && (!config.storyEnabled || !config.eligibility?.story?.eligible))) return false;
  if (feature === 'story') return config.storyEnabled && config.eligibility?.story?.eligible === true;
  if (feature === 'faq' || feature === 'sales') return config[`${feature}Enabled`] && config.eligibility?.[feature]?.eligible === true;
  return (config.faqEnabled && config.eligibility?.faq?.eligible === true) || (config.salesEnabled && config.eligibility?.sales?.eligible === true);
}
const configEpoch = config => config?.activationEpoch ?? null;
const threadRevision = thread => thread?.automationRevision ?? 0;
const sameGeneration = (thread, job, config) => threadRevision(thread) === (job.automationRevision ?? 0) && configEpoch(config) === (job.activationEpoch ?? null) && thread.lastInboundId === job.inboundId;
function invalidateThread(state, thread, now) {
  thread.automationRevision = threadRevision(thread) + 1;
  for (const job of Object.values(state.jobs)) if (job.threadId === thread.id && ['pending', 'processing'].includes(job.status)) {
    job.status = 'ignored'; job.finishedAt = now;
  }
}
function statusDTO(state, running, stopping) {
  const jobs = Object.values(state.jobs); const events = Object.values(state.events);
  return { threads: Object.keys(state.threads).length, pending: jobs.filter(job => job.status === 'pending').length,
    processing: jobs.filter(job => job.status === 'processing').length, unknown: Object.values(state.attempts).filter(attempt => attempt.status === 'unknown').length,
    receivedMessageCount: events.filter(event => ['message', 'story_mention', 'story_reply'].includes(event.kind)).length,
    receivedStoryCount: events.filter(event => ['story_mention', 'story_reply'].includes(event.kind)).length,
    acceptedSendCount: Object.values(state.attempts).filter(attempt => attempt.status === 'accepted').length,
    running, stopping, reviewReason: state.workerReview };
}

// One atomic snapshot contains event IDs, jobs and thread state. A crash-held lock is
// deliberately not expired: an operator must review it, rather than replay a send.
export class PrivateStateFile {
  #directory; #filename; #initial; #validate; #memory; #queue = Promise.resolve();
  constructor({ directory = null, filename, initial, validate }) {
    if ((directory !== null && !path.isAbsolute(directory)) || !/^[a-z-]+\.json$/.test(filename) ||
        typeof initial !== 'function' || typeof validate !== 'function') fail('INVALID_STORE_CONFIG', 'Configuração do estado privado inválida.');
    this.#directory = directory; this.#filename = filename; this.#initial = initial; this.#validate = validate;
  }
  get persistent() { return this.#directory !== null; }
  async #load() {
    let state;
    if (!this.#directory) state = this.#memory ?? this.#initial();
    else {
      let handle;
      try {
        const directory = await lstat(this.#directory);
        if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) fail('PRIVATE_STATE_INVALID', 'O diretório privado precisa de revisão.');
        handle = await open(path.join(this.#directory, this.#filename), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 8_000_000 || (stat.mode & 0o077)) fail('PRIVATE_STATE_INVALID', 'O arquivo privado precisa de revisão.');
        state = JSON.parse(await handle.readFile('utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') state = this.#initial();
        else if (error instanceof InboxError) throw error;
        else fail('PRIVATE_STATE_UNREADABLE', 'Não foi possível ler o estado privado.');
      } finally { await handle?.close(); }
    }
    if (!this.#validate(state)) fail('PRIVATE_STATE_INVALID', 'O estado privado precisa de revisão.');
    return clone(state);
  }
  async read() { return this.#load(); }
  async update(mutate) {
    const work = async () => {
      let lock; let temporary; let ownsLock = false;
      const lockPath = this.#directory && path.join(this.#directory, `${this.#filename}.lock`);
      try {
        if (this.#directory) {
          await mkdir(this.#directory, { recursive: true, mode: 0o700 });
          const directory = await lstat(this.#directory);
          if (!directory.isDirectory() || directory.isSymbolicLink()) fail('PRIVATE_STATE_INVALID', 'O diretório privado precisa de revisão.');
          await chmod(this.#directory, 0o700);
          try { lock = await open(lockPath, 'wx', 0o600); ownsLock = true; }
          catch (error) { if (error.code === 'EEXIST') fail('PRIVATE_STATE_BUSY', 'Uma operação privada precisa terminar ou ser revisada.'); throw error; }
          await lock.writeFile(randomUUID()); await lock.sync();
        }
        const state = await this.#load();
        const result = await mutate(state);
        if (!this.#validate(state)) fail('PRIVATE_STATE_INVALID', 'A atualização privada é inválida.');
        const encoded = JSON.stringify(state);
        if (Buffer.byteLength(encoded, 'utf8') > 8_000_000) fail('PRIVATE_STATE_FULL', 'O estado privado atingiu o limite; nenhuma operação nova foi iniciada.');
        if (!this.#directory) this.#memory = clone(state);
        else {
          temporary = path.join(this.#directory, `${this.#filename}.${randomUUID()}.tmp`);
          const handle = await open(temporary, 'wx', 0o600);
          try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, path.join(this.#directory, this.#filename)); temporary = null;
        }
        return clone(result);
      } catch (error) {
        if (error instanceof InboxError) throw error;
        fail('PRIVATE_STATE_UNWRITABLE', 'Não foi possível persistir a operação privada.');
      } finally {
        await lock?.close();
        if (temporary) await unlink(temporary).catch(() => {});
        if (ownsLock) await unlink(lockPath).catch(() => {});
      }
    };
    const operation = this.#queue.then(work, work);
    this.#queue = operation.catch(() => {});
    return operation;
  }
}

// Shapes: Meta's Instagram webhook examples, updated 16 September 2026:
// https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
// Story URLs are never fetched or retained. Follows are not a verified public trigger.
export function normalizeInstagramWebhook(payload, { verifiedAccountId, signatureVerified = false, receivedAt = Date.now() } = {}) {
  if (!signatureVerified) fail('WEBHOOK_SIGNATURE_REQUIRED', 'A assinatura do corpo original precisa ser verificada antes da normalização.');
  if (!numeric(verifiedAccountId) || !Number.isSafeInteger(receivedAt) || receivedAt < 1) fail('INVALID_WEBHOOK_CONTEXT', 'Informe a identidade canônica verificada da conta.');
  if (Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8') > 1_000_000) fail('WEBHOOK_TOO_LARGE', 'A notificação excedeu o limite.');
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (!envelopes.length || envelopes.length > 10) fail('INVALID_WEBHOOK', 'Notificação do Instagram inválida.');
  const events = []; const unsupported = [];
  const unsupportedField = field => unsupported.push({ field: typeof field === 'string' && /^[a-z_]{1,40}$/.test(field) ? field : 'unknown', reason: 'UNSUPPORTED_TRIGGER' });
  for (const envelope of envelopes) {
    if (envelope?.object !== 'instagram' || !Array.isArray(envelope.entry) || envelope.entry.length > 50) fail('INVALID_WEBHOOK', 'Notificação do Instagram inválida.');
    for (const entry of envelope.entry) {
      if (entry?.id !== verifiedAccountId) fail('WEBHOOK_ACCOUNT_MISMATCH', 'A notificação pertence a outra conta.');
      const changes = [...(Array.isArray(entry.changes) ? entry.changes : []), ...(entry.field ? [{ field: entry.field, value: entry.value }] : [])];
      if (changes.length > 100 || (entry.messaging !== undefined && (!Array.isArray(entry.messaging) || entry.messaging.length > 100))) fail('INVALID_WEBHOOK', 'A notificação contém eventos demais.');
      for (const change of changes) {
        if (!['comments', 'live_comments'].includes(change?.field)) { unsupportedField(change?.field); continue; }
        const value = change.value; const commentId = value?.id ?? value?.comment_id;
        if (!numeric(commentId) || (value.id && value.comment_id && value.id !== value.comment_id) || !numeric(value?.media?.id) ||
            !numeric(value?.from?.id) || !boundedText(value?.text ?? '', 4000, true) ||
            (value.parent_id !== undefined && !numeric(value.parent_id))) fail('INVALID_COMMENT_EVENT', 'O evento de comentário não contém IDs oficiais válidos.');
        const username = typeof value.from.username === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(value.from.username) ? value.from.username : null;
        events.push({ eventId: sha([verifiedAccountId, change.field, commentId]), kind: 'comment', accountId: verifiedAccountId,
          commentId, mediaId: value.media.id, fromId: value.from.id, username, text: value.text ?? '',
          parentId: value.parent_id ?? null, at: new Date(receivedAt).toISOString(), commentCreatedAt: null });
      }
      for (const item of entry.messaging ?? []) {
        if (!item?.message) { unsupportedField(item?.postback ? 'messaging_postbacks' : item?.reaction ? 'message_reactions' : 'unknown'); continue; }
        const message = item.message;
        if (message.is_self || message.is_deleted || message.is_unsupported) { unsupportedField('messages'); continue; }
        const echo = message.is_echo === true;
        const senderId = item.sender?.id; const recipientId = item.recipient?.id;
        if (!numeric(senderId) || !numeric(recipientId) || (echo ? senderId !== verifiedAccountId : recipientId !== verifiedAccountId) ||
            senderId === recipientId || typeof message.mid !== 'string' || !MESSAGE_ID.test(message.mid) ||
            !Number.isSafeInteger(item.timestamp) || item.timestamp < 1 || item.timestamp > receivedAt ||
            (message.text !== undefined && !boundedText(message.text, 4000, true)) ||
            (message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length > 20))) {
          fail('INVALID_MESSAGE_EVENT', 'A mensagem precisa de destinatário, ID e horário oficiais válidos.');
        }
        const storyMention = message.attachments?.some(attachment => attachment?.type === 'story_mention') ?? false;
        const storyReply = object(message.reply_to?.story);
        if (storyReply && !numeric(message.reply_to.story.id)) fail('INVALID_MESSAGE_EVENT', 'A resposta ao story precisa de ID válido.');
        const mediaOnly = !message.text?.trim();
        const kind = echo ? 'echo' : storyMention ? 'story_mention' : storyReply ? 'story_reply' : 'message';
        events.push({ eventId: sha([verifiedAccountId, echo ? 'outbound' : 'inbound', message.mid]), kind,
          accountId: verifiedAccountId, recipientId: echo ? recipientId : senderId, messageId: message.mid,
          username: null, text: message.text ?? (storyMention ? '[Menção em story]' : '[Mídia recebida]'),
          at: new Date(item.timestamp).toISOString(), mediaOnly });
      }
      if (events.length + unsupported.length > 500) fail('WEBHOOK_TOO_LARGE', 'A notificação contém eventos demais.');
    }
  }
  return { events, unsupported };
}

function initialInbox() { return { version: 1, events: {}, threads: {}, jobs: {}, attempts: {}, workerReview: null }; }
function validInbox(state) {
  if (!object(state) || state.version !== 1 || !['events', 'threads', 'jobs', 'attempts'].every(key => object(state[key])) ||
      Object.keys(state.events).length > 50_000 || Object.keys(state.threads).length > 1000 || Object.keys(state.jobs).length > 10_000 || Object.keys(state.attempts).length > 10_000) return false;
  for (const [key, thread] of Object.entries(state.threads)) {
    if (!/^[a-f0-9]{64}$/.test(key) || thread.id !== key || !numeric(thread.accountId) || !numeric(thread.recipientId) ||
        thread.verifiedRecipient !== true || !Array.isArray(thread.messages) || thread.messages.length > 200 ||
        !['handoff', 'aiEnabled', 'optout', 'quarantine'].every(field => typeof thread[field] === 'boolean') ||
        !Number.isInteger(thread.unreadCount) || thread.unreadCount < 0 ||
        (thread.automationRevision !== undefined && (!Number.isSafeInteger(thread.automationRevision) || thread.automationRevision < 0)) ||
        !thread.messages.every(m => object(m) && typeof m.id === 'string' && ['inbound', 'outbound'].includes(m.direction) && boundedText(m.text, 4000, true) && Number.isFinite(Date.parse(m.at)))) return false;
  }
  const jobStatuses = ['pending', 'processing', 'accepted', 'ignored', 'handoff', 'optout', 'unknown', 'rejected'];
  for (const [key, job] of Object.entries(state.jobs)) {
    if (!/^[a-f0-9]{64}$/.test(key) || job.id !== key || !state.threads[job.threadId] || !jobStatuses.includes(job.status) ||
        typeof job.inboundId !== 'string' || !Number.isFinite(Date.parse(job.inboundAt))) return false;
  }
  for (const [key, attempt] of Object.entries(state.attempts)) {
    if (!/^[a-f0-9]{64}$/.test(key) || attempt.id !== key || !state.threads[attempt.threadId] ||
        !['inflight', 'accepted', 'unknown', 'rejected'].includes(attempt.status) || !boundedText(attempt.text, 1000) ||
        !Number.isFinite(Date.parse(attempt.inboundAt)) || typeof attempt.inboundId !== 'string') return false;
  }
  return state.workerReview === null || (typeof state.workerReview === 'string' && /^[A-Z_]{1,64}$/.test(state.workerReview));
}

function append(thread, message) {
  const existing = thread.messages.find(existing => existing.id === message.id);
  if (!existing) thread.messages.push(message);
  else if (message.status !== 'echo') Object.assign(existing, message);
  thread.messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  thread.messages = thread.messages.slice(-200);
}

export class InboxService {
  #store; #clientProvider; #assistant; #clock; #allowInMemory; #worker = null; #stopping = false; #decisions = new Map();
  constructor({ dataDir = null, clientProvider, assistant = null, clock = Date.now, allowInMemory = false } = {}) {
    if (typeof clientProvider !== 'function' || typeof clock !== 'function') fail('INVALID_INBOX_CONFIG', 'Configure o acesso privado à conexão.');
    this.#store = new PrivateStateFile({ directory: dataDir && path.join(dataDir, 'inbox'), filename: 'inbox-state.json', initial: initialInbox, validate: validInbox });
    this.#clientProvider = clientProvider; this.#assistant = assistant; this.#clock = clock; this.#allowInMemory = allowInMemory;
    this.#assistant?.onConfigChange?.(() => { for (const controller of this.#decisions.values()) controller.abort(); });
  }
  #permissions(thread) {
    let reason;
    if (!thread.lastInboundAt || !thread.lastInboundId || !thread.verifiedRecipient) reason = 'VERIFIED_INBOUND_REQUIRED';
    else if (thread.optout) reason = 'CONTACT_OPTED_OUT';
    else if (thread.quarantine) reason = 'OUTCOME_REQUIRES_REVIEW';
    else if (thread.activeAttemptId) reason = 'SEND_IN_PROGRESS';
    else if (Date.parse(thread.lastInboundAt) > this.#clock() || this.#clock() - Date.parse(thread.lastInboundAt) >= DAY) reason = 'WINDOW_CLOSED';
    return { canReply: !reason, ...(reason ? { reason } : {}) };
  }
  #publicThread(thread) {
    const latest = thread.messages.at(-1);
    const inbound = Date.parse(thread.lastInboundAt);
    const windowOpen = Number.isFinite(inbound) && inbound <= this.#clock() && this.#clock() - inbound < DAY;
    return { id: thread.id, username: thread.username || `Contato ${thread.id.slice(0, 6)}`, lastMessageAt: latest?.at ?? thread.lastInboundAt,
      preview: Array.from(latest?.text ?? '').slice(0, 180).join(''), unreadCount: thread.unreadCount,
      lastMessageActor: latest?.actor ?? (latest?.direction === 'inbound' ? 'customer' : 'unknown'), lastMessageStatus: latest?.status ?? null,
      handoff: thread.handoff, aiEnabled: thread.aiEnabled, windowOpen,
      lastInboundAt: thread.lastInboundAt, quarantine: thread.quarantine, sendInProgress: Boolean(thread.activeAttemptId),
      windowClosesAt: Number.isFinite(inbound) ? new Date(inbound + DAY).toISOString() : null, channel: thread.channel,
      optout: thread.optout, reviewRequired: thread.quarantine || Boolean(thread.activeAttemptId) };
  }
  async list() {
    const state = await this.#store.read();
    return { threads: Object.values(state.threads).map(thread => this.#publicThread(thread)).sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)), status: statusDTO(state, Boolean(this.#worker), this.#stopping) };
  }
  async detail(threadId) {
    const state = await this.#store.read(); const thread = state.threads[threadId];
    if (!thread) fail('THREAD_NOT_FOUND', 'Conversa não encontrada.');
    return { thread: this.#publicThread(thread), messages: thread.messages.map(({ id, direction, text, at, status, actor, mediaOnly }) => ({ id, direction, text, at,
      actor: actor ?? (direction === 'inbound' ? 'customer' : 'unknown'), mediaOnly: mediaOnly === true, ...(status ? { status } : {}) })), permissions: this.#permissions(thread) };
  }
  async ingestWebhook(payload, options) {
    const normalized = normalizeInstagramWebhook(payload, { ...options, receivedAt: this.#clock() });
    // Global activation applies to future arrivals, never to a dormant backlog.
    const config = this.#assistant?.getConfig ? await this.#assistant.getConfig() : { enabled: false };
    return this.#store.update(state => {
      let ingested = 0; let duplicates = 0; let queued = 0;
      for (const event of normalized.events) {
        if (state.events[event.eventId]) { duplicates++; continue; }
        state.events[event.eventId] = { kind: event.kind, at: event.at };
        ingested++;
        if (event.kind === 'comment') continue; // A notification timestamp cannot establish a private-reply creation window.
        const threadId = sha([event.accountId, event.recipientId]);
        const thread = state.threads[threadId] ??= { id: threadId, accountId: event.accountId, recipientId: event.recipientId,
          verifiedRecipient: true, username: null, messages: [], unreadCount: 0, handoff: false, aiEnabled: true,
          optout: false, quarantine: false, activeAttemptId: null, automationRevision: 0, channel: 'instagram', lastInboundAt: null, lastInboundId: null };
        const knownAttempt = event.kind === 'echo' && Object.values(state.attempts).find(attempt => attempt.threadId === threadId && attempt.messageId === event.messageId);
        append(thread, { id: event.messageId, direction: event.kind === 'echo' ? 'outbound' : 'inbound', text: event.text, at: event.at, mediaOnly: event.mediaOnly,
          actor: event.kind !== 'echo' ? 'customer' : knownAttempt ? (knownAttempt.automatic ? 'assistant' : 'human') : 'unknown', status: knownAttempt ? knownAttempt.status : event.kind === 'echo' ? 'echo' : 'received' });
        if (event.kind === 'echo') {
          const known = Object.values(state.attempts).some(attempt => attempt.threadId === threadId && attempt.messageId === event.messageId);
          if (!known && thread.activeAttemptId) {
            // The echo can precede the send acknowledgement. Resolve after the
            // inflight send finishes; a different/manual echo still takes over.
            thread.pendingEchoIds = [...new Set([...(thread.pendingEchoIds ?? []), event.messageId])].slice(-20);
          } else if (!known) { thread.handoff = true; thread.aiEnabled = false; invalidateThread(state, thread, new Date(this.#clock()).toISOString()); this.#decisions.get(threadId)?.abort(); }
          continue;
        }
        thread.unreadCount++;
        if (!thread.lastInboundAt || Date.parse(event.at) >= Date.parse(thread.lastInboundAt)) {
          thread.lastInboundAt = event.at; thread.lastInboundId = event.messageId; thread.lastInboundKind = event.kind;
        }
        thread.channel = event.kind.startsWith('story_') ? 'story' : 'instagram';
        if (isOptOutCommand(event.text)) { thread.optout = true; thread.handoff = true; thread.aiEnabled = false; invalidateThread(state, thread, new Date(this.#clock()).toISOString()); this.#decisions.get(threadId)?.abort(); }
        const future = (!config.activatedAt || Date.parse(event.at) >= Date.parse(config.activatedAt)) &&
          (!thread.automationActivatedAt || Date.parse(event.at) >= Date.parse(thread.automationActivatedAt));
        const active = config.enabled && thread.aiEnabled && !thread.handoff && future;
        state.jobs[event.eventId] = { id: event.eventId, threadId, inboundId: event.messageId, inboundAt: event.at,
          activationEpoch: configEpoch(config), automationRevision: threadRevision(thread),
          kind: event.kind, text: event.text, mediaOnly: event.mediaOnly, status: thread.optout ? 'optout' : active ? 'pending' : 'ignored' };
        if (!thread.optout && active) queued++;
      }
      return { ingested, duplicates, queued, unsupported: normalized.unsupported };
    });
  }
  async setHandoff(threadId, { enabled }) {
    if (typeof enabled !== 'boolean') fail('INVALID_THREAD_CONFIG', 'Informe enabled como booleano.');
    await this.#store.update(state => { const thread = state.threads[threadId]; if (!thread) fail('THREAD_NOT_FOUND', 'Conversa não encontrada.'); thread.handoff = enabled; if (enabled) thread.aiEnabled = false;
      invalidateThread(state, thread, new Date(this.#clock()).toISOString()); return null; });
    this.#decisions.get(threadId)?.abort();
    return this.detail(threadId);
  }
  async setAssistant(threadId, { enabled }) {
    if (typeof enabled !== 'boolean') fail('INVALID_THREAD_CONFIG', 'Informe enabled como booleano.');
    await this.#store.update(state => { const thread = state.threads[threadId]; if (!thread) fail('THREAD_NOT_FOUND', 'Conversa não encontrada.');
      if (enabled && (thread.optout || thread.quarantine || thread.activeAttemptId)) fail('ASSISTANT_BLOCKED', 'A conversa precisa de revisão humana.');
      thread.aiEnabled = enabled; if (enabled) { thread.handoff = false; thread.automationActivatedAt = new Date(this.#clock()).toISOString(); }
      invalidateThread(state, thread, new Date(this.#clock()).toISOString()); return null; });
    this.#decisions.get(threadId)?.abort();
    return this.detail(threadId);
  }
  // Private server context: never return this method through HTTP.
  async getContext(threadId) {
    const state = await this.#store.read(); const thread = state.threads[threadId];
    if (!thread) fail('THREAD_NOT_FOUND', 'Conversa não encontrada.');
    return { threadId, accountId: thread.accountId, recipientId: thread.recipientId, verifiedRecipient: thread.verifiedRecipient,
      inboundId: thread.lastInboundId, inboundAt: thread.lastInboundAt, kind: thread.lastInboundKind,
      handoff: thread.handoff, optout: thread.optout, aiEnabled: thread.aiEnabled,
      automationRevision: threadRevision(thread),
      messages: thread.messages.filter(message => message.direction === 'inbound' || !['sending', 'rejected', 'unknown'].includes(message.status)).slice(-20).map(({ direction, text, at }) => ({ direction, text, at })) };
  }
  async #reserveReply(threadId, { text, requestId, inboundId = null, automatic = false, feature = null, automationRevision = null, activationEpoch = null }) {
    if (!this.#store.persistent && !this.#allowInMemory) fail('PERSISTENCE_REQUIRED', 'Envios precisam de estado privado persistente.');
    if (!boundedText(text, 1000) || typeof requestId !== 'string' || !UUID.test(requestId)) fail('INVALID_REPLY', 'Informe texto de até 1000 bytes e requestId UUID estável.');
    return this.#store.update(state => {
      const thread = state.threads[threadId]; if (!thread) fail('THREAD_NOT_FOUND', 'Conversa não encontrada.');
      const attemptId = sha([threadId, requestId]);
      if (state.attempts[attemptId]) {
        const existing = state.attempts[attemptId];
        if (existing.text !== text) fail('REQUEST_ID_REUSED', 'O requestId já está ligado a outro texto.');
        return { duplicate: true, attempt: existing };
      }
      const permission = this.#permissions(thread); if (!permission.canReply) fail(permission.reason, 'A conversa não está elegível para envio agora.');
      if (automatic && (!thread.aiEnabled || thread.handoff || thread.lastInboundId !== inboundId ||
          (automationRevision !== null && threadRevision(thread) !== automationRevision))) fail('ASSISTANT_BLOCKED', 'O atendimento automático foi pausado ou chegou uma nova mensagem.');
      const attempt = { id: attemptId, requestId, threadId, accountId: thread.accountId, recipientId: thread.recipientId,
        inboundId: thread.lastInboundId, inboundAt: thread.lastInboundAt, status: 'inflight', text, at: new Date(this.#clock()).toISOString(), automatic, feature, kind: thread.lastInboundKind,
        automationRevision: threadRevision(thread), activationEpoch };
      state.attempts[attemptId] = attempt; thread.activeAttemptId = attemptId;
      append(thread, { id: `attempt:${attempt.id}`, direction: 'outbound', text, at: attempt.at, actor: automatic ? 'assistant' : 'human', status: 'sending', mediaOnly: false });
      if (!automatic) { thread.handoff = true; thread.aiEnabled = false; invalidateThread(state, thread, attempt.at); this.#decisions.get(threadId)?.abort(); }
      return { duplicate: false, attempt };
    });
  }
  async #finishReply(attempt, outcome, result = {}) {
    return this.#store.update(state => {
      const existing = state.attempts[attempt.id]; const thread = state.threads[attempt.threadId];
      if (!existing || existing.status !== 'inflight' || thread.activeAttemptId !== attempt.id) fail('SEND_STATE_CONFLICT', 'O resultado do envio precisa de revisão.');
      existing.status = outcome; existing.finishedAt = new Date(this.#clock()).toISOString();
      if (result.messageId) existing.messageId = result.messageId;
      if (result.errorCode) existing.errorCode = result.errorCode;
      thread.activeAttemptId = null;
      const uncorrelatedEcho = (thread.pendingEchoIds ?? []).some(mid => mid !== result.messageId &&
        !Object.values(state.attempts).some(item => item.threadId === thread.id && item.messageId === mid));
      thread.pendingEchoIds = [];
      if (uncorrelatedEcho || outcome === 'unknown') {
        thread.handoff = true; thread.aiEnabled = false; if (outcome === 'unknown') thread.quarantine = true;
        invalidateThread(state, thread, existing.finishedAt); this.#decisions.get(thread.id)?.abort();
      }
      if (result.messageId) thread.messages = thread.messages.filter(message => message.id !== `attempt:${attempt.id}`);
      append(thread, { id: result.messageId ?? `attempt:${attempt.id}`, direction: 'outbound', text: attempt.text, at: existing.finishedAt, status: outcome,
        actor: attempt.automatic ? 'assistant' : 'human', mediaOnly: false });
      return { outcome, ...(result.messageId ? { messageId: result.messageId } : {}), ...(result.errorCode ? { code: result.errorCode } : {}) };
    });
  }
  async reply(threadId, { text, requestId, inboundId = null, automatic = false, feature = null, automationRevision = null, activationEpoch = null } = {}) {
    if (this.#stopping && !automatic) fail('INBOX_STOPPING', 'O atendimento está encerrando; nenhuma nova tentativa foi iniciada.');
    if (automatic && !['faq', 'sales', 'story', null].includes(feature)) fail('INVALID_REPLY', 'Recurso automático inválido.');
    const reserved = await this.#reserveReply(threadId, { text, requestId, inboundId, automatic, feature, automationRevision, activationEpoch });
    if (reserved.duplicate) return { outcome: reserved.attempt.status === 'inflight' ? 'unknown' : reserved.attempt.status, duplicate: true, ...(reserved.attempt.messageId ? { messageId: reserved.attempt.messageId } : {}) };
    const attempt = reserved.attempt;
    let context;
    const beforeSend = async () => {
      const config = automatic ? await this.#assistant?.getConfig?.() : null;
      if (automatic && (!automaticEligible(config, attempt.kind, attempt.feature) || configEpoch(config) !== attempt.activationEpoch)) fail('SEND_GATE_CHANGED', 'O recurso automático foi desativado antes do envio.');
      const current = await this.#store.read(); const thread = current.threads[threadId];
      if (automatic && this.#assistant?.isConfigCurrent?.(attempt.activationEpoch) === false) fail('SEND_GATE_CHANGED', 'A configuração mudou antes do envio.');
      if (thread.optout || thread.quarantine || thread.activeAttemptId !== attempt.id ||
          (thread.pendingEchoIds?.length ?? 0) > 0 ||
          (automatic && (!thread.aiEnabled || thread.handoff || thread.lastInboundId !== attempt.inboundId || threadRevision(thread) !== attempt.automationRevision)) ||
          this.#clock() - Date.parse(attempt.inboundAt) >= DAY || Date.parse(attempt.inboundAt) > this.#clock()) fail('SEND_GATE_CHANGED', 'A janela ou o atendimento mudou antes do envio.');
    };
    try {
      context = await this.#clientProvider();
      if (context?.identity?.userId !== attempt.accountId || typeof context?.client?.sendContinuation !== 'function') fail('CONNECTION_ACCOUNT_MISMATCH', 'A conexão não confirmou a conta desta conversa.');
      await beforeSend();
    } catch (error) { return this.#finishReply(attempt, 'rejected', { errorCode: safeCode(error) }); }
    try {
      const result = await context.client.sendContinuation(attempt.accountId, attempt.recipientId, { text }, {
        lastInboundAt: attempt.inboundAt, idempotencyKey: `inbox:${attempt.id}`, beforeSend,
      });
      if (result?.outcome !== 'accepted' || typeof result.messageId !== 'string' || !MESSAGE_ID.test(result.messageId) || result.recipientId !== attempt.recipientId) {
        fail('INVALID_SEND_ACCEPTANCE', 'O aceite da API não contém IDs válidos.');
      }
      return await this.#finishReply(attempt, 'accepted', { messageId: result.messageId });
    } catch (error) {
      const unknown = error.outcome !== 'rejected';
      const result = await this.#finishReply(attempt, unknown ? 'unknown' : 'rejected', { errorCode: safeCode(error) });
      if ([4, 10, 17, 32, 190, 200, 613, 80002].includes(error.graphCode)) {
        await this.#store.update(state => { state.workerReview = 'META_REJECTION_REQUIRES_REVIEW'; return null; });
      }
      return result;
    }
  }
  async processPending({ maximum = 5 } = {}) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 5) fail('INVALID_WORKER_LIMIT', 'O worker processa até cinco mensagens por ciclo.');
    if (this.#stopping) return { processed: 0, disabled: true, stopping: true };
    if (this.#worker) return this.#worker;
    const run = async () => {
      if (!this.#assistant || typeof this.#assistant.makeDecision !== 'function' || typeof this.#assistant.getConfig !== 'function') return { processed: 0, disabled: true };
      let processed = 0;
      while (processed < maximum && !this.#stopping) {
        const config = await this.#assistant.getConfig();
        if (!config.enabled) return { processed, disabled: true };
        if (!['faq', 'sales', 'story'].some(feature => automaticEligible(config, feature === 'story' ? 'story_mention' : 'message', feature))) return { processed, disabled: false, unavailable: true };
        const reservation = await this.#store.update(state => {
          if (state.workerReview || this.#stopping) return null;
          // Purge obsolete generations in one durable pass so a large paused
          // backlog cannot delay fresh DMs behind the per-cycle send limit.
          for (const pending of Object.values(state.jobs)) if (pending.status === 'pending' &&
              (!sameGeneration(state.threads[pending.threadId], pending, config) || this.#clock() - Date.parse(pending.inboundAt) >= DAY || Date.parse(pending.inboundAt) > this.#clock())) {
            pending.status = 'ignored'; pending.finishedAt = new Date(this.#clock()).toISOString();
          }
          const job = Object.values(state.jobs).find(item => item.status === 'pending'); if (!job) return null;
          const thread = state.threads[job.threadId];
          if (thread.handoff || thread.optout || thread.quarantine || thread.activeAttemptId || !thread.aiEnabled ||
              !sameGeneration(thread, job, config) ||
              thread.lastInboundId !== job.inboundId || !this.#permissions(thread).canReply ||
              ((job.kind === 'story_reply' || job.kind === 'story_mention') && (!config.storyEnabled || !config.eligibility?.story?.eligible)) ||
              (job.kind === 'message' && !config.eligibility?.faq?.eligible && !config.eligibility?.sales?.eligible)) {
            job.status = thread.optout ? 'optout' : 'ignored'; return { skipped: true };
          }
          job.status = 'processing'; job.requestId = randomUUID();
          return { job: clone(job) };
        });
        if (!reservation) break;
        processed++;
        if (reservation.skipped) continue;
        const job = reservation.job;
        const controller = new AbortController(); this.#decisions.set(job.threadId, controller);
        let decision;
        try {
          const context = await this.getContext(job.threadId);
          const latestConfig = await this.#assistant.getConfig();
          if (controller.signal.aborted || context.handoff || !context.aiEnabled || !sameGeneration({ ...context, lastInboundId: context.inboundId }, job, latestConfig) ||
              !latestConfig.enabled || this.#assistant?.isConfigCurrent?.(job.activationEpoch ?? null) === false) decision = { action: 'ignore' };
          else decision = job.mediaOnly && job.kind !== 'story_mention' ? { action: 'handoff', reason: 'MEDIA_REQUIRES_HUMAN' } : await this.#assistant.makeDecision({ ...context, inboundId: job.inboundId, inboundAt: job.inboundAt, text: job.text, kind: job.kind, signal: controller.signal });
        }
        catch { decision = { action: 'handoff', reason: 'ASSISTANT_DECISION_FAILED' }; }
        finally { if (this.#decisions.get(job.threadId) === controller) this.#decisions.delete(job.threadId); }
        if (!['reply', 'handoff', 'optout', 'ignore'].includes(decision?.action) || (decision.action === 'reply' && !boundedText(decision.text, 1000))) decision = { action: 'handoff', reason: 'ASSISTANT_DECISION_INVALID' };
        let outcome = decision.action;
        if (decision.action === 'reply') {
          const latestConfig = await this.#assistant.getConfig();
          if (controller.signal.aborted || configEpoch(latestConfig) !== job.activationEpoch || !automaticEligible(latestConfig, job.kind, decision.feature ?? null)) outcome = 'ignored';
          else {
            try { outcome = (await this.reply(job.threadId, { text: decision.text, requestId: job.requestId, inboundId: job.inboundId, automatic: true, feature: decision.feature ?? null,
              automationRevision: job.automationRevision ?? 0, activationEpoch: job.activationEpoch ?? null })).outcome; }
            catch { outcome = 'handoff'; }
          }
        }
        const commitConfig = await this.#assistant.getConfig();
        await this.#store.update(state => {
          const current = state.jobs[job.id]; const thread = state.threads[job.threadId];
          // Record actual send outcomes, but obsolete model decisions cannot
          // opt out or take over a conversation after a newer intervention.
          const sent = ['accepted', 'unknown', 'rejected'].includes(outcome);
          if (!sent && (current.status !== 'processing' || controller.signal.aborted || !commitConfig.enabled || !sameGeneration(thread, job, commitConfig) || this.#assistant?.isConfigCurrent?.(job.activationEpoch ?? null) === false)) {
            if (current.status === 'processing') { current.status = 'ignored'; current.finishedAt = new Date(this.#clock()).toISOString(); }
            return null;
          }
          current.status = outcome === 'ignore' ? 'ignored' : outcome;
          if (outcome === 'handoff' || outcome === 'optout') { thread.handoff = true; thread.aiEnabled = false; if (outcome === 'optout') thread.optout = true; invalidateThread(state, thread, new Date(this.#clock()).toISOString()); }
          current.finishedAt = new Date(this.#clock()).toISOString(); return null;
        });
        if (outcome === 'unknown') break;
      }
      return { processed, disabled: false };
    };
    this.#worker = run();
    try { return await this.#worker; } finally { this.#worker = null; }
  }
  async status() {
    return statusDTO(await this.#store.read(), Boolean(this.#worker), this.#stopping);
  }
  async shutdown() { this.#stopping = true; if (this.#worker) await this.#worker; return this.status(); }
}
