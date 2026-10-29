/**
 * A refund can never return more than was actually captured.
 *
 * processRefund computed the refundable amount as authorized - refunded.
 * With a partial capture (authorize 10,000, capture 4,000) that allowed a
 * 10,000 refund: 6,000 fils that the merchant never received went back to
 * the card. And because the status stays partially_captured after a
 * refund, the transaction stayed "refundable" afterwards.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";
import { initiateMerchantRefund } from "./initiateMerchantRefund.js";

const h = createTestHarness();

const refund = (m: TestMerchant, transactionId: string, amountFils?: number) =>
  initiateMerchantRefund(h.pool, h.app.acquirer, {
    merchantId: m.merchantId,
    transactionId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils),
    reason: "ceiling test",
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });

async function partiallyCaptured(m: TestMerchant): Promise<string> {
  const tx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, tx, 4_000)).statusCode, 200);
  return tx;
}

async function refundedFils(tx: string): Promise<number> {
  const r = await h.pool.query<{ v: string }>(`SELECT refunded_fils::text AS v FROM transactions WHERE id = $1`, [tx]);
  return Number(r.rows[0]!.v);
}

test("authorize 10,000 / capture 4,000: a 10,000 refund is refused, refundable is 4,000", async () => {
  const m = await h.merchant({ label: "refund-ceiling" });
  const tx = await partiallyCaptured(m);
  const res = await refund(m, tx, 10_000);
  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
  assert.equal((res.body as { code: string; refundableFils: number }).code, "refund_exceeds_refundable");
  assert.equal((res.body as { refundableFils: number }).refundableFils, 4_000);
  assert.equal(await refundedFils(tx), 0);
});

test("refunding exactly the captured 4,000 works, and nothing more can be refunded after", async () => {
  const m = await h.merchant({ label: "refund-ceiling" });
  const tx = await partiallyCaptured(m);
  assert.equal((await refund(m, tx, 4_000)).statusCode, 200);
  const more = await refund(m, tx, 1);
  assert.notEqual(more.statusCode, 200, "no fils beyond the captured amount");
  assert.equal(await refundedFils(tx), 4_000);
});

test("a refund with no amount defaults to what is left of the CAPTURED amount", async () => {
  const m = await h.merchant({ label: "refund-ceiling" });
  const tx = await partiallyCaptured(m);
  assert.equal((await refund(m, tx, 1_500)).statusCode, 200);
  const rest = await refund(m, tx);
  assert.equal(rest.statusCode, 200, JSON.stringify(rest.body));
  assert.equal((rest.body as { amountFils: number }).amountFils, 2_500);
  assert.equal(await refundedFils(tx), 4_000);
});
