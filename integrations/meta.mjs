// Server-only Instagram Login connector. Importing this module performs no I/O.
import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const GRAPH_ORIGIN = 'https://graph.instagram.com';
const DAY = 24 * 60 * 60 * 1000;
const STATUSES = new Set(['inflight', 'sent', 'unknown', 'rejected']);

export class MetaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MetaError';
    this.code = code;
    // Never attach provider messages, request URLs, payloads or credential-bearing causes.
    for (const field of ['outcome', 'httpStatus', 'graphCode', 'graphSubcode', 'isTransient', 'status']) {
      if (details[field] !== undefined) this[field] = details[field];
    }
  }
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MetaError('CONFIG_REQUIRED', `${name} precisa estar configurado no servidor.`);
  }
  return value;
}

function id(value, name) {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value)) {
    throw new MetaError('INVALID_ID', `${name} precisa ser um ID numérico da API oficial.`);
  }
  return value;
}

function textMessage(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 1000) {
    throw new MetaError('INVALID_MESSAGE', 'A mensagem precisa conter texto com até 1000 bytes em UTF-8.');
  }
  return value;
}

function timestamp(value, now, maximumAge, code) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || parsed > now || now - parsed > maximumAge) {
    throw new MetaError(code, 'O envio precisa de um evento elegível dentro da janela permitida.');
  }
  return parsed;
}

export function loadMetaConfig(env = process.env) {
  const config = {
    accessToken: required(env.BENION_META_ACCESS_TOKEN, 'BENION_META_ACCESS_TOKEN'),
    appSecret: required(env.BENION_META_APP_SECRET, 'BENION_META_APP_SECRET'),
    verifyToken: required(env.BENION_META_VERIFY_TOKEN, 'BENION_META_VERIFY_TOKEN'),
    accountId: id(required(env.BENION_META_ACCOUNT_ID, 'BENION_META_ACCOUNT_ID'), 'BENION_META_ACCOUNT_ID'),
    apiVersion: required(env.BENION_META_API_VERSION, 'BENION_META_API_VERSION'),
    ledgerDirectory: env.BENION_META_LEDGER_DIR || null,
  };
  if (!/^v\d+\.0$/.test(config.apiVersion)) {
    throw new MetaError('INVALID_VERSION', 'BENION_META_API_VERSION precisa ter o formato v26.0.');
  }
  if (config.ledgerDirectory && !path.isAbsolute(config.ledgerDirectory)) {
    throw new MetaError('INVALID_LEDGER_PATH', 'BENION_META_LEDGER_DIR precisa ser um caminho absoluto privado.');
  }
  return config;
}

export function validateWebhookSignature(rawBody, signature, appSecret) {
  required(appSecret, 'App Secret');
  if (!(typeof rawBody === 'string' || rawBody instanceof Uint8Array) ||
      typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  return received.length === expected.length && timingSafeEqual(expected, received);
}

export function verifyWebhookQuery(query, verifyToken) {
  required(verifyToken, 'Verify Token');
  const get = key => query instanceof URLSearchParams
    ? (query.getAll(key).length === 1 ? query.get(key) : null)
    : query?.[key];
  const token = get('hub.verify_token');
  const challenge = get('hub.challenge');
  const matches = typeof token === 'string' &&
    Buffer.byteLength(token) === Buffer.byteLength(verifyToken) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken));
  if (get('hub.mode') !== 'subscribe' || !matches ||
      typeof challenge !== 'string' || !/^\d{1,100}$/.test(challenge)) {
    return { status: 403, body: 'Forbidden' };
  }
  return { status: 200, body: challenge };
}

function ledgerIdentity(accountId, kind, key) {
  id(accountId, 'accountId');
  if (!['private', 'continuation', 'public'].includes(kind) ||
      typeof key !== 'string' || !key.trim() || key.length > 200) {
    throw new MetaError('INVALID_LEDGER_KEY', 'A tentativa precisa de uma chave estável de idempotência.');
  }
  return createHash('sha256').update(JSON.stringify([accountId, kind, key])).digest('hex');
}

