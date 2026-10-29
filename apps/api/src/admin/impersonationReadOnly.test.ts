/**
 * "View as merchant" is view-only, whoever starts it.
 *
 * HANDOVER and the grant lookup's own contract say every impersonation
 * grant maps to the merchant `support` role and is read-only. These tests
 * start a real grant for each admin role (support, finance, super_admin)
 * and check that it:
 *   - resolves to merchant role `support`,
 *   - can read the merchant's data,
 *   - cannot capture or void a payment (money moves), and the payment is
 *     left untouched,
 *   - cannot create payment links or webhook endpoints,
 * while the merchant's own API key keeps working on the same payment.
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
import { recordKycReview } from "../onboarding/review.js";
import { lookupImpersonationGrant } from "./impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("impersonationReadOnly.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

type AdminRole = "support" | "finance" | "super_admin";
const ADMIN_ROLES: AdminRole[] = ["support", "finance", "super_admin"];
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
async function signedInAdmin(role: AdminRole): Promise<string> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `imp-ro-${role}-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4)`,
    [email, cachedHash, `Read-only ${role}`, role],
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

/** An approved merchant with an API key and one authorized (uncaptured) payment. */
async function merchantWithAuthorizedPayment() {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Imp RO ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "imp-ro" });

  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000, card: VALID_CARD, reference: "imp-ro" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  return { merchantId, rawKey, transactionId: (auth.json() as { id: string }).id };
}

async function startGrant(role: AdminRole, merchantId: string) {
  const adminCookie = await signedInAdmin(role);
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: adminCookie },
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = cookieNamed(res.headers["set-cookie"], config.impersonationCookieName);
  return { cookie, rawToken: decodeURIComponent(cookie.split("=")[1]!) };
}

async function paymentState(transactionId: string) {
  const r = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils FROM transactions WHERE id = $1`,
    [transactionId],
  );
  return { status: r.rows[0]!.status, capturedFils: Number(r.rows[0]!.captured_fils) };
}

// ------------------------------------------------------------------- tests

for (const role of ADMIN_ROLES) {
  test(`a ${role} grant resolves to merchant role "support"`, async () => {
    const { merchantId } = await merchantWithAuthorizedPayment();
    const { rawToken } = await startGrant(role, merchantId);
    const grant = await lookupImpersonationGrant(pool, rawToken);
    assert.ok(grant);
    assert.equal(grant.merchantRole, "support");
  });

  test(`a ${role} grant can still read the merchant's payments`, async () => {
    const { merchantId, transactionId } = await merchantWithAuthorizedPayment();
    const { cookie } = await startGrant(role, merchantId);
    const list = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
    assert.equal(list.statusCode, 200, list.body);
    const one = await app.inject({ method: "GET", url: `/v1/transactions/${transactionId}`, headers: { cookie } });
    assert.equal(one.statusCode, 200, one.body);
  });

  test(`a ${role} grant cannot capture or void, and the payment is left untouched`, async () => {
    const { merchantId, rawKey, transactionId } = await merchantWithAuthorizedPayment();
    const { cookie } = await startGrant(role, merchantId);
    const before = await paymentState(transactionId);

    const capture = await app.inject({
      method: "POST",
      url: `/v1/transactions/${transactionId}/capture`,
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {},
    });
    assert.equal(capture.statusCode, 403, capture.body);
    const voided = await app.inject({
      method: "POST",
      url: `/v1/transactions/${transactionId}/void`,
      headers: { cookie, "idempotency-key": randomUUID() },
    });
    assert.equal(voided.statusCode, 403, voided.body);
    assert.deepEqual(await paymentState(transactionId), before);

    // The merchant itself is unaffected: its own key still captures.
    const ownCapture = await app.inject({
      method: "POST",
      url: `/v1/transactions/${transactionId}/capture`,
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
      payload: {},
    });
    assert.equal(ownCapture.statusCode, 200, ownCapture.body);
  });

  test(`a ${role} grant cannot create payment links or webhook endpoints`, async () => {
    const { merchantId } = await merchantWithAuthorizedPayment();
    const { cookie } = await startGrant(role, merchantId);
    const link = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: { cookie },
      payload: { amountFils: 1000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(link.statusCode, 403, link.body);
    const endpoint = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints`,
      headers: { cookie },
      payload: { url: "http://127.0.0.1:9/hook" },
    });
    assert.equal(endpoint.statusCode, 403, endpoint.body);
  });
}
