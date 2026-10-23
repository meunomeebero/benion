// Optional private configuration for an instance whose first account predates
// the multi-account registry. Generic installs have no owner.json.
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const MAX_BYTES = 1024 * 1024;
// Files the original account wrote directly in the private root. A start without
// owner.json must not silently orphan them (and their campaigns or ledgers).
const ROOT_STATE = ['connection.json', 'capabilities.json', 'campaigns.json', 'publishing.json', 'ledger', 'contact-ledger', 'comment-ledger', 'inbox', 'assistant'];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const numeric = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const username = value => typeof value === 'string' && /^[a-z0-9_.]{1,30}$/.test(value);

export class OwnerConfigError extends Error {
  constructor(code) { super(code); this.name = 'OwnerConfigError'; this.code = code; }
}
const fail = code => { throw new OwnerConfigError(code); };

function httpsLink(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}

export function validLegacy(legacy) {
  return exact(legacy, ['reelUrl', 'shortcode', 'mediaId', 'protectedCount', 'requiredLinks']) &&
    typeof legacy.shortcode === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(legacy.shortcode) &&
    legacy.reelUrl === `https://www.instagram.com/reel/${legacy.shortcode}/` && numeric(legacy.mediaId) &&
    Number.isSafeInteger(legacy.protectedCount) && legacy.protectedCount > 0 && legacy.protectedCount <= 1000 &&
    Array.isArray(legacy.requiredLinks) && legacy.requiredLinks.length <= 5 && legacy.requiredLinks.every(httpsLink) &&
    new Set(legacy.requiredLinks).size === legacy.requiredLinks.length;
}

// The record keeps the original manual recovery schema. Its sent rows are the
// exact comment IDs that must never receive an automatic DM.
export function parseLegacyRecovery(data, { account, legacy }) {
  if (!object(data) || data.schemaVersion !== 1 || data.account !== account || data.reel !== legacy.reelUrl || !Array.isArray(data.comments)) fail('LEGACY_RECOVERY_INVALID');
  const sent = data.comments.filter(comment => comment.status === 'sent');
  if (sent.length !== legacy.protectedCount) fail('LEGACY_RECOVERY_INVALID');
  const ids = new Set();
  for (const comment of sent) {
    if (typeof comment.commentId !== 'string' || !/^\d{1,40}$/.test(comment.commentId) || typeof comment.username !== 'string' ||
        !/^[\w.]{1,30}$/.test(comment.username) || ids.has(comment.commentId)) fail('LEGACY_RECOVERY_INVALID');
    ids.add(comment.commentId);
  }
  return { sent, excludedIds: new Set((data.excludedReplies || []).map(reply => reply.commentId)) };
}

async function readPrivateJSON(filename, code) {
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return undefined; fail(code); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.mode & 0o077) fail(code);
    return JSON.parse(await handle.readFile('utf8'));
  } catch { fail(code); }
  finally { await handle.close(); }
}

function freeze(value) {
  if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

// Returns null for a generic install, or { primaryAccount, legacy } where legacy
// also carries the validated private recovery record.
export async function loadOwnerConfig(dataDir) {
  const config = await readPrivateJSON(path.join(dataDir, 'owner.json'), 'OWNER_CONFIG_INVALID');
  if (config === undefined) {
    for (const name of ROOT_STATE) {
      try { await lstat(path.join(dataDir, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; fail('OWNER_CONFIG_INVALID'); }
      fail('OWNER_CONFIG_REQUIRED');
    }
    return null;
  }
  if (!object(config) || config.schemaVersion !== 1 || Object.keys(config).some(key => !['schemaVersion', 'primaryAccount', 'legacy'].includes(key)) ||
      !exact(config.primaryAccount, ['id', 'username']) || !numeric(config.primaryAccount.id) || !username(config.primaryAccount.username) ||
      (config.legacy != null && !validLegacy(config.legacy))) fail('OWNER_CONFIG_INVALID');
  const primaryAccount = { id: config.primaryAccount.id, username: config.primaryAccount.username };
  if (config.legacy == null) return freeze({ primaryAccount, legacy: null });
  const recovery = await readPrivateJSON(path.join(dataDir, 'legacy-recovery.json'), 'LEGACY_RECOVERY_INVALID');
  if (recovery === undefined) fail('LEGACY_RECOVERY_REQUIRED');
  try { parseLegacyRecovery(recovery, { account: primaryAccount.username, legacy: config.legacy }); }
  catch { fail('LEGACY_RECOVERY_INVALID'); }
  return freeze({ primaryAccount, legacy: { ...config.legacy, recovery } });
}
