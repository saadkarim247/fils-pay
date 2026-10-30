/**
 * Deferred item: the negotiated discount was rounded differently by the
 * ledger (TS) and by settlement (Go), so a discounted merchant's ledger and
 * batches disagreed by about a fil per capture.
 *
 * ARCHITECTURE: "Discounts reduce the amount the MDR is charged on." Go's
 * ComputeSettlementFee does exactly that: fee = MDR(amount - discount(amount)).
 * TS charged MDR(amount) and then rebated discount(fee).
 *
 * 602 fils at 275 bps with a 1250 bps (12.5 %) discount:
 *   Go:  discounted = 602 - round(75.25) = 527; fee = round(14.49) = 14
 *   TS:  fee = round(16.555) = 17; rebate = round(2.125) = 2; kept 15
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getReconciliationReport } from "../settlement/query.js";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

function bahrainDate(offsetDays: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

test("a discounted capture keeps exactly the fee settlement charges, and reconciliation has no gap", async () => {
  const m = await h.merchant({ mdrBps: 275, label: "discount-rounding" });
  await h.pool.query(`UPDATE merchants SET negotiated_discount_bps = 1250 WHERE id = $1`, [m.merchantId]);

  const tx = await h.authorize(m, 602);
  assert.equal((await h.capture(m, tx)).statusCode, 200);

  const kept = await h.pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [tx],
  );
  assert.equal(Number(kept.rows[0]!.net), 14, "the ledger must keep Go's ComputeSettlementFee(602, 275, 1250) = 14");

  const report = await getReconciliationReport(h.pool, { merchantId: m.merchantId, from: bahrainDate(0), to: bahrainDate(1) });
  assert.equal(report.gapFils, 0, JSON.stringify(report));
});

/** The same table is asserted against Go's ComputeSettlementFee in
 *  apps/settlement/internal/settlement/discounted_fee_parity_test.go, so the
 *  two implementations can't drift apart again unnoticed. */
const DISCOUNTED_FEE_PARITY: ReadonlyArray<readonly [amount: number, mdrBps: number, discountBps: number, fee: number]> = [
  [602, 275, 1250, 14],
  [10000, 250, 1000, 225],
  [1, 250, 5000, 0],
  [999999, 275, 1250, 24062],
  [12345, 0, 1000, 0],
  [5000, 275, 0, 138],
  [4, 2500, 5000, 0],
  [1999, 333, 777, 61],
];

test("discountedFeeFils matches the shared TS/Go parity table", async () => {
  const { discountedFeeFils } = await import("../fees/discountedFee.js");
  const { toFils } = await import("@filspay/money");
  for (const [amount, mdrBps, discountBps, fee] of DISCOUNTED_FEE_PARITY) {
    assert.equal(discountedFeeFils(toFils(amount), mdrBps, discountBps), fee, `${amount} @ ${mdrBps} bps, ${discountBps} bps off`);
  }
});
