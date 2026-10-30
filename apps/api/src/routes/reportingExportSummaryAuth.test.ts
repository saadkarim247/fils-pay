/**
 * GET /v1/reporting/export-summary is a merchant endpoint: it needs the
 * merchant's authentication, like every other /v1/reporting route. It had no
 * auth preHandler, so request.merchantAuth was undefined and every call (with
 * or without credentials) crashed with a 500.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

test("without credentials it is a 401, not a crash", async () => {
  const res = await h.app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(res.statusCode, 401, res.body);
});

test("with the merchant's API key it returns that merchant's summary", async () => {
  const m = await h.merchant({ label: "export-summary" });
  await h.pool.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils) VALUES ($1, '2026-10-01', 2, 7500)`,
    [m.merchantId],
  );
  const res = await h.app.inject({ method: "GET", url: "/v1/reporting/export-summary", headers: h.bearer(m) });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { totalDays: 1, grossFils: 7_500 });
});
