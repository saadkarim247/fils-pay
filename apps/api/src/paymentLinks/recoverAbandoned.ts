import type { Pool } from "pg";
import { voidTransaction } from "../payments/void.js";

export interface RecoveryResult {
  /** Links marked paid whose money was never captured: un-committed, authorization voided. */
  uncommitted: number;
  /** Links left reserved: released. */
  released: number;
  /** Pay-flow authorizations no link points to: voided. */
  orphansVoided: number;
}

/**
 * Undoes payment-link checkouts abandoned mid-flight, e.g. by a crash (the
 * process died, so payPaymentLink's own undo never ran). Applies the same
 * undo as a failed capture: the buyer's authorization is voided and the link
 * becomes payable again. Only touches states older than `olderThanSeconds`
 * (the reservation timeout): anything newer may still be in flight.
 * Safe to run concurrently and repeatedly: every change is a guarded,
 * conditional UPDATE and voiding is idempotent.
 */
export async function recoverAbandonedCheckouts(pool: Pool, opts: { olderThanSeconds: number }): Promise<RecoveryResult> {
  const age = String(opts.olderThanSeconds);

  // 1. Paid link, money only authorized: un-commit the link (only if it is
  //    still in that state), then void the authorization.
  const stuckPaid = await pool.query<{ link_id: string; txn_id: string; merchant_id: string }>(
    `UPDATE payment_links l SET status = 'active', paid_at = NULL, transaction_id = NULL
       FROM transactions t
      WHERE t.id = l.transaction_id AND l.status = 'paid' AND t.status = 'authorized'
        AND l.paid_at < now() - ($1 || ' seconds')::interval
      RETURNING l.id AS link_id, t.id AS txn_id, l.merchant_id`,
    [age],
  );
  for (const row of stuckPaid.rows) {
    await voidTransaction(pool, { transactionId: row.txn_id, merchantId: row.merchant_id, actor: { type: "system", id: row.link_id } });
  }

  // 2. Reservation never finished: release it.
  const released = await pool.query(
    `UPDATE payment_links SET status = 'active', reserved_at = NULL, reservation_id = NULL
      WHERE status = 'reserved' AND reserved_at < now() - ($1 || ' seconds')::interval`,
    [age],
  );

  // 3. Authorized by the pay flow (its idempotency key says so) but never
  //    attached to a link: void it.
  const orphans = await pool.query<{ id: string; merchant_id: string }>(
    `SELECT t.id, t.merchant_id
       FROM transactions t
       JOIN idempotency_keys ik ON ik.resource_id::text = t.id::text AND ik.key LIKE 'paylink:%:authorize'
      WHERE t.status = 'authorized' AND t.created_at < now() - ($1 || ' seconds')::interval
        AND NOT EXISTS (SELECT 1 FROM payment_links l WHERE l.transaction_id = t.id)`,
    [age],
  );
  for (const row of orphans.rows) {
    await voidTransaction(pool, { transactionId: row.id, merchantId: row.merchant_id, actor: { type: "system", id: row.id } });
  }

  return { uncommitted: stuckPaid.rows.length, released: released.rowCount ?? 0, orphansVoided: orphans.rows.length };
}
