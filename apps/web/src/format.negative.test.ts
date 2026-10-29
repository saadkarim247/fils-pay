/**
 * The dashboard's money formatter must render negative amounts. Refund
 * events on a transaction's timeline are negative by design (processRefund
 * records -amount), and a reconciliation gap can be negative. bhd() called
 * toFils() without allowNegative, which throws, so opening a refunded
 * transaction or a reconciliation with a negative gap crashed the page.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bhd } from "./format.js";

test("a refund timeline amount renders with a minus sign", () => {
  assert.equal(bhd(-4_000), "-4.000 BHD");
  assert.equal(bhd(-5), "-0.005 BHD");
});

test("positive and zero amounts are unchanged", () => {
  assert.equal(bhd(4_750), "4.750 BHD");
  assert.equal(bhd(0), "0.000 BHD");
});

test("a fractional fil is still rejected (amounts are whole fils)", () => {
  assert.throws(() => bhd(1.5));
});
