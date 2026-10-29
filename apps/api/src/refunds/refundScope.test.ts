/**
 * A merchant can only refund its OWN transactions.
 *
 * initiateMerchantRefund looked the transaction up by id alone and then
 * refunded it as the transaction's merchant, so merchant B could refund
 * merchant A's sale (and A's refund hold was checked against B, the
 * caller). processRefund also matched by id alone. The guarding test was
 * deleted as "redundant" (initiateMerchantRefund.test.ts).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";
import { initiateMerchantRefund } from "./initiateMerchantRefund.js";
import { processRefund } from "../payments/processRefund.js";

const h = createTestHarness();

async function capturedPayment(m: TestMerchant, amount: number): Promise<string> {
  const tx = await h.authorize(m, amount);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  return tx;
}

async function untouched(transactionId: string): Promise<void> {
  const t = await h.pool.query<{ refunded_fils: string }>(`SELECT refunded_fils::text FROM transactions WHERE id = $1`, [transactionId]);
  assert.equal(t.rows[0]!.refunded_fils, "0", "the victim's transaction must not be refunded");
  const r = await h.pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [transactionId]);
  assert.equal(r.rowCount, 0);
  const legs = await h.pool.query(`SELECT 1 FROM ledger_entries WHERE transaction_id = $1 AND description LIKE 'refund:%'`, [transactionId]);
  assert.equal(legs.rowCount, 0);
}

const asB = (b: TestMerchant, transactionId: string) =>
  initiateMerchantRefund(h.pool, h.app.acquirer, {
    merchantId: b.merchantId,
    transactionId,
    amountFils: toFils(1_000),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });

test("merchant B cannot refund merchant A's transaction: 404 and nothing moves", async () => {
  const a = await h.merchant({ label: "refund-victim" });
  const b = await h.merchant({ label: "refund-attacker" });
  const tx = await capturedPayment(a, 9_000);

  await assert.rejects(asB(b, tx), (err: unknown) => (err as { code?: string }).code === "transaction_not_found");
  await untouched(tx);
});

test("merchant A's refund hold cannot be bypassed by a different merchant", async () => {
  const a = await h.merchant({ label: "refund-on-hold" });
  const b = await h.merchant({ label: "refund-attacker" });
  const tx = await capturedPayment(a, 9_000);
  await h.pool.query(`UPDATE merchants SET refunds_enabled = false WHERE id = $1`, [a.merchantId]);

  await assert.rejects(asB(b, tx));
  await untouched(tx);
});

test("processRefund itself refuses a transaction that is not the given merchant's", async () => {
  const a = await h.merchant({ label: "refund-victim" });
  const b = await h.merchant({ label: "refund-attacker" });
  const tx = await capturedPayment(a, 9_000);

  const res = await processRefund(h.pool, h.app.acquirer, {
    transactionId: tx,
    merchantId: b.merchantId,
    amountFils: toFils(1_000),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
  await untouched(tx);
});

test("the owner can still refund its own transaction", async () => {
  const a = await h.merchant({ label: "refund-owner" });
  const tx = await capturedPayment(a, 9_000);
  const res = await asB(a, tx);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});
