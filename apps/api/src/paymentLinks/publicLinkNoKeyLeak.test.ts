/**
 * The public payment-link page reveals nothing that authenticates the
 * merchant. GET /v1/payment-links/:token is unauthenticated; its own
 * contract says it "contains nothing that identifies or authenticates the
 * merchant beyond its display name". It returned the merchant's newest live
 * API key's prefix (its first 16 characters) and its full key_hash, giving
 * anyone with a link URL a head start on brute-forcing the key offline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

test("the public link response carries no API key prefix, hash or other key material", async () => {
  const m = await h.merchant({ label: "public-link" });
  const created = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/payment-links`,
    headers: h.bearer(m),
    payload: { amountFils: 2_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { token } = created.json() as { token: string };

  const res = await h.app.inject({ method: "GET", url: `/v1/payment-links/${token}` });
  assert.equal(res.statusCode, 200, res.body);

  const key = await h.pool.query<{ key_prefix: string; key_hash: string }>(
    `SELECT key_prefix, key_hash FROM api_keys WHERE merchant_id = $1`,
    [m.merchantId],
  );
  assert.ok(!res.body.includes(key.rows[0]!.key_prefix), "response leaks the API key prefix");
  assert.ok(!res.body.includes(key.rows[0]!.key_hash), "response leaks the API key hash");
  assert.ok(!res.body.includes(m.rawKey.slice(0, 12)), "response leaks part of the raw key");
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.merchantPublicKey, undefined);
  assert.equal(body.merchantIntegrationId, undefined);
  assert.ok(body.merchantDisplayName, "the display name is still shown");
});
