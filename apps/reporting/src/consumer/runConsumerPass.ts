import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor, lockConsumer } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

// Every type listed here must have a case in applyEvent (its default throws
// and would stop the worker) and somewhere to land in the rollups.
export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.batch_closed",
  "refund.succeeded",
];

/**
 * Keys this worker's row in reporting_outbox_cursor. Two processes using the
 * same name serialize on that row, so a catch-up run beside a live worker
 * cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, and the watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events is applied *and* the watermark moves past all
 * of them, atomically, or (on any error) nothing in this pass is applied
 * and the watermark is untouched — the next pass simply re-selects the
 * identical event range and retries. This is the exact property that makes
 * the watermark alone sufficient for exactly-once application, with no
 * separate per-event dedup table the way webhook_deliveries needs one.
 *
 * The `SELECT` below is a plain, unlocked read — no row lock, no
 * `FOR UPDATE`, no mutation of any outbox_events column — identical
 * posture to webhooks/dispatcher.ts's Step A.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number }> {
  return withTransaction(pool, async (client) => {
    // One pass at a time across processes, and never during an admin
    // "Rebuild analytics" (which takes the same lock).
    await lockConsumer(client, CONSUMER_NAME);
    const cursor = await readCursor(client, CONSUMER_NAME);

    // Commit order, not id order (0079): only events whose writing
    // transaction is older than every transaction still running (those are
    // final and can never be overtaken), read in (txid, id) order after the
    // cursor. An event that commits late always lands above the cursor.
    const eventsResult = await client.query<OutboxEventRow & { txid: string }>(
      `SELECT id, event_type, aggregate_id, payload, created_at, txid::text AS txid
         FROM outbox_events
        WHERE (txid, id) > ($1::xid8, $2::bigint)
          AND txid < pg_snapshot_xmin(pg_current_snapshot())
          AND event_type = ANY($3::text[])
          -- already counted by an admin rebuild from source (0084)
          AND NOT EXISTS (SELECT 1 FROM reporting_rebuild_reflected r
                           WHERE r.consumer_name = $5 AND r.event_id = outbox_events.id)
        ORDER BY txid ASC, id ASC
        LIMIT $4`,
      [cursor.lastProcessedTxid, cursor.lastProcessedId.toString(), REPORTING_EVENT_TYPES, config.consumerBatchLimit, CONSUMER_NAME],
    );

    for (const row of eventsResult.rows) {
      await applyEvent(client, row);
    }

    const last = eventsResult.rows[eventsResult.rows.length - 1];
    if (last) {
      await advanceCursor(client, CONSUMER_NAME, last.txid, BigInt(last.id));
    }

    return { processedCount: eventsResult.rows.length };
  });
}
