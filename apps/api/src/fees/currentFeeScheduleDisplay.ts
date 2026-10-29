import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the fee schedule in effect right now, for the admin
 * merchant-detail page: the same rule capture uses (fees/feeSchedule.ts),
 * so the rate shown is the rate charged. A backdated correction entered
 * later, or a rate scheduled for the future, is not "current".
 */
// MK 15/06/2026: shouldnt this be effective_from <= now() like feeSchedule.ts? a backdated
// correction entered today would show as "current"
// FH: asked Claude, it said created_at is right for "most recently agreed" (see docblock). resolved
// am: display only, nobody bills off this. leave it
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}
