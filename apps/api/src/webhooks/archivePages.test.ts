/**
 * Bug 67: ADMIN.md says "Archives are written in pages of 1000 deliveries,
 * so any range is fine." The code loaded every delivery in the range into
 * memory and wrote one JSON row (and restore parsed it back whole), so a long
 * range for a busy endpoint could exhaust the API's memory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";
import { createWebhookDeliveryArchive, replayWebhookDeliveryArchive } from "./archiveReplay.js";

const h = createTestHarness();

async function endpoint(m: TestMerchant, url: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/webhook-endpoints`,
    headers: h.bearer(m),
    payload: { url },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}

test("an archive of 2,500 deliveries is written in pages of 1,000 and restores completely, in order", async () => {
  const m = await h.merchant({ label: "archive-pages" });
  const source = await endpoint(m, "http://127.0.0.1:9/old");
  const target = await endpoint(m, "http://127.0.0.1:9/new");
  await h.pool.query(
    `WITH ev AS (
       INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       SELECT 'transaction.captured', 'transaction', gen_random_uuid(), jsonb_build_object('n', g)
         FROM generate_series(1, 2500) g
       RETURNING id, (payload->>'n')::int AS n
     )
     INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, created_at)
     SELECT $1, ev.id, 'transaction.captured', gen_random_uuid(), jsonb_build_object('n', ev.n), 'succeeded',
            '2026-05-01T00:00:00Z'::timestamptz + ev.n * interval '1 second'
       FROM ev`,
    [source],
  );

  const admin = await h.admin("support");
  const created = await createWebhookDeliveryArchive(h.pool, {
    merchantId: m.merchantId,
    endpointId: source,
    adminUserId: admin.id,
    from: new Date("2026-05-01T00:00:00Z"),
    to: new Date("2026-06-01T00:00:00Z"),
  });
  assert.equal(created.deliveryCount, 2500);

  const pages = await h.pool.query<{ page_no: number; size: number; first_n: number }>(
    `SELECT page_no, jsonb_array_length(entries::jsonb) AS size, ((entries::jsonb)->0->'payload'->>'n')::int AS first_n
       FROM webhook_delivery_archive_pages WHERE archive_id = $1 ORDER BY page_no`,
    [created.archiveId],
  );
  assert.deepEqual(pages.rows.map((p) => p.size), [1000, 1000, 500]);
  assert.deepEqual(pages.rows.map((p) => p.first_n), [1, 1001, 2001], "pages follow capture order");

  const restored = await replayWebhookDeliveryArchive(h.pool, {
    merchantId: m.merchantId,
    archiveId: created.archiveId,
    targetEndpointId: target,
    adminUserId: admin.id,
  });
  assert.equal(restored.replayedCount, 2500);
  const queued = await h.pool.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1`, [target]);
  assert.equal(queued.rows[0].n, 2500);

  // Don't leave 2,500 due deliveries for later tests' dispatch passes (they
  // take the oldest 100 due rows, so these would crowd out everyone else).
  await h.pool.query(`UPDATE webhook_deliveries SET status = 'exhausted' WHERE endpoint_id = $1`, [target]);
});

test("an archive taken before paging (entries only in archive_payload) still restores", async () => {
  const m = await h.merchant({ label: "archive-legacy" });
  const target = await endpoint(m, "http://127.0.0.1:9/legacy-target");
  const admin = await h.admin("support");
  const ev = await h.pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('transaction.captured', 'transaction', gen_random_uuid(), '{}') RETURNING id`,
  );
  // A restore points each new row at the original delivery, so it must exist.
  const original = await h.pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status)
     VALUES ($1, $2, 'transaction.captured', gen_random_uuid(), '{"legacy":true}', 'succeeded') RETURNING id`,
    [target, ev.rows[0]!.id],
  );
  const legacy = [{ deliveryId: original.rows[0]!.id, outboxEventId: ev.rows[0]!.id, eventType: "transaction.captured", payload: { legacy: true }, createdAt: "2026-04-01T00:00:00.000Z" }];
  const archive = await h.pool.query<{ id: string }>(
    `INSERT INTO webhook_delivery_archives
        (endpoint_id, merchant_id, created_by_admin_user_id, from_created_at, to_created_at, delivery_count, archive_payload)
     VALUES ($1, $2, $3, '2026-04-01', '2026-04-02', 1, $4) RETURNING id`,
    [target, m.merchantId, admin.id, JSON.stringify(legacy)],
  );

  const restored = await replayWebhookDeliveryArchive(h.pool, {
    merchantId: m.merchantId,
    archiveId: archive.rows[0]!.id,
    targetEndpointId: target,
    adminUserId: admin.id,
  });
  assert.equal(restored.replayedCount, 1);
});
