/**
 * Rotating an API key must kill the old key.
 *
 * Rotation is what an operator does when a key may have leaked. 0037
 * defines it as one transaction that revokes the old key with reason
 * 'rotated' and issues a replacement pointing back at it; the admin UI tells
 * the operator "the current key is revoked". These tests check exactly that,
 * through the real admin route and the real API-key guard:
 *   - the old key stops authenticating (reads and money-moving calls),
 *   - the new key works,
 *   - the old row records revoked_at + reason 'rotated',
 *   - a revoked key can't be rotated again into a second live key,
 *   - the merchant's other keys are left alone.
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("apiKeyRotation.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
async function signedInFinanceAdmin(): Promise<string> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `rotate-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Rotation test', 'finance')`,
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

async function approvedMerchant() {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Rotation ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  return { merchantId, ownerUserId: owner.rows[0]!.id };
}

async function rotate(adminCookie: string, merchantId: string, keyId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/api-keys/${keyId}/rotate`,
    headers: { cookie: adminCookie },
    payload: {},
  });
}

async function listWith(rawKey: string): Promise<number> {
  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}` },
  });
  return res.statusCode;
}

/** A setup where the merchant has one key, an admin rotates it, and the
 *  caller gets both raw keys back. */
async function rotatedKeyPair() {
  const admin = await signedInFinanceAdmin();
  const { merchantId, ownerUserId } = await approvedMerchant();
  const original = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "original" });
  assert.equal(await listWith(original.rawKey), 200, "the original key works before rotation");

  const res = await rotate(admin, merchantId, original.id);
  assert.equal(res.statusCode, 201, res.body);
  const rotated = res.json() as { id: string; rawKey: string; previousKeyId: string };
  return { admin, merchantId, ownerUserId, original, rotated };
}

// ------------------------------------------------------------------- tests

test("after rotation the old key is refused and the new key works", async () => {
  const { original, rotated } = await rotatedKeyPair();
  assert.equal(await listWith(original.rawKey), 401, "the rotated-out key must stop authenticating");
  assert.equal(await listWith(rotated.rawKey), 200);
});

test("the rotated-out key can no longer move money", async () => {
  const { original } = await rotatedKeyPair();
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${original.rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 5_000, card: VALID_CARD, reference: "after-rotation" },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test("the old row records the revocation as 'rotated' and the new row points back at it", async () => {
  const { original, rotated } = await rotatedKeyPair();
  const rows = await pool.query<{ id: string; revoked_at: Date | null; revoked_reason: string | null; rotated_from_key_id: string | null }>(
    `SELECT id, revoked_at, revoked_reason, rotated_from_key_id FROM api_keys WHERE id = ANY($1)`,
    [[original.id, rotated.id]],
  );
  const oldRow = rows.rows.find((r) => r.id === original.id)!;
  const newRow = rows.rows.find((r) => r.id === rotated.id)!;
  assert.ok(oldRow.revoked_at, "old key must have revoked_at set");
  assert.equal(oldRow.revoked_reason, "rotated");
  assert.equal(newRow.revoked_at, null);
  assert.equal(newRow.rotated_from_key_id, original.id);
});

test("rotating the same old key twice is refused, so it can't mint a second live key", async () => {
  const { admin, merchantId, original } = await rotatedKeyPair();
  const again = await rotate(admin, merchantId, original.id);
  assert.equal(again.statusCode, 409, again.body);

  const live = await pool.query(`SELECT 1 FROM api_keys WHERE merchant_id = $1 AND revoked_at IS NULL`, [merchantId]);
  assert.equal(live.rowCount, 1, "exactly one live key after one rotation");
});

test("rotating one key leaves the merchant's other keys working", async () => {
  const { merchantId, ownerUserId } = await approvedMerchant();
  const admin = await signedInFinanceAdmin();
  const keyA = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "a" });
  const keyB = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label: "b" });

  const res = await rotate(admin, merchantId, keyA.id);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(await listWith(keyB.rawKey), 200, "an unrelated key must not be revoked");
});
