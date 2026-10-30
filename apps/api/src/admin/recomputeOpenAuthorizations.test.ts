/**
 * Bug 78 (left over from bug 09): "Recompute statuses" reports how many of
 * the merchant's transactions are still only authorized, but counted them
 * among rows its own query had already excluded (status NOT IN
 * ('authorized', 'voided')), so the figure was always 0.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withTransaction } from "../db/withTransaction.js";
import { createTestHarness } from "../testSupport/fixtures.js";
import { recomputeTransactionStatusesForMerchant } from "./transactionStatusRecompute.js";

const h = createTestHarness();

test("open authorizations are counted", async () => {
  const m = await h.merchant({ label: "recompute-open-auths" });
  await h.pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference)
     SELECT $1::uuid, s, 5000, CASE WHEN s = 'captured' THEN 5000 ELSE 0 END, 0, 'acq-open-auth-' || g || '-' || $1::text
       FROM unnest(ARRAY['authorized', 'authorized', 'voided', 'captured']) WITH ORDINALITY AS u(s, g)`,
    [m.merchantId],
  );

  const result = await withTransaction(h.pool, (client) => recomputeTransactionStatusesForMerchant(client, m.merchantId));

  assert.equal(result.openAuthorizations, 2);
  assert.equal(result.scanned, 1, "only the captured sale is a candidate for a status change");
});
