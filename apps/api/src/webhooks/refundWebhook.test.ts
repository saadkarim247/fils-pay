/**
 * A merchant is told about every refund by webhook (FP-300: "shop gets the
 * right webhook").
 *
 * processRefund enqueues refund.succeeded, but the dispatcher only fans out
 * transaction.captured / transaction.voided / settlement.paid, and
 * buildEnvelope throws on any other type. So refunds never reached the
 * merchant, and simply adding the type to the list would have thrown inside
 * the fan-out transaction and blocked every merchant's webhooks.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { createTestHarness } from "../testSupport/fixtures.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import type { WebhookTransport } from "./transport.js";

const h = createTestHarness();

test("a refund is delivered to the merchant as a refund.succeeded webhook with the refund's figures", async () => {
  const m = await h.merchant({ label: "refund-webhook", mdrBps: 250 });
  const url = `http://127.0.0.1:9/refund-hook-${randomUUID()}`;
  await createWebhookEndpoint(h.pool, h.config, { merchantId: m.merchantId, url, createdByType: "merchant_session", createdById: randomUUID() });
  const tx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);

  const refund = await initiateMerchantRefund(h.pool, h.app.acquirer, {
    merchantId: m.merchantId,
    transactionId: tx,
    amountFils: toFils(4_000),
    reason: "webhook test",
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });
  assert.equal(refund.statusCode, 200, JSON.stringify(refund.body));
  const refundId = (refund.body as { id: string }).id;

  const sent: Array<Record<string, any>> = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) sent.push(JSON.parse(req.body));
    return { statusCode: 200, body: "" };
  };
  await runDispatchPass(h.pool, transport, h.config);

  const refundHooks = sent.filter((e) => e.type === "refund.succeeded");
  assert.equal(refundHooks.length, 1, `got types ${sent.map((e) => e.type).join(", ")}`);
  assert.deepEqual(refundHooks[0]!.data, {
    refundId,
    transactionId: tx,
    merchantId: m.merchantId,
    amountFils: 4_000,
    feeReversedFils: 100,
    refundedTotalFils: 4_000,
    status: "partially_refunded",
  });
  assert.ok(sent.some((e) => e.type === "transaction.captured"), "other webhooks still flow");
});
