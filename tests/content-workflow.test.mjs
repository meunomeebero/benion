import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ContentWorkflow } from '../content-workflow.mjs';
import { PublishingService } from '../publishing.mjs';
import { createBenionServer } from '../server.mjs';

const ACCOUNT = '100';
const NOW = Date.parse('2026-10-24T13:00:00Z');
const config = () => ({ seriesId: randomUUID(), product: { name: 'Example App', facts: 'A free document review is available.', url: 'https://example.com' },
  character: { id: randomUUID(), type: 'image_job' }, timeZone: 'America/Sao_Paulo', slots: ['12:00', '18:00'],
  group: { id: randomUUID(), name: 'Example campaign' }, caption: 'Comment to receive the link.', dmText: 'Here is your free review.', dmLink: 'https://example.com/trial' });
const reservation = (id = 'genjutsu:example', scheduledAt = '2026-10-24T15:00:00Z') => ({ trend: { provider: 'higgsfield-genjutsu', id }, scheduledAt, title: 'Example Reel' });
async function fixture(t, override = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'benion-content-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publishing = new PublishingService({ dataDir: directory, accountId: ACCOUNT, campaigns: {}, clock: () => NOW,
    clientProvider: async () => ({ identity: { userId: ACCOUNT }, client: { publishReel() { throw new Error('No publication in these tests'); } } }) });
  const create = () => new ContentWorkflow({ dataDir: directory, accountId: ACCOUNT, publishing, clock: () => NOW, ...override });
  return { directory, publishing, create, workflow: create() };
}

test('concurrent reservations and durable generation claims allow one charge per trend and one trend per slot', async t => {
  const f = await fixture(t); const configValue = config(); await f.workflow.configure(configValue);
  const [a, b] = await Promise.all([f.workflow.reserve(reservation()), f.create().reserve(reservation())]);
  assert.equal(a.id, b.id);
  const started = await Promise.all([f.workflow.startGeneration({ id: a.id }), f.create().startGeneration({ id: b.id })]);
  assert.equal(started.filter(row => row.mayGenerate).length, 1);
  assert.equal((await f.create().startGeneration({ id: a.id })).mayGenerate, false);
  await assert.rejects(f.create().reserve(reservation('genjutsu:another')), { code: 'CONTENT_SLOT_RESERVED' });
  const again = await f.create().reserve(reservation('genjutsu:example', '2026-10-24T21:00:00Z'));
  assert.equal(again.id, a.id); assert.equal(again.reused, true); assert.equal(again.scheduledAt, a.scheduledAt);
  assert.equal((await f.workflow.list()).jobs.length, 1);
});

test('restarts reuse provider jobs and the known asset, then attach one scheduled publication and DM template', async t => {
  const f = await fixture(t); const original = config(); await f.workflow.configure(original);
  const row = await f.workflow.reserve(reservation()); await f.workflow.startGeneration({ id: row.id });
  const jobId = randomUUID(); await f.create().recordGeneration({ id: row.id, jobIds: [jobId] });
  const resumed = await f.create().startGeneration({ id: row.id });
  assert.equal(resumed.mayGenerate, false); assert.deepEqual(resumed.jobIds, [jobId]);
  await f.create().recordAsset({ id: row.id, jobId, videoUrl: 'https://media.example.com/video.mp4' });
  await f.workflow.configure({ ...original, caption: 'New draft for future reservations', dmText: 'Future DM' });
  const result = await f.create().schedule({ id: row.id }); assert.equal(result.status, 'scheduled');
  await f.create().schedule({ id: row.id });
  const publications = await f.publishing.list(); assert.equal(publications.jobs.length, 1);
  assert.equal(publications.jobs[0].caption, original.caption); assert.equal(publications.jobs[0].dmText, original.dmText);
  assert.equal(publications.jobs[0].dmLink, original.dmLink); assert.equal(publications.jobs[0].id, row.id);
  await assert.rejects(f.workflow.recordGeneration({ id: row.id, jobIds: [randomUUID()] }), { code: 'CONTENT_GENERATION_CONFLICT' });
  await assert.rejects(f.workflow.recordAsset({ id: row.id, jobId, videoUrl: 'https://media.example.com/replacement.mp4' }), { code: 'CONTENT_ASSET_CONFLICT' });
});

