// Server-only owned-account registry. An optional configured primary account keeps
// the original root private layout; every registered account has its own runtime
// under accounts/<id>.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, chmod, lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { ConnectionService } from './connection.mjs';
import { InboxService, normalizeInstagramWebhook, modelReady } from './inbox.mjs';
import { CatalogStore, AssistantConfigStore, SalesAssistant, createSalesModelFromEnv } from './sales.mjs';
import { CampaignService } from './campaigns.mjs';
import { PublishingService } from './publishing.mjs';

const numeric = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const username = value => typeof value === 'string' && /^[a-z0-9_.]{1,30}$/.test(value);
const within = (directory, root) => { const relative = path.relative(root, directory); return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function validate(state, primary) {
  if (!state || state.version !== 1 || Object.keys(state).some(key => !['version', 'accounts'].includes(key)) || !Array.isArray(state.accounts) || state.accounts.length > 49) return false;
  const ids = new Set(primary ? [primary.id] : []); const names = new Set(primary ? [primary.username] : []);
  for (const item of state.accounts) {
    if (!item || Object.keys(item).length !== 3 || !numeric(item.id) || !username(item.username) || !Number.isFinite(Date.parse(item.createdAt)) || ids.has(item.id) || names.has(item.username)) return false;
    ids.add(item.id); names.add(item.username);
  }
  return true;
}

// legacy is the owner's legacy config with its recovery record, only for the primary account.
export function createAccountRuntime({ account, dataDir, servedRoot, inspectToken, env = process.env, fetchImpl = globalThis.fetch, clock = Date.now, modelProvider = null, legacy = null }) {
  if (!numeric(account?.id) || !username(account?.username)) fail('ACCOUNT_INVALID');
  const connection = new ConnectionService({ privateDirectory: dataDir, servedRoot, inspectToken, fetchImpl, clock,
    expectedUsername: account.username, expectedUserId: account.id, legacy });
  const provider = modelProvider ?? createSalesModelFromEnv({ env, fetchImpl });
  const catalog = new CatalogStore({ dataDir, clock });
  let inbox;
  const eligibilityProvider = async () => {
    const state = await inbox.status();
    const modelOk = modelReady(provider?.publicStatus?.());
    const ready = modelOk && !!env.BENION_META_APP_SECRET && connection.status().connected === true && state.receivedMessageCount > 0 && !state.reviewReason;
    const storyReady = ready && state.receivedStoryCount > 0;
    const reason = ready ? 'Mensagem assinada e identidade confirmadas. Valide o primeiro envio no Direct; cada resposta verifica a janela de 24 horas.' : !modelOk ? 'Salve e teste a chave da OpenRouter antes de ativar.' : 'Confirme a conexão e receba uma DM pelo webhook oficial antes de ativar.';
    return { faq: { eligible: ready, reason }, sales: { eligible: ready, reason }, story: { eligible: storyReady, reason: storyReady ? 'Interação de Story assinada recebida. Valide o primeiro envio no Direct.' : 'Receba uma menção ou resposta de Story pelo webhook oficial para validar este recurso.' } };
  };
  const assistantConfig = new AssistantConfigStore({ dataDir, provider, providerRequired: true, eligibilityProvider, clock });
  const assistant = new SalesAssistant({ catalogStore: catalog, configStore: assistantConfig, modelAdapter: provider });
  const previewConfig = { get: async () => ({ ...await assistantConfig.get(), enabled: true, faqEnabled: true, salesEnabled: true, storyEnabled: true,
    eligibility: { faq: { eligible: true }, sales: { eligible: true }, story: { eligible: true } } }) };
  // Preview uses the same model interpretation as live replies, without any send.
  const previewAssistant = new SalesAssistant({ catalogStore: catalog, configStore: previewConfig, modelAdapter: provider });
  inbox = new InboxService({ dataDir, clientProvider: () => connection.messagingContext(), assistant, clock });
  let publishing;
  const campaigns = new CampaignService({ dataDir, clientProvider: () => connection.messagingContext(), clock,
    mediaEligibility: async mediaId => { const routing = await publishing.routing(); return (!routing.blocked || routing.knownMediaIds.includes(mediaId)) && !routing.mediaIds.includes(mediaId); },
    accountId: account.id, accountUsername: account.username, legacy,
    recoveryProvider: legacy ? async scope => {
      try { return connection.campaignRecovery(scope); }
      catch (error) { if (error.code !== 'PREFLIGHT_REQUIRED') throw error; }
      // A restarted worker has no in-memory preflight. Recheck the original
      // recovery and durable ledgers before resuming with the saved cutoff.
      await connection.verifyAccess({});
      return connection.campaignRecovery(scope);
    } : null });
  publishing = new PublishingService({ dataDir, accountId: account.id, clientProvider: () => connection.messagingContext(), campaigns, clock, origin: env.BENION_PUBLIC_ORIGIN });
  const assertAssistantActivation = async input => {
    const current = await assistantConfig.get();
    const enabled = Object.hasOwn(input ?? {}, 'enabled') ? input.enabled : current.enabled;
    if (enabled !== true) return;
    if (!modelReady(provider?.publicStatus?.())) fail('MODEL_VERIFICATION_REQUIRED');
    for (const feature of ['faq', 'sales', 'story']) {
      const key = `${feature}Enabled`; const selected = Object.hasOwn(input ?? {}, key) ? input[key] : current[key];
      if (selected === true && current.eligibility[feature]?.eligible !== true) fail('ASSISTANT_ELIGIBILITY_REQUIRED');
    }
  };
  return { connection, inbox, catalog, assistantConfig, previewAssistant, campaigns, publishing, assertAssistantActivation, legacy };
}

export class AccountRegistry {
  #directory; #servedRoot; #inspect; #factory; #clock; #primary; #runtimes = new Map(); #rows = new Map(); #loaded = null; #queue = Promise.resolve();
  constructor({ privateDirectory, servedRoot, inspectToken, primaryAccount = null, primaryRuntime = null, runtimeFactory, clock = Date.now }) {
    if (!path.isAbsolute(privateDirectory) || !path.isAbsolute(servedRoot) || within(privateDirectory, servedRoot) || typeof inspectToken !== 'function' || typeof runtimeFactory !== 'function' ||
        (primaryAccount !== null && (!numeric(primaryAccount?.id) || !username(primaryAccount?.username) || !primaryRuntime?.connection))) fail('ACCOUNT_REGISTRY_INVALID');
    this.#directory = path.resolve(privateDirectory); this.#servedRoot = path.resolve(servedRoot); this.#inspect = inspectToken;
    this.#factory = runtimeFactory; this.#clock = clock;
    this.#primary = primaryAccount && { id: primaryAccount.id, username: primaryAccount.username };
    if (this.#primary) this.#runtimes.set(this.#primary.id, primaryRuntime);
  }
  async #read() {
    let handle;
    try {
      const directory = await lstat(this.#directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || within(await realpath(this.#directory), await realpath(this.#servedRoot))) fail('ACCOUNT_STORE_INVALID');
      handle = await open(path.join(this.#directory, 'accounts.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32_000 || stat.mode & 0o077) fail('ACCOUNT_STORE_INVALID');
      const state = JSON.parse(await handle.readFile('utf8'));
      if (!validate(state, this.#primary)) fail('ACCOUNT_STORE_INVALID');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, accounts: [] };
      if (error.code === 'ACCOUNT_STORE_INVALID') throw error;
      fail('ACCOUNT_STORE_UNREADABLE');
    } finally { await handle?.close(); }
  }
  async #load() {
    this.#loaded ||= (async () => {
      const state = await this.#read();
      if (state.accounts.length) await this.#accountDirectory(false);
      for (const row of state.accounts) {
        await this.#validateAccountDirectory(row.id);
        this.#rows.set(row.id, row);
        this.#runtimes.set(row.id, this.#factory({ account: row, dataDir: path.join(this.#directory, 'accounts', row.id) }));
      }
    })();
    await this.#loaded;
  }
  async #accountDirectory(create = true) {
    try {
      if (create) await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const root = await lstat(this.#directory);
      if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077 || within(await realpath(this.#directory), await realpath(this.#servedRoot))) fail('ACCOUNT_STORE_INVALID');
      const directory = path.join(this.#directory, 'accounts');
      if (create) await mkdir(directory, { mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || !within(await realpath(directory), await realpath(this.#directory))) fail('ACCOUNT_STORE_INVALID');
    } catch (error) {
      if (create && error.code === 'EEXIST') return this.#accountDirectory(false);
      if (error.code === 'ACCOUNT_STORE_INVALID') throw error;
      fail('ACCOUNT_STORE_INVALID');
    }
  }
  async #validateAccountDirectory(id) {
    await this.#accountDirectory(false);
    try {
      const directory = path.join(this.#directory, 'accounts', id);
      const stat = await lstat(directory);
      const expected = path.join(await realpath(this.#directory), 'accounts', id);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || await realpath(directory) !== expected) fail('ACCOUNT_STORE_INVALID');
    } catch (error) {
      if (error.code === 'ACCOUNT_STORE_INVALID') throw error;
      fail('ACCOUNT_STORE_INVALID');
    }
  }
  // The primary account when configured, else the first registered one, else null.
  #defaultId() { return this.#primary?.id ?? this.#rows.keys().next().value ?? null; }
  #dto(account) {
    const runtime = this.#runtimes.get(account.id); const connection = runtime.connection.status();
    return { id: account.id, username: account.username, isDefault: account.id === this.#defaultId(), legacyRecovery: Boolean(runtime.legacy),
      connected: connection.connected === true, connection };
  }
  async list() {
    await this.#load();
    return { defaultAccountId: this.#defaultId(), accounts: [...(this.#primary ? [this.#dto(this.#primary)] : []), ...[...this.#rows.values()].map(row => this.#dto(row))] };
  }
  async resolve(id) {
    await this.#load();
    const selected = id === undefined ? this.#defaultId() : id;
    if (!numeric(selected) || !this.#runtimes.has(selected)) fail('ACCOUNT_NOT_FOUND');
    if (selected !== this.#primary?.id) await this.#validateAccountDirectory(selected);
    return this.#runtimes.get(selected);
  }
  async runtimes() { await this.#load(); for (const id of this.#rows.keys()) await this.#validateAccountDirectory(id); return [...this.#runtimes.values()]; }
  async register(input) {
    const work = async () => {
      await this.#load();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 ||
          !username(input.expectedUsername) || typeof input.accessToken !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(input.accessToken) ||
          typeof input.apiVersion !== 'string' || !/^v\d{1,3}\.0$/.test(input.apiVersion)) fail('INVALID_ACCOUNT_REGISTRATION');
      if (this.#rows.size >= 49) fail('ACCOUNT_LIMIT_REACHED');
      let identity;
      try { identity = await this.#inspect({ accessToken: input.accessToken, apiVersion: input.apiVersion }); } catch { fail('TOKEN_VALIDATION_FAILED'); }
      if (!numeric(identity?.userId) || !username(identity?.username?.toLowerCase())) fail('IDENTITY_UNVERIFIED');
      if (identity.username.toLowerCase() !== input.expectedUsername) fail('WRONG_ACCOUNT');
      if (this.#runtimes.has(identity.userId) || input.expectedUsername === this.#primary?.username || [...this.#rows.values()].some(row => row.username === input.expectedUsername)) fail('ACCOUNT_ALREADY_REGISTERED');
      const account = { id: identity.userId, username: input.expectedUsername, createdAt: new Date(this.#clock()).toISOString() };
      await this.#accountDirectory();
      const runtime = this.#factory({ account, dataDir: path.join(this.#directory, 'accounts', account.id) });
      await runtime.connection.connect({ accessToken: input.accessToken, apiVersion: input.apiVersion });
      await this.#validateAccountDirectory(account.id);
      let lock; let temporary; let ownsLock = false;
      try {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(this.#directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || within(await realpath(this.#directory), await realpath(this.#servedRoot))) fail('ACCOUNT_STORE_INVALID');
        await chmod(this.#directory, 0o700);
        lock = await open(path.join(this.#directory, 'accounts.json.lock'), 'wx', 0o600); ownsLock = true;
        const state = await this.#read();
        if (state.accounts.some(row => row.id === account.id || row.username === account.username)) fail('ACCOUNT_ALREADY_REGISTERED');
        state.accounts.push(account);
        if (!validate(state, this.#primary)) fail('ACCOUNT_STORE_INVALID');
        temporary = path.join(this.#directory, `.accounts-${randomUUID()}.tmp`);
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, path.join(this.#directory, 'accounts.json')); temporary = null;
        this.#rows.set(account.id, account); this.#runtimes.set(account.id, runtime);
        return { defaultAccountId: this.#defaultId(), account: this.#dto(account) };
      } catch (error) {
        if (error.code === 'EEXIST') fail('ACCOUNT_STORE_BUSY');
        if (/^ACCOUNT_[A-Z_]+$/.test(error.code || '')) throw error;
        fail('ACCOUNT_STORE_UNWRITABLE');
      } finally {
        await lock?.close(); if (temporary) await unlink(temporary).catch(() => {});
        if (ownsLock) await unlink(path.join(this.#directory, 'accounts.json.lock')).catch(() => {});
      }
    };
    const result = this.#queue.then(work); this.#queue = result.catch(() => {}); return result;
  }
  async ingestWebhook(payload) {
    await this.#load();
    const envelopes = Array.isArray(payload) ? payload : [payload];
    if (!envelopes.length || envelopes.length > 10) fail('INVALID_WEBHOOK');
    // Validate envelopes and registered entry shapes before persisting any account.
    const grouped = new Map();
    for (const envelope of envelopes) {
      if (envelope?.object !== 'instagram' || !Array.isArray(envelope.entry) || envelope.entry.length > 50) fail('INVALID_WEBHOOK');
      for (const entry of envelope.entry) {
        if (!numeric(entry?.id)) fail('INVALID_WEBHOOK');
        if (!this.#runtimes.has(entry.id)) continue;
        if (!grouped.has(entry.id)) grouped.set(entry.id, []);
        grouped.get(entry.id).push(entry);
      }
    }
    for (const [id, entry] of grouped) {
      if (id !== this.#primary?.id) await this.#validateAccountDirectory(id);
      normalizeInstagramWebhook({ object: 'instagram', entry }, { signatureVerified: true, verifiedAccountId: id, receivedAt: this.#clock() });
    }
    for (const [id, entry] of grouped) {
      const inbox = this.#runtimes.get(id).inbox;
      if (inbox) await inbox.ingestWebhook({ object: 'instagram', entry }, { signatureVerified: true, verifiedAccountId: id });
    }
    return { registeredAccounts: grouped.size };
  }
}
