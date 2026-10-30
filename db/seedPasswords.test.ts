/**
 * Bug 76: the seed's fixture passwords are constants in this public repo,
 * and the hosted demo returns the OTP in the login response
 * (OTP_DEV_EXPOSE=true), so anyone who read the repo could sign in to the
 * live admin console as super_admin. A deployment now supplies its own
 * passwords (ops/init-env.sh generates them), and existing fixture accounts
 * can be reset to them without re-seeding.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import { hashPassword, verifyPassword } from "../apps/api/src/auth/passwords.js";
import type { Config } from "../apps/api/src/config.js";
import { SEED_ADMIN_PASSWORD, SEED_USER_PASSWORD, seedPasswords } from "./seed/generate.js";
import { resetSeedPasswords } from "./seed/resetPasswords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("seedPasswords.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
after(() => pool.end());
// Only the hashing cost parameters are needed (the API defaults).
const argon2 = { argon2MemoryKib: 19_456, argon2TimeCost: 2, argon2Parallelism: 1 } as Config;

test("seed passwords come from the environment when set", () => {
  assert.deepEqual(seedPasswords({ SEED_USER_PASSWORD: "u-from-env", SEED_ADMIN_PASSWORD: "a-from-env" }), {
    user: "u-from-env",
    admin: "a-from-env",
  });
});

test("without the environment, the documented laptop defaults are used", () => {
  assert.deepEqual(seedPasswords({}), { user: SEED_USER_PASSWORD, admin: SEED_ADMIN_PASSWORD });
});

test("resetting refuses to run without both passwords set", async () => {
  await assert.rejects(resetSeedPasswords(pool, { SEED_ADMIN_PASSWORD: "only-one" }, argon2), /SEED_USER_PASSWORD/);
});

test("reset gives an existing fixture admin the deployment's password; others are untouched", async () => {
  const oldHash = await hashPassword(SEED_ADMIN_PASSWORD, argon2);
  const fixture = "superadmin@filspay.test";
  const other = `not-a-fixture-${Date.now()}@example.test`;
  await pool.query(`DELETE FROM admin_users WHERE email = $1`, [fixture]);
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $3, 'Fixture', 'super_admin'), ($2, $3, 'Other', 'support')`,
    [fixture, other, oldHash],
  );
  try {
    const result = await resetSeedPasswords(
      pool,
      { SEED_USER_PASSWORD: "new-user-pass-123", SEED_ADMIN_PASSWORD: "new-admin-pass-456" },
      argon2,
    );
    assert.equal(result.adminUsers, 1);

    const rows = await pool.query<{ email: string; password_hash: string }>(
      `SELECT email, password_hash FROM admin_users WHERE email = ANY($1)`,
      [[fixture, other]],
    );
    const hashOf = (email: string) => rows.rows.find((r) => r.email === email)!.password_hash;
    assert.equal(await verifyPassword(hashOf(fixture), "new-admin-pass-456"), true);
    assert.equal(await verifyPassword(hashOf(fixture), SEED_ADMIN_PASSWORD), false, "the public password no longer works");
    assert.equal(hashOf(other), oldHash, "a non-fixture account is not touched");
  } finally {
    await pool.query(`DELETE FROM admin_users WHERE email = ANY($1)`, [[fixture, other]]);
  }
});
