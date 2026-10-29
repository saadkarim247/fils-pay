/**
 * Refunds give back exactly the fee the platform kept, to the fil.
 *
 * Each refund reverses a share of the MDR fee. That share was rounded per
 * refund, independently, so partial refunds did not add up to the fee
 * (225 bps on 1,000: fee 22, refunds 333+333+334 reversed 7+7+7 = 21;
 * 250 bps on 1,000: fee 25, refunds 300+700 reversed 8+18 = 26, more than
 * was charged). It also took "the fee charged" as the gross MDR credit,
 * ignoring the negotiated-discount rebate, so a discounted merchant got
 * back more fee than the platform ever kept.
 *
 * The rule checked here: after every refund, total fee reversed =
 * round(net fee x refunded so far / captured); after the last refund the
 * platform's fee revenue for the payment is exactly zero.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";
import { initiateMerchantRefund } from "./initiateMerchantRefund.js";

const h = createTestHarness();

async function refund(m: TestMerchant, transactionId: string, amountFils: number): Promise<number> {
  const res = await initiateMerchantRefund(h.pool, h.app.acquirer, {
    merchantId: m.merchantId,
    transactionId,
    amountFils: toFils(amountFils),
    reason: "fee test",
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return (res.body as { feeReversedFils: number }).feeReversedFils;
}

/** Platform fee revenue still held for this payment (credits - debits). */
async function feeHeld(transactionId: string): Promise<number> {
  const r = await h.pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [transactionId],
  );
  return Number(r.rows[0]!.net);
}

async function captured(m: TestMerchant, amount: number): Promise<string> {
  const tx = await h.authorize(m, amount);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  return tx;
}

test("225 bps on 1,000 (fee 22): refunds of 333 + 333 + 334 reverse exactly 22", async () => {
  const m = await h.merchant({ label: "fee-reversal", mdrBps: 225 });
  const tx = await captured(m, 1_000);
  assert.equal(await feeHeld(tx), 22);

  const reversals = [await refund(m, tx, 333), await refund(m, tx, 333), await refund(m, tx, 334)];
  assert.equal(reversals.reduce((a, b) => a + b, 0), 22, `reversed ${reversals.join("+")}`);
  assert.equal(await feeHeld(tx), 0);
});

test("250 bps on 1,000 (fee 25): refunds of 300 + 700 reverse 25, never more than was charged", async () => {
  const m = await h.merchant({ label: "fee-reversal", mdrBps: 250 });
  const tx = await captured(m, 1_000);
  const reversals = [await refund(m, tx, 300), await refund(m, tx, 700)];
  assert.equal(reversals.reduce((a, b) => a + b, 0), 25, `reversed ${reversals.join("+")}`);
  assert.equal(await feeHeld(tx), 0);
});

test("a merchant with a 20% fee discount gets back the discounted fee, not the gross one", async () => {
  const m = await h.merchant({ label: "fee-reversal", mdrBps: 250 });
  await h.pool.query(`UPDATE merchants SET negotiated_discount_bps = 2000 WHERE id = $1`, [m.merchantId]);
  const tx = await captured(m, 10_000);
  assert.equal(await feeHeld(tx), 200, "250 fee - 50 discount");

  assert.equal(await refund(m, tx, 10_000), 200);
  assert.equal(await feeHeld(tx), 0, "the platform must not pay back more fee than it kept");
});

test("a single partial refund reverses the proportional, rounded share", async () => {
  const m = await h.merchant({ label: "fee-reversal", mdrBps: 250 });
  const tx = await captured(m, 10_000); // fee 250
  assert.equal(await refund(m, tx, 2_500), 62, "250 x 2,500 / 10,000 = 62.5, half to even (ADR-0001) = 62");
});
