/**
 * Bug 64: a delivery that throws before reaching the receiver (e.g. its
 * endpoint secret no longer decrypts after a key change) was skipped but
 * left exactly as it was, so it stayed the oldest due row forever. Each pass
 * takes the oldest 100 due rows; once 100 such rows existed, no other
 * merchant's webhook was ever sent, the opposite of what the code's comment
 * promises.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";
import { runDispatchPass } from "./dispatcher.js";

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

async function dueDeliveries(endpointId: string, merchantId: string, count: number, age: string): Promise<void> {
  await h.pool.query(
    `WITH ev AS (
       INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       SELECT 'transaction.captured', 'transaction', gen_random_uuid(), jsonb_build_object('merchantId', $2::text)
         FROM generate_series(1, $3)
       RETURNING id
     )
     INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, next_attempt_at)
     SELECT $1, ev.id, 'transaction.captured', gen_random_uuid(), '{"type":"transaction.captured"}'::jsonb, 'pending',
            now() - $4::interval
       FROM ev`,
    [endpointId, merchantId, count, age],
  );
}

test("100 undeliverable rows do not starve every other merchant's webhooks", async () => {
  const broken = await h.merchant({ label: "poisoned" });
  const healthy = await h.merchant({ label: "healthy" });
  const brokenEndpoint = await endpoint(broken, "http://127.0.0.1:9/broken");
  const healthyEndpoint = await endpoint(healthy, "http://127.0.0.1:9/healthy");
  await h.pool.query(`UPDATE webhook_endpoints SET secret_ciphertext = 'AAAA' WHERE id = $1`, [brokenEndpoint]);

  await dueDeliveries(brokenEndpoint, broken.merchantId, 100, "1 day");
  await dueDeliveries(healthyEndpoint, healthy.merchantId, 1, "1 hour");

  const sent: string[] = [];
  const transport = async (req: { url: string }) => {
    sent.push(req.url);
    return { statusCode: 200, body: "ok" };
  };
  for (let pass = 0; pass < 3 && !sent.includes("http://127.0.0.1:9/healthy"); pass++) {
    await runDispatchPass(h.pool, transport, h.config);
  }
  assert.ok(sent.includes("http://127.0.0.1:9/healthy"), "the healthy merchant's webhook was never sent");

  // The broken rows are recorded as failed attempts and backed off, not left first in line.
  const broken1 = await h.pool.query<{ attempt_count: number; future: boolean }>(
    `SELECT attempt_count, next_attempt_at > now() AS future FROM webhook_deliveries WHERE endpoint_id = $1`,
    [brokenEndpoint],
  );
  assert.ok(broken1.rows.every((r) => r.attempt_count >= 1 && r.future), JSON.stringify(broken1.rows.slice(0, 3)));
});
