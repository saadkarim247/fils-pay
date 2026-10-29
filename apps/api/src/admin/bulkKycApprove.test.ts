/**
 * Bulk KYC approve only approves merchants that are actually waiting for
 * review, and leaves a review record for each one.
 *
 * Approval is what lets a merchant take card payments (authorize refuses
 * anything not 'approved'). ADMIN.md: "Only merchants currently
 * under_review are affected." 0016: merchant_kyc_reviews is the single
 * source of truth for KYC, and nothing may set kyc_passed without writing a
 * row there in the same transaction. So, through the real admin route:
 *   - under_review merchants are approved, each with a review row naming
 *     the admin,
 *   - submitted (never reviewed), rejected and already-approved merchants
 *     are left exactly as they were and are not reported as approved,
 *   - a rejected merchant swept up in a bulk approve still can't take a
 *     payment.
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
import { issueApiKey } from "../apiKeys/issue.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("bulkKycApprove.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

type OnboardingStatus = "submitted" | "under_review" | "approved" | "rejected";
const ADMIN_PASSWORD = "admin-test-password-9000!";
const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

// ---------------------------------------------------------------- fixtures

function cookieNamed(setCookie: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (!match) throw new Error(`expected a ${name} Set-Cookie header`);
  return match.split(";")[0] as string;
}

let cachedHash: string | null = null;
async function signedInFinanceAdmin(): Promise<{ id: string; email: string; cookie: string }> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `bulk-kyc-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Bulk KYC', 'finance') RETURNING id`,
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
  return { id: inserted.rows[0]!.id, email, cookie };
}

/** A merchant sitting in the given onboarding state (kyc_passed matching it). */
async function merchantIn(status: OnboardingStatus): Promise<{ merchantId: string; ownerUserId: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status, kyc_passed)
     VALUES ($1, 250, $2, $3) RETURNING id`,
    [`Bulk KYC ${status} ${randomUUID().slice(0, 8)}`, status, status === "approved"],
  );
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchant.rows[0]!.id, `owner-${randomUUID()}@example.test`],
  );
  return { merchantId: merchant.rows[0]!.id, ownerUserId: owner.rows[0]!.id };
}

async function bulkApprove(cookie: string, merchantIds: string[]) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/bulk-approve",
    headers: { cookie },
    payload: { merchantIds, notes: "bulk test" },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { approvedCount: number; approvedMerchantIds: string[] };
}

async function merchantState(merchantId: string) {
  const r = await pool.query<{ onboarding_status: string; kyc_passed: boolean; reviews: string }>(
    `SELECT m.onboarding_status, m.kyc_passed,
            (SELECT count(*) FROM merchant_kyc_reviews r WHERE r.merchant_id = m.id)::text AS reviews
       FROM merchants m WHERE m.id = $1`,
    [merchantId],
  );
  const row = r.rows[0]!;
  return { status: row.onboarding_status, kycPassed: row.kyc_passed, reviews: Number(row.reviews) };
}

// ------------------------------------------------------------------- tests

test("under_review merchants are approved, each with its own review record naming the admin", async () => {
  const admin = await signedInFinanceAdmin();
  const a = await merchantIn("under_review");
  const b = await merchantIn("under_review");

  const result = await bulkApprove(admin.cookie, [a.merchantId, b.merchantId]);
  assert.equal(result.approvedCount, 2);
  assert.deepEqual(new Set(result.approvedMerchantIds), new Set([a.merchantId, b.merchantId]));

  for (const { merchantId } of [a, b]) {
    assert.deepEqual(await merchantState(merchantId), { status: "approved", kycPassed: true, reviews: 1 });
    const review = await pool.query<{ outcome: string; reviewer_admin_user_id: string; reviewer_identifier: string; notes: string }>(
      `SELECT outcome, reviewer_admin_user_id, reviewer_identifier, notes FROM merchant_kyc_reviews WHERE merchant_id = $1`,
      [merchantId],
    );
    assert.equal(review.rows[0]!.outcome, "approved");
    assert.equal(review.rows[0]!.reviewer_admin_user_id, admin.id);
    assert.equal(review.rows[0]!.reviewer_identifier, admin.email);
    assert.equal(review.rows[0]!.notes, "bulk test");
  }
});

for (const status of ["submitted", "rejected", "approved"] as const) {
  test(`${status === "approved" ? "an" : "a"} ${status} merchant in the batch is left exactly as it was and not reported as approved`, async () => {
    const admin = await signedInFinanceAdmin();
    const target = await merchantIn(status);
    const before = await merchantState(target.merchantId);

    const result = await bulkApprove(admin.cookie, [target.merchantId]);
    assert.equal(result.approvedCount, 0);
    assert.deepEqual(result.approvedMerchantIds, []);
    assert.deepEqual(await merchantState(target.merchantId), before);
  });
}

test("in a mixed batch only the under_review merchant moves", async () => {
  const admin = await signedInFinanceAdmin();
  const waiting = await merchantIn("under_review");
  const notReviewed = await merchantIn("submitted");
  const failedKyc = await merchantIn("rejected");

  const result = await bulkApprove(admin.cookie, [waiting.merchantId, notReviewed.merchantId, failedKyc.merchantId]);
  assert.deepEqual(result.approvedMerchantIds, [waiting.merchantId]);
  assert.equal((await merchantState(notReviewed.merchantId)).status, "submitted");
  assert.equal((await merchantState(failedKyc.merchantId)).status, "rejected");
});

test("a rejected merchant swept into a bulk approve still cannot take a card payment", async () => {
  const admin = await signedInFinanceAdmin();
  const failedKyc = await merchantIn("rejected");
  const { rawKey } = await issueApiKey(pool, config, {
    merchantId: failedKyc.merchantId,
    createdBy: failedKyc.ownerUserId,
    label: "bulk-kyc",
  });

  await bulkApprove(admin.cookie, [failedKyc.merchantId]);

  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 5_000, card: VALID_CARD, reference: "after-bulk" },
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().error, "merchant_not_approved");
});

// Guard, not a red-first test: the existing rollback test in admin.test.ts
// uses 'submitted' merchants, which are now never eligible, so it no longer
// exercises a rollback. This one does, including the new review rows.
test("if the audit write fails, the approvals and their review rows all roll back", async () => {
  const admin = await signedInFinanceAdmin();
  const a = await merchantIn("under_review");
  const b = await merchantIn("under_review");

  await pool.query(
    `ALTER TABLE admin_audit_log
       ADD CONSTRAINT test_block_bulk_kyc_review_audit CHECK (action <> 'kyc_bulk_approve') NOT VALID`,
  );
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/merchants/bulk-approve",
      headers: { cookie: admin.cookie },
      payload: { merchantIds: [a.merchantId, b.merchantId] },
    });
    assert.equal(res.statusCode, 500, res.body);
  } finally {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT test_block_bulk_kyc_review_audit`);
  }

  for (const { merchantId } of [a, b]) {
    assert.deepEqual(await merchantState(merchantId), { status: "under_review", kycPassed: false, reviews: 0 });
  }
});
