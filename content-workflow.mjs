import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, link, unlink, readdir } from 'node:fs/promises';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[a-zA-Z0-9:_-]{1,160}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const https = value => { try { const url = new URL(value); return text(value, 4096) && url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableId = value => { const digest = hash(value); return `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function configuration(body) {
  if (!keys(body, ['seriesId', 'product', 'character', 'timeZone', 'slots', 'group', 'caption', 'dmText', 'dmLink']) ||
      !UUID.test(body.seriesId || '') || !keys(body.product, ['name', 'facts', 'url']) || !text(body.product.name, 100) ||
      !text(body.product.facts, 4000) || !https(body.product.url) || !keys(body.character, ['id', 'type']) ||
      !ID.test(body.character.id || '') || !['image_job', 'media_input'].includes(body.character.type) ||
      !keys(body.group, ['id', 'name']) || !UUID.test(body.group.id || '') || !text(body.group.name, 80) ||
      !text(body.caption, 4400) || [...body.caption].length > 2200 || !text(body.dmText, 1000) || !https(body.dmLink) ||
      Buffer.byteLength(`${body.dmText.trim()}\n\n${body.dmLink}`, 'utf8') > 1000 || !text(body.timeZone, 80) ||
      !Array.isArray(body.slots) || !body.slots.length || body.slots.length > 24 || new Set(body.slots).size !== body.slots.length ||
      body.slots.some(slot => typeof slot !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot))) fail('CONTENT_CONFIG_INVALID');
  try { new Intl.DateTimeFormat('en-US', { timeZone: body.timeZone }).format(); } catch { fail('CONTENT_TIMEZONE_INVALID'); }
  return { seriesId: body.seriesId, product: { name: body.product.name, facts: body.product.facts, url: body.product.url },
    character: { id: body.character.id, type: body.character.type }, timeZone: body.timeZone, slots: [...body.slots],
    group: { id: body.group.id, name: body.group.name.trim() }, caption: body.caption, dmText: body.dmText.trim(), dmLink: body.dmLink };
}

function localSlot(scheduledAt, config) {
  if (typeof scheduledAt !== 'string' || !Number.isFinite(Date.parse(scheduledAt))) fail('CONTENT_SLOT_INVALID');
  const date = new Date(scheduledAt);
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) fail('CONTENT_SLOT_INVALID');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
  const time = `${parts.hour}:${parts.minute}`;
  if (!config.slots.includes(time)) fail('CONTENT_SLOT_INVALID');
  return `${parts.year}-${parts.month}-${parts.day}T${time}`;
}

export class ContentWorkflow {
  #dir; #account; #publishing; #clock; #queue = Promise.resolve();
  constructor({ dataDir, accountId, publishing, clock = Date.now }) {
    if (!path.isAbsolute(dataDir) || !/^\d{1,40}$/.test(accountId || '') || typeof publishing?.schedule !== 'function' || typeof publishing?.createGroup !== 'function') fail('CONTENT_CONFIG_INVALID');
    this.#dir = path.join(dataDir, 'content-workflow'); this.#account = accountId; this.#publishing = publishing; this.#clock = clock;
  }
  #serial(work) { const next = this.#queue.then(work); this.#queue = next.catch(() => {}); return next; }
  async #directory(directory = this.#dir) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) fail('CONTENT_STORE_INVALID');
  }
  async #read(name) {
    let handle;
    try {
      handle = await open(path.join(this.#dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 32000) fail('CONTENT_STORE_INVALID');
      const row = JSON.parse(await handle.readFile('utf8'));
      if (!object(row) || row.accountId !== this.#account) fail('CONTENT_STORE_INVALID');
      return row;
    } catch (error) { if (error.code === 'ENOENT') return null; fail('CONTENT_STORE_UNREADABLE'); }
    finally { await handle?.close(); }
  }
  async #write(name, values, immutable = true) {
    await this.#directory();
    const file = path.join(this.#dir, `.pending-${randomUUID()}`);
    const target = path.join(this.#dir, name); let handle;
    const row = { ...values, accountId: this.#account };
    try {
      handle = await open(file, 'wx', 0o600); await handle.writeFile(JSON.stringify(row)); await handle.sync(); await handle.close(); handle = null;
      if (immutable) {
        try { await link(file, target); }
        catch (error) { if (error.code === 'EEXIST') return { created: false, row: await this.#read(name) }; throw error; }
      } else await rename(file, target);
      const dir = await open(this.#dir, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      return { created: true, row };
    } finally { await handle?.close(); await unlink(file).catch(() => {}); }
  }
  async #reservation(id) {
    if (!UUID.test(id || '')) fail('CONTENT_JOB_INVALID');
    await this.#directory();
    const row = await this.#read(`${id}.reservation.json`);
    if (!row || row.id !== id || !object(row.trend) || row.trend.provider !== 'higgsfield-genjutsu' || !ID.test(row.trend.id || '') ||
        !text(row.title, 80) || !Number.isFinite(Date.parse(row.scheduledAt))) fail('CONTENT_JOB_NOT_FOUND');
    configuration(row.config);
    return row;
  }
  async #view(row) {
    const stages = {};
    for (const stage of ['started', 'generation', 'asset', 'schedule-intent', 'scheduled']) stages[stage] = await this.#read(`${row.id}.${stage}.json`);
    const status = stages.scheduled ? 'scheduled' : stages['schedule-intent'] ? 'scheduling' : stages.asset ? 'asset_ready' : stages.generation ? 'generating' : stages.started ? 'generation_unknown' : 'reserved';
    return { ...row, status, jobIds: stages.generation?.jobIds || [], videoUrl: stages.asset?.videoUrl || null, assetJobId: stages.asset?.jobId || null,
      publicationId: stages.scheduled?.publicationId || null, generationAttemptedAt: stages.started?.attemptedAt || null };
  }
  async list() {
    await this.#directory(); const jobs = [];
    for (const file of await readdir(this.#dir)) {
      if (!file.endsWith('.reservation.json')) continue;
      jobs.push(await this.#view(await this.#reservation(file.slice(0, -17))));
    }
    return { available: true, accountId: this.#account, config: (await this.#read('config.json'))?.config || null,
      jobs: jobs.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)) };
  }
  configure(body) { return this.#serial(async () => { const config = configuration(body); await this.#write('config.json', { config }, false); return config; }); }
  reserve(body) {
    return this.#serial(async () => {
      if (!keys(body, ['trend', 'scheduledAt', 'title']) || !keys(body.trend, ['provider', 'id']) || body.trend.provider !== 'higgsfield-genjutsu' ||
          !ID.test(body.trend.id || '') || !text(body.title, 80)) fail('CONTENT_RESERVATION_INVALID');
      await this.#directory(); const config = (await this.#read('config.json'))?.config;
      if (!config) fail('CONTENT_SETUP_REQUIRED'); configuration(config);
      const local = localSlot(body.scheduledAt, config);
      const scheduledAt = new Date(body.scheduledAt).toISOString();
      const id = stableId([this.#account, config.seriesId, body.trend.provider, body.trend.id]);
      const existing = await this.#read(`${id}.reservation.json`);
      if (existing) return { reused: true, ...await this.#view(await this.#reservation(id)) };
      if (Date.parse(scheduledAt) < this.#clock() + 60000) fail('CONTENT_SLOT_IN_PAST');
      const slot = await this.#write(`slot-${hash([this.#account, config.seriesId, config.timeZone, local])}.json`, { id, scheduledAt });
      if (slot.row?.id !== id) fail('CONTENT_SLOT_RESERVED');
      const result = await this.#write(`${id}.reservation.json`, { id, title: body.title.trim(), trend: { provider: body.trend.provider, id: body.trend.id },
        scheduledAt, config, createdAt: new Date(this.#clock()).toISOString() });
      return { reused: !result.created, ...await this.#view(result.row) };
    });
  }
  startGeneration(body) {
    return this.#serial(async () => {
      if (!keys(body, ['id'])) fail('CONTENT_JOB_INVALID');
      const row = await this.#reservation(body.id);
      if (Date.parse(row.scheduledAt) < this.#clock() + 60000) fail('CONTENT_SLOT_IN_PAST');
      const claim = await this.#write(`${row.id}.started.json`, { attemptedAt: new Date(this.#clock()).toISOString() });
      // The permission is returned only to the caller that created the durable claim.
      return { ...await this.#view(row), mayGenerate: claim.created };
    });
  }
  recordGeneration(body) {
    return this.#serial(async () => {
      if (!keys(body, ['id', 'jobIds']) || !Array.isArray(body.jobIds) || !body.jobIds.length || body.jobIds.length > 20 ||
          new Set(body.jobIds).size !== body.jobIds.length || !body.jobIds.every(id => ID.test(id))) fail('CONTENT_GENERATION_INVALID');
      const row = await this.#reservation(body.id);
      if (!await this.#read(`${row.id}.started.json`)) fail('CONTENT_GENERATION_NOT_STARTED');
      const receipt = await this.#write(`${row.id}.generation.json`, { jobIds: [...body.jobIds] });
      if (!same(receipt.row.jobIds, body.jobIds)) fail('CONTENT_GENERATION_CONFLICT');
      return this.#view(row);
    });
  }
  recordAsset(body) {
    return this.#serial(async () => {
      if (!keys(body, ['id', 'jobId', 'videoUrl']) || !ID.test(body.jobId || '') || !https(body.videoUrl)) fail('CONTENT_ASSET_INVALID');
      const row = await this.#reservation(body.id); const receipt = await this.#read(`${row.id}.generation.json`);
      if (!receipt?.jobIds?.includes(body.jobId)) fail('CONTENT_GENERATION_NOT_FOUND');
      const asset = await this.#write(`${row.id}.asset.json`, { jobId: body.jobId, videoUrl: body.videoUrl });
      if (asset.row.jobId !== body.jobId || asset.row.videoUrl !== body.videoUrl) fail('CONTENT_ASSET_CONFLICT');
      return this.#view(row);
    });
  }
  schedule(body) {
    return this.#serial(async () => {
      if (!keys(body, ['id'])) fail('CONTENT_JOB_INVALID');
      const row = await this.#reservation(body.id); const asset = await this.#read(`${row.id}.asset.json`);
      if (!asset) fail('CONTENT_ASSET_REQUIRED');
      const values = { id: row.id, groupId: row.config.group.id, title: row.title, videoUrl: asset.videoUrl, caption: row.config.caption,
        scheduledAt: row.scheduledAt, dmText: row.config.dmText, dmLink: row.config.dmLink };
      const intent = await this.#write(`${row.id}.schedule-intent.json`, { values });
      if (!same(intent.row.values, values)) fail('CONTENT_SCHEDULE_CONFLICT');
      await this.#publishing.createGroup(row.config.group);
      const publication = await this.#publishing.schedule(intent.row.values);
      if (publication?.id !== row.id) fail('CONTENT_SCHEDULE_UNVERIFIED');
      await this.#write(`${row.id}.scheduled.json`, { publicationId: publication.id });
      return this.#view(row);
    });
  }
}
