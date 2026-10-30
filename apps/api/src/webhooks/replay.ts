import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";

export interface ReplayResult {
  deliveryId: string;
  status: string;
}

export interface OriginalDelivery {
  id: string;
  endpointId: string;
  outboxEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * The single definition of "what does replaying one delivery mean", used by
 * both the merchant-facing single-delivery replay route and the admin
 * batch-replay function — so the two can never mean different things.
 *
 * A replay is the same event to the receiver: it keeps the original
 * Webhook-Delivery-Id (= the envelope id), which receivers dedupe on
 * (ARCHITECTURE, CHANGELOG 1.9.1, 0022; bug 37). The dispatcher still signs
 * each attempt with a fresh timestamp, so freshness checks pass. A payload
 * without an id (never written by this platform) falls back to a new one.
 *
 * The original row (payload + signature) is never mutated — forensic value
 * is preserved there, not by resending its exact bytes.
 *
 * Takes a PoolClient so the caller controls the transaction: the batch path
 * needs every insert and its audit row to commit or roll back together.
 * Writes every replay in ONE statement (one INSERT per delivery was an N+1
 * for batch and archive replays); results come back in input order.
 */
export async function insertReplayDeliveryRows(
  client: PoolClient,
  originals: readonly OriginalDelivery[],
): Promise<ReplayResult[]> {
  if (originals.length === 0) return [];
  const rowIds = originals.map(() => randomUUID());
  const eventIds: string[] = [];
  const payloads: string[] = [];
  for (const original of originals) {
    const originalId = typeof original.payload.id === "string" ? original.payload.id : undefined;
    const deliveryEventId = originalId ?? randomUUID();
    eventIds.push(deliveryEventId);
    payloads.push(JSON.stringify({ ...original.payload, id: deliveryEventId }));
  }

  const insertResult = await client.query(
    `INSERT INTO webhook_deliveries
        (id, endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, next_attempt_at, replay_of_delivery_id)
     SELECT r.id, r.endpoint_id, r.outbox_event_id, r.event_type, r.delivery_event_id, r.payload::jsonb, 'pending', now(), r.original_id
       FROM unnest($1::uuid[], $2::uuid[], $3::bigint[], $4::text[], $5::uuid[], $6::text[], $7::uuid[])
            AS r(id, endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, original_id)`,
    [
      rowIds,
      originals.map((o) => o.endpointId),
      originals.map((o) => o.outboxEventId),
      originals.map((o) => o.eventType),
      eventIds,
      payloads,
      originals.map((o) => o.id),
    ],
  );
  if (insertResult.rowCount !== originals.length) {
    throw new Error(`insertReplayDeliveryRows: inserted ${insertResult.rowCount} of ${originals.length} replays`);
  }
  return rowIds.map((id) => ({ deliveryId: id, status: "pending" }));
}

/** One replay: the same definition as the batch path, with one row. */
export async function insertReplayDeliveryRow(
  client: PoolClient,
  original: OriginalDelivery,
): Promise<ReplayResult> {
  const [result] = await insertReplayDeliveryRows(client, [original]);
  return result!;
}

interface OriginalDeliveryRow {
  id: string;
  endpoint_id: string;
  outbox_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  endpoint_status: string;
}

/**
 * `POST .../webhook-endpoints/:id/deliveries/:deliveryId/replay` business
 * logic: it validates the
 * three-way ownership predicate and then defers to
 * `insertReplayDeliveryRow` above for the replay itself.
 */
export async function replayWebhookDelivery(
  pool: Pool,
  input: { merchantId: string; endpointId: string; deliveryId: string },
): Promise<ReplayResult> {
  // Three-way predicate (delivery, endpoint, merchant all agree) — a replay
  // can't be aimed at a delivery/endpoint pairing that doesn't actually
  // belong to the caller even if two of the three IDs are individually
  // valid.
  const lookupResult = await pool.query<OriginalDeliveryRow>(
    `SELECT wd.id, wd.endpoint_id, wd.outbox_event_id, wd.event_type, wd.payload, we.status AS endpoint_status
       FROM webhook_deliveries wd
       JOIN webhook_endpoints we ON we.id = wd.endpoint_id
      WHERE wd.id = $1 AND wd.endpoint_id = $2 AND we.merchant_id = $3`,
    [input.deliveryId, input.endpointId, input.merchantId],
  );
  const original = lookupResult.rows[0];
  if (!original) {
    throw new NotFoundError("webhook_delivery_not_found");
  }
  if (original.endpoint_status !== "active") {
    throw new ConflictError("endpoint_disabled");
  }

  return withTransaction(pool, async (client) =>
    insertReplayDeliveryRow(client, {
      id: original.id,
      endpointId: original.endpoint_id,
      outboxEventId: original.outbox_event_id,
      eventType: original.event_type,
      payload: original.payload,
    }),
  );
}
