/**
 * N+1: an admin "Replay batch" inserted one replay delivery per matching
 * delivery, each its own round trip (up to 500 per click). They are now
 * inserted in one statement; what a replay is stays defined in one place.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { countingPool } from "../testSupport/countingPool.js";
import { replayWebhookDeliveriesBatch } from "./replayBatch.js";

const h = createTestHarness();

test("a 50-delivery replay batch is one insert, and each replay keeps its original's identity", async () => {
  const m = await h.merchant({ label: "replay-batch-n1" });
  const created = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/webhook-endpoints`,
    headers: h.bearer(m),
    payload: { url: "http://127.0.0.1:9/replay-n1" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const endpointId = (created.json() as { id: string }).id;
  const originals = await h.pool.query<{ id: string; envelope_id: string }>(
    `WITH ev AS (
       INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       SELECT 'transaction.captured', 'transaction', gen_random_uuid(), '{}' FROM generate_series(1, 50) RETURNING id
     )
     INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, created_at)
     SELECT $1, ev.id, 'transaction.captured', gen_random_uuid(),
            jsonb_build_object('id', gen_random_uuid(), 'type', 'transaction.captured'), 'exhausted', '2026-05-05T00:00:00Z'
       FROM ev
     RETURNING id, payload->>'id' AS envelope_id`,
    [endpointId],
  );
  const admin = await h.admin("finance");

  const counted = countingPool(h.pool);
  const result = await replayWebhookDeliveriesBatch(counted.pool, {
    merchantId: m.merchantId,
    endpointId,
    adminUserId: admin.id,
    from: new Date("2026-05-01T00:00:00Z"),
    to: new Date("2026-05-10T00:00:00Z"),
    statuses: ["exhausted"],
  });

  assert.equal(result.matchedCount, 50);
  assert.equal(new Set(result.replayedDeliveryIds).size, 50);
  assert.ok(counted.count() <= 8, `replaying 50 deliveries took ${counted.count()} queries`);

  // Bug 37 still holds: each replay carries its original's Webhook-Delivery-Id.
  const replays = await h.pool.query<{ original: string; delivery_event_id: string; status: string }>(
    `SELECT replay_of_delivery_id AS original, delivery_event_id::text, status
       FROM webhook_deliveries WHERE id = ANY($1::uuid[])`,
    [result.replayedDeliveryIds],
  );
  const envelopeOf = new Map(originals.rows.map((o) => [o.id, o.envelope_id]));
  assert.equal(replays.rows.length, 50);
  for (const r of replays.rows) {
    assert.equal(r.status, "pending");
    assert.equal(r.delivery_event_id, envelopeOf.get(r.original));
  }
  await h.pool.query(`UPDATE webhook_deliveries SET status = 'exhausted' WHERE endpoint_id = $1`, [endpointId]);
});
