/**
 * Bug 77: the abandoned-checkout recovery pass (bug 74) runs every minute
 * and read whole tables to find a handful of rows: every payment link
 * (twice) and every idempotency key, so its cost grew with every link ever
 * created (~185 ms of Postgres a minute at 34k links on the live box).
 *
 * Each statement it runs is planned with sequential scans disabled; the
 * planner still picks one when no index can serve it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { RECOVERY_SQL } from "./recoverAbandoned.js";

const h = createTestHarness();

for (const [name, sql] of Object.entries(RECOVERY_SQL)) {
  test(`recovery statement "${name}" uses indexes only`, async () => {
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, ["60"]);
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      assert.doesNotMatch(text, /Seq Scan/, text);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
}
