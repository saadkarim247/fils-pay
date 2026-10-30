/**
 * Bug 58: refunds must reach the dashboard's daily rollup (FP-300 "shows up
 * right in the reports"). The worker never consumed refund.succeeded, and the
 * refund rollup helper wrote columns merchant_daily_volume didn't have, keyed
 * by the UTC date instead of the Bahrain business day.
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
if (!databaseUrl) throw new Error("refundRollup.test.ts requires DATABASE_URL (role needs CREATEDB)");
const here = dirname(fileURLToPath(import.meta.url));
const dbName = `filspay_refroll_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

async function outbox(eventType: string, payload: Record<string, unknown>, createdAt: string): Promise<void> {
  await pool.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, created_at)
     VALUES ($1, 'transaction', $2, $3, $4)`,
    [eventType, randomUUID(), JSON.stringify(payload), createdAt],
  );
}

test("refund.succeeded events roll up into the merchant's Bahrain day, beside its captures", async () => {
  const merchantId = (await pool.query(`INSERT INTO merchants (display_name) VALUES ('Refunder') RETURNING id`)).rows[0].id as string;

  // 22:30 UTC on 1 July is 01:30 on 2 July in Bahrain: all three belong to 2 July.
  await outbox("transaction.captured", { merchantId, amountCapturedFils: 10_000 }, "2026-07-01T22:00:00Z");
  await outbox("refund.succeeded", { merchantId, refundId: randomUUID(), amountFils: 4_000, feeReversedFils: 100 }, "2026-07-01T22:30:00Z");
  await outbox("refund.succeeded", { merchantId, refundId: randomUUID(), amountFils: 1_500, feeReversedFils: 38 }, "2026-07-02T08:00:00Z");

  await runConsumerPass(pool, { consumerBatchLimit: 500 });

  const rows = await pool.query<{ r: Record<string, unknown> }>(
    `SELECT to_jsonb(v) AS r FROM merchant_daily_volume v WHERE merchant_id = $1 ORDER BY volume_date`,
    [merchantId],
  );
  assert.equal(rows.rows.length, 1, JSON.stringify(rows.rows));
  const day = rows.rows[0]!.r;
  assert.equal(day.volume_date, "2026-07-02");
  assert.equal(Number(day.captured_gross_fils), 10_000);
  assert.equal(day.refund_count, 2);
  assert.equal(Number(day.refund_gross_fils), 5_500);

  // Consumed exactly once: a second pass finds nothing new.
  assert.equal((await runConsumerPass(pool, { consumerBatchLimit: 500 })).processedCount, 0);
});
