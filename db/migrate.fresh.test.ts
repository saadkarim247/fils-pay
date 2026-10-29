/**
 * Fresh-database migration tests: every deploy to a new environment (the
 * hosted demo, CI, a new laptop) starts from an empty database, so the whole
 * chain 0001–0072 must apply from nothing, in one run, and stay re-runnable.
 *
 * Each run creates its own throwaway database next to the one DATABASE_URL
 * points at (the role needs CREATEDB), runs the real db/migrate.ts against
 * it as a child process, and drops it afterwards.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("migrate.fresh.test.ts requires DATABASE_URL to point at a Postgres the role can CREATE DATABASE on");
}

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATE_SCRIPT = join(here, "migrate.ts");
const MIGRATION_FILES = readdirSync(join(here, "migrations")).filter((f) => f.endsWith(".sql")).sort();

const freshDbName = `filspay_fresh_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const freshUrl = (() => {
  const url = new URL(databaseUrl);
  url.pathname = `/${freshDbName}`;
  return url.toString();
})();

async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function runMigrate(): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", MIGRATE_SCRIPT], {
    env: { ...process.env, DATABASE_URL: freshUrl },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

before(async () => {
  await withClient(databaseUrl, (c) => c.query(`CREATE DATABASE ${freshDbName}`));
});

after(async () => {
  await withClient(databaseUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${freshDbName} WITH (FORCE)`));
});

test("a brand-new database migrates end to end and records every file", { timeout: 120_000 }, async () => {
  const run = runMigrate();
  assert.equal(run.status, 0, `migrate exited ${run.status}:\n${run.output}`);

  const recorded = await withClient(freshUrl, async (c) => {
    const r = await c.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename");
    return r.rows.map((row) => row.filename);
  });
  assert.deepEqual(recorded, MIGRATION_FILES);
});

test("objects from the end of the chain exist on a fresh database", async () => {
  // One object per late migration that the running services depend on. Before
  // the fix, migrate stopped at 0054 and none of these were ever created.
  const expected = [
    "merchant_payable_position", // 0054: rebuild-balances source
    "v_active_api_keys", // 0054
    "settlement_payout_disbursements", // 0057: payout webhooks write here
    "live_sessions", // 0058: every merchant session lookup reads this
    "credit_requests", // 0060
    "adjustment_imports", // 0065
    "adjustment_import_rows", // 0066
    "webhook_delivery_archives", // 0068
    "reporting_saved_filters", // 0069
    "refund_merchant_summary", // 0072
  ];
  const missing = await withClient(freshUrl, async (c) => {
    const r = await c.query<{ name: string }>(
      "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NULL",
      [expected],
    );
    return r.rows.map((row) => row.name);
  });
  assert.deepEqual(missing, []);

  const revokeAfter = await withClient(freshUrl, (c) =>
    c.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'api_keys' AND column_name = 'revoke_after'"),
  );
  assert.equal(revokeAfter.rowCount, 1, "0056 api_keys.revoke_after missing");
});

test("the chart of accounts keeps only the kinds its CHECK allows", async () => {
  const kinds = await withClient(freshUrl, async (c) => {
    const r = await c.query<{ kind: string }>("SELECT DISTINCT kind FROM chart_of_accounts ORDER BY kind");
    return r.rows.map((row) => row.kind);
  });
  for (const kind of kinds) assert.ok(["asset", "liability", "revenue"].includes(kind), `unexpected kind ${kind}`);
});

test("re-running migrate on an up-to-date database applies nothing and succeeds", { timeout: 120_000 }, () => {
  const run = runMigrate();
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, new RegExp(`0 migration\\(s\\) applied, ${MIGRATION_FILES.length} already up to date`));
});
