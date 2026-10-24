import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { PrivateStateFile, InboxError } from './inbox.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new InboxError(code, code); };
export const conversionSecretReady = secret => typeof secret === 'string' && secret.length >= 32;

export function verifyConversionSignature(raw, timestamp, signature, secret, now = Date.now()) {
  if (!conversionSecretReady(secret) || !Buffer.isBuffer(raw) || typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) ||
      Math.abs(now - Number(timestamp) * 1000) > 300000 || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function campaignLink(link, campaignId) {
  const url = new URL(link);
  if (!identifier(campaignId) || url.protocol !== 'https:' || url.username || url.password) fail('CONVERSION_LINK_INVALID');
  url.searchParams.set('benion_campaign', campaignId);
  return url.href;
}

export class ConversionService {
  #store; #account; #clock; #configured; #campaignExists;
  constructor({ dataDir, accountId, configured = false, campaignExists, clock = Date.now }) {
    this.#account = accountId; this.#configured = configured; this.#campaignExists = campaignExists; this.#clock = clock;
    this.#store = new PrivateStateFile({ directory: path.join(dataDir, 'conversions'), filename: 'events.json',
      initial: () => ({ version: 1, accountId, verifiedAt: null, events: {}, orders: {} }),
      validate: state => state?.version === 1 && state.accountId === accountId &&
        (state.verifiedAt === null || Number.isFinite(Date.parse(state.verifiedAt))) &&
        state.events && typeof state.events === 'object' && !Array.isArray(state.events) &&
        state.orders && typeof state.orders === 'object' && !Array.isArray(state.orders) &&
        Object.values(state.events).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) &&
        Object.values(state.orders).every(order => identifier(order.campaignId) && typeof order.purchased === 'boolean' && typeof order.refunded === 'boolean' &&
          (order.couponCode === null || typeof order.couponCode === 'string' && /^[A-Z0-9_-]{1,40}$/.test(order.couponCode))) });
  }
  async ingest(body) {
    if (!this.#configured) fail('CONVERSIONS_NOT_CONFIGURED');
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.accountId !== this.#account || !identifier(body.eventId) ||
        !['connection_test', 'purchase', 'refund'].includes(body.type)) fail('CONVERSION_EVENT_INVALID');
    const keys = body.type === 'connection_test' ? ['accountId', 'eventId', 'type'] : ['accountId', 'eventId', 'type', 'campaignId', 'orderId', 'occurredAt', 'couponCode'];
    if (Object.keys(body).some(key => !keys.includes(key))) fail('CONVERSION_EVENT_INVALID');
    let orderKey;
    if (body.type !== 'connection_test') {
      if (!identifier(body.campaignId) || !identifier(body.orderId) || !Number.isFinite(Date.parse(body.occurredAt)) || Date.parse(body.occurredAt) > this.#clock() + 300000 ||
          (body.couponCode != null && (typeof body.couponCode !== 'string' || !/^[A-Z0-9_-]{1,40}$/.test(body.couponCode)))) fail('CONVERSION_EVENT_INVALID');
      if (!await this.#campaignExists(body.campaignId)) fail('CONVERSION_CAMPAIGN_UNKNOWN');
      orderKey = digest(body.orderId);
    }
    const eventKey = digest(body.eventId);
    const fingerprint = digest(JSON.stringify([body.accountId, body.type, body.campaignId ?? null, body.orderId ?? null, body.occurredAt ?? null, body.couponCode ?? null]));
    return this.#store.update(state => {
      if (state.events[eventKey]) {
        if (state.events[eventKey] !== fingerprint) fail('CONVERSION_EVENT_CONFLICT');
        return { accepted: true, duplicate: true };
      }
      if (Object.keys(state.events).length >= 15000) fail('CONVERSION_STORE_FULL');
      if (orderKey) {
        const order = state.orders[orderKey] ?? { campaignId: body.campaignId, purchased: false, refunded: false, couponCode: null };
        if (order.campaignId !== body.campaignId || (body.type === 'purchase' && order.purchased && order.couponCode !== (body.couponCode ?? null))) fail('CONVERSION_ORDER_CONFLICT');
        if (body.type === 'purchase') { order.purchased = true; order.couponCode = body.couponCode ?? null; }
        else order.refunded = true;
        state.orders[orderKey] = order;
      }
      state.events[eventKey] = fingerprint;
      state.verifiedAt ||= new Date(this.#clock()).toISOString();
      return { accepted: true, duplicate: false };
    });
  }
  async report(campaignIds = []) {
    const state = await this.#store.read();
    const available = this.#configured && Boolean(state.verifiedAt);
    const metrics = {};
    for (const id of campaignIds) {
      const orders = Object.values(state.orders).filter(order => order.campaignId === id && order.purchased);
      metrics[id] = { available, purchases: available ? orders.length : null,
        refunded: available ? orders.filter(order => order.refunded).length : null,
        netPurchases: available ? orders.filter(order => !order.refunded).length : null,
        couponPurchases: available ? orders.filter(order => order.couponCode !== null).length : null,
        clicks: null };
    }
    return { configured: this.#configured, available, verifiedAt: state.verifiedAt, metrics };
  }
}
