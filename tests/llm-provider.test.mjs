import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelProviderStore, DEFAULT_MODEL } from '../llm-provider.mjs';

const KEY = 'test-only-private-provider-key';
const PLAN = { action: 'answer', productId: 'benion-test', factIndexes: [], includeDescription: true, includePrice: false, includeUrl: false, question: null, replyText: 'É um produto fictício para validar a conexão.' };
const status = { configured: true, name: 'openrouter', model: DEFAULT_MODEL, verifiedAt: '2026-10-05T18:00:00.000Z' };
async function fixture(t, { rejectKey = false, rejectModel = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'benion-provider-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/key')) return { ok: !rejectKey, json: async () => ({ data: { is_management_key: false, limit_remaining: 10 } }) };
    return { ok: !rejectModel, json: async () => ({ model: DEFAULT_MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(PLAN) } }] }) };
  };
  return { dataDir, calls, fetchImpl, store: new ModelProviderStore({ dataDir, fetchImpl, clock: () => Date.parse(status.verifiedAt) }) };
}
test('provider verifies only synthetic context, persists privately and restores a redacted status', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.load()).configured, false);
  await assert.rejects(f.store.selectPlan({}), { code: 'MODEL_NOT_CONFIGURED' });
  assert.deepEqual(await f.store.set({ apiKey: KEY }), status);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.headers.Authorization, `Bearer ${KEY}`);
  const sent = JSON.parse(f.calls[1].options.body);
  assert.equal(sent.model, DEFAULT_MODEL); assert.equal(sent.provider.allow_fallbacks, false);
  assert.match(sent.messages[1].content, /Produto fictício/);
  assert.doesNotMatch(sent.messages[1].content, /17841|example\.owner|recipient|private-provider-key/);
  const file = path.join(f.dataDir, 'provider', 'provider-config.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).apiKey, KEY);
  const restored = new ModelProviderStore({ dataDir: f.dataDir, fetchImpl: f.fetchImpl });
  assert.deepEqual(await restored.load(), status);
  assert.doesNotMatch(JSON.stringify(restored.publicStatus()), /private-provider-key|apiKey/);
  const changedModel = new ModelProviderStore({ dataDir: f.dataDir, env: { BENION_LLM_MODEL: 'example/model' }, fetchImpl: f.fetchImpl });
  const changedStatus = await changedModel.load();
  assert.equal(changedStatus.model, 'example/model');
  assert.equal(changedStatus.verifiedAt, null);
  assert.equal(f.calls.length, 2);
});
test('invalid credentials and extra model fields never issue a provider request or create private config', async t => {
  const f = await fixture(t);
  for (const input of [{ apiKey: KEY, model: 'different' }, { apiKey: 'bad\nkey' }, { apiKey: 'short' }, null]) await assert.rejects(f.store.set(input), { code: 'MODEL_CONFIG_INVALID' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(stat(path.join(f.dataDir, 'provider')), { code: 'ENOENT' });
});
test('rejected key or model does not become configured and upstream details stay private', async t => {
  for (const options of [{ rejectKey: true }, { rejectModel: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.store.set({ apiKey: KEY }), error => /^MODEL_/.test(error.code) && !error.message.includes(KEY));
    assert.equal(f.store.publicStatus().configured, false);
    await assert.rejects(stat(path.join(f.dataDir, 'provider')), { code: 'ENOENT' });
  }
});
test('failed replacement preserves the verified adapter and durable credential', async t => {
  const f = await fixture(t); await f.store.set({ apiKey: KEY });
  const failing = new ModelProviderStore({ dataDir: f.dataDir, fetchImpl: async () => { throw new Error(KEY); } });
  await failing.load();
  await assert.rejects(failing.set({ apiKey: 'test-only-replacement-private-key' }), { code: 'MODEL_VALIDATION_FAILED' });
  assert.deepEqual(failing.publicStatus(), status);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'provider', 'provider-config.json'), 'utf8')).apiKey, KEY);
});
