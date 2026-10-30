/**
 * Bug 58: a refund must show in the dashboard's daily volumes, both when the
 * admin rebuilds the analytics from source tables and through
 * GET /v1/analytics/volumes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { refreshAnalyticsRollups } from "../admin/reportingRebuild.js";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

function bahrainDate(offsetDays: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

test("a refund appears in the daily volumes after an analytics rebuild", async () => {
  const m = await h.merchant({ label: "refund-analytics" });
  const tx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  const refund = await h.app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...h.bearer(m), "idempotency-key": randomUUID() },
    payload: { transactionId: tx, amountFils: 4_000, reason: "damaged" },
  });
  assert.equal(refund.statusCode, 200, refund.body);

  const client = await h.pool.connect();
  try {
    await refreshAnalyticsRollups(client);
  } finally {
    client.release();
  }

  const res = await h.app.inject({
    method: "GET",
    url: `/v1/analytics/volumes?from=${bahrainDate(0)}&to=${bahrainDate(1)}`,
    headers: h.bearer(m),
  });
  assert.equal(res.statusCode, 200, res.body);
  const points = (res.json() as { points: Array<Record<string, unknown>> }).points;
  assert.equal(points.length, 1, res.body);
  assert.equal(points[0]!.capturedGrossFils, 10_000);
  assert.equal(points[0]!.refundCount, 1, res.body);
  assert.equal(points[0]!.refundGrossFils, 4_000, res.body);
});
