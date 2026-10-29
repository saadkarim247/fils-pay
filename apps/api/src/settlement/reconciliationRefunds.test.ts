/**
 * The merchant reconciliation report must explain a period with refunds.
 *
 * gap = ledger merchant_payable net - settled net payout - pending (not yet
 * batched). The report's own contract: "Refund legs are included both in the
 * ledger figure and in pending, so a period with refunds still explains to
 * zero." Pending only counted captures, so an unbatched refund lowered the
 * ledger figure but not pending, and the report showed an unexplained gap.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { createTestHarness } from "../testSupport/fixtures.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { getReconciliationReport } from "./query.js";

const h = createTestHarness();

/** Today's Bahrain business date and the next one, YYYY-MM-DD. */
function todayWindow(): { from: string; to: string } {
  const bahrainNow = new Date(Date.now() + 3 * 3_600_000);
  const from = bahrainNow.toISOString().slice(0, 10);
  const to = new Date(bahrainNow.getTime() + 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

test("a captured sale with a not-yet-settled partial refund still reconciles to zero", async () => {
  const m = await h.merchant({ label: "recon-refund", mdrBps: 250 });
  const tx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200); // fee 250, net 9,750
  const refund = await initiateMerchantRefund(h.pool, h.app.acquirer, {
    merchantId: m.merchantId,
    transactionId: tx,
    amountFils: toFils(4_000), // fee reversed 100, net 3,900
    reason: "recon test",
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });
  assert.equal(refund.statusCode, 200, JSON.stringify(refund.body));

  const report = await getReconciliationReport(h.pool, { merchantId: m.merchantId, ...todayWindow() });
  assert.equal(report.ledgerMerchantPayableNetFils, 5_850);
  assert.equal(report.pendingUnbatchedFils, 5_850, "pending = 9,750 captured net - 3,900 refunded net");
  assert.equal(report.gapFils, 0);
  assert.equal(report.explained, true);
});

test("a period with only a refund (sale settled earlier) is explained too", async () => {
  const m = await h.merchant({ label: "recon-refund", mdrBps: 250 });
  const tx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  // Pretend the capture was settled already: mark its event batched in an
  // old batch so only the refund is pending in today's window.
  const batch = await h.pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils)
     VALUES ($1, '2026-01-05', 'paid', 10000, 250, 9750) RETURNING id`,
    [m.merchantId],
  );
  await h.pool.query(`UPDATE transaction_events SET settlement_batch_id = $2 WHERE transaction_id = $1`, [tx, batch.rows[0]!.id]);
  await h.pool.query(`UPDATE ledger_entries SET occurred_at = '2026-01-05T08:00:00Z' WHERE transaction_id = $1`, [tx]);

  const refund = await initiateMerchantRefund(h.pool, h.app.acquirer, {
    merchantId: m.merchantId,
    transactionId: tx,
    amountFils: toFils(2_000), // fee reversed 50, net 1,950
    reason: "recon test",
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });
  assert.equal(refund.statusCode, 200);

  const report = await getReconciliationReport(h.pool, { merchantId: m.merchantId, ...todayWindow() });
  assert.equal(report.ledgerMerchantPayableNetFils, -1_950);
  assert.equal(report.pendingUnbatchedFils, -1_950);
  assert.equal(report.explained, true);
});
