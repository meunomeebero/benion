// One private provider credential; conversation context remains scoped by account.
import path from 'node:path';
import { PrivateStateFile } from './inbox.mjs';
import { SalesModelAdapter, SalesError, createSalesModelFromEnv } from './sales.mjs';

// Existing instances keep this model unless BENION_LLM_MODEL selects another.
export const DEFAULT_MODEL = 'openai/gpt-6-luna';
const keyValid = key => typeof key === 'string' && /^[\x21-\x7e]{16,1000}$/.test(key);
const valid = state => state?.version === 1 && Object.keys(state).every(key => ['version', 'apiKey', 'verifiedAt', 'verifiedModel'].includes(key)) &&
  (state.verifiedModel === undefined || typeof state.verifiedModel === 'string' && /^[A-Za-z0-9_./:-]{1,120}$/.test(state.verifiedModel)) &&
  (state.apiKey === null || keyValid(state.apiKey)) &&
  (state.verifiedAt === null || typeof state.verifiedAt === 'string' && Number.isFinite(Date.parse(state.verifiedAt))) &&
  (state.apiKey === null) === (state.verifiedAt === null);
const fail = code => { throw new SalesError(code, 'Não foi possível validar o modelo configurado. Confira a chave e os créditos da OpenRouter.'); };

export class ModelProviderStore {
  #store; #adapter; #model; #catalogUrl; #verifiedAt = null; #fetch; #clock; #timeout; #queue = Promise.resolve();
  constructor({ dataDir, env = {}, fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = 15000 }) {
    if (env.BENION_LLM_MODEL && !/^[A-Za-z0-9_./:-]{1,120}$/.test(env.BENION_LLM_MODEL)) fail('MODEL_CONFIG_INVALID');
    this.#model = env.BENION_LLM_MODEL || DEFAULT_MODEL;
    this.#catalogUrl = /^https:\/\/[^\s/]+$/.test(env.BENION_PUBLIC_ORIGIN || '') ? env.BENION_PUBLIC_ORIGIN : 'https://example.com';
    this.#store = new PrivateStateFile({ directory: path.join(dataDir, 'provider'), filename: 'provider-config.json',
      initial: () => ({ version: 1, apiKey: null, verifiedAt: null }), validate: valid });
    this.#fetch = fetchImpl; this.#clock = clock; this.#timeout = timeoutMs;
    this.#adapter = createSalesModelFromEnv({ env, fetchImpl, timeoutMs });
  }
  async load() {
    const state = await this.#store.read();
    if (state.apiKey) {
      this.#adapter = new SalesModelAdapter({ provider: 'openrouter', model: this.#model, apiKey: state.apiKey, fetchImpl: this.#fetch, timeoutMs: this.#timeout });
      // Legacy records verified the original default model. A new model must be tested.
      this.#verifiedAt = (state.verifiedModel ?? DEFAULT_MODEL) === this.#model ? state.verifiedAt : null;
    }
    return this.publicStatus();
  }
  publicStatus() {
    const status = this.#adapter?.publicStatus?.();
    return { configured: status?.configured === true, name: status?.name ?? 'openrouter', model: status?.model ?? this.#model, verifiedAt: this.#verifiedAt };
  }
  async selectPlan(input) {
    if (!this.#adapter) fail('MODEL_NOT_CONFIGURED');
    return this.#adapter.selectPlan(input);
  }
  async set(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'apiKey') || !keyValid(input.apiKey)) fail('MODEL_CONFIG_INVALID');
    const apiKey = input.apiKey;
    const work = async () => {
      try {
        const response = await this.#fetch('https://openrouter.ai/api/v1/key', { method: 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(this.#timeout) });
        if (!response.ok) fail('MODEL_KEY_REJECTED');
        const result = await response.json();
        const data = result?.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || result.error || data.disabled === true || data.is_management_key === true || data.is_provisioning_key === true ||
          (data.expires_at != null && (!Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= this.#clock()))) fail('MODEL_KEY_REJECTED');
        if (typeof data.limit_remaining === 'number' && data.limit_remaining <= 0) fail('MODEL_CREDITS_REQUIRED');
        const adapter = new SalesModelAdapter({ provider: 'openrouter', model: this.#model, apiKey, fetchImpl: this.#fetch, timeoutMs: this.#timeout });
        // A bounded synthetic request verifies the requested model before storing
        // the credential. It contains no Instagram conversation or customer data.
        await adapter.selectPlan({ text: 'O que faz Benion Test?', history: [], tone: 'Direto e cordial', rules: '', catalog: [
          { id: 'benion-test', name: 'Benion Test', description: 'Produto fictício usado apenas para validar a conexão.', url: this.#catalogUrl, facts: [] },
        ] });
        const verifiedAt = new Date(this.#clock()).toISOString();
        await this.#store.update(state => { state.apiKey = apiKey; state.verifiedAt = verifiedAt; state.verifiedModel = this.#model; return null; });
        this.#adapter = adapter; this.#verifiedAt = verifiedAt;
        return this.publicStatus();
      } catch (error) {
        if (error instanceof SalesError) throw error;
        if (typeof error?.code === 'string' && /^PRIVATE_STATE_[A-Z_]+$/.test(error.code)) throw error;
        fail('MODEL_VALIDATION_FAILED');
      }
    };
    const next = this.#queue.then(work, work); this.#queue = next.catch(() => {}); return next;
  }
}
