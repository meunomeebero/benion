import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { ConversionService } from '../conversions.mjs';
import { PublishingService } from '../publishing.mjs';
import { createBenionServer } from '../server.mjs';
import { runtimeConfig } from '../runtime.mjs';

test('scheduled referral → signed purchase → idempotent reporting and refund across restart, with forged and cross-account requests rejected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benion-conversions-'));
  const webRoot = path.join(root, 'public'); await mkdir(webRoot);
  const dataDir = path.join(root, 'private'); await mkdir(dataDir, { mode: 0o700 });
  const accountId = '100'; const secret = 'synthetic-conversion-secret-at-least-32-characters';
  const env = { BENION_MODE: 'production', BENION_PUBLIC_ORIGIN: 'https://example.test', BENION_ADMIN_PASSWORD: 'synthetic-admin-password', BENION_SESSION_SECRET: 'synthetic-session-secret-at-least-32-characters', BENION_CONVERSION_SECRET: secret };
  let now = Date.parse('2026-10-24T15:00:00Z'); let campaignMessage;
  const client = { createReelContainer: async () => ({ id: '10' }), reelContainerStatus: async () => ({ status: 'FINISHED' }),
    listMedia: async () => ({ media: [], truncated: false }), publishReel: async () => ({ id: '20' }) };
  const campaigns = { createFromPublication: async values => { campaignMessage = values.messageText; return { status: { running: true }, enabled: true, reel: { permalink: 'https://www.instagram.com/reel/example/' } }; } };
  const publishing = new PublishingService({ dataDir, accountId, campaigns, conversionTracking: true, clock: () => now,
    clientProvider: async () => ({ client, identity: { userId: accountId } }) });
  const create = () => new ConversionService({ dataDir, accountId, configured: true, campaignExists: id => publishing.hasCampaign(id), clock: () => now });
  let conversions = create();
  const accounts = { resolve: async id => { assert.equal(id, accountId); return { conversions, publishing, connection: {} }; }, runtimes: async () => [] };
  const app = createBenionServer({ env, config: runtimeConfig(env), webRoot, privateDirectory: dataDir, accounts, clock: () => now });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await publishing.shutdown(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = (body, { signature = true, target = accountId, timestamp = String(Math.floor(now / 1000)) } = {}) => new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const signed = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`;
    const req = http.request({ host: '127.0.0.1', port: app.server.address().port, path: `/webhooks/conversions/${target}`, method: 'POST',
      headers: { Host: 'example.test', 'Content-Type': 'application/json', 'X-Benion-Timestamp': timestamp, 'X-Benion-Signature': signature ? signed : `sha256=${'0'.repeat(64)}` } }, res => {
      let value = ''; res.on('data', part => value += part); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(value) }));
    }); req.on('error', reject); req.end(raw);
  });
  const id = randomUUID(), groupId = randomUUID();
  await publishing.createGroup({ id: groupId, name: 'Synthetic campaign' });
  const scheduled = await publishing.schedule({ id, groupId, title: 'Synthetic Reel', caption: 'Example caption', videoUrl: 'https://example.test/video.mp4',
    scheduledAt: new Date(now + 60000).toISOString(), dmText: 'Try the product', dmLink: 'https://example.test/trial?offer=EXAMPLE#start' });
  const link = new URL(scheduled.deliveryDmLink);
  assert.equal(link.searchParams.get('benion_campaign'), id); assert.equal(link.searchParams.get('offer'), 'EXAMPLE'); assert.equal(link.hash, '#start');
  assert.equal((await conversions.report([id])).metrics[id].purchases, null);
  now += 60000; await publishing.processDue();
  assert.equal(campaignMessage, `Try the product\n\n${scheduled.deliveryDmLink}`);
  const purchase = { accountId, eventId: 'event-one', type: 'purchase', campaignId: id, orderId: 'opaque-order-one', occurredAt: new Date(now).toISOString(), couponCode: 'EXAMPLE50' };
  assert.equal((await request(purchase, { signature: false })).status, 403);
  assert.equal((await request(purchase, { timestamp: String(Math.floor(now / 1000) - 301) })).status, 403);
  assert.equal((await request(purchase, { target: '200' })).status, 400);
  assert.equal((await request({ ...purchase, campaignId: randomUUID() })).body.error, 'CONVERSION_CAMPAIGN_UNKNOWN');
  assert.equal((await conversions.report([id])).available, false);
  assert.equal((await request(purchase)).status, 200);
  assert.equal((await request(purchase)).body.duplicate, true);
  assert.equal((await request({ ...purchase, eventId: 'event-same-order' })).status, 200);
  assert.equal((await request({ ...purchase, orderId: 'different-order' })).body.error, 'CONVERSION_EVENT_CONFLICT');
  conversions = create();
  assert.deepEqual((await conversions.report([id])).metrics[id], { available: true, purchases: 1, refunded: 0, netPurchases: 1, couponPurchases: 1, clicks: null });
  const refund = { ...purchase, eventId: 'refund-one', type: 'refund' };
  assert.equal((await request(refund)).status, 200);
  assert.equal((await request(refund)).body.duplicate, true);
  assert.equal((await conversions.report([id])).metrics[id].netPurchases, 0);
  const earlyRefund = { ...refund, eventId: 'refund-before-purchase', orderId: 'opaque-order-two' };
  assert.equal((await request(earlyRefund)).status, 200);
  assert.equal((await request({ ...earlyRefund, type: 'purchase', eventId: 'late-purchase' })).status, 200);
  const metrics = (await create().report([id])).metrics[id];
  assert.equal(metrics.purchases, 2); assert.equal(metrics.refunded, 2); assert.equal(metrics.netPurchases, 0);
});
