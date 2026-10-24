// Hosted, account-scoped Reel scheduling. No browser or Codex timer is required.
import path from 'node:path';
import { campaignLink } from './conversions.mjs';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink, readdir } from 'node:fs/promises';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const numeric = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const states = ['scheduled', 'creating', 'processing', 'ready', 'publishing', 'published', 'active', 'attention', 'cancelled'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code || '') ? error.code : 'PUBLISHING_FAILED';
const text = (value, max, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= max;
const https = value => { try { const u = new URL(value); return typeof value === 'string' && value.length <= 4096 && u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };
const MAX_VIDEO = 100 * 1024 * 1024;
const MINUTE = 60000;

function configuration(body) {
  if (!body || Object.keys(body).some(k => !['id', 'groupId', 'title', 'videoUrl', 'caption', 'scheduledAt', 'dmText', 'dmLink'].includes(k)) ||
      !UUID.test(body.id || '') || !UUID.test(body.groupId || '') || !text(body.title, 80) || !https(body.videoUrl) ||
      !text(body.caption, 4400, true) || [...body.caption].length > 2200 || !Number.isFinite(Date.parse(body.scheduledAt)) ||
      !text(body.dmText, 1000) || !https(body.dmLink) || Buffer.byteLength(`${body.dmText.trim()}\n\n${body.dmLink}`, 'utf8') > 1000) fail('SCHEDULE_INVALID');
  return { id: body.id, groupId: body.groupId, title: body.title.trim(), videoUrl: body.videoUrl, caption: body.caption,
    scheduledAt: new Date(body.scheduledAt).toISOString(), dmText: body.dmText.trim(), dmLink: body.dmLink };
}

export class PublishingService {
  #dir; #account; #provider; #campaigns; #clock; #origin; #conversionTracking; #queue = Promise.resolve(); #working = null; #closed = false;
  constructor({ dataDir, accountId, clientProvider, campaigns, clock = Date.now, origin, conversionTracking = false }) {
    if (!path.isAbsolute(dataDir) || !numeric(accountId) || typeof clientProvider !== 'function' || !campaigns) fail('PUBLISHING_CONFIG_INVALID');
    this.#dir = dataDir; this.#account = accountId; this.#provider = clientProvider; this.#campaigns = campaigns; this.#clock = clock; this.#origin = origin;
    this.#conversionTracking = conversionTracking;
  }
  #serial(work) { const next = this.#queue.then(work); this.#queue = next.catch(() => {}); return next; }
  async #directory() {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.#dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) fail('PUBLISHING_STORE_INVALID');
  }
  async #read() {
    await this.#directory(); let handle;
    try {
      handle = await open(path.join(this.#dir, 'publishing.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 4_000_000) fail('PUBLISHING_STORE_INVALID');
      const state = JSON.parse(await handle.readFile('utf8'));
      if (state.version !== 1 || state.accountId !== this.#account || !Array.isArray(state.groups) || !Array.isArray(state.jobs) || state.groups.length > 100 || state.jobs.length > 500 ||
          new Set(state.groups.map(g => g.id)).size !== state.groups.length || new Set(state.jobs.map(j => j.id)).size !== state.jobs.length ||
          state.groups.some(g => !UUID.test(g.id) || !text(g.name, 80)) || state.jobs.some(j => !UUID.test(j.id) || !states.includes(j.state) ||
            !state.groups.some(g => g.id === j.groupId) || !Number.isFinite(Date.parse(j.scheduledAt)) || !https(j.videoUrl) ||
            !text(j.title, 80) || !text(j.caption, 4400, true) || !text(j.dmText, 1000) || !https(j.dmLink) || (j.deliveryDmLink !== undefined && !https(j.deliveryDmLink)) ||
            (j.containerId != null && !numeric(j.containerId)) || (j.mediaId != null && !numeric(j.mediaId)) ||
            (j.attemptedAt != null && !Number.isSafeInteger(j.attemptedAt)) ||
            (j.knownMediaIds !== undefined && (!Array.isArray(j.knownMediaIds) || j.knownMediaIds.length > 500 || !j.knownMediaIds.every(numeric))))) fail('PUBLISHING_STORE_INVALID');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, accountId: this.#account, groups: [], jobs: [] }; fail('PUBLISHING_STORE_UNREADABLE'); }
    finally { await handle?.close(); }
  }
  async #write(state) {
    const file = path.join(this.#dir, `.publishing-${randomUUID()}.tmp`); let handle;
    try {
      handle = await open(file, 'wx', 0o600); await handle.writeFile(JSON.stringify(state)); await handle.sync(); await handle.close(); handle = null;
      await rename(file, path.join(this.#dir, 'publishing.json'));
    } finally { await handle?.close(); await unlink(file).catch(() => {}); }
  }
  async #context() {
    const context = await this.#provider();
    if (context?.identity?.userId !== this.#account || typeof context.client?.publishReel !== 'function') fail('PUBLISHING_CONNECTION_REQUIRED');
    return context.client;
  }
  async routing() {
    const state = await this.#read();
    const uncertain = state.jobs.filter(j => !j.mediaId && (j.state === 'publishing' || j.reason === 'PUBLISH_OUTCOME_UNKNOWN'));
    return { blocked: uncertain.length > 0, knownMediaIds: uncertain.length ? (uncertain[0].knownMediaIds || []).filter(id => uncertain.every(j => j.knownMediaIds?.includes(id))) : [],
      mediaIds: state.jobs.filter(j => j.mediaId).map(j => j.mediaId) };
  }
  async hasCampaign(id) { return (await this.#read()).jobs.some(job => job.id === id); }
  async list() {
    const state = await this.#read();
    const jobs = [];
    for (const job of state.jobs) {
      let metrics = null; let automation = null;
      if (job.mediaId) {
        try { metrics = await this.#campaigns.mediaMetrics(job.mediaId); } catch {}
        try { const row = await this.#campaigns.status(job.id); automation = { running: row.status.running, enabled: row.enabled, reason: row.status.reviewReason }; } catch {}
      }
      jobs.push({ ...job, metrics, automation });
    }
    return { available: true, timeZone: 'America/Sao_Paulo', groups: state.groups, jobs, checkedAt: new Date(this.#clock()).toISOString() };
  }
  createGroup(body) {
    return this.#serial(async () => {
      if (!body || Object.keys(body).some(k => !['id', 'name'].includes(k)) || !UUID.test(body.id || '') || !text(body.name, 80)) fail('CAMPAIGN_GROUP_INVALID');
      const state = await this.#read(); const existing = state.groups.find(g => g.id === body.id);
      if (existing) { if (existing.name !== body.name.trim()) fail('SCHEDULE_CONFLICT'); return existing; }
      if (state.groups.length >= 100) fail('CAMPAIGN_GROUP_LIMIT');
      const row = { id: body.id, name: body.name.trim(), createdAt: new Date(this.#clock()).toISOString() };
      state.groups.push(row); await this.#write(state); return row;
    });
  }
  schedule(body) {
    return this.#serial(async () => {
      const values = configuration(body); const state = await this.#read();
      const existing = state.jobs.find(j => j.id === values.id);
      if (existing) {
        if (Object.keys(values).some(key => existing[key] !== values[key])) fail('SCHEDULE_CONFLICT');
        return existing; // Retrying a lost HTTP response cannot schedule twice.
      }
      if (!state.groups.some(g => g.id === values.groupId)) fail('CAMPAIGN_GROUP_NOT_FOUND');
      if (state.jobs.length >= 500) fail('SCHEDULE_LIMIT');
      if (Date.parse(values.scheduledAt) < this.#clock() + MINUTE) fail('SCHEDULE_IN_PAST');
      await this.#context(); // Verify the selected identity, never publish on Save.
      const deliveryDmLink = this.#conversionTracking ? campaignLink(values.dmLink, values.id) : values.dmLink;
      if (Buffer.byteLength(`${values.dmText}\n\n${deliveryDmLink}`, 'utf8') > 1000) fail('PUBLICATION_DM_TOO_LONG');
      const row = { ...values, deliveryDmLink, state: 'scheduled', reason: null, createdAt: new Date(this.#clock()).toISOString(), containerId: null, mediaId: null, attemptedAt: null };
      state.jobs.push(row); await this.#write(state); return row;
    });
  }
  cancel(id) {
    return this.#serial(async () => {
      const state = await this.#read(); const row = state.jobs.find(j => j.id === id);
      if (!row) fail('SCHEDULE_NOT_FOUND');
      if (!['scheduled', 'processing', 'ready', 'cancelled'].includes(row.state)) fail('SCHEDULE_ALREADY_ATTEMPTED');
      row.state = 'cancelled'; row.reason = null; await this.#write(state); return row;
    });
  }
  processDue() {
    if (this.#closed) return Promise.resolve();
    if (this.#working) return this.#working;
    this.#working = this.#serial(async () => {
      const state = await this.#read();
      for (const job of state.jobs) {
        if (this.#closed) break;
        if (!['scheduled', 'creating', 'processing', 'ready', 'publishing', 'published'].includes(job.state) || Date.parse(job.scheduledAt) - this.#clock() > 15 * MINUTE) continue;
        try { await this.#advance(state, job); }
        catch (error) {
          // GET/connection failures can resume; no ambiguous POST is retried.
          if (['creating', 'publishing'].includes(job.state)) {
            job.reason = job.state === 'publishing' ? 'PUBLISH_OUTCOME_UNKNOWN' : 'CONTAINER_OUTCOME_UNKNOWN'; job.state = 'attention';
          } else { job.reason = safeCode(error); }
          await this.#write(state);
        }
      }
      await this.#cleanUploads(state);
    }).finally(() => { this.#working = null; });
    return this.#working;
  }
  async #advance(state, job) {
    // A crashed POST remains uncertain. This is intentional duplicate protection.
    if (job.state === 'creating' || job.state === 'publishing') {
      job.reason = job.state === 'publishing' ? 'PUBLISH_OUTCOME_UNKNOWN' : 'CONTAINER_OUTCOME_UNKNOWN'; job.state = 'attention'; await this.#write(state); return;
    }
    if (!job.mediaId && this.#clock() - Date.parse(job.scheduledAt) > 60 * MINUTE) {
      job.state = 'attention'; job.reason = 'PUBLICATION_WINDOW_MISSED'; await this.#write(state); return;
    }
    const client = await this.#context();
    if (job.state === 'scheduled') {
      job.state = 'creating'; job.reason = null; await this.#write(state);
      const container = await client.createReelContainer(this.#account, { videoUrl: job.videoUrl, caption: job.caption });
      job.containerId = container.id; job.state = 'processing'; await this.#write(state);
    }
    if (job.state === 'processing') {
      const result = await client.reelContainerStatus(job.containerId);
      if (['ERROR', 'EXPIRED', 'PUBLISHED'].includes(result.status)) { job.state = 'attention'; job.reason = `CONTAINER_${result.status}`; await this.#write(state); return; }
      if (result.status !== 'FINISHED') return;
      job.state = 'ready'; job.reason = null; await this.#write(state);
    }
    if (job.state === 'ready' && this.#clock() >= Date.parse(job.scheduledAt)) {
      const previous = await client.listMedia(this.#account, { pageSize: 50, maxPages: 10 });
      if (!Array.isArray(previous.media) || previous.truncated !== false || previous.media.length > 500) fail('PUBLICATION_MEDIA_UNAVAILABLE');
      job.knownMediaIds = previous.media.map(item => item.id);
      // Exclusive durable claim survives a crash and also prevents duplicate POSTs
      // if an old process overlaps the replacement during deployment.
      let claim;
      try { claim = await open(path.join(this.#dir, `publish-${job.id}.claim`), 'wx', 0o600); await claim.sync(); }
      catch (error) { if (error.code !== 'EEXIST') throw error; job.state = 'attention'; job.reason = 'PUBLISH_OUTCOME_UNKNOWN'; await this.#write(state); return; }
      finally { await claim?.close(); }
      job.state = 'publishing'; job.attemptedAt = this.#clock(); await this.#write(state);
      try {
        const result = await client.publishReel(this.#account, job.containerId);
        job.mediaId = result.id; job.state = 'published'; job.reason = null; job.publishedAt = new Date(this.#clock()).toISOString(); await this.#write(state);
      } catch (error) {
        job.state = 'attention'; job.reason = error.outcome === 'rejected' ? 'PUBLICATION_REJECTED' : 'PUBLISH_OUTCOME_UNKNOWN'; await this.#write(state); return;
      }
    }
    if (job.state === 'published') {
      // The stable job ID makes this recovery idempotent across server restarts.
      const campaign = await this.#campaigns.createFromPublication({ id: job.id, mediaId: job.mediaId, name: job.title,
        messageText: `${job.dmText}\n\n${job.deliveryDmLink ?? job.dmLink}`, cutoff: job.attemptedAt - 1000 });
      if (!campaign.status.running && campaign.enabled) fail('PUBLICATION_DM_PENDING');
      job.state = 'active'; job.reason = null; job.permalink = campaign.reel.permalink; await this.#write(state);
    }
  }
  async upload(request) {
    const length = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 12 || length > MAX_VIDEO || request.headers['content-type'] !== 'video/mp4' || !https(this.#origin)) fail('VIDEO_UPLOAD_INVALID');
    await this.#directory();
    const directory = path.join(this.#dir, 'videos'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) fail('VIDEO_STORE_INVALID');
    const files = await readdir(directory);
    let size = 0; for (const f of files) size += (await lstat(path.join(directory, f))).size;
    if (size + length > 1024 * 1024 * 1024) fail('VIDEO_STORAGE_FULL');
    const id = randomUUID(); const file = path.join(directory, `${id}.mp4`); const handle = await open(file, 'wx', 0o600); let total = 0; let header = Buffer.alloc(0);
    try {
      for await (const chunk of request) {
        total += chunk.length; if (total > length) fail('VIDEO_UPLOAD_INVALID');
        if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
        await handle.writeFile(chunk);
      }
      if (total !== length || header.subarray(4, 8).toString() !== 'ftyp') fail('VIDEO_UPLOAD_INVALID');
      await handle.sync();
      return { videoUrl: `${this.#origin}/videos/${this.#account}/${id}.mp4`, bytes: total };
    } catch (error) { await unlink(file).catch(() => {}); throw error; } finally { await handle.close(); }
  }
  async videoFile(id) {
    if (!UUID.test(id)) fail('VIDEO_NOT_FOUND');
    await this.#directory();
    const directory = path.join(this.#dir, 'videos'); const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.mode & 0o077) fail('VIDEO_NOT_FOUND');
    const handle = await open(path.join(directory, `${id}.mp4`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > MAX_VIDEO) { await handle.close(); fail('VIDEO_NOT_FOUND'); }
    return { handle, size: stat.size };
  }
  async #cleanUploads(state) {
    const directory = path.join(this.#dir, 'videos'); let files;
    try { const stat = await lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) return; files = await readdir(directory); } catch { return; }
    for (const file of files) {
      if (!UUID.test(file.slice(0, -4)) || !file.endsWith('.mp4')) continue;
      const pending = state.jobs.some(j => j.videoUrl === `${this.#origin}/videos/${this.#account}/${file}` && !['active', 'cancelled'].includes(j.state));
      if (!pending && this.#clock() - (await lstat(path.join(directory, file))).mtimeMs > 7 * 86400000) await unlink(path.join(directory, file));
    }
  }
  async shutdown() { this.#closed = true; await this.#working; }
}
