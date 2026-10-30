/**
 * Bug 62: deleting a webhook endpoint failed once it had ever received a
 * delivery. The docblock promises "deleted also when the endpoint had
 * deliveries; those rows are kept with endpoint_id set to NULL", but both
 * foreign keys were NO ACTION on NOT NULL columns, so the DELETE violated
 * them and the merchant got an error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { runDispatchPass } from "./dispatcher.js";
import { createWebhookDeliveryArchive } from "./archiveReplay.js";

const h = createTestHarness();

test("an endpoint with delivery history and an archive can be deleted; the history is kept", async () => {
  const m = await h.merchant({ label: "endpoint-delete" });
  const created = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/webhook-endpoints`,
    headers: h.bearer(m),
    payload: { url: "http://127.0.0.1:9/hook" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const endpointId = (created.json() as { id: string }).id;

  // A real capture -> outbox event -> delivery row, sent successfully.
  const tx = await h.authorize(m, 5_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  await runDispatchPass(h.pool, async () => ({ statusCode: 200, body: "ok" }), h.config);
  const deliveries = await h.pool.query<{ id: string }>(`SELECT id FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId]);
  assert.ok(deliveries.rows.length >= 1, "the endpoint has delivery history");

  const admin = await h.admin("support");
  await createWebhookDeliveryArchive(h.pool, {
    merchantId: m.merchantId,
    endpointId,
    adminUserId: admin.id,
    from: new Date(Date.now() - 3_600_000),
    to: new Date(Date.now() + 3_600_000),
  });

  const del = await h.app.inject({
    method: "DELETE",
    url: `/v1/merchants/${m.merchantId}/webhook-endpoints/${endpointId}`,
    headers: h.bearer(m),
  });
  assert.equal(del.statusCode, 204, del.body);

  const kept = await h.pool.query<{ endpoint_id: string | null }>(
    `SELECT endpoint_id FROM webhook_deliveries WHERE id = ANY($1::uuid[])`,
    [deliveries.rows.map((r) => r.id)],
  );
  assert.equal(kept.rows.length, deliveries.rows.length, "delivery history is retained");
  assert.ok(kept.rows.every((r) => r.endpoint_id === null));
  const archives = await h.pool.query(`SELECT 1 FROM webhook_delivery_archives WHERE merchant_id = $1 AND endpoint_id IS NULL`, [m.merchantId]);
  assert.equal(archives.rowCount, 1, "the archive is retained");
});
