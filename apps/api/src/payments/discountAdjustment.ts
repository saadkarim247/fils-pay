import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { applyRateFils, subtractFils, toFils } from "@filspay/money";
import { withTransaction } from "../db/withTransaction.js";
import { discountedFeeFils } from "../fees/discountedFee.js";

/**
 * Applies a merchant's negotiated processing discount against the MDR fee
 * capture.ts already charged. ARCHITECTURE: "Discounts reduce the amount
 * the MDR is charged on", so the fee kept must be MDR(amount - discount),
 * exactly what settlement's ComputeSettlementFee charges. (The "partner-
 * pricing addendum" the old comment cited is not in the repo.) This reads
 * the capture's amount, fee and applied rate back from its
 * transaction_events row, then rebates the difference via a same-day ledger
 * adjustment.
 *
 * A merchant with negotiated_discount_bps = 0 (the default for anyone
 * without a negotiated rate) is a no-op: this
 * function reads the merchant row, sees a zero discount rate, and inserts
 * nothing.
 */
export async function applyCaptureDiscountAdjustment(
  pool: Pool,
  input: { merchantId: string; transactionId: string },
): Promise<void> {
  return withTransaction(pool, async (client) => {
    const merchantRow = await client.query<{ negotiated_discount_bps: number }>(
      `SELECT negotiated_discount_bps FROM merchants WHERE id = $1`,
      [input.merchantId],
    );
    const discountBps = merchantRow.rows[0]?.negotiated_discount_bps ?? 0;
    if (discountBps === 0) return;

    // Exactly one adjustment per capture event. A replayed (idempotent)
    // capture returns its cached 200 without writing a new
    // transaction_events row, so the caller re-enters this path with
    // nothing new to adjust — reversing the same fee a second time would
    // credit the merchant twice for one capture. The row lock serializes
    // this count against a concurrent capture's own adjustment.
    await client.query(`SELECT id FROM transactions WHERE id = $1 FOR UPDATE`, [input.transactionId]);
    const countRow = await client.query<{ capture_events: string; adjustments: string }>(
      `SELECT (SELECT count(*) FROM transaction_events
                WHERE transaction_id = $1 AND event_type IN ('captured', 'partially_captured')) AS capture_events,
              (SELECT count(*) FROM ledger_entries
                WHERE transaction_id = $1 AND direction = 'credit'
                  AND description = 'capture: negotiated discount adjustment') AS adjustments`,
      [input.transactionId],
    );
    const counts = countRow.rows[0];
    if (counts && Number(counts.adjustments) >= Number(counts.capture_events)) return;

    const eventRow = await client.query<{ amount_fils: string | number; metadata: { feeFils?: number; mdrBps?: number } }>(
      `SELECT amount_fils, metadata FROM transaction_events
        WHERE transaction_id = $1 AND event_type IN ('captured', 'partially_captured')
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [input.transactionId],
    );
    const feeBeforeDiscount = toFils(eventRow.rows[0]?.metadata?.feeFils ?? 0);
    if (feeBeforeDiscount <= 0) return;

    // The rebate brings the fee kept down to exactly what settlement charges:
    // MDR on the discounted amount (ARCHITECTURE; Go ComputeSettlementFee).
    // Rebating discount(fee) instead rounded differently, about a fil per
    // capture. Events captured before mdrBps was recorded keep the old rule.
    const mdrBps = eventRow.rows[0]?.metadata?.mdrBps;
    const discountFils =
      mdrBps === undefined
        ? applyRateFils(feeBeforeDiscount, discountBps)
        : subtractFils(feeBeforeDiscount, discountedFeeFils(toFils(Number(eventRow.rows[0]!.amount_fils)), mdrBps, discountBps));
    if (discountFils <= 0) return;

    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'capture: negotiated discount adjustment'),
         ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'capture: negotiated discount adjustment')`,
      [entryGroupId, input.merchantId, input.transactionId, discountFils],
    );
  });
}
