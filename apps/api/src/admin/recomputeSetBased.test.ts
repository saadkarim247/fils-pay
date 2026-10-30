/**
 * N+1: "Recompute statuses" issued one UPDATE per transaction whose status
 * changed. The rule (nextStatusAfterRefund) still decides each status; the
 * changes are now applied in one statement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withTransaction } from "../db/withTransaction.js";
import { createTestHarness } from "../testSupport/fixtures.js";
import { countingPool } from "../testSupport/countingPool.js";
import { recomputeTransactionStatusesForMerchant } from "./transactionStatusRecompute.js";

const h = createTestHarness();

test("recomputing 60 transactions is one read and one update, with the same results", async () => {
  const m = await h.merchant({ label: "recompute-n1" });
  await h.pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference)
     SELECT $1::uuid, 'captured', 5000, 5000, CASE WHEN g <= 40 THEN 5000 WHEN g <= 50 THEN 1000 ELSE 0 END, 'acq-recompute-n1-' || g || '-' || $1::text
       FROM generate_series(1, 60) g`,
    [m.merchantId],
  );

  const counted = countingPool(h.pool);
  const result = await withTransaction(counted.pool, (client) => recomputeTransactionStatusesForMerchant(client, m.merchantId));

  assert.equal(result.scanned, 60);
  assert.equal(result.updated, 50);
  assert.ok(counted.count() <= 5, `recomputing 60 transactions took ${counted.count()} queries`);
  const byStatus = await h.pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM transactions WHERE merchant_id = $1 GROUP BY status ORDER BY status`,
    [m.merchantId],
  );
  assert.deepEqual(byStatus.rows, [
    { status: "captured", n: 10 },
    { status: "partially_refunded", n: 10 },
    { status: "refunded", n: 40 },
  ]);
});
