/**
 * A merchant with no daily-volume rollup row must not freeze analytics for
 * everyone. applyBatchClosed has a diagnostic check ("rollup lags ground
 * truth") that dereferenced the rollup row without checking it exists: it
 * threw exactly when the rollup was missing, rolled back the whole consumer
 * pass, and every pass after that hit the same event again.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("noWedge.test.ts requires DATABASE_URL (role needs CREATEDB)");
const here = dirname(fileURLToPath(import.meta.url));
const dbName = `filspay_wedge_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const url = (() => {
  const u = new URL(databaseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();
let pool: Pool;

async function admin(text: string): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query(text);
  } finally {
    await c.end();
  }
}

before(async () => {
  await admin(`CREATE DATABASE ${dbName}`);
  const migrated = spawnSync(process.execPath, ["--import", "tsx", join(here, "..", "..", "..", "..", "db", "migrate.ts")], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);
  pool = new Pool({ connectionString: url, max: 3 });
});

after(async () => {
  await pool?.end();
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test("a batch_closed event for a merchant with no rollup row is applied, and later events still flow", async () => {
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  const lagging = (await q(`INSERT INTO merchants (display_name) VALUES ('Lagging') RETURNING id`)).rows[0].id as string;
  const other = (await q(`INSERT INTO merchants (display_name) VALUES ('Other') RETURNING id`)).rows[0].id as string;

  // A real capture on 2026-07-01 (Bahrain) that never made it into a rollup.
  const tx = (await q(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference) VALUES ($1, 'captured', 5000, 5000, $2) RETURNING id`,
    [lagging, `acq-${randomUUID()}`],
  )).rows[0].id as string;
  await q(`INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at) VALUES ($1, 'captured', 5000, 'system', '2026-07-01T09:00:00+03:00')`, [tx]);
  const batch = (await q(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils) VALUES ($1, '2026-07-01', 'closed', 5000, 125, 4875) RETURNING id`,
    [lagging],
  )).rows[0].id as string;

  await q(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('settlement.batch_closed', 'settlement_batch', $1, $2)`, [
    batch,
    JSON.stringify({ merchantId: lagging, batchId: batch, batchDate: "2026-07-01", grossFils: 5000, feeFils: 125, netPayoutFils: 4875 }),
  ]);
  await q(`INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('transaction.captured', 'transaction', $1, $2)`, [
    randomUUID(),
    JSON.stringify({ merchantId: other, amountCapturedFils: 2000, feeFils: 50, newStatus: "captured", capturedTotalFils: 2000 }),
  ]);

  await runConsumerPass(pool, { consumerBatchLimit: 500 });

  const trend = await q(`SELECT net_payout_fils::text FROM merchant_payout_trends WHERE settlement_batch_id = $1`, [batch]);
  assert.equal(trend.rows[0]?.net_payout_fils, "4875", "the batch_closed event was applied");
  const otherVolume = await q(`SELECT captured_count FROM merchant_daily_volume WHERE merchant_id = $1`, [other]);
  assert.equal(otherVolume.rows[0]?.captured_count, 1, "a different merchant's later event was not blocked");
});
