/**
 * The transactions report may only widen to a sub-merchant of the CALLER.
 *
 * A marketplace parent (merchant_split_children, 0045) may report on its own
 * child accounts. Every other merchant's data is private. These tests use
 * two separate marketplaces and an unrelated merchant, all calling the real
 * GET /v1/reporting/transactions with their own API keys, and check that a
 * caller only ever gets rows for itself or its own children.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reportingScope.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

// ---------------------------------------------------------------- fixtures

interface Merchant {
  id: string;
  rawKey: string;
}

/** An approved merchant with one API key and one captured transaction. */
async function merchant(label: string): Promise<Merchant> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status, kyc_passed) VALUES ($1, 250, 'approved', true) RETURNING id`,
    [`Scope ${label} ${randomUUID().slice(0, 8)}`],
  );
  const id = m.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [id, `owner-${randomUUID()}@example.test`],
  );
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, reference)
     VALUES ($1, 'captured', 7000, 7000, $2, $3)`,
    [id, `scope-${randomUUID()}`, `order-of-${label}`],
  );
  const { rawKey } = await issueApiKey(pool, config, { merchantId: id, createdBy: owner.rows[0]!.id, label });
  return { id, rawKey };
}

async function makeChild(parent: Merchant, child: Merchant): Promise<void> {
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, 10000)`,
    [parent.id, child.id],
  );
}

/** The merchant ids that appear in the caller's report for `requested`. */
async function reportedMerchants(caller: Merchant, requested?: Merchant): Promise<Set<string>> {
  const filter = requested ? `?filter=${encodeURIComponent(JSON.stringify({ merchantId: requested.id }))}` : "";
  const res = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions${filter}`,
    headers: { authorization: `Bearer ${caller.rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return new Set((res.json() as Array<{ merchantId: string }>).map((r) => r.merchantId));
}

/** Marketplace A with its child, marketplace B with its child, and an outsider. */
async function world() {
  const parentA = await merchant("parentA");
  const childA = await merchant("childA");
  const parentB = await merchant("parentB");
  const childB = await merchant("childB");
  const outsider = await merchant("outsider");
  await makeChild(parentA, childA);
  await makeChild(parentB, childB);
  return { parentA, childA, parentB, childB, outsider };
}

// ------------------------------------------------------------------- tests

test("an unrelated merchant cannot read another marketplace's sub-merchant", async () => {
  const { childA, outsider } = await world();
  const seen = await reportedMerchants(outsider, childA);
  assert.ok(!seen.has(childA.id), "outsider must not see childA's transactions");
  assert.deepEqual(seen, new Set([outsider.id]));
});

test("one marketplace cannot read a different marketplace's sub-merchant", async () => {
  const { childA, parentB } = await world();
  const seen = await reportedMerchants(parentB, childA);
  assert.ok(!seen.has(childA.id), "parentB must not see childA's transactions");
  assert.deepEqual(seen, new Set([parentB.id]));
});

test("a sub-merchant cannot read its sibling marketplace's other child", async () => {
  const { childA, childB } = await world();
  const seen = await reportedMerchants(childB, childA);
  assert.ok(!seen.has(childA.id));
});

test("a marketplace parent can still report on its own sub-merchant", async () => {
  const { parentA, childA } = await world();
  assert.deepEqual(await reportedMerchants(parentA, childA), new Set([childA.id]));
});

test("asking for a merchant that is nobody's child falls back to the caller", async () => {
  const { parentA, outsider } = await world();
  assert.deepEqual(await reportedMerchants(outsider, parentA), new Set([outsider.id]));
});

test("with no merchantId the caller gets its own report", async () => {
  const { outsider } = await world();
  assert.deepEqual(await reportedMerchants(outsider), new Set([outsider.id]));
});
