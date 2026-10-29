/**
 * The pre-OTP session must authenticate nothing.
 *
 * Login is two steps: password, then OTP. Step 1 already creates the session
 * row and hands its token to the browser as a cookie, with
 * `authenticated = false` until the OTP is verified (see 0012). So the only
 * thing standing between "knows the password" and "is logged in" is the
 * `authenticated = true` predicate on every authenticating lookup.
 *
 * These tests pin that rule at both levels: the lookup query itself, and the
 * real HTTP flow through both merchant auth guards (requireSession for the
 * dashboard's own endpoints, requireMerchantAuth for the data surface).
 * The positive cases make sure the fix doesn't simply lock everyone out.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { lookupPendingSession, lookupSession } from "./sessions.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("pendingSession.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const kycUploadDir = mkdtempSync(join(tmpdir(), "filspay-pending-session-"));
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  KYC_UPLOAD_DIR: kycUploadDir,
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
  await rm(kycUploadDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

async function createMerchantUser(): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Pending Session ${randomUUID().slice(0, 8)}`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused-in-these-tests', 'owner') RETURNING id`,
    [merchant.rows[0]!.id, `pending-${randomUUID()}@sessions.test`],
  );
  return user.rows[0]!.id;
}

/** A session that is live in every respect except the OTP step. */
async function insertPendingSession(merchantUserId: string): Promise<string> {
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, false, now() + interval '1 hour')`,
    [merchantUserId, sha256Hex(rawToken)],
  );
  return rawToken;
}

function parseCookie(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!header) throw new Error("expected a Set-Cookie header in the response");
  return header.split(";")[0] as string;
}

/** Real signup + password step: returns the cookie a browser holds between
 *  the password screen and the OTP screen, plus the OTP it would receive. */
async function signupAndPasswordStep(): Promise<{ cookie: string; otp: string }> {
  const email = `pending-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";
  const signupRes = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `Pending Co ${randomUUID().slice(0, 8)}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: `contact-${randomUUID()}@example.test`,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  assert.equal(signupRes.statusCode, 201, signupRes.body);
  const { merchantId } = signupRes.json() as { merchantId: string };

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const body = loginRes.json() as { otpRequired: boolean; devOtpCode?: string };
  assert.equal(body.otpRequired, true);
  assert.ok(body.devOtpCode, "expected devOtpCode with OTP_DEV_EXPOSE=true");
  return { cookie: parseCookie(loginRes.headers["set-cookie"]), otp: body.devOtpCode };
}

// ------------------------------------------------------- lookup query level

test("lookupSession rejects a live session that has not passed OTP", async () => {
  const token = await insertPendingSession(await createMerchantUser());
  assert.equal(await lookupSession(pool, token), null);
});

test("lookupSession accepts that same session once OTP marks it authenticated", async () => {
  const userId = await createMerchantUser();
  const token = await insertPendingSession(userId);
  await pool.query(`UPDATE sessions SET authenticated = true WHERE token_hash = $1`, [sha256Hex(token)]);

  const session = await lookupSession(pool, token);
  assert.ok(session, "a verified session must still log in");
  assert.equal(session.merchantUserId, userId);
});

test("the OTP step can still find the pending session (verify keeps working)", async () => {
  const token = await insertPendingSession(await createMerchantUser());
  assert.ok(await lookupPendingSession(pool, token));
});

// ------------------------------------------------------------ HTTP level

test("a pre-OTP cookie is refused by GET /v1/auth/me (requireSession)", async () => {
  const { cookie } = await signupAndPasswordStep();
  const res = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(res.statusCode, 401, res.body);
});

test("a pre-OTP cookie is refused by GET /v1/transactions (requireMerchantAuth)", async () => {
  const { cookie } = await signupAndPasswordStep();
  const res = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
  assert.equal(res.statusCode, 401, res.body);
});

test("the same cookie is accepted on both guards after OTP verify", async () => {
  const { cookie, otp } = await signupAndPasswordStep();
  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: otp },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);

  const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(me.statusCode, 200, me.body);
  const list = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
  assert.equal(list.statusCode, 200, list.body);
});
