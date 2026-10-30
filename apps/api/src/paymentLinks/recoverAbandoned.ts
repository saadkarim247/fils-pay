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
/** The pass's statements ($1 = age in seconds), exported for the plan test. */
export const RECOVERY_SQL = {
  // 1. Paid link, money only authorized: un-commit the link (only if it is
  //    still in that state).
  stuckPaid: `UPDATE payment_links l SET status = 'active', paid_at = NULL, transaction_id = NULL
       FROM transactions t
      WHERE t.id = l.transaction_id AND l.status = 'paid' AND t.status = 'authorized'
        AND l.paid_at < now() - ($1 || ' seconds')::interval
      RETURNING l.id AS link_id, t.id AS txn_id, l.merchant_id`,
  // 2. Reservation never finished: release it.
  stuckReserved: `UPDATE payment_links SET status = 'active', reserved_at = NULL, reservation_id = NULL
      WHERE status = 'reserved' AND reserved_at < now() - ($1 || ' seconds')::interval`,
  // 3. Authorized by the pay flow (its idempotency key says so) but never
  //    attached to a link.
  orphans: `SELECT t.id, t.merchant_id
       FROM transactions t
      WHERE t.status = 'authorized' AND t.created_at < now() - ($1 || ' seconds')::interval
        AND EXISTS (SELECT 1 FROM idempotency_keys ik
                     WHERE ik.resource_id = t.id AND ik.key LIKE 'paylink:%:authorize')
        AND NOT EXISTS (SELECT 1 FROM payment_links l WHERE l.transaction_id = t.id)`,
} as const;

export async function recoverAbandonedCheckouts(pool: Pool, opts: { olderThanSeconds: number }): Promise<RecoveryResult> {
  const age = String(opts.olderThanSeconds);

  // 1. Un-commit the link, then void the authorization.
  const stuckPaid = await pool.query<{ link_id: string; txn_id: string; merchant_id: string }>(RECOVERY_SQL.stuckPaid, [age]);
  for (const row of stuckPaid.rows) {
    await voidTransaction(pool, { transactionId: row.txn_id, merchantId: row.merchant_id, actor: { type: "system", id: row.link_id } });
  }

  // 2. Release stuck reservations.
  const released = await pool.query(RECOVERY_SQL.stuckReserved, [age]);

  // 3. Void orphaned pay-flow authorizations.
  const orphans = await pool.query<{ id: string; merchant_id: string }>(RECOVERY_SQL.orphans, [age]);
  for (const row of orphans.rows) {
    await voidTransaction(pool, { transactionId: row.id, merchantId: row.merchant_id, actor: { type: "system", id: row.id } });
  }

  return { uncommitted: stuckPaid.rows.length, released: released.rowCount ?? 0, orphansVoided: orphans.rows.length };
}
