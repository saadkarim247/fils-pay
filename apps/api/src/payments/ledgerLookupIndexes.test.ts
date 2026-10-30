/**
 * Bug 75: every checkout read the whole ledger. The balance trigger (0007)
 * runs at commit for each inserted leg and sums its group by entry_group_id,
 * and capture/void release holds by transaction_id; neither column had an
 * index, so each leg and each release was a full table scan and checkout
 * cost grew with the size of the ledger.
 *
 * With sequential scans disabled the planner still picks one when no index
 * can serve the lookup, so the plan shows whether the index exists however
 * small the test tables are.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

const hotLookups = [
  // check_ledger_group_balance(), once per inserted leg
  `SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries WHERE entry_group_id = $1`,
  // capture discount adjustment and refund fee lookup
  `SELECT count(*) FROM ledger_entries WHERE transaction_id = $1`,
  // capture.ts and void.ts release the hold
  `UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND status = 'active'`,
];

for (const sql of hotLookups) {
  test(`uses an index: ${sql.slice(0, 70)}…`, async () => {
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, [
        "00000000-0000-0000-0000-000000000000",
      ]);
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      assert.doesNotMatch(text, /Seq Scan/, text);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
}
