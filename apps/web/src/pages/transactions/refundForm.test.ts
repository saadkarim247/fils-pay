/**
 * The refund drawer's decisions, kept pure so they are testable:
 *   - what is still refundable is captured - refunded (not captured), and a
 *     partially refunded payment can be refunded again;
 *   - the merchant types an amount in BD (like every other amount on the
 *     dashboard), parsed exactly to fils, never more than what is left.
 * The parked drawer allowed up to the full captured amount, hid the button
 * on partially_refunded payments and took a raw fils number.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRefundable, parseRefundAmountInput, remainingRefundableFils } from "./refundForm.js";

const txn = (status: string, capturedFils: number, refundedFils: number) =>
  ({ status, capturedFils, refundedFils }) as Parameters<typeof isRefundable>[0];

test("what's left to refund is captured minus already refunded", () => {
  assert.equal(remainingRefundableFils(txn("partially_refunded", 10_000, 4_000)), 6_000);
  assert.equal(remainingRefundableFils(txn("captured", 10_000, 0)), 10_000);
});

test("captured, partially captured and partially refunded payments can be refunded; others can't", () => {
  assert.equal(isRefundable(txn("captured", 10_000, 0)), true);
  assert.equal(isRefundable(txn("partially_captured", 4_000, 0)), true);
  assert.equal(isRefundable(txn("partially_refunded", 10_000, 4_000)), true);
  assert.equal(isRefundable(txn("refunded", 10_000, 10_000)), false);
  assert.equal(isRefundable(txn("authorized", 0, 0)), false);
  assert.equal(isRefundable(txn("voided", 0, 0)), false);
  assert.equal(isRefundable(txn("partially_captured", 4_000, 4_000)), false, "nothing left");
});

test("a blank amount refunds everything left; a BD amount is parsed exactly to fils", () => {
  assert.deepEqual(parseRefundAmountInput("", 6_000), { ok: true });
  assert.deepEqual(parseRefundAmountInput("4.75", 6_000), { ok: true, amountFils: 4_750 });
  assert.deepEqual(parseRefundAmountInput(" 0.005 ", 6_000), { ok: true, amountFils: 5 });
});

test("amounts that are zero, malformed, over 3 decimals or above what's left are refused", () => {
  for (const raw of ["0", "0.000", "-1", "abc", "1.2345", "6.001"]) {
    assert.equal(parseRefundAmountInput(raw, 6_000).ok, false, raw);
  }
});
