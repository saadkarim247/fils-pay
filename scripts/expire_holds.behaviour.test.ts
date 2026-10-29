/**
 * The nightly hold-expiry job, run for real against its own database.
 *
 * HANDOVER: "scripts/expire_holds.ts flips active to expired with one
 * UPDATE. Holds are never deleted." A card hold is money reserved on a
 * buyer's card; the row is the record of it. These tests create a fresh,
 * fully migrated database (the job touches the whole holds table, so it
 * must not share one with other tests), insert holds in every state, run
 * the actual script as a child process, and check:
 *   - on a night with nothing expired, no hold changes and none disappear,
 *   - an expired active hold becomes 'expired' and is kept,
 *   - captured/released, already-expired and still-valid holds are untouched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("expire_holds.behaviour.test.ts requires DATABASE_URL (role needs CREATEDB)");

const here = dirname(fileURLToPath(import.meta.url));
const dbName = `filspay_holds_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

function run(script: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

before(async () => {
  await sql(`CREATE DATABASE ${dbName}`, [], databaseUrl);
  const migrated = run(join(here, "..", "db", "migrate.ts"));
  assert.equal(migrated.status, 0, migrated.output);
});

after(async () => {
  await sql(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`, [], databaseUrl);
});

async function merchant(): Promise<string> {
  const r = await sql<{ id: string }>(`INSERT INTO merchants (display_name) VALUES ($1) RETURNING id`, [`Holds ${randomUUID().slice(0, 8)}`]);
  return r[0]!.id;
}

async function hold(merchantId: string, status: string, expiresIn: string): Promise<string> {
  const r = await sql<{ id: string }>(
    `INSERT INTO holds (merchant_id, amount_fils, status, expires_at) VALUES ($1, 1000, $2, now() + $3::interval) RETURNING id`,
    [merchantId, status, expiresIn],
  );
  return r[0]!.id;
}

async function statusOf(ids: string[]): Promise<Record<string, string>> {
  const rows = await sql<{ id: string; status: string }>(`SELECT id, status FROM holds WHERE id = ANY($1::uuid[])`, [ids]);
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

const EXPIRE_HOLDS = join(here, "expire_holds.ts");

test("a night with nothing expired changes no hold and deletes none", async () => {
  const m = await merchant();
  const live = await hold(m, "active", "2 days");
  const released = await hold(m, "released", "-3 days");
  const before = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM holds`);

  const r = run(EXPIRE_HOLDS);
  assert.equal(r.status, 0, r.output);

  const after = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM holds`);
  assert.equal(after[0]!.n, before[0]!.n, "no hold may disappear");
  assert.deepEqual(await statusOf([live, released]), { [live]: "active", [released]: "released" });
});

test("an expired active hold is flipped to 'expired' and kept; every other hold is untouched", async () => {
  const m = await merchant();
  const expiredActive = await hold(m, "active", "-1 hour");
  const stillValid = await hold(m, "active", "6 hours");
  const released = await hold(m, "released", "-2 days");
  const alreadyExpired = await hold(m, "expired", "-5 days");

  const r = run(EXPIRE_HOLDS);
  assert.equal(r.status, 0, r.output);

  assert.deepEqual(await statusOf([expiredActive, stillValid, released, alreadyExpired]), {
    [expiredActive]: "expired",
    [stillValid]: "active",
    [released]: "released",
    [alreadyExpired]: "expired",
  });
});

test("running it twice in a night is harmless", async () => {
  const m = await merchant();
  const expiredActive = await hold(m, "active", "-1 hour");
  assert.equal(run(EXPIRE_HOLDS).status, 0);
  const r = run(EXPIRE_HOLDS);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(await statusOf([expiredActive]), { [expiredActive]: "expired" });
});
