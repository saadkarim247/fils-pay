/**
 * Only finance and super_admin may create credits.
 *
 * A credit at or below the 50.000 BD threshold posts to the merchant's
 * ledger the moment it is created, so "create" is itself a money-moving
 * action. The admin console only offers it to finance/super_admin ("Your
 * role cannot issue credits. Ask a finance admin."), createCreditRequest's
 * contract says a support caller gets a 403, and ARCHITECTURE says roles are
 * checked server-side per route. These tests check the server actually
 * enforces it, and that a refused request leaves no trace in the ledger.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("adminCreditsCreateRole.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

type AdminRole = "support" | "finance" | "super_admin";
const ADMIN_PASSWORD = "admin-test-password-9000!";
/** At or below the threshold: posts to the ledger immediately on create. */
const SMALL_CREDIT_FILS = 10_000;
/** Above the threshold: would wait for a second approver. */
const LARGE_CREDIT_FILS = 60_000;

// ---------------------------------------------------------------- fixtures

function cookieNamed(setCookie: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (!match) throw new Error(`expected a ${name} Set-Cookie header`);
  return match.split(";")[0] as string;
}

let cachedHash: string | null = null;
async function signedInAdmin(role: AdminRole): Promise<string> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `credit-role-${role}-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4)`,
    [email, cachedHash, `Credit role ${role}`, role],
  );
  const login = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = cookieNamed(login.headers["set-cookie"], config.adminCookieName);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookie;
}

async function newMerchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Credit role ${randomUUID().slice(0, 8)}`],
  );
  return r.rows[0]!.id;
}

async function createCredit(cookie: string, merchantId: string, baseAmountFils: number) {
  return app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/credits`,
    headers: { cookie },
    payload: { baseAmountFils, reasonCode: "goodwill", effectiveDate: "2026-10-01" },
  });
}

/** Everything a credit could have touched for this merchant. */
async function moneyTrail(merchantId: string) {
  const r = await pool.query<{ requests: string; ledger_legs: string }>(
    `SELECT (SELECT count(*) FROM credit_requests WHERE merchant_id = $1)::text AS requests,
            (SELECT count(*) FROM ledger_entries  WHERE merchant_id = $1)::text AS ledger_legs`,
    [merchantId],
  );
  return { requests: Number(r.rows[0]!.requests), ledgerLegs: Number(r.rows[0]!.ledger_legs) };
}

// ------------------------------------------------------------------- tests

test("a support admin cannot create a small credit, and nothing reaches the ledger", async () => {
  const support = await signedInAdmin("support");
  const merchantId = await newMerchant();
  const res = await createCredit(support, merchantId, SMALL_CREDIT_FILS);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error, "forbidden");
  assert.deepEqual(await moneyTrail(merchantId), { requests: 0, ledgerLegs: 0 });
});

test("a support admin cannot create a large credit either, and no request is queued", async () => {
  const support = await signedInAdmin("support");
  const merchantId = await newMerchant();
  const res = await createCredit(support, merchantId, LARGE_CREDIT_FILS);
  assert.equal(res.statusCode, 403, res.body);
  assert.deepEqual(await moneyTrail(merchantId), { requests: 0, ledgerLegs: 0 });
});

for (const role of ["finance", "super_admin"] as const) {
  test(`a ${role} admin can still create a small credit and it posts`, async () => {
    const cookie = await signedInAdmin(role);
    const merchantId = await newMerchant();
    const res = await createCredit(cookie, merchantId, SMALL_CREDIT_FILS);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((res.json() as { status: string }).status, "posted");
    const trail = await moneyTrail(merchantId);
    assert.equal(trail.requests, 1);
    assert.ok(trail.ledgerLegs >= 2, "a posted credit writes balanced ledger legs");
  });
}

test("a support admin can still read the credits queue", async () => {
  const support = await signedInAdmin("support");
  const res = await app.inject({ method: "GET", url: "/v1/admin/credits", headers: { cookie: support } });
  assert.equal(res.statusCode, 200, res.body);
});
