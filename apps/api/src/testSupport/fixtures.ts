/**
 * Shared fixtures for the bug-fix regression tests (docs/bugs/points).
 * Each test file calls createTestHarness() once and gets a real app + pool
 * against DATABASE_URL, plus helpers that build the real objects (approved
 * merchants with API keys, signed-in admins) through the real code paths.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig, type Config } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

export const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const ADMIN_PASSWORD = "admin-test-password-9000!";

export type AdminRole = "support" | "finance" | "super_admin";

export interface TestMerchant {
  merchantId: string;
  ownerUserId: string;
  rawKey: string;
}

export interface TestHarness {
  app: FastifyInstance;
  pool: Pool;
  config: Config;
  /** Approved merchant with an owner user and a real API key. */
  merchant(opts?: { mdrBps?: number; label?: string }): Promise<TestMerchant>;
  /** Admin of the given role, logged in through password + OTP. */
  admin(role: AdminRole): Promise<{ id: string; email: string; cookie: string }>;
  /** Authorization header for a merchant's API key. */
  bearer(m: TestMerchant): Record<string, string>;
  /** Authorize a card payment through the real API; returns the transaction id. */
  authorize(m: TestMerchant, amountFils: number): Promise<string>;
  /** Capture through the real API. */
  capture(m: TestMerchant, transactionId: string, amountFils?: number): Promise<{ statusCode: number; body: string }>;
}

export function cookieNamed(setCookie: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (!match) throw new Error(`expected a ${name} Set-Cookie header`);
  return match.split(";")[0] as string;
}

export function createTestHarness(env: Record<string, string> = {}): TestHarness {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("these tests require DATABASE_URL to point at a real, migrated Postgres");

  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    OTP_DEV_EXPOSE: "true",
    INTERNAL_API_TOKEN: "test-internal-token",
    ACQUIRER_FAILURE_RATE: "0",
    ACQUIRER_LATENCY_MIN_MS: "0",
    ACQUIRER_LATENCY_MAX_MS: "1",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    ...env,
  });
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const app = buildApp(config, pool);

  test.after(async () => {
    await app.close();
    await pool.end();
  });

  let cachedHash: string | null = null;

  const harness: TestHarness = {
    app,
    pool,
    config,

    async merchant(opts = {}) {
      const label = opts.label ?? "fixture";
      const m = await pool.query<{ id: string }>(
        `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
        [`${label} ${randomUUID().slice(0, 8)}`, opts.mdrBps ?? 250],
      );
      const merchantId = m.rows[0]!.id;
      const owner = await pool.query<{ id: string }>(
        `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
         VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
        [merchantId, `owner-${randomUUID()}@example.test`],
      );
      const ownerUserId = owner.rows[0]!.id;
      await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
      const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label });
      return { merchantId, ownerUserId, rawKey };
    },

    async admin(role) {
      cachedHash ??= await hashPassword(ADMIN_PASSWORD, config);
      const email = `fixture-${role}-${randomUUID()}@admin.test`;
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, cachedHash, `Fixture ${role}`, role],
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
    },

    bearer(m) {
      return { authorization: `Bearer ${m.rawKey}` };
    },

    async authorize(m, amountFils) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/transactions",
        headers: { ...harness.bearer(m), "idempotency-key": randomUUID() },
        payload: { amountFils, card: VALID_CARD, reference: `fixture-${randomUUID().slice(0, 8)}` },
      });
      assert.equal(res.statusCode, 201, res.body);
      return (res.json() as { id: string }).id;
    },

    async capture(m, transactionId, amountFils) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/transactions/${transactionId}/capture`,
        headers: { ...harness.bearer(m), "idempotency-key": randomUUID() },
        payload: amountFils === undefined ? {} : { amountFils },
      });
      return { statusCode: res.statusCode, body: res.body };
    },
  };
  return harness;
}
