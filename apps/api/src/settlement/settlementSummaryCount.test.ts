/**
 * The settlement summary's "gross captured" for a period must equal what
 * the period's batches settle: the sum of the capture events in the window.
 * It summed transactions.captured_fils (a running total) once per capture
 * event, so a payment captured in two parts was counted twice over, and a
 * capture from an earlier day dragged its whole total into today
 * (docs/perf: the summary ran ~38% above batch gross).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { getSettlementSummary } from "./query.js";

const h = createTestHarness();

function todayWindow(): { from: string; to: string } {
  const bahrainNow = new Date(Date.now() + 3 * 3_600_000);
  return {
    from: bahrainNow.toISOString().slice(0, 10),
    to: new Date(bahrainNow.getTime() + 86_400_000).toISOString().slice(0, 10),
  };
}

test("a payment captured in two parts counts once, at the sum of its captures", async () => {
  const m = await h.merchant({ label: "summary" });
  const a = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, a, 4_000)).statusCode, 200);
  assert.equal((await h.capture(m, a, 6_000)).statusCode, 200);
  const b = await h.authorize(m, 3_000);
  assert.equal((await h.capture(m, b)).statusCode, 200);

  const summary = await getSettlementSummary(h.pool, { merchantId: m.merchantId, ...todayWindow() });
  assert.equal(summary.transactionCount, 2);
  assert.equal(summary.totalCapturedFils, 13_000);
});

test("only the part captured inside the window counts", async () => {
  const m = await h.merchant({ label: "summary" });
  const a = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, a, 4_000)).statusCode, 200);
  // Move that first capture to last week; capture the rest today.
  await h.pool.query(
    `UPDATE transaction_events SET occurred_at = now() - interval '7 days' WHERE transaction_id = $1 AND event_type IN ('captured', 'partially_captured')`,
    [a],
  );
  assert.equal((await h.capture(m, a, 6_000)).statusCode, 200);

  const summary = await getSettlementSummary(h.pool, { merchantId: m.merchantId, ...todayWindow() });
  assert.equal(summary.totalCapturedFils, 6_000);
});