test('a lost scheduling response retries the identical UUID and payload without another generation or publication', async t => {
  const jobs = new Map(); let loseResponse = true;
  const f = await fixture(t, { publishing: { async createGroup() {}, async schedule(values) {
    if (!jobs.has(values.id)) jobs.set(values.id, structuredClone(values));
    assert.deepEqual(jobs.get(values.id), values);
    if (loseResponse) { loseResponse = false; throw new Error('Simulated response loss'); }
    return jobs.get(values.id);
  } } });
  await f.workflow.configure(config()); const row = await f.workflow.reserve(reservation());
  await f.workflow.startGeneration({ id: row.id }); const jobId = randomUUID();
  await f.workflow.recordGeneration({ id: row.id, jobIds: [jobId] });
  await f.workflow.recordAsset({ id: row.id, jobId, videoUrl: 'https://media.example.com/video.mp4' });
  await assert.rejects(f.workflow.schedule({ id: row.id }));
  assert.equal((await f.create().list()).jobs[0].status, 'scheduling');
  assert.equal((await f.create().schedule({ id: row.id })).status, 'scheduled');
  assert.equal(jobs.size, 1); assert.equal((await f.create().startGeneration({ id: row.id })).mayGenerate, false);
});

test('unknown generation stays blocked and cannot be scheduled without a recorded provider result', async t => {
  const f = await fixture(t); await f.workflow.configure(config()); const row = await f.workflow.reserve(reservation());
  await f.workflow.startGeneration({ id: row.id });
  assert.equal((await f.create().list()).jobs[0].status, 'generation_unknown');
  await assert.rejects(f.create().schedule({ id: row.id }), { code: 'CONTENT_ASSET_REQUIRED' });
  await assert.rejects(f.create().recordAsset({ id: row.id, jobId: randomUUID(), videoUrl: 'https://media.example.com/video.mp4' }), { code: 'CONTENT_GENERATION_NOT_FOUND' });
  assert.equal((await f.create().startGeneration({ id: row.id })).mayGenerate, false);
});

test('account mismatches and symlinked private records fail closed', async t => {
  const f = await fixture(t); await f.workflow.configure(config()); const row = await f.workflow.reserve(reservation());
  const other = new ContentWorkflow({ dataDir: f.directory, accountId: '200', publishing: f.publishing, clock: () => NOW });
  await assert.rejects(other.list(), { code: 'CONTENT_STORE_UNREADABLE' });
  const source = path.join(f.directory, 'content-workflow', `${row.id}.reservation.json`);
  const target = path.join(f.directory, 'content-workflow', `${row.id}.started.json`);
  await symlink(source, target);
  await assert.rejects(f.create().startGeneration({ id: row.id }), { code: 'CONTENT_STORE_UNREADABLE' });
  assert.equal(JSON.parse(await readFile(source, 'utf8')).accountId, ACCOUNT);
});

test('the shipped CLI configures and resumes through authenticated account-scoped HTTP routes', async t => {
  const f = await fixture(t);
  const runtime = { production: false, origin: 'http://127.0.0.1:5197', host: '127.0.0.1', port: 5197 };
  const selected = { connection: { status: () => ({ connected: true }) }, contentWorkflow: f.workflow };
  const app = createBenionServer({ env: {}, config: runtime, privateDirectory: f.directory, accounts: {
    async resolve(id) { if (id !== ACCOUNT) throw Object.assign(new Error('ACCOUNT_NOT_FOUND'), { code: 'ACCOUNT_NOT_FOUND' }); return selected; },
    async runtimes() { return []; }
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  runtime.origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const cli = (action, body, accountId = ACCOUNT) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/content-workflow.mjs', action], { cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, BENION_WORKFLOW_AUTH_FILE: '', BENION_ORIGIN: runtime.origin, BENION_ACCOUNT_ID: accountId }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(body === undefined ? '' : JSON.stringify(body));
  });
  assert.equal((await cli('configure', config())).code, 0);
  const reserved = await cli('reserve', reservation()); assert.equal(reserved.code, 0, reserved.stderr);
  const listed = await cli('list'); assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).jobs[0].id, JSON.parse(reserved.stdout).id);
  assert.equal(Object.hasOwn(JSON.parse(listed.stdout), 'config'), false);
  assert.equal((await cli('list', undefined, '200')).code, 1);
});
