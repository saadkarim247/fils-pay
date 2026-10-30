/**
 * Bug 55: the transactions export must (a) never let a reference run as a
 * spreadsheet formula and (b) stream from the database page by page instead
 * of holding the whole result in memory, without losing rows that share a
 * timestamp at a page boundary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTransactionsExportCsv, streamTransactionsExportCsv } from "./exportCsv.js";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

async function insertTx(merchantId: string, reference: string | null, occurredAt = "2026-04-01T10:00:00Z") {
  await h.pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', 1000, 1000, $2, 'acq_' || gen_random_uuid(), $3)`,
    [merchantId, reference, occurredAt],
  );
}

async function collect(merchantId: string): Promise<string> {
  let out = "";
  for await (const chunk of streamTransactionsExportCsv(h.pool, { merchantId })) out += chunk;
  return out;
}

const FORMULAS = ['=HYPERLINK("http://evil.example","x")', "+971", "-2+3", "@SUM(A1)", "\t=1"];

test("a reference that a spreadsheet would run as a formula is exported as text", async () => {
  const m = await h.merchant();
  for (const ref of FORMULAS) await insertTx(m.merchantId, ref);

  for (const csv of [await buildTransactionsExportCsv(h.pool, { merchantId: m.merchantId }), await collect(m.merchantId)]) {
    const refs = csv.trim().split("\n").slice(1).map((line) => line.split(",").slice(4, -1).join(","));
    for (const cell of refs) {
      const unquoted = cell.startsWith('"') ? cell.slice(1) : cell;
      assert.ok(unquoted.startsWith("'"), `reference cell ${JSON.stringify(cell)} must start with a quote mark`);
    }
  }
});

test("ordinary references are exported unchanged", async () => {
  const m = await h.merchant();
  await insertTx(m.merchantId, "order-7");
  const csv = await collect(m.merchantId);
  assert.ok(csv.includes(",order-7,"));
});

test("the stream returns every row even when a page boundary splits rows with the same timestamp", async () => {
  const m = await h.merchant();
  await h.pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference, occurred_at)
     SELECT $1, 'captured', 1000, 1000, 'r' || g, 'acq_' || gen_random_uuid(), '2026-04-01T10:00:00Z'
       FROM generate_series(1, 1005) g`,
    [m.merchantId],
  );
  const rows = (await collect(m.merchantId)).trim().split("\n").slice(1);
  assert.equal(rows.length, 1005);
  assert.equal(new Set(rows.map((r) => r.split(",")[0])).size, 1005);
});

test("GET /v1/transactions/export streams the CSV instead of buffering it", async () => {
  const m = await h.merchant();
  await insertTx(m.merchantId, "streamed-1");
  await insertTx(m.merchantId, "=1+1", "2026-04-02T10:00:00Z");

  const res = await h.app.inject({ method: "GET", url: "/v1/transactions/export", headers: h.bearer(m) });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/csv/);
  assert.equal(res.headers["content-length"], undefined, "a buffered body would carry a content-length");
  const lines = res.body.trim().split("\n");
  assert.equal(lines[0], "id,status,amount_bhd,captured_bhd,reference,occurred_at");
  assert.equal(lines.length, 3);
  assert.ok(lines[2]!.includes(",'=1+1,"));
});
