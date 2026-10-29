/**
 * Concurrent refunds of one transaction can never return more than was
 * captured, and every refund that succeeds is counted (FP-209).
 *
 * processRefund validated against a row it read WITHOUT a lock, committed,
 * called the acquirer outside any transaction, then wrote an absolute
 * refunded_fils from that stale read. Five simultaneous 3,000 refunds of a
 * 10,000 capture all passed validation, all paid out, and refunded_fils
 * ended at 3,000 (lost updates). Capture already holds the row lock across
 * its acquirer call; refunds must do the same.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";
import { initiateMerchantRefund } from "./initiateMerchantRefund.js";

// Slow the acquirer so the refunds genuinely overlap.
const h = createTestHarness({ ACQUIRER_LATENCY_MIN_MS: "60", ACQUIRER_LATENCY_MAX_MS: "120" });

const refund = (m: TestMerchant, transactionId: string, amountFils: number) =>
  initiateMerchantRefund(h.pool, h.app.acquirer, {
    merchantId: m.merchantId,
    transactionId,
    amountFils: toFils(amountFils),
    reason: "concurrency test",
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  }).catch((err: unknown) => ({ statusCode: (err as { statusCode?: number }).statusCode ?? 500, body: String(err) }));

test("five simultaneous 3,000 refunds of a 10,000 capture: at most 3 succeed and every one is counted", async () => {
  const m = await h.merchant({ label: "refund-race" });
  const tx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);

  const results = await Promise.all(Array.from({ length: 5 }, () => refund(m, tx, 3_000)));
  const succeeded = results.filter((r) => r.statusCode === 200).length;

  const rows = await h.pool.query<{ n: string; total: string }>(
    `SELECT count(*)::text AS n, COALESCE(SUM(amount_fils), 0)::text AS total FROM refunds WHERE transaction_id = $1`,
    [tx],
  );
  const txn = await h.pool.query<{ refunded_fils: string }>(`SELECT refunded_fils::text FROM transactions WHERE id = $1`, [tx]);
  const reversed = await h.pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS total FROM ledger_entries
      WHERE transaction_id = $1 AND description = 'refund: gross' AND account_id = 'merchant_payable'`,
    [tx],
  );

  assert.ok(succeeded <= 3, `at most 3 x 3,000 fit in 10,000, got ${succeeded} successes`);
  assert.equal(Number(rows.rows[0]!.n), succeeded, "one refund row per success, none for failures");
  assert.equal(Number(rows.rows[0]!.total), succeeded * 3_000);
  assert.equal(Number(txn.rows[0]!.refunded_fils), succeeded * 3_000, "no lost update");
  assert.equal(Number(reversed.rows[0]!.total), succeeded * 3_000, "ledger reverses exactly what was refunded");
  assert.ok(succeeded >= 1);
});

test("two simultaneous full refunds: exactly one goes through", async () => {
  const m = await h.merchant({ label: "refund-race" });
  const tx = await h.authorize(m, 7_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);

  const results = await Promise.all([refund(m, tx, 7_000), refund(m, tx, 7_000)]);
  assert.deepEqual(results.map((r) => r.statusCode === 200).filter(Boolean).length, 1);
  const rows = await h.pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [tx]);
  assert.equal(rows.rowCount, 1);
});
