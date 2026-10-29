/**
 * A payment link's expiry is judged by the SERVER's clock, except for the
 * link's own merchant's offline terminal (FP-187).
 *
 * The pay route is public. It passed the buyer-supplied submittedAt straight
 * into the expiry check, so any buyer could pay an expired link by claiming
 * an old time ("2000-01-01"). The route's own contract says submittedAt is
 * "ignored unless the request is authenticated with an API key", and
 * ARCHITECTURE allows it for offline terminals; a terminal authenticates as
 * the merchant that owns the link.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness, VALID_CARD, type TestMerchant } from "../testSupport/fixtures.js";

const h = createTestHarness();

/** A link that expired 10 minutes ago (created an hour ago). */
async function expiredLink(m: TestMerchant): Promise<{ id: string; token: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/payment-links`,
    headers: h.bearer(m),
    payload: { amountFils: 3_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  const link = res.json() as { id: string; token: string };
  await h.pool.query(
    `UPDATE payment_links SET created_at = now() - interval '1 hour', expires_at = now() - interval '10 minutes' WHERE id = $1`,
    [link.id],
  );
  return link;
}

function pay(token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": randomUUID(), ...headers },
    payload: { card: VALID_CARD, ...body },
  });
}

async function linkStatus(id: string): Promise<string> {
  return (await h.pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [id])).rows[0]!.status;
}

const thirtyMinutesAgo = () => new Date(Date.now() - 30 * 60_000).toISOString();

test("a public buyer cannot pay an expired link by claiming an old submittedAt", async () => {
  const m = await h.merchant({ label: "link-clock" });
  const link = await expiredLink(m);
  const res = await pay(link.token, { submittedAt: "2000-01-01T00:00:00Z" });
  assert.equal(res.statusCode, 410, res.body);
  assert.equal(await linkStatus(link.id), "active");
});

test("a public buyer's plausible-looking submittedAt is ignored too", async () => {
  const m = await h.merchant({ label: "link-clock" });
  const link = await expiredLink(m);
  assert.equal((await pay(link.token, { submittedAt: thirtyMinutesAgo() })).statusCode, 410);
});

test("the link's own merchant terminal (its API key) may submit an offline time before expiry", async () => {
  const m = await h.merchant({ label: "link-clock" });
  const link = await expiredLink(m);
  const res = await pay(link.token, { submittedAt: thirtyMinutesAgo() }, h.bearer(m));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await linkStatus(link.id), "paid");
});

test("another merchant's API key does not unlock someone else's expired link", async () => {
  const owner = await h.merchant({ label: "link-clock" });
  const other = await h.merchant({ label: "link-clock-other" });
  const link = await expiredLink(owner);
  assert.equal((await pay(link.token, { submittedAt: thirtyMinutesAgo() }, h.bearer(other))).statusCode, 410);
  assert.equal(await linkStatus(link.id), "active");
});
