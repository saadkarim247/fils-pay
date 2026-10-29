/**
 * Two-person control on large credits compares PEOPLE, not names.
 *
 * Credits above 50.000 BD need a second operator to approve them (HANDOVER:
 * "the second approver is compared by admin user id"). Display names are
 * mutable and not unique (0031 has no UNIQUE on display_name; 0060 even
 * snapshots the requester's name because it can change). So:
 *   - the same admin must be refused even after their name changes,
 *   - two different admins must be allowed even if they share a name.
 * Checked on the rule itself and end to end through the real admin routes,
 * including that a refused approval moves no money.
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
import { AppError } from "../lib/errors.js";
import { assertDistinctApprover } from "./creditApproval.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("creditTwoPerson.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
/** Above the 50.000 BD threshold, so it waits for a second approver. */
const LARGE_CREDIT_FILS = 60_000;

// ---------------------------------------------------------------- fixtures

function cookieNamed(setCookie: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (!match) throw new Error(`expected a ${name} Set-Cookie header`);
  return match.split(";")[0] as string;
}

let cachedHash: string | null = null;
async function signedInFinanceAdmin(displayName: string): Promise<{ id: string; cookie: string }> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `credit-2p-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'finance') RETURNING id`,
    [email, cachedHash, displayName],
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
  return { id: inserted.rows[0]!.id, cookie };
}

async function newMerchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Credit 2P ${randomUUID().slice(0, 8)}`],
  );
  return r.rows[0]!.id;
}

async function requestLargeCredit(requesterCookie: string, merchantId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/credits`,
    headers: { cookie: requesterCookie },
    payload: { baseAmountFils: LARGE_CREDIT_FILS, reasonCode: "goodwill", effectiveDate: "2026-10-01" },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { id: string; status: string };
  assert.equal(body.status, "pending_approval", "a credit above the threshold must wait for a second approver");
  return body.id;
}

async function approve(approverCookie: string, creditRequestId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/admin/credits/${creditRequestId}/approve`,
    headers: { cookie: approverCookie },
  });
}

async function creditState(creditRequestId: string) {
  const r = await pool.query<{ status: string; ledger_entry_group_id: string | null }>(
    `SELECT status, ledger_entry_group_id FROM credit_requests WHERE id = $1`,
    [creditRequestId],
  );
  return r.rows[0]!;
}

function isSelfApprovalError(err: unknown): boolean {
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 409);
  assert.equal(err.code, "self_approval_forbidden");
  return true;
}

// ------------------------------------------------------------- rule level

test("the same admin is refused even when their display name has changed", () => {
  const adminUserId = randomUUID();
  assert.throws(
    () =>
      assertDistinctApprover(
        { adminUserId, displayName: "Dana Finance" },
        { adminUserId, displayName: "Dana F. (renamed)" },
      ),
    isSelfApprovalError,
  );
});

test("two different admins who share a display name may approve each other", () => {
  assert.doesNotThrow(() =>
    assertDistinctApprover(
      { adminUserId: randomUUID(), displayName: "Ali Hasan" },
      { adminUserId: randomUUID(), displayName: "Ali Hasan" },
    ),
  );
});

// --------------------------------------------------------- end to end

test("a requester who is renamed before approving cannot approve their own credit, and no money moves", async () => {
  const requester = await signedInFinanceAdmin(`Requester ${randomUUID().slice(0, 6)}`);
  const merchantId = await newMerchant();
  const creditId = await requestLargeCredit(requester.cookie, merchantId);

  await pool.query(`UPDATE admin_users SET display_name = $2 WHERE id = $1`, [
    requester.id,
    `Someone Else ${randomUUID().slice(0, 6)}`,
  ]);

  const res = await approve(requester.cookie, creditId);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, "self_approval_forbidden");
  assert.deepEqual(await creditState(creditId), { status: "pending_approval", ledger_entry_group_id: null });
});

test("a requester cannot approve their own credit (no rename)", async () => {
  const requester = await signedInFinanceAdmin(`Requester ${randomUUID().slice(0, 6)}`);
  const creditId = await requestLargeCredit(requester.cookie, await newMerchant());
  const res = await approve(requester.cookie, creditId);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((await creditState(creditId)).status, "pending_approval");
});

test("a second, different admin with the same display name can approve and the credit posts", async () => {
  const sharedName = `Ali Hasan ${randomUUID().slice(0, 6)}`;
  const requester = await signedInFinanceAdmin(sharedName);
  const approver = await signedInFinanceAdmin(sharedName);
  const creditId = await requestLargeCredit(requester.cookie, await newMerchant());

  const res = await approve(approver.cookie, creditId);
  assert.equal(res.statusCode, 200, res.body);
  const state = await creditState(creditId);
  assert.equal(state.status, "posted");
  assert.ok(state.ledger_entry_group_id, "a posted credit names its ledger entry group");
});
