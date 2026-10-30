#!/usr/bin/env -S npx tsx
/**
 * Gives the seed's fixture accounts this deployment's passwords
 * (SEED_USER_PASSWORD / SEED_ADMIN_PASSWORD) without re-seeding, which would
 * truncate the fixture tables. For a database seeded while the passwords
 * were the public constants in generate.ts (bug 76).
 *
 * Usage: DATABASE_URL=... SEED_USER_PASSWORD=... SEED_ADMIN_PASSWORD=... npm run seed:reset-passwords
 */
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { hashPassword } from "../../apps/api/src/auth/passwords.js";
import { loadConfig, type Config } from "../../apps/api/src/config.js";
import { MERCHANT_FIXTURES } from "./fixtures/merchants.js";
import { ADMIN_USER_FIXTURES } from "./generate.js";

export async function resetSeedPasswords(
  pool: Pool,
  env: NodeJS.ProcessEnv,
  config: Pick<Config, "argon2MemoryKib" | "argon2TimeCost" | "argon2Parallelism">,
): Promise<{ merchantUsers: number; adminUsers: number }> {
  // Both must be set: falling back to the public constants would "reset"
  // the accounts to the passwords this exists to replace.
  for (const name of ["SEED_USER_PASSWORD", "SEED_ADMIN_PASSWORD"] as const) {
    if (!env[name]) throw new Error(`resetSeedPasswords: ${name} must be set`);
  }
  const userEmails = [...new Set(MERCHANT_FIXTURES.flatMap((m) => m.users.map((u) => u.email)))];
  const adminEmails = ADMIN_USER_FIXTURES.map((a) => a.email);

  const users = await pool.query(`UPDATE merchant_users SET password_hash = $2 WHERE email = ANY($1)`, [
    userEmails,
    await hashPassword(env.SEED_USER_PASSWORD!, config as Config),
  ]);
  const admins = await pool.query(`UPDATE admin_users SET password_hash = $2 WHERE email = ANY($1)`, [
    adminEmails,
    await hashPassword(env.SEED_ADMIN_PASSWORD!, config as Config),
  ]);
  return { merchantUsers: users.rowCount ?? 0, adminUsers: admins.rowCount ?? 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  resetSeedPasswords(pool, process.env, loadConfig(process.env))
    .then((r) => console.log(`reset ${r.merchantUsers} merchant users and ${r.adminUsers} admin users`))
    .finally(() => pool.end());
}
