# Confirmed campaign conversions

Benion receives conversion facts from your product's trusted backend. It does not apply coupons, collect payments, infer purchases from conversations or trust browser checkout-success redirects. Set a distinct `BENION_CONVERSION_SECRET` (at least 32 random characters) in the host and product backend secret stores. Never expose it to the frontend, chat, repository or request logs.

New scheduled Reels then append `benion_campaign=<publication UUID>` to the DM link. Existing schedules and sends retain their original link. The ID identifies a campaign, not a recipient. Preserve it through signup/checkout using your product's own attribution storage. Validate incoming IDs and choose/document your attribution policy, for example first touch. Links are shareable: this measures attributed paid orders, not unique Instagram recipients or causal uplift. Existing standalone comment campaigns can use their stable campaign ID in the same parameter; do not rewrite a running campaign to backfill attribution.

## Backend callback

Send `POST /webhooks/conversions/<INSTAGRAM_ACCOUNT_ID>` over HTTPS from your backend. Serialize JSON once; compute `HMAC-SHA256(secret, timestamp + "." + exactBodyBytes)`. Headers are `Content-Type: application/json`, `X-Benion-Timestamp` (Unix seconds) and `X-Benion-Signature: sha256=<lowercase hex digest>`. Requests must arrive within five minutes of the timestamp. On retries use a fresh timestamp/signature but the same event ID and identical event fields.

First send `{"accountId":"YOUR_ACCOUNT_ID","eventId":"unique-test-id","type":"connection_test"}`. Until a valid signed callback arrives, the dashboard reports conversions as **unavailable**, not zero. The first accepted callback establishes the integration verification time; it does not prove historical coverage. Reconcile your product's payment ledger before assuming the report is complete.

After independently verifying a **paid** order against your payment provider, send:

```json
{
  "accountId": "YOUR_ACCOUNT_ID",
  "eventId": "opaque-provider-event-id",
  "type": "purchase",
  "campaignId": "PUBLICATION_UUID_OR_CAMPAIGN_ID",
  "orderId": "opaque-internal-order-id",
  "occurredAt": "2026-11-01T15:10:00Z",
  "couponCode": "EXAMPLE50"
}
```

IDs use 1–100 ASCII letters, digits, hyphens or underscores. Use stable opaque IDs; no email, name, Instagram recipient ID or DM content. `couponCode` is optional/null, with 1–40 uppercase letters, digits, underscores or hyphens. The exact account and campaign must exist in this installation. Send `type: "refund"` with a new stable event ID and the same order/campaign when the order is fully refunded; do not call a partial adjustment a full refund. Refunds can arrive before the matching purchase and still remove it from net purchases when reconciled.

Benion stores hashes of event/order IDs in its account's private `conversions/` directory. Duplicate event IDs are accepted only with identical fields; conflicting reuse is rejected. Multiple provider events for the same order count once. Keep the product's outbox until Benion returns 200; retry temporary connection/server failures with backoff. Fix signature, identity and event-conflict errors instead of blindly retrying them. A private store limit or interrupted filesystem lock requires operator review, never deleting the ledger.

The campaign dashboard separates purchases, refunded purchases, coupon purchases and API-accepted DMs. Click counts remain unavailable because this integration does not measure clicks. Purchases can be backfilled from verified historical provider events using their actual `occurredAt`; maintain stable IDs so retries cannot inflate totals.

## Coupon contract from the example video

The advertised `LOL50` offer means 50% off, uppercase with no spaces, no expiry, and only the first paid purchase of an account with no previous purchase. This is an example integration contract, **not a coupon created or activated by Benion**. The product must enforce it transactionally before charging, including concurrent checkouts, existing purchase history and provider webhook reconciliation. Confirm the deployed product configuration before advertising the offer. Benion's callback records the coupon reported on a verified order; it is not the coupon eligibility authority.

Synthetic validation: `node --test tests/conversions.test.mjs`. It exercises signed callbacks, forged/stale/cross-account rejection, duplicate events and orders, refunds, restart recovery and the scheduled DM attribution link without real payments or messages.
