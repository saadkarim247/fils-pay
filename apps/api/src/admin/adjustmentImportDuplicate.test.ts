/**
 * The same adjustment CSV must not post twice.
 *
 * Each import writes real ledger legs. 2026-09-04: "aug-adjustments-v3-
 * FINAL.csv" (31 rows) was applied twice, 22 s apart, and nothing stopped
 * it (no constraint exists, despite a comment claiming a unique filename).
 * Duplicates are detected by content (the normalised rows), not filename,
 * through the real admin route.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

function post(cookie: string, csvContent: string, originalFilename = "aug-adjustments.csv") {
  return h.app.inject({
    method: "POST",
    url: "/v1/admin/adjustment-imports",
    headers: { cookie },
    payload: { csvContent, originalFilename },
  });
}

async function payable(merchantId: string): Promise<number> {
  const r = await h.pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  return Number(r.rows[0]!.net);
}

async function setup() {
  const admin = await h.admin("finance");
  const a = await h.merchant({ label: "dup-import" });
  const b = await h.merchant({ label: "dup-import" });
  const csv = `merchantId,amount,reason\n${a.merchantId},12.500,Aug fee correction\n${b.merchantId},-3.250,reversal\n`;
  return { admin, a, b, csv };
}

test("submitting the same CSV twice posts it once; the second is a 409", async () => {
  const { admin, a, b, csv } = await setup();
  assert.equal((await post(admin.cookie, csv)).statusCode, 201);
  const again = await post(admin.cookie, csv);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error, "duplicate_import");
  assert.equal(await payable(a.merchantId), 12_500);
  assert.equal(await payable(b.merchantId), -3_250);
});

test("renaming the file does not make it a different import", async () => {
  const { admin, a, csv } = await setup();
  assert.equal((await post(admin.cookie, csv, "aug-v3.csv")).statusCode, 201);
  assert.equal((await post(admin.cookie, csv, "aug-v3-FINAL.csv")).statusCode, 409);
  assert.equal(await payable(a.merchantId), 12_500);
});

test("re-saving with Windows line endings and stray spaces is still the same import", async () => {
  const { admin, a, csv } = await setup();
  assert.equal((await post(admin.cookie, csv)).statusCode, 201);
  const resaved = csv.split("\n").map((line) => line.replace(",", " , ")).join("\r\n");
  assert.equal((await post(admin.cookie, resaved)).statusCode, 409);
  assert.equal(await payable(a.merchantId), 12_500);
});

test("two simultaneous submissions of one file post it exactly once", async () => {
  const { admin, a, csv } = await setup();
  const results = await Promise.all([post(admin.cookie, csv), post(admin.cookie, csv)]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal(await payable(a.merchantId), 12_500);
});

test("a genuinely different file (one amount changed) still applies", async () => {
  const { admin, a, b, csv } = await setup();
  assert.equal((await post(admin.cookie, csv)).statusCode, 201);
  const corrected = csv.replace("12.500", "12.750");
  assert.equal((await post(admin.cookie, corrected)).statusCode, 201);
  assert.equal(await payable(a.merchantId), 25_250);
  assert.equal(await payable(b.merchantId), -6_500);
});

test("an import that failed and rolled back does not block resubmitting it", async () => {
  const { admin, a } = await setup();
  const bad = `merchantId,amount,reason\n${a.merchantId},1.000,ok\n${a.merchantId},abc,bad\n`;
  assert.equal((await post(admin.cookie, bad)).statusCode, 400);
  const fixed = `merchantId,amount,reason\n${a.merchantId},1.000,ok\n`;
  assert.equal((await post(admin.cookie, fixed)).statusCode, 201);
  assert.equal(await payable(a.merchantId), 1_000);
});
