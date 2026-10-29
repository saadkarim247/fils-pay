/**
 * A replayed webhook keeps its Webhook-Delivery-Id, so the merchant's
 * system can recognise it as the same event and not process it twice.
 * ARCHITECTURE / CHANGELOG 1.9.1 tell receivers to dedupe on
 * Webhook-Delivery-Id, and 0022 calls delivery_event_id the stable id
 * receivers dedupe on. Replays minted a new one each time (Beta's export:
 * one batch's payout delivered 5x with 5 different ids).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import type { WebhookTransport } from "./transport.js";

const h = createTestHarness();

test("replaying a delivery resends it with the same Webhook-Delivery-Id and body id", async () => {
  const m = await h.merchant({ label: "replay-id" });
  const url = `http://127.0.0.1:9/replay-${randomUUID()}`;
  const endpoint = await createWebhookEndpoint(h.pool, h.config, { merchantId: m.merchantId, url, createdByType: "merchant_session", createdById: randomUUID() });
  const tx = await h.authorize(m, 5_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);

  const sent: Array<{ headerId: string; bodyId: string }> = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) sent.push({ headerId: req.headers["Webhook-Delivery-Id"]!, bodyId: JSON.parse(req.body).id });
    return { statusCode: 200, body: "" };
  };
  await runDispatchPass(h.pool, transport, h.config);
  assert.equal(sent.length, 1);

  const original = await h.pool.query<{ id: string }>(`SELECT id FROM webhook_deliveries WHERE endpoint_id = $1`, [endpoint.id]);
  for (let i = 0; i < 2; i++) {
    const replay = await h.app.inject({
      method: "POST",
      url: `/v1/merchants/${m.merchantId}/webhook-endpoints/${endpoint.id}/deliveries/${original.rows[0]!.id}/replay`,
      headers: h.bearer(m),
    });
    assert.equal(replay.statusCode, 202, replay.body);
  }
  await runDispatchPass(h.pool, transport, h.config);

  assert.equal(sent.length, 3, "original + two replays were sent");
  for (const s of sent) {
    assert.equal(s.headerId, sent[0]!.headerId, "every resend carries the original Webhook-Delivery-Id");
    assert.equal(s.bodyId, sent[0]!.headerId);
  }
});
