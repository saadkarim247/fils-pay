/**
 * A merchant's negotiated discount applies to every capture, including
 * captures made by a buyer paying a payment link.
 *
 * The discount (merchants.negotiated_discount_bps) is applied to the MDR fee
 * after capture by applyCaptureDiscountAdjustment. Only the API capture
 * route called it; the payment-link flow did not (a comment in pay.ts
 * claims it was "moved into capture.ts in July" - it wasn't). These tests
 * pay a real link through the public endpoint and compare the net fee with
 * a real API capture of the same amount for the same merchant.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness, VALID_CARD, type TestMerchant } from "../testSupport/fixtures.js";

const h = createTestHarness();

async function discountedMerchant(discountBps: number): Promise<TestMerchant> {
  const m = await h.merchant({ label: "link-discount", mdrBps: 250 });
  await h.pool.query(`UPDATE merchants SET negotiated_discount_bps = $2 WHERE id = $1`, [m.merchantId, discountBps]);
  return m;
}

/** Platform fee net of any discount for one transaction, from the ledger. */
async function netFee(transactionId: string): Promise<number> {
  const r = await h.pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [transactionId],
  );
  return Number(r.rows[0]!.net);
}

async function payLink(m: TestMerchant, amountFils: number): Promise<string> {
  const created = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/payment-links`,
    headers: h.bearer(m),
    payload: { amountFils, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { id, token } = created.json() as { id: string; token: string };
  assert.ok(token, `create response should carry the link token: ${created.body}`);

  const paid = await h.app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: VALID_CARD },
  });
  assert.equal(paid.statusCode, 200, paid.body);
  const tx = await h.pool.query<{ transaction_id: string }>(
    `SELECT transaction_id FROM payment_links WHERE id = $1 AND status = 'paid'`,
    [id],
  );
  return tx.rows[0]!.transaction_id;
}

test("a link payment gets the merchant's 20% fee discount, exactly like an API capture", async () => {
  const m = await discountedMerchant(2_000);
  const apiTx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, apiTx)).statusCode, 200);
  const linkTx = await payLink(m, 10_000);

  assert.equal(await netFee(apiTx), 200, "API capture: 250 fee - 50 discount");
  assert.equal(await netFee(linkTx), 200, "link payment must be charged the same discounted fee");
});

test("a merchant with no negotiated discount pays the plain fee on links", async () => {
  const m = await discountedMerchant(0);
  assert.equal(await netFee(await payLink(m, 10_000)), 250);
});
