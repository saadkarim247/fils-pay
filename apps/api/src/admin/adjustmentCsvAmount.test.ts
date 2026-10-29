/**
 * CSV adjustment amounts are BD with up to 3 decimals (1 BD = 1000 fils,
 * ADR-0001). ADMIN.md: amounts are "in BD as finance's sheets already have
 * them (4.75, 120.00)". So "4.75" is 4.750 BD = 4750 fils, never 475.
 * Unit cases on the parser, plus the real admin import route posting to the
 * ledger, including the 2026-08-27 sheet that posted a tenth of its value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

// ------------------------------------------------------------- parser

const CASES: Array<[string, number]> = [
  ["4.75", 4_750],
  ["4.750", 4_750],
  ["120.00", 120_000],
  ["4.755", 4_755],
  ["0.005", 5],
  ["7", 7_000],
  ["-2.5", -2_500],
  ["4141.90", 4_141_900],
];
for (const [raw, fils] of CASES) {
  test(`"${raw}" BD parses to ${fils} fils`, () => {
    assert.equal(parseAdjustmentAmountFils(raw), fils);
  });
}

for (const raw of ["1.2345", "4,75", "abc", "1e3", ""]) {
  test(`"${raw}" is rejected as an amount`, () => {
    assert.throws(() => parseAdjustmentAmountFils(raw), (err: unknown) => (err as { code?: string }).code === "invalid_amount");
  });
}

// ------------------------------------------------------------- end to end

async function importCsv(cookie: string, csvContent: string) {
  return h.app.inject({
    method: "POST",
    url: "/v1/admin/adjustment-imports",
    headers: { cookie },
    payload: { csvContent, originalFilename: "test.csv" },
  });
}

async function payableMovement(merchantId: string): Promise<number> {
  const r = await h.pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  return Number(r.rows[0]!.net);
}

test("importing finance's 4141.90 BD correction credits the merchant 4,141.900 BD, not 414.190", async () => {
  const admin = await h.admin("finance");
  const m = await h.merchant({ label: "csv-import" });
  const res = await importCsv(admin.cookie, `merchantId,amount,reason\n${m.merchantId},4141.90,Aug statement correction`);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(await payableMovement(m.merchantId), 4_141_900);
});

test("a three-decimal amount keeps its last fil, and a negative row debits", async () => {
  const admin = await h.admin("finance");
  const m = await h.merchant({ label: "csv-import" });
  const res = await importCsv(admin.cookie, `merchantId,amount,reason\n${m.merchantId},4.755,a\n${m.merchantId},-0.005,b`);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(await payableMovement(m.merchantId), 4_750);
});

test("a four-decimal amount rejects the whole import and posts nothing", async () => {
  const admin = await h.admin("finance");
  const m = await h.merchant({ label: "csv-import" });
  const res = await importCsv(admin.cookie, `merchantId,amount,reason\n${m.merchantId},1.00,a\n${m.merchantId},1.2345,b`);
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(await payableMovement(m.merchantId), 0);
});
