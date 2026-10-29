/**
 * The fee rate the admin console shows as "current" must be the rate
 * capture actually charges right now.
 *
 * Capture resolves the rate as the newest fee_schedules row whose
 * effective_from has arrived (ties broken by created_at). The display's own
 * contract says the same ("the latest row whose effectiveFrom is not in the
 * future") but it ordered by created_at, so a backdated correction keyed in
 * later showed as current. Seed case, Alpha Retail: 225 bps effective 1 Aug,
 * then a 245 bps correction for March entered 15 Aug. Console said 245,
 * capture charged 225.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { getCurrentFeeScheduleForDisplay } from "./currentFeeScheduleDisplay.js";

const h = createTestHarness();

async function schedule(merchantId: string, mdrBps: number, effectiveFrom: string, createdAt: string) {
  await h.pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES ($1, $2, $3, $4)`,
    [merchantId, mdrBps, effectiveFrom, createdAt],
  );
}

/** Fee actually posted by a real authorize + full capture of 10,000 fils (rate in bps = fils). */
async function chargedBps(m: Awaited<ReturnType<typeof h.merchant>>): Promise<number> {
  const txId = await h.authorize(m, 10_000);
  const cap = await h.capture(m, txId);
  assert.equal(cap.statusCode, 200, cap.body);
  const r = await h.pool.query<{ fee: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS fee FROM ledger_entries
      WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue' AND direction = 'credit'`,
    [txId],
  );
  return Number(r.rows[0]!.fee);
}

test("Alpha Retail's case: a backdated correction entered later does not show as the current rate", async () => {
  const m = await h.merchant({ label: "fee-display" });
  await schedule(m.merchantId, 225, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
  await schedule(m.merchantId, 245, "2026-03-01T00:00:00Z", "2026-08-15T00:00:00Z");

  const shown = await getCurrentFeeScheduleForDisplay(h.pool, m.merchantId);
  assert.equal(shown?.mdrBps, 225);
  assert.equal(await chargedBps(m), 225, "and 225 is what capture charges");
});

test("a rate scheduled for the future is not shown as current", async () => {
  const m = await h.merchant({ label: "fee-display" });
  await schedule(m.merchantId, 200, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  await schedule(m.merchantId, 150, "2099-01-01T00:00:00Z", "2026-02-01T00:00:00Z");

  assert.equal((await getCurrentFeeScheduleForDisplay(h.pool, m.merchantId))?.mdrBps, 200);
  assert.equal(await chargedBps(m), 200);
});

test("two rows effective the same day: the later-entered correction wins on both sides", async () => {
  const m = await h.merchant({ label: "fee-display" });
  await schedule(m.merchantId, 230, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
  await schedule(m.merchantId, 210, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z");

  assert.equal((await getCurrentFeeScheduleForDisplay(h.pool, m.merchantId))?.mdrBps, 210);
  assert.equal(await chargedBps(m), 210);
});

test("with only future schedules nothing is shown, and capture uses the merchant's own rate", async () => {
  const m = await h.merchant({ label: "fee-display", mdrBps: 250 });
  await schedule(m.merchantId, 150, "2099-01-01T00:00:00Z", "2026-02-01T00:00:00Z");

  assert.equal(await getCurrentFeeScheduleForDisplay(h.pool, m.merchantId), null);
  assert.equal(await chargedBps(m), 250);
});
