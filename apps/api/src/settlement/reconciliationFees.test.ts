/**
 * The reconciliation report's pending figure must use the fee each capture
 * was actually charged. It re-estimated it with floats, half-up rounding and
 * merchants.mdr_bps (not the effective fee schedule), so a merchant with a
 * negotiated schedule, or an amount that rounds on a .5, showed a gap that
 * isn't there (capture uses integer applyRateFils, half to even, at the
 * scheduled rate).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { getReconciliationReport } from "./query.js";

const h = createTestHarness();

function todayWindow(): { from: string; to: string } {
  const bahrainNow = new Date(Date.now() + 3 * 3_600_000);
  return {
    from: bahrainNow.toISOString().slice(0, 10),
    to: new Date(bahrainNow.getTime() + 86_400_000).toISOString().slice(0, 10),
  };
}

test("a .5 fee (1,300 at 250 bps = 32.5) reconciles: capture charged 32, half to even", async () => {
  const m = await h.merchant({ label: "recon-fee", mdrBps: 250 });
  const tx = await h.authorize(m, 1_300);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  const report = await getReconciliationReport(h.pool, { merchantId: m.merchantId, ...todayWindow() });
  assert.equal(report.pendingUnbatchedFils, 1_300 - 32);
  assert.equal(report.gapFils, 0);
});

test("a merchant on a negotiated fee schedule (225 bps vs 250 on file) reconciles", async () => {
  const m = await h.merchant({ label: "recon-fee", mdrBps: 250 });
  await h.pool.query(`INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 225, now() - interval '1 day')`, [m.merchantId]);
  const tx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  const report = await getReconciliationReport(h.pool, { merchantId: m.merchantId, ...todayWindow() });
  assert.equal(report.pendingUnbatchedFils, 10_000 - 225);
  assert.equal(report.explained, true);
});

test("a merchant with a negotiated discount reconciles (fee 250, rebate 50)", async () => {
  const m = await h.merchant({ label: "recon-fee", mdrBps: 250 });
  await h.pool.query(`UPDATE merchants SET negotiated_discount_bps = 2000 WHERE id = $1`, [m.merchantId]);
  const tx = await h.authorize(m, 10_000);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  const report = await getReconciliationReport(h.pool, { merchantId: m.merchantId, ...todayWindow() });
  assert.equal(report.pendingUnbatchedFils, 10_000 - 200);
  assert.equal(report.gapFils, 0);
});
