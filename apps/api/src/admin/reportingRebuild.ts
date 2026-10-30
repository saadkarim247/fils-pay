import type { PoolClient } from "pg";

/** Rows written into each rollup table by the rebuild. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/** The reporting worker's consumer name and event types (apps/reporting
 *  consumer/runConsumerPass.ts); repeated here because the API can't import
 *  the worker package. */
const REPORTING_CONSUMER = "reporting";
const REPORTING_EVENT_TYPES = ["transaction.captured", "transaction.voided", "settlement.batch_closed", "refund.succeeded"];

/**
 * Truncates and repopulates the two rollup tables (merchant_daily_volume,
 * merchant_payout_trends) from the source tables, and hands over to the
 * reporting worker so nothing is counted twice or lost.
 *
 * It used to leave the worker's cursor alone, so the worker then applied
 * every event it hadn't consumed yet on top of a rebuild that already
 * counted it. Now, under the worker's own lock and in ONE statement (one
 * snapshot S):
 *  - the rollups are rebuilt from everything S can see;
 *  - the cursor moves to S's oldest still-running transaction (every event
 *    below it is visible in S, so already counted);
 *  - the few events above that point that S could already see are listed in
 *    reporting_rebuild_reflected, which the worker skips (0084).
 * Events S couldn't see are applied by the worker as usual.
 * (The rebuild can't replay the outbox instead: it doesn't hold all history.)
 */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  // Same lock as every worker pass (apps/reporting consumer/cursor.ts lockConsumer).
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('reporting_consumer:' || $1))`, [REPORTING_CONSUMER]);
  await client.query(`TRUNCATE merchant_daily_volume, merchant_payout_trends`);
  await client.query(`DELETE FROM reporting_rebuild_reflected WHERE consumer_name = $1`, [REPORTING_CONSUMER]);

  const result = await client.query<{ volume_rows: string; trend_rows: string }>(
    `WITH snap AS (
       SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin
     ),
     trends AS (
       INSERT INTO merchant_payout_trends
           (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, last_updated_at)
       SELECT merchant_id, id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, now()
         FROM settlement_batches
       RETURNING 1
     ),
     volume AS (
       INSERT INTO merchant_daily_volume
           (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count, refund_count, refund_gross_fils, last_updated_at)
       SELECT merchant_id, day, SUM(cc), SUM(cg), SUM(vc), SUM(rc), SUM(rg), now()
         FROM (
           SELECT t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS day,
                  (te.event_type IN ('captured', 'partially_captured'))::int AS cc,
                  CASE WHEN te.event_type IN ('captured', 'partially_captured') THEN te.amount_fils ELSE 0 END AS cg,
                  (te.event_type = 'voided')::int AS vc,
                  0 AS rc, 0::bigint AS rg
             FROM transaction_events te
             JOIN transactions t ON t.id = te.transaction_id
            WHERE te.event_type IN ('captured', 'partially_captured', 'voided')
           UNION ALL
           -- Succeeded refunds per Bahrain business day (bug 58).
           SELECT merchant_id, (occurred_at AT TIME ZONE 'Asia/Bahrain')::date, 0, 0, 0, 1, amount_fils
             FROM refunds
            WHERE status = 'succeeded'
         ) src
        GROUP BY merchant_id, day
       RETURNING 1
     ),
     reflected AS (
       INSERT INTO reporting_rebuild_reflected (consumer_name, event_id)
       SELECT $1, oe.id
         FROM outbox_events oe, snap
        WHERE oe.txid >= snap.xmin AND oe.event_type = ANY($2::text[])
       RETURNING 1
     ),
     handover AS (
       INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_txid, last_processed_id, updated_at)
       SELECT $1, snap.xmin, 0, now() FROM snap
       ON CONFLICT (consumer_name) DO UPDATE
         SET last_processed_txid = EXCLUDED.last_processed_txid, last_processed_id = 0, updated_at = now()
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM volume)::text AS volume_rows,
            (SELECT count(*) FROM trends)::text AS trend_rows,
            (SELECT count(*) FROM reflected) + (SELECT count(*) FROM handover) AS _written`,
    [REPORTING_CONSUMER, REPORTING_EVENT_TYPES],
  );

  const row = result.rows[0]!;
  return { volumeRows: Number(row.volume_rows), trendRows: Number(row.trend_rows) };
}
