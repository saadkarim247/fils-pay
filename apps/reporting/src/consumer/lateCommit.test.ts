/**
 * An outbox event that commits late must still be counted.
 *
 * The consumer read WHERE id > cursor and advanced the cursor to the highest
 * id it saw. Ids are assigned at INSERT, not COMMIT: if a transaction
 * holding id N commits after id N+1 was already processed, N is below the
 * cursor and is skipped forever (HANDOVER: "outbox consumption by commit
 * order instead of id" - not finished). This test runs on its own fresh
 * database and stages exactly that interleaving with two connections.
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
if (!databaseUrl) throw new Error("lateCommit.test.ts requires DATABASE_URL (role needs CREATEDB)");

const here = dirname(fileURLToPath(import.meta.url));
const dbName = `filspay_late_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

const INSERT_CAPTURED = `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('transaction.captured', 'transaction', $1, $2)`;
const capturedValues = (merchantId: string): unknown[] => [
  randomUUID(),
  JSON.stringify({ merchantId, amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 }),
];

test("an event whose transaction commits after a later event was processed is still applied", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name) VALUES ('Late Co') RETURNING id`);
  const merchantId = m.rows[0]!.id;

  const slow = new Client({ connectionString: url });
  await slow.connect();
  try {
    await slow.query("BEGIN");
    await slow.query(INSERT_CAPTURED, capturedValues(merchantId)); // gets the lower id, not committed yet

    await pool.query(INSERT_CAPTURED, capturedValues(merchantId)); // higher id, commits immediately
    await runConsumerPass(pool, { consumerBatchLimit: 500 });

    await slow.query("COMMIT"); // the earlier event finally commits
  } finally {
    await slow.end();
  }
  await runConsumerPass(pool, { consumerBatchLimit: 500 });

  const r = await pool.query<{ captured_count: number; captured_gross_fils: string }>(
    `SELECT captured_count, captured_gross_fils::text FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(r.rows[0]?.captured_count, 2, "both captures must be counted, including the one that committed late");
  assert.equal(r.rows[0]?.captured_gross_fils, "2000");
});

test("re-running the consumer applies nothing twice", async () => {
  const before = await pool.query(`SELECT COALESCE(SUM(captured_count), 0)::int AS n FROM merchant_daily_volume`);
  await runConsumerPass(pool, { consumerBatchLimit: 500 });
  const after = await pool.query(`SELECT COALESCE(SUM(captured_count), 0)::int AS n FROM merchant_daily_volume`);
  assert.equal(after.rows[0].n, before.rows[0].n);
});