// An exclusive per-operation file reserves the send across clients/processes.
// inflight is deliberately never expired automatically: a crashed send may have succeeded.
export class SendLedger {
  #directory;
  #records = new Map();
  #clock;

  constructor({ directory = null, clock = Date.now } = {}) {
    if (directory !== null && (typeof directory !== 'string' || !path.isAbsolute(directory))) {
      throw new MetaError('INVALID_LEDGER_PATH', 'O diretório do ledger precisa ser absoluto.');
    }
    this.#directory = directory;
    this.#clock = clock;
  }

  #file(identity) { return path.join(this.#directory, `${identity}.json`); }

  async #write(file, record) {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
  }

  async get(accountId, kind, key) {
    const identity = ledgerIdentity(accountId, kind, key);
    let record;
    if (!this.#directory) record = this.#records.get(identity);
    else {
      try { record = JSON.parse(await readFile(this.#file(identity), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new MetaError('LEDGER_UNREADABLE', 'Não foi possível verificar o registro de envio.');
      }
    }
    if (!record) return null;
    if (record.version !== 1 || record.accountId !== accountId || record.kind !== kind ||
        record.key !== key || !STATUSES.has(record.status) || typeof record.attemptId !== 'string') {
      throw new MetaError('LEDGER_INVALID', 'O registro de envio precisa de revisão manual.');
    }
    return structuredClone(record);
  }

  async reserve(accountId, kind, key) {
    const identity = ledgerIdentity(accountId, kind, key);
    const record = {
      version: 1, accountId, kind, key, attemptId: randomUUID(), status: 'inflight',
      reservedAt: new Date(this.#clock()).toISOString(),
    };
    if (!this.#directory) {
      const existing = this.#records.get(identity);
      if (existing) throw new MetaError('DUPLICATE_SEND', 'Esta operação já possui uma tentativa registrada.', { status: existing.status });
      this.#records.set(identity, record);
    } else {
      try {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        await this.#write(this.#file(identity), record);
      } catch (error) {
        if (error.code === 'EEXIST') {
          const existing = await this.get(accountId, kind, key);
          throw new MetaError('DUPLICATE_SEND', 'Esta operação já possui uma tentativa registrada.', { status: existing?.status || 'unknown' });
        }
        throw new MetaError('LEDGER_UNWRITABLE', 'Não foi possível reservar o envio; nenhuma solicitação foi iniciada.');
      }
    }
    return structuredClone(record);
  }

  async finish(reservation, result) {
    const { accountId, kind, key, attemptId } = reservation;
    const identity = ledgerIdentity(accountId, kind, key);
    const existing = await this.get(accountId, kind, key);
    if (!existing || existing.status !== 'inflight' || existing.attemptId !== attemptId ||
        !STATUSES.has(result.status) || result.status === 'inflight') {
      throw new MetaError('LEDGER_CONFLICT', 'A reserva de envio precisa de revisão manual.');
    }
    const record = { ...existing, status: result.status, finishedAt: new Date(this.#clock()).toISOString() };
    for (const field of ['outcome', 'messageId', 'recipientId', 'commentReplyId', 'errorCode', 'graphCode', 'source']) {
      if (result[field] !== undefined) record[field] = result[field];
    }
    if (!this.#directory) this.#records.set(identity, record);
    else {
      const temporary = `${this.#file(identity)}.${attemptId}.tmp`;
      try {
        await this.#write(temporary, record);
        await rename(temporary, this.#file(identity));
      } catch {
        await unlink(temporary).catch(() => {});
        throw new MetaError('LEDGER_UNWRITABLE', 'O resultado não foi persistido; a reserva continua bloqueada.', { outcome: 'unknown' });
      }
    }
    return structuredClone(record);
  }

  async importHandledComments(accountId, comments) {
    id(accountId, 'accountId');
    if (!Array.isArray(comments)) throw new MetaError('INVALID_IMPORT', 'Informe os IDs canônicos dos comentários tratados.');
    // Validate the entire input before reserving any records.
    for (const comment of comments) {
      id(comment.commentId, 'commentId');
      if (comment.status !== 'sent' && comment.status !== 'unknown') {
        throw new MetaError('INVALID_IMPORT', 'A importação aceita apenas sent ou unknown.');
      }
      required(comment.source, 'source');
    }
    const imported = [];
    for (const comment of comments) {
      try {
        const reservation = await this.reserve(accountId, 'private', comment.commentId);
        imported.push(await this.finish(reservation, {
          status: comment.status, outcome: 'external_handled', source: comment.source,
        }));
      } catch (error) {
        if (error.code !== 'DUPLICATE_SEND') throw error;
      }
    }
    return imported;
  }
}

export class GraphClient {
  #accessToken;
  #accessTokenProvider;
  #apiVersion;
  #accountId;
  #fetch;
  #ledger;
  #timeoutMs;
  #clock;

  constructor({ accessToken, accessTokenProvider = null, apiVersion, accountId, ledger, fetchImpl = globalThis.fetch, timeoutMs = 15000, clock = Date.now }) {
    this.#accessToken = required(accessToken, 'Access Token');
    if (accessTokenProvider !== null && typeof accessTokenProvider !== 'function') throw new MetaError('INVALID_CLIENT_CONFIG', 'Configuração de credencial inválida.');
    this.#accessTokenProvider = accessTokenProvider;
    this.#apiVersion = required(apiVersion, 'API Version');
    if (!/^v\d+\.0$/.test(apiVersion)) throw new MetaError('INVALID_VERSION', 'A versão da API precisa ser explícita.');
    this.#accountId = id(accountId, 'accountId');
    if (!(ledger instanceof SendLedger)) throw new MetaError('LEDGER_REQUIRED', 'Configure o ledger antes de enviar mensagens.');
    if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
      throw new MetaError('INVALID_CLIENT_CONFIG', 'Configuração de transporte inválida.');
    }
    this.#ledger = ledger;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#clock = clock;
  }

  #assertAccount(accountId) {
    id(accountId, 'accountId');
    if (accountId !== this.#accountId) throw new MetaError('ACCOUNT_MISMATCH', 'O envio precisa usar a conta configurada no servidor.');
  }

  async #request(method, objectId, edge, { query = {}, body } = {}) {
    const url = new URL(`${GRAPH_ORIGIN}/${this.#apiVersion}/${id(objectId, 'objectId')}/${edge}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(url, {
            method, redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${this.#accessTokenProvider ? required(await this.#accessTokenProvider(), 'Access Token') : this.#accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          let data;
          try { data = await response.json(); }
          catch { throw new MetaError('INVALID_GRAPH_RESPONSE', 'A API não retornou um resultado JSON conclusivo.', { outcome: method === 'POST' ? 'unknown' : 'none', httpStatus: response.status }); }
          if (!response.ok || data?.error) {
            const error = data?.error;
            const ambiguous = response.status >= 500 || !error || !Number.isInteger(error.code);
            throw new MetaError('GRAPH_REJECTED', 'A API não confirmou o envio.', {
              outcome: method === 'POST' ? (ambiguous ? 'unknown' : 'rejected') : 'none',
              httpStatus: response.status,
              ...(Number.isInteger(error?.code) ? { graphCode: error.code } : {}),
              ...(Number.isInteger(error?.error_subcode) ? { graphSubcode: error.error_subcode } : {}),
              ...(typeof error?.is_transient === 'boolean' ? { isTransient: error.is_transient } : {}),
            });
          }
          return data;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new MetaError('NETWORK_TIMEOUT', 'A solicitação expirou sem resultado conclusivo.', { outcome: method === 'POST' ? 'unknown' : 'none' }));
          }, this.#timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof MetaError) throw error;
      throw new MetaError('NETWORK_ERROR', 'A solicitação terminou sem resposta conclusiva.', { outcome: method === 'POST' ? 'unknown' : 'none' });
    } finally { clearTimeout(timer); }
  }

  async listComments(mediaId, { maxPages = 10, pageSize = 50, after = null } = {}) {
    id(mediaId, 'mediaId');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 ||
        (after !== null && (typeof after !== 'string' || !after || after.length > 4096))) {
      throw new MetaError('INVALID_PAGINATION', 'Use de 1 a 100 páginas, com até 50 comentários por página.');
    }
    const comments = new Map();
    const seenCursors = new Set(after ? [after] : []);
    let cursor = after;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.#request('GET', mediaId, 'comments', { query: {
        fields: 'id,text,timestamp,username,from,parent_id', limit: pageSize, ...(cursor ? { after: cursor } : {}),
      } });
      if (!Array.isArray(data?.data) || data.data.length > pageSize) {
        throw new MetaError('INVALID_GRAPH_RESPONSE', 'A lista de comentários não possui o formato esperado.');
      }
      for (const comment of data.data) {
        id(comment?.id, 'commentId');
        if ((comment.text != null && typeof comment.text !== 'string') || typeof comment.timestamp !== 'string' || !Number.isFinite(Date.parse(comment.timestamp))) {
          throw new MetaError('INVALID_GRAPH_RESPONSE', 'Um comentário não possui campos e data válidos.');
        }
        comments.set(comment.id, {
          id: comment.id, timestamp: comment.timestamp,
          ...(typeof comment.text === 'string' ? { text: comment.text } : {}),
          ...(typeof comment.username === 'string' ? { username: comment.username } : {}),
          ...(typeof comment.from?.username === 'string' ? { fromUsername: comment.from.username } : {}),
          ...(typeof comment.from?.id === 'string' && /^\d{1,40}$/.test(comment.from.id) ? { fromId: comment.from.id } : {}),
          ...(typeof comment.parent_id === 'string' ? { parentId: comment.parent_id } : {}),
        });
      }
      if (!data.paging?.next) return { comments: [...comments.values()], pages: page, truncated: false, nextCursor: null };
      cursor = data.paging?.cursors?.after;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || seenCursors.has(cursor)) {
        throw new MetaError('INVALID_PAGINATION', 'A API retornou uma paginação incompleta ou repetida.');
      }
      seenCursors.add(cursor);
      if (page === maxPages) return { comments: [...comments.values()], pages: page, truncated: true, nextCursor: cursor };
    }
  }

  async createReelContainer(accountId, { videoUrl, caption }) {
    this.#assertAccount(accountId);
    let url;
    try { url = new URL(videoUrl); } catch { throw new MetaError('INVALID_VIDEO_URL', 'Informe um vídeo HTTPS público.'); }
    if (url.protocol !== 'https:' || url.username || url.password || typeof caption !== 'string' || [...caption].length > 2200) {
      throw new MetaError('INVALID_REEL', 'Revise o vídeo e a legenda.');
    }
    const data = await this.#request('POST', accountId, 'media', { body: { media_type: 'REELS', video_url: url.href, caption, share_to_feed: true } });
    if (!/^\d{1,40}$/.test(data?.id || '')) throw new MetaError('INVALID_GRAPH_RESPONSE', 'A Meta não confirmou o container.', { outcome: 'unknown' });
    return { id: data.id };
  }

  async reelContainerStatus(containerId) {
    const data = await this.#request('GET', id(containerId, 'containerId'), '', { query: { fields: 'status_code' } });
    if (!['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'].includes(data?.status_code)) throw new MetaError('INVALID_GRAPH_RESPONSE', 'Estado do vídeo indisponível.');
    return { status: data.status_code };
  }

  // The hosted publishing queue reserves this POST durably before calling it.
  async publishReel(accountId, containerId) {
    this.#assertAccount(accountId);
    const data = await this.#request('POST', accountId, 'media_publish', { body: { creation_id: id(containerId, 'containerId') } });
    if (!/^\d{1,40}$/.test(data?.id || '')) throw new MetaError('INVALID_GRAPH_RESPONSE', 'A Meta não confirmou o Reel.', { outcome: 'unknown' });
    return { id: data.id };
  }

  async listMedia(accountId, { maxPages = 10, pageSize = 50, after = null } = {}) {
    this.#assertAccount(accountId);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 ||
        (after !== null && (typeof after !== 'string' || !after || after.length > 4096))) {
      throw new MetaError('INVALID_PAGINATION', 'Use de 1 a 100 páginas, com até 50 mídias por página.');
    }
    const media = new Map();
    const seenCursors = new Set(after ? [after] : []);
    let cursor = after;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.#request('GET', accountId, 'media', { query: {
        fields: 'id,permalink,shortcode,comments_count', limit: pageSize, ...(cursor ? { after: cursor } : {}),
      } });
      if (!Array.isArray(data?.data) || data.data.length > pageSize) {
        throw new MetaError('INVALID_GRAPH_RESPONSE', 'A lista de mídias não possui o formato esperado.', { outcome: 'none' });
      }
      for (const item of data.data) {
        if (typeof item?.id !== 'string' || !/^\d{1,40}$/.test(item.id) ||
            typeof item.shortcode !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.shortcode) ||
            typeof item.permalink !== 'string') {
          throw new MetaError('INVALID_GRAPH_RESPONSE', 'Uma mídia não possui ID, shortcode e permalink válidos.', { outcome: 'none' });
        }
        let permalink;
        try { permalink = new URL(item.permalink); }
        catch { throw new MetaError('INVALID_GRAPH_RESPONSE', 'O permalink da mídia não é válido.', { outcome: 'none' }); }
        const parts = permalink.pathname.split('/').filter(Boolean);
        if (permalink.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(permalink.hostname) ||
            permalink.username || permalink.password || permalink.port || parts.length !== 2 ||
            !['p', 'reel', 'tv'].includes(parts[0]) || parts[1] !== item.shortcode) {
          throw new MetaError('INVALID_GRAPH_RESPONSE', 'O permalink não corresponde à mídia pública no Instagram.', { outcome: 'none' });
        }
        if (Object.hasOwn(item, 'comments_count') && (!Number.isSafeInteger(item.comments_count) || item.comments_count < 0)) {
          throw new MetaError('INVALID_GRAPH_RESPONSE', 'A contagem de comentários não é válida.', { outcome: 'none' });
        }
        // Return only public metadata; omit query/hash and all unrequested provider fields.
        media.set(item.id, { id: item.id, shortcode: item.shortcode, permalink: `${permalink.origin}${permalink.pathname}`,
          ...(Object.hasOwn(item, 'comments_count') ? { commentsCount: item.comments_count } : {}) });
      }
      if (!data.paging?.next) return { media: [...media.values()], pages: page, truncated: false, nextCursor: null };
      cursor = data.paging?.cursors?.after;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || seenCursors.has(cursor)) {
        throw new MetaError('INVALID_PAGINATION', 'A API retornou uma paginação de mídias incompleta ou repetida.', { outcome: 'none' });
      }
      seenCursors.add(cursor);
      if (page === maxPages) return { media: [...media.values()], pages: page, truncated: true, nextCursor: cursor };
    }
  }

  async listConversations(accountId, { pageSize = 1 } = {}) {
    this.#assertAccount(accountId);
    // This diagnostic deliberately samples one conversation and never reads message content.
    if (pageSize !== 1) throw new MetaError('INVALID_PAGINATION', 'O diagnóstico consulta somente uma conversa por vez.');
    const data = await this.#request('GET', accountId, 'conversations', { query: {
      platform: 'instagram', fields: 'id', limit: 1,
    } });
    if (!Array.isArray(data?.data) || data.data.length > 1 ||
        data.data.some(item => typeof item?.id !== 'string' || !/^[a-zA-Z0-9_:./+=-]{1,512}$/.test(item.id)) ||
        (data.paging?.next !== undefined && typeof data.paging.next !== 'string')) {
      throw new MetaError('INVALID_GRAPH_RESPONSE', 'A amostra de conversas não possui IDs válidos.', { outcome: 'none' });
    }
    const conversationIds = data.data.map(item => item.id);
    return { conversationIds, count: conversationIds.length, truncated: Boolean(data.paging?.next) };
  }

  async #send(accountId, kind, key, objectId, edge, body, validate, beforeSend = null) {
    const reservation = await this.#ledger.reserve(accountId, kind, key);
    // Continuation callers can recheck private conversation gates after the
    // durable reservation. A failed preflight confirms that no POST started.
    if (beforeSend) {
      try { await beforeSend(); }
      catch {
        const cancelled = new MetaError('SEND_GATE_CHANGED', 'O atendimento mudou antes do envio; nenhuma solicitação foi iniciada.', { outcome: 'rejected' });
        await this.#ledger.finish(reservation, { status: 'rejected', outcome: 'rejected', errorCode: cancelled.code });
        throw cancelled;
      }
    }
    let accepted;
    try { accepted = validate(await this.#request('POST', objectId, edge, { body })); }
    catch (error) {
      const safeError = error instanceof MetaError ? error : new MetaError('INVALID_GRAPH_RESPONSE', 'A API não retornou prova de aceite.', { outcome: 'unknown' });
      await this.#ledger.finish(reservation, {
        status: safeError.outcome === 'rejected' ? 'rejected' : 'unknown',
        outcome: safeError.outcome || 'unknown', errorCode: safeError.code,
        ...(safeError.graphCode !== undefined ? { graphCode: safeError.graphCode } : {}),
      });
      throw safeError;
    }
    await this.#ledger.finish(reservation, { status: 'sent', outcome: 'accepted', ...accepted });
    // accepted is API acknowledgement, not proof that the person received/read it.
    return { outcome: 'accepted', ...accepted };
  }

  #validateMessageResult(data, expectedRecipient = null) {
    if (typeof data?.message_id !== 'string' || !data.message_id.trim() ||
        typeof data?.recipient_id !== 'string' || !/^\d{1,40}$/.test(data.recipient_id) ||
        (expectedRecipient && data.recipient_id !== expectedRecipient)) {
      throw new MetaError('INVALID_GRAPH_RESPONSE', 'O aceite precisa incluir message_id e recipient_id válidos.', { outcome: 'unknown' });
    }
    return { messageId: data.message_id, recipientId: data.recipient_id };
  }

  async sendPrivateReply(accountId, commentId, text, { commentCreatedAt, beforeSend = null } = {}) {
    this.#assertAccount(accountId);
    id(commentId, 'commentId');
    textMessage(text);
    timestamp(commentCreatedAt, this.#clock(), 7 * DAY, 'PRIVATE_REPLY_WINDOW_CLOSED');
    if (beforeSend !== null && typeof beforeSend !== 'function') throw new MetaError('INVALID_SEND_GATE', 'A verificação antes do envio precisa ser uma função.', { outcome: 'none' });
    return this.#send(accountId, 'private', commentId, accountId, 'messages', {
      recipient: { comment_id: commentId }, message: { text },
    }, data => this.#validateMessageResult(data), beforeSend);
  }

  async sendContinuation(accountId, recipientId, payload, { lastInboundAt, idempotencyKey, beforeSend = null } = {}) {
    this.#assertAccount(accountId);
    id(recipientId, 'recipientId');
    if (beforeSend !== null && typeof beforeSend !== 'function') {
      throw new MetaError('INVALID_SEND_PREFLIGHT', 'A verificação de envio precisa ser interna ao servidor.');
    }
    // Narrow first connector: allow only text, so arbitrary recipient/tags cannot escape validation.
    if (!payload || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'text')) {
      throw new MetaError('INVALID_MESSAGE', 'Esta versão aceita payload { text } para continuação.');
    }
    textMessage(payload.text);
    const now = this.#clock();
    const inbound = timestamp(lastInboundAt, now, DAY, 'CONTINUATION_WINDOW_CLOSED');
    if (now - inbound >= DAY) throw new MetaError('CONTINUATION_WINDOW_CLOSED', 'A janela de 24 horas terminou.');
    ledgerIdentity(accountId, 'continuation', idempotencyKey);
    return this.#send(accountId, 'continuation', idempotencyKey, accountId, 'messages', {
      recipient: { id: recipientId }, message: { text: payload.text },
    }, data => this.#validateMessageResult(data, recipientId), beforeSend);
  }

  async sendPublicReply(accountId, commentId, text, { beforeSend = null } = {}) {
    this.#assertAccount(accountId);
    id(commentId, 'commentId');
    textMessage(text);
    if (beforeSend !== null && typeof beforeSend !== 'function') throw new MetaError('INVALID_SEND_GATE', 'A verificação antes do envio precisa ser uma função.', { outcome: 'none' });
    const privateReply = await this.#ledger.get(accountId, 'private', commentId);
    if (privateReply?.status !== 'sent' || privateReply.outcome !== 'accepted' ||
        !privateReply.messageId || !privateReply.recipientId) {
      throw new MetaError('PRIVATE_ACCEPTANCE_REQUIRED', 'A resposta pública depende de aceite comprovado da resposta privada.');
    }
    return this.#send(accountId, 'public', commentId, commentId, 'replies', { message: text }, data => {
      if (typeof data?.id !== 'string' || !/^\d{1,40}$/.test(data.id)) {
        throw new MetaError('INVALID_GRAPH_RESPONSE', 'A resposta pública não retornou seu ID.', { outcome: 'unknown' });
      }
      return { commentReplyId: data.id };
    }, beforeSend);
  }
}

export function createMetaClientFromEnv({ env = process.env, ledger, fetchImpl, timeoutMs, clock } = {}) {
  const config = loadMetaConfig(env);
  if (!ledger && !config.ledgerDirectory) {
    throw new MetaError('LEDGER_REQUIRED', 'Configure BENION_META_LEDGER_DIR antes de criar o cliente real.');
  }
  return new GraphClient({
    accessToken: config.accessToken, apiVersion: config.apiVersion, accountId: config.accountId,
    ledger: ledger || new SendLedger({ directory: config.ledgerDirectory, clock }), fetchImpl, timeoutMs, clock,
  });
}

// Read-only manual-token check. /me.user_id is the canonical professional ID;
// /me.id is app-scoped and may be different. Identity does not prove messaging scopes.
export async function inspectInstagramToken({ accessToken, apiVersion, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  required(accessToken, 'Access Token');
  required(apiVersion, 'API Version');
  if (!/^v\d+\.0$/.test(apiVersion)) throw new MetaError('INVALID_VERSION', 'A versão da API precisa ser explícita.');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new MetaError('INVALID_CLIENT_CONFIG', 'Configuração de transporte inválida.');
  }
  const url = new URL(`${GRAPH_ORIGIN}/${apiVersion}/me`);
  url.searchParams.set('fields', 'user_id,username,id');
  const controller = new AbortController();
  let timer;
  try {
    const data = await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        let body;
        try { body = await response.json(); }
        catch { throw new MetaError('IDENTITY_RESPONSE_INVALID', 'A API não retornou uma identidade verificável.', { outcome: 'none' }); }
        if (!response.ok || body?.error) {
          throw new MetaError('GRAPH_REJECTED', 'A API não confirmou a identidade deste token.', {
            outcome: 'none', httpStatus: response.status,
            ...(Number.isInteger(body?.error?.code) ? { graphCode: body.error.code } : {}),
            ...(Number.isInteger(body?.error?.error_subcode) ? { graphSubcode: body.error.error_subcode } : {}),
          });
        }
        return body;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MetaError('NETWORK_TIMEOUT', 'A verificação expirou sem resultado conclusivo.', { outcome: 'none' }));
        }, timeoutMs);
      }),
    ]);
    // The official guide shows {data:[identity]}; Graph can also return the object.
    const wrapped = Object.hasOwn(data || {}, 'data');
    if (wrapped && (!Array.isArray(data.data) || data.data.length !== 1 ||
        ['user_id', 'username', 'id'].some(field => Object.hasOwn(data, field)))) {
      throw new MetaError('IDENTITY_RESPONSE_INVALID', 'A resposta de identidade é ambígua.', { outcome: 'none' });
    }
    const identity = wrapped ? data.data[0] : data;
    if (typeof identity?.user_id !== 'string' || !/^\d{1,40}$/.test(identity.user_id) ||
        typeof identity?.username !== 'string' || !/^[a-zA-Z0-9._]{1,30}$/.test(identity.username) ||
        (identity.id !== undefined && (typeof identity.id !== 'string' || !/^\d{1,40}$/.test(identity.id)))) {
      throw new MetaError('IDENTITY_RESPONSE_INVALID', 'A resposta precisa de user_id e username oficiais válidos.', { outcome: 'none' });
    }
    // Do not expose extra provider fields, including any credential or unrequested scopes.
    return {
      userId: identity.user_id, username: identity.username, id: identity.id ?? null,
      permissions: null, permissionsVerified: false,
    };
  } catch (error) {
    if (error instanceof MetaError) throw error;
    throw new MetaError('NETWORK_ERROR', 'Não foi possível verificar a identidade deste token.', { outcome: 'none' });
  } finally { clearTimeout(timer); }
}

// Server-only. A successful refresh confirms the provider's long-lived-token eligibility.
export async function refreshInstagramToken({ accessToken, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  required(accessToken, 'Access Token');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new MetaError('INVALID_CLIENT_CONFIG', 'Configuração de transporte inválida.');
  }
  const url = new URL(`${GRAPH_ORIGIN}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', accessToken);
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal });
        let body;
        try { body = await response.json(); }
        catch { throw new MetaError('TOKEN_RESPONSE_INVALID', 'A Meta não confirmou a renovação.', { outcome: 'unknown' }); }
        if (!response.ok || body?.error) {
          throw new MetaError('GRAPH_REJECTED', 'A Meta recusou a renovação.', {
            outcome: 'rejected', httpStatus: response.status,
            ...(Number.isInteger(body?.error?.code) ? { graphCode: body.error.code } : {}),
            ...(Number.isInteger(body?.error?.error_subcode) ? { graphSubcode: body.error.error_subcode } : {}),
            isTransient: body?.error?.is_transient === true,
          });
        }
        if (typeof body?.access_token !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(body.access_token) ||
            !Number.isInteger(body.expires_in) || body.expires_in <= 0 || body.expires_in > 60 * 24 * 60 * 60 ||
            typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') {
          throw new MetaError('TOKEN_RESPONSE_INVALID', 'A Meta não confirmou a validade da renovação.', { outcome: 'unknown' });
        }
        return { accessToken: body.access_token, expiresIn: body.expires_in };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MetaError('NETWORK_TIMEOUT', 'A renovação expirou sem confirmação.', { outcome: 'unknown' }));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof MetaError) throw error;
    throw new MetaError('NETWORK_ERROR', 'Não foi possível confirmar a renovação.', { outcome: 'unknown' });
  } finally { clearTimeout(timer); }
}
