#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const actions = new Map([['configure', '/config'], ['reserve', '/reserve'], ['start', '/start'], ['generation', '/generation'], ['asset', '/asset'], ['schedule', '/schedule']]);
const action = process.argv[2];
let logout;

async function authSettings() {
  const filename = process.env.BENION_WORKFLOW_AUTH_FILE;
  if (!filename) return { origin: process.env.BENION_ORIGIN || 'http://127.0.0.1:5197' };
  if (!path.isAbsolute(filename)) fail('CONTENT_AUTH_FILE_INVALID');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('CONTENT_AUTH_FILE_INVALID');
    const data = JSON.parse(await handle.readFile('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['origin', 'password'].includes(key)) ||
        typeof data.origin !== 'string' || typeof data.password !== 'string' || !data.password || data.password.length > 256) fail('CONTENT_AUTH_FILE_INVALID');
    return data;
  } finally { await handle.close(); }
}

async function input() {
  let data = '';
  for await (const chunk of process.stdin) { data += chunk; if (Buffer.byteLength(data) > 30000) fail('CONTENT_INPUT_TOO_LARGE'); }
  try { return JSON.parse(data); } catch { fail('CONTENT_INPUT_INVALID'); }
}

function summary(row) {
  return { id: row.id, accountId: row.accountId, status: row.status, trend: row.trend, scheduledAt: row.scheduledAt,
    jobIds: row.jobIds, publicationId: row.publicationId, ...(row.mayGenerate !== undefined ? { mayGenerate: row.mayGenerate } : {}),
    ...(row.reused !== undefined ? { reused: row.reused } : {}) };
}

try {
  if (process.argv.length !== 3 || (!actions.has(action) && action !== 'list')) fail('CONTENT_COMMAND_INVALID');
  const accountId = process.env.BENION_ACCOUNT_ID;
  if (!/^\d{1,40}$/.test(accountId || '')) fail('CONTENT_ACCOUNT_REQUIRED');
  const settings = await authSettings(); const origin = new URL(settings.origin);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)))) fail('CONTENT_ORIGIN_INVALID');
  let cookie = '';
  if (settings.password) {
    const response = await fetch(`${origin.origin}/admin/login`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Origin: origin.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: settings.password }) });
    settings.password = '';
    if (response.status !== 303 || response.headers.get('location') !== '/') fail('CONTENT_LOGIN_FAILED');
    const cookies = response.headers.getSetCookie();
    cookie = cookies.map(value => value.split(';')[0]).find(value => value.startsWith('benion_admin='));
    if (!cookie) fail('CONTENT_LOGIN_FAILED');
  }
  const headers = { Origin: origin.origin, 'X-Benion-Request': '1', 'X-Benion-Account': accountId, ...(cookie ? { Cookie: cookie } : {}) };
  const request = async (endpoint, options = {}) => {
    const response = await fetch(`${origin.origin}${endpoint}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { ...headers, ...options.headers } });
    let data; try { data = await response.json(); } catch { fail('CONTENT_RESPONSE_INVALID'); }
    if (!response.ok) fail(typeof data.error === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(data.error) ? data.error : 'CONTENT_REQUEST_FAILED');
    return data;
  };
  if (cookie) logout = async () => {
    const { nonce } = await request('/api/csrf');
    await request('/api/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Benion-CSRF': nonce }, body: '{}' });
  };
  if (action === 'list') {
    const data = await request('/api/content-workflow');
    process.stdout.write(JSON.stringify({ available: data.available, accountId: data.accountId, configured: Boolean(data.config), jobs: data.jobs.map(summary) }) + '\n');
  } else {
    const body = await input(); const { nonce } = await request('/api/csrf');
    if (typeof nonce !== 'string') fail('CONTENT_CSRF_FAILED');
    const data = await request('/api/content-workflow' + actions.get(action), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Benion-CSRF': nonce }, body: JSON.stringify(body) });
    process.stdout.write(JSON.stringify(action === 'configure' ? { configured: true, seriesId: data.seriesId } : summary(data)) + '\n');
  }
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code || '') ? error.code : 'CONTENT_COMMAND_FAILED';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
} finally { await logout?.().catch(() => {}); }
