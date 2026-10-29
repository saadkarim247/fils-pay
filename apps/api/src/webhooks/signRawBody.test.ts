/**
 * A webhook receiver must be able to verify the signature over the exact
 * bytes it received (HANDOVER: "the dispatcher should sign exactly the bytes
 * it sends"; FP-240). The dispatcher signed canonicalJson(payload) (keys
 * sorted) but sent JSON.stringify of the jsonb payload (Postgres key order),
 * so standard raw-body verification failed. Beta's log: 59/220 deliveries
 * rejected as "invalid signature" across every retry. The existing tests
 * re-parsed the body before verifying, so they could not see it.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import type { WebhookTransport } from "./transport.js";

const h = createTestHarness();

test("the signature verifies against the raw request body, exactly as a receiver would check it", async () => {
  const m = await h.merchant({ label: "sign-raw" });
  const url = `http://127.0.0.1:9/raw-${randomUUID()}`;
  const endpoint = await createWebhookEndpoint(h.pool, h.config, { merchantId: m.merchantId, url, createdByType: "merchant_session", createdById: randomUUID() });
  const tx = await h.authorize(m, 5_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);

  const received: Array<{ body: string; signature: string }> = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) received.push({ body: req.body, signature: req.headers["Webhook-Signature"]! });
    return { statusCode: 200, body: "" };
  };
  await runDispatchPass(h.pool, transport, h.config);

  assert.ok(received.length >= 1, "a delivery was sent");
  for (const { body, signature } of received) {
    const t = /t=(\d+)/.exec(signature)![1];
    const v1 = /v1=([0-9a-f]+)/.exec(signature)![1];
    const expected = createHmac("sha256", endpoint.secret).update(`${t}.${body}`).digest("hex");
    assert.equal(v1, expected, `signature must cover the raw body sent: ${body.slice(0, 80)}`);
  }
});
