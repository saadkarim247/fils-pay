/**
 * A refund with no reason must still be recorded. 0070 gives refunds.reason
 * a default ('unspecified') for exactly this case and forbids an explicit
 * NULL. processRefund passed NULL, so the INSERT failed AFTER the acquirer
 * had already refunded the card: money out, no refund row, no ledger
 * reversal, and the idempotency key stuck.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";
import { initiateMerchantRefund } from "./initiateMerchantRefund.js";

const h = createTestHarness();

async function capturedPayment(m: TestMerchant, amount: number): Promise<string> {
  const tx = await h.authorize(m, amount);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  return tx;
}

function refund(m: TestMerchant, transactionId: string, extra: { amountFils?: number; reason?: string; key?: string } = {}) {
  return initiateMerchantRefund(h.pool, h.app.acquirer, {
    merchantId: m.merchantId,
    transactionId,
    amountFils: extra.amountFils === undefined ? undefined : toFils(extra.amountFils),
    reason: extra.reason,
    idempotencyKey: extra.key ?? randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });
}

test("a refund without a reason is recorded with reason 'unspecified' and reverses the ledger", async () => {
  const m = await h.merchant({ label: "refund-reason" });
  const tx = await capturedPayment(m, 8_000);

  const res = await refund(m, tx, { amountFils: 3_000 });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const row = await h.pool.query<{ reason: string; amount_fils: string }>(
    `SELECT reason, amount_fils::text FROM refunds WHERE transaction_id = $1`,
    [tx],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0]!.reason, "unspecified");
  const legs = await h.pool.query(`SELECT 1 FROM ledger_entries WHERE transaction_id = $1 AND description = 'refund: gross'`, [tx]);
  assert.equal(legs.rowCount, 2, "the gross reversal is journaled");
});

test("a reason that is only whitespace is treated as none", async () => {
  const m = await h.merchant({ label: "refund-reason" });
  const tx = await capturedPayment(m, 8_000);
  const res = await refund(m, tx, { amountFils: 1_000, reason: "   " });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const row = await h.pool.query<{ reason: string }>(`SELECT reason FROM refunds WHERE transaction_id = $1`, [tx]);
  assert.equal(row.rows[0]!.reason, "unspecified");
});

test("a given reason is kept as written", async () => {
  const m = await h.merchant({ label: "refund-reason" });
  const tx = await capturedPayment(m, 8_000);
  assert.equal((await refund(m, tx, { amountFils: 1_000, reason: "damaged item" })).statusCode, 200);
  const row = await h.pool.query<{ reason: string }>(`SELECT reason FROM refunds WHERE transaction_id = $1`, [tx]);
  assert.equal(row.rows[0]!.reason, "damaged item");
});

test("retrying the same refund key replays the recorded refund instead of failing", async () => {
  const m = await h.merchant({ label: "refund-reason" });
  const tx = await capturedPayment(m, 8_000);
  const key = randomUUID();
  const first = await refund(m, tx, { amountFils: 2_000, key });
  const again = await refund(m, tx, { amountFils: 2_000, key });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(again, first);
  const rows = await h.pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [tx]);
  assert.equal(rows.rowCount, 1);
});
