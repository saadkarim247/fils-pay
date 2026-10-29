/**
 * "Recompute transaction statuses" tidies statuses. It must never switch a
 * sandbox merchant live.
 *
 * ADMIN.md describes the tool as tidying old refund-era statuses, "safe to
 * run more than once". Settlement leaves out every merchant with
 * test_mode = true (batch.go), so clearing that flag puts a sandbox
 * merchant's test captures into the real payout run. Nothing documents the
 * tool doing that, and it is the only code path that ever cleared test_mode.
 * These tests drive the real admin route and check that:
 *   - a sandbox merchant stays sandbox (with or without open authorizations),
 *   - a live merchant stays live,
 *   - the tool still corrects a stale status, which is its actual job.
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
  throw new Error("adminRecomputeStatuses.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

const ADMIN_PASSWORD = "admin-test-password-9000!";

// ---------------------------------------------------------------- fixtures

function cookieNamed(setCookie: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (!match) throw new Error(`expected a ${name} Set-Cookie header`);
  return match.split(";")[0] as string;
}

let cachedHash: string | null = null;
async function signedInFinanceAdmin(): Promise<string> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `recompute-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Recompute', 'finance')`,
    [email, cachedHash],
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

async function merchant(testMode: boolean): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status, kyc_passed, test_mode)
     VALUES ($1, 250, 'approved', true, $2) RETURNING id`,
    [`Recompute ${testMode ? "sandbox" : "live"} ${randomUUID().slice(0, 8)}`, testMode],
  );
  return r.rows[0]!.id;
}

async function addTransaction(
  merchantId: string,
  t: { status: string; amountFils: number; capturedFils: number; refundedFils: number },
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [merchantId, t.status, t.amountFils, t.capturedFils, t.refundedFils, `recompute-test-${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

const CAPTURED = { status: "captured", amountFils: 10_000, capturedFils: 10_000, refundedFils: 0 };
const OPEN_AUTH = { status: "authorized", amountFils: 5_000, capturedFils: 0, refundedFils: 0 };
/** Fully refunded money, but still labelled 'captured': the stale refund-era
 *  status this tool exists to tidy. */
const STALE_REFUNDED = { status: "captured", amountFils: 8_000, capturedFils: 8_000, refundedFils: 8_000 };

async function recompute(cookie: string, merchantId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/transactions/recompute-statuses`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { scanned: number; updated: number };
}

async function testMode(merchantId: string): Promise<boolean> {
  const r = await pool.query<{ test_mode: boolean }>(`SELECT test_mode FROM merchants WHERE id = $1`, [merchantId]);
  return r.rows[0]!.test_mode;
}

// ------------------------------------------------------------------- tests

test("a sandbox merchant with only captured payments stays in sandbox (the Gamma case)", async () => {
  const admin = await signedInFinanceAdmin();
  const sandbox = await merchant(true);
  await addTransaction(sandbox, CAPTURED);
  await addTransaction(sandbox, CAPTURED);

  await recompute(admin, sandbox);
  assert.equal(await testMode(sandbox), true, "recompute must not move a sandbox merchant into real settlement");
});

test("a sandbox merchant with an open authorization also stays in sandbox", async () => {
  const admin = await signedInFinanceAdmin();
  const sandbox = await merchant(true);
  await addTransaction(sandbox, CAPTURED);
  await addTransaction(sandbox, OPEN_AUTH);

  await recompute(admin, sandbox);
  assert.equal(await testMode(sandbox), true);
});

test("running it twice is still safe for a sandbox merchant", async () => {
  const admin = await signedInFinanceAdmin();
  const sandbox = await merchant(true);
  await addTransaction(sandbox, STALE_REFUNDED);

  await recompute(admin, sandbox);
  await recompute(admin, sandbox);
  assert.equal(await testMode(sandbox), true);
});

test("a live merchant stays live", async () => {
  const admin = await signedInFinanceAdmin();
  const live = await merchant(false);
  await addTransaction(live, CAPTURED);

  await recompute(admin, live);
  assert.equal(await testMode(live), false);
});

test("the tool still corrects a stale refund-era status", async () => {
  const admin = await signedInFinanceAdmin();
  const sandbox = await merchant(true);
  const stale = await addTransaction(sandbox, STALE_REFUNDED);
  const fine = await addTransaction(sandbox, CAPTURED);

  const result = await recompute(admin, sandbox);
  assert.equal(result.updated, 1);
  const rows = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM transactions WHERE id = ANY($1)`,
    [[stale, fine]],
  );
  const status = Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
  assert.equal(status[stale], "refunded");
  assert.equal(status[fine], "captured");
});
