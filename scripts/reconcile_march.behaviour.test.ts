/**
 * The March residue sweep, run for real against its own database.
 *
 * ADR-0002: scheme rounding residue is posted as
 *   credit card_scheme_clearing / debit scheme_rounding_residue
 * - the merchant is not involved. The script instead DEBITED the merchant's
 * payable (charging merchants for the scheme's own truncation), and minted a
 * random entry_group_id per run, so running it twice posted everything
 * twice ("am: re-running is safe, entry_group_id dedupes it" - it did not).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("reconcile_march.behaviour.test.ts requires DATABASE_URL (role needs CREATEDB)");

const here = dirname(fileURLToPath(import.meta.url));
const dbName = `filspay_march_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const url = (() => {
  const u = new URL(databaseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

async function sql<T = Record<string, unknown>>(text: string, values: unknown[] = [], target = url): Promise<T[]> {
  const c = new Client({ connectionString: target });
  await c.connect();
  try {
    return (await c.query(text, values)).rows as T[];
  } finally {
    await c.end();
  }
}

function run(script: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

let merchantId = "";

before(async () => {
  await sql(`CREATE DATABASE ${dbName}`, [], databaseUrl);
  const migrated = run(join(here, "..", "db", "migrate.ts"));
  assert.equal(migrated.status, 0, migrated.output);
  merchantId = (await sql<{ id: string }>(`INSERT INTO merchants (display_name) VALUES ('March Co') RETURNING id`))[0]!.id;
  // March 2026 captures with 7 + 3 = 10 fils of residue; one with none; one in April.
  for (const [captured, at] of [[4_747, "2026-03-05T10:00:00Z"], [1_003, "2026-03-20T10:00:00Z"], [5_000, "2026-03-21T10:00:00Z"], [2_225, "2026-04-02T10:00:00Z"]] as const) {
    await sql(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at) VALUES ($1, 'captured', $2, $2, $3, $4)`,
      [merchantId, captured, `acq-${randomUUID()}`, at],
    );
  }
});

after(async () => {
  await sql(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`, [], databaseUrl);
});

async function legs(account: string, direction: string): Promise<number> {
  const r = await sql<{ total: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS total FROM ledger_entries WHERE merchant_id = $1 AND account_id = $2 AND direction = $3`,
    [merchantId, account, direction],
  );
  return Number(r[0]!.total);
}

const SCRIPT = join(here, "reconcile_march.ts");

test("the sweep posts ADR-0002's legs and never touches the merchant's payable", async () => {
  const r = run(SCRIPT);
  assert.equal(r.status, 0, r.output);
  assert.equal(await legs("card_scheme_clearing", "credit"), 10);
  assert.equal(await legs("scheme_rounding_residue", "debit"), 10);
  assert.equal(await legs("merchant_payable", "debit") + (await legs("merchant_payable", "credit")), 0, "merchants are not charged for scheme rounding");
});

test("running it a second time posts nothing more", async () => {
  const r = run(SCRIPT);
  assert.equal(r.status, 0, r.output);
  assert.equal(await legs("card_scheme_clearing", "credit"), 10);
  assert.equal(await legs("scheme_rounding_residue", "debit"), 10);
});
