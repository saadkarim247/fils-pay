import type { QueryableClient } from "@filspay/events";

/**
 * reporting_outbox_cursor read/advance — this consumer's own watermark,
 * never a reuse of outbox_events.processed_at.
 *
 * The watermark is a position in COMMIT order: the (txid, id) of the last
 * applied event (0079). An id alone is not enough, because ids are assigned
 * at INSERT and a transaction holding a lower id can commit later.
 */
export interface ConsumerCursor {
  /** xid8 as text (pg returns it as a string). */
  lastProcessedTxid: string;
  lastProcessedId: bigint;
}

/**
 * last_processed_id is BIGINT; pg returns it as a string, hence the union.
 */
interface CursorRow {
  last_processed_txid: string;
  last_processed_id: string | number;
}

/**
 * Transaction-scoped lock for one consumer's work. Taken by every consumer
 * pass, by the cursor reset and by the API's admin "Rebuild analytics" (the
 * API repeats this exact expression), so none of them interleave. The
 * `running` flag in the worker only guards one process; this guards all.
 */
export async function lockConsumer(client: QueryableClient, consumerName: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('reporting_consumer:' || $1))`, [consumerName]);
}

/**
 * Seeds the row on first ever run (INSERT ... ON CONFLICT DO NOTHING),
 * then reads it. Never throws on a missing row — a worker's first pass
 * against a fresh database always starts from the beginning.
 */
export async function readCursor(client: QueryableClient, consumerName: string): Promise<ConsumerCursor> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ($1, 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
    [consumerName],
  );

  const result = (await client.query(
    `SELECT last_processed_txid::text AS last_processed_txid, last_processed_id
       FROM reporting_outbox_cursor WHERE consumer_name = $1`,
    [consumerName],
  )) as { rows: CursorRow[] };

  const row = result.rows[0];
  return row
    ? { lastProcessedTxid: row.last_processed_txid, lastProcessedId: BigInt(row.last_processed_id) }
    : { lastProcessedTxid: "0", lastProcessedId: 0n };
}

// YA: absolute SET is fine, only one writer.
export async function advanceCursor(
  client: QueryableClient,
  consumerName: string,
  newLastProcessedTxid: string,
  newLastProcessedId: bigint,
): Promise<void> {
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_txid = $2::xid8, last_processed_id = $3, updated_at = now()
      WHERE consumer_name = $1`,
    [consumerName, newLastProcessedTxid, newLastProcessedId.toString()],
  );
}

/** Resets this consumer's watermark to the start — used only by the `rebuild`
 *  subcommand (cli/rebuild.ts) before replaying the entire outbox history. */
// MK: rebuild only. never call from the worker.
export async function resetCursor(client: QueryableClient, consumerName: string): Promise<void> {
  await lockConsumer(client, consumerName);
  // A full replay counts every event, so no rebuild skip list applies.
  await client.query(`DELETE FROM reporting_rebuild_reflected WHERE consumer_name = $1`, [consumerName]);
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, last_processed_txid, updated_at)
     VALUES ($1, 0, '0'::xid8, now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = 0, last_processed_txid = '0'::xid8, updated_at = now()`,
    [consumerName],
  );
}
