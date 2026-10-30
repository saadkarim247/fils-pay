/**
 * Bug 56: a credit's effective date is metadata (HANDOVER: "ledger rows go in
 * at now()"), and a future effective date is refused (the validator's own
 * contract). Back-dated legs reopened days finance had already reconciled.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../lib/errors.js";
import { getReconciliationReport } from "../settlement/query.js";
import { createTestHarness } from "../testSupport/fixtures.js";
import { createCreditRequest } from "./credits.js";
import { parseCreditRequestInput } from "./creditRequestValidation.js";

const h = createTestHarness();

/** Calendar date in Asia/Bahrain (UTC+3, no DST), offset by whole days. */
function bahrainDate(offsetDays: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const BODY = { baseAmountFils: 4_000, reasonCode: "goodwill", reverseFee: true };

test("a future effective date is refused", () => {
  for (const offset of [1, 30]) {
    assert.throws(
      () => parseCreditRequestInput({ ...BODY, effectiveDate: bahrainDate(offset) }),
      (err: unknown) => err instanceof AppError && err.statusCode === 400 && err.code === "invalid_effective_date",
    );
  }
});

test("today in Bahrain is accepted even when it is already tomorrow in UTC terms", () => {
  assert.equal(parseCreditRequestInput({ ...BODY, effectiveDate: bahrainDate(0) }).effectiveDate, bahrainDate(0));
});

test("a back-dated credit posts its ledger legs now and keeps the date as metadata", async () => {
  const m = await h.merchant();
  const admin = await h.admin("finance");
  const effectiveDate = bahrainDate(-40);

  const before = Date.now();
  const record = await createCreditRequest(h.pool, {
    merchantId: m.merchantId,
    adminUserId: admin.id,
    body: { ...BODY, effectiveDate },
  });
  assert.equal(record.status, "posted");
  assert.equal(record.effectiveDate, effectiveDate);

  const legs = await h.pool.query<{ occurred_at: Date }>(
    `SELECT occurred_at FROM ledger_entries WHERE entry_group_id = $1`,
    [record.ledgerEntryGroupId],
  );
  assert.ok(legs.rows.length >= 2);
  for (const leg of legs.rows) {
    assert.ok(leg.occurred_at.getTime() >= before - 60_000, `leg dated ${leg.occurred_at.toISOString()}, expected now`);
  }

  // The day it was "booked against" was closed long ago; it must not gain a gap.
  const old = await getReconciliationReport(h.pool, {
    merchantId: m.merchantId,
    from: effectiveDate,
    to: bahrainDate(-39),
  });
  assert.equal(old.gapFils, 0);
});
