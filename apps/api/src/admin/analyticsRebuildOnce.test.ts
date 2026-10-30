/**
 * Deferred item: the admin "Rebuild analytics" rebuilt the rollups from the
 * source tables but left the reporting worker's cursor where it was, so the
 * worker then applied every event it hadn't consumed yet a second time. Every
 * capture between the worker's last pass and the rebuild was counted twice.
 * It must count each capture exactly once, and later events must still flow.
 *
 * Runs the real reporting worker (`catch-up`, one pass until idle) as a child
 * process, and the real admin route.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();
const reportingEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "reporting", "src", "index.ts");

function catchUp(): void {
  const r = spawnSync(process.execPath, ["--import", "tsx", reportingEntry, "catch-up"], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, `reporting catch-up failed:\n${r.stdout}\n${r.stderr}`);
}

async function capturedCount(merchantId: string): Promise<number> {
  const r = await h.pool.query<{ n: string }>(
    `SELECT COALESCE(SUM(captured_count), 0)::text AS n FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  return Number(r.rows[0]!.n);
}

test("Rebuild analytics counts each capture once, and the worker carries on after it", async () => {
  // Start the worker from "now": earlier tests in this database leave
  // unrelated outbox events (some with hand-made payloads) behind.
  await h.pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_txid, last_processed_id)
     SELECT 'reporting', COALESCE(max(txid), '0'::xid8), COALESCE(max(id), 0) FROM outbox_events
     ON CONFLICT (consumer_name) DO UPDATE
       SET last_processed_txid = EXCLUDED.last_processed_txid, last_processed_id = EXCLUDED.last_processed_id`,
  );

  const m = await h.merchant({ label: "rebuild-once" });
  const capture = async () => {
    const tx = await h.authorize(m, 1_000);
    assert.equal((await h.capture(m, tx)).statusCode, 200);
  };

  await capture(); // A
  catchUp(); // the worker consumes A
  assert.equal(await capturedCount(m.merchantId), 1);

  await capture(); // B: in the outbox, not consumed yet

  const finance = await h.admin("finance");
  const rebuild = await h.app.inject({ method: "POST", url: "/v1/admin/reporting/rebuild", headers: { cookie: finance.cookie } });
  assert.equal(rebuild.statusCode, 200, rebuild.body);
  assert.equal(await capturedCount(m.merchantId), 2, "the rebuild counts A and B from source");

  catchUp(); // the worker must not apply B again
  assert.equal(await capturedCount(m.merchantId), 2, "B was counted twice");

  await capture(); // C: after the rebuild
  catchUp();
  assert.equal(await capturedCount(m.merchantId), 3, "events after the rebuild still flow");
});
