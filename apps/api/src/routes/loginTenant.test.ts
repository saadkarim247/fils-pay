/**
 * Login must authenticate the account whose password was checked, and no
 * other.
 *
 * merchant_users emails are unique per merchant only (0003), and signup lets
 * anyone open a new merchant with any email. So the same email can belong to
 * two unrelated accounts: a victim's real one and an attacker's copy. Logging
 * in to merchant X with X's password must give a session (and an OTP
 * challenge) on X's user, never on another merchant's user with the same
 * email.
 *
 * Each test checks both directions, so they hold whatever order Postgres
 * happens to return rows in.
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
import { sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("loginTenant.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const kycUploadDir = mkdtempSync(join(tmpdir(), "filspay-login-tenant-"));
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

interface Account {
  merchantId: string;
  ownerUserId: string;
  email: string;
  password: string;
}

async function signup(email: string, password: string): Promise<Account> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `Tenant Co ${randomUUID().slice(0, 8)}`,
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
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as { merchantId: string; ownerUserId: string };
  return { merchantId: body.merchantId, ownerUserId: body.ownerUserId, email, password };
}

/** The victim signs up first; the attacker then opens their own merchant
 *  reusing the victim's email with a password only the attacker knows. */
async function victimAndAttacker(): Promise<{ victim: Account; attacker: Account }> {
  const email = `shared-${randomUUID()}@example.test`;
  const victim = await signup(email, "victim's own password 1!");
  const attacker = await signup(email, "attacker's own password 2!");
  return { victim, attacker };
}

async function passwordStep(account: Account, password = account.password) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: account.merchantId, email: account.email, password },
  });
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!header) throw new Error("expected a Set-Cookie header");
  return header.split(";")[0] as string;
}

/** Full password + OTP login, then asks the API who it thinks we are. */
async function loginAndWhoAmI(account: Account): Promise<{ merchantUserId: string; merchantId: string }> {
  const loginRes = await passwordStep(account);
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const { devOtpCode } = loginRes.json() as { devOtpCode: string };
  const cookie = cookieFrom(loginRes.headers["set-cookie"]);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);

  const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(me.statusCode, 200, me.body);
  const body = me.json() as { merchantUserId: string; merchant: { id: string } };
  return { merchantUserId: body.merchantUserId, merchantId: body.merchant.id };
}

// ------------------------------------------------------------------- tests

test("the attacker's password logs in to the attacker's merchant, never the victim's", async () => {
  const { victim, attacker } = await victimAndAttacker();
  const who = await loginAndWhoAmI(attacker);
  assert.equal(who.merchantUserId, attacker.ownerUserId);
  assert.equal(who.merchantId, attacker.merchantId);
  assert.notEqual(who.merchantId, victim.merchantId);
});

test("the victim still lands on their own merchant when the same email exists elsewhere", async () => {
  const { victim } = await victimAndAttacker();
  const who = await loginAndWhoAmI(victim);
  assert.equal(who.merchantUserId, victim.ownerUserId);
  assert.equal(who.merchantId, victim.merchantId);
});

test("the pending session and OTP challenge belong to the user whose password was checked", async () => {
  const { victim, attacker } = await victimAndAttacker();
  for (const account of [attacker, victim]) {
    const loginRes = await passwordStep(account);
    assert.equal(loginRes.statusCode, 200, loginRes.body);
    const rawToken = cookieFrom(loginRes.headers["set-cookie"]).split("=")[1]!;

    const row = await pool.query<{ session_user: string; challenge_user: string }>(
      `SELECT s.merchant_user_id AS session_user, c.merchant_user_id AS challenge_user
         FROM sessions s
         JOIN otp_challenges c ON c.id = s.otp_challenge_id
        WHERE s.token_hash = $1`,
      [sha256Hex(decodeURIComponent(rawToken))],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0]!.session_user, account.ownerUserId);
    assert.equal(row.rows[0]!.challenge_user, account.ownerUserId);
  }
});

test("one merchant's password is still rejected on the other merchant", async () => {
  const { victim, attacker } = await victimAndAttacker();
  const res = await passwordStep(attacker, victim.password);
  assert.equal(res.statusCode, 401, res.body);
});
