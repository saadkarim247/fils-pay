#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released stays 'active'
 * past its expires_at forever (authorize.ts inserts one, capture.ts/void.ts
 * release one; nothing else sweeps one). This flips those to 'expired' with
 * one UPDATE. Holds are never deleted (HANDOVER). Run once a night from
 * cron/the host's own scheduler.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

/**
 * Marks holds that outlived their window without being captured or released
 * as 'expired', in one atomic statement (no read-then-write race with a
 * concurrent capture). Returns how many it flipped; a quiet night is 0.
 */
export async function expireHolds(client: Client): Promise<number> {
  const result = await client.query(
    `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`,
  );
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expired = await expireHolds(client);
    console.log(`expire_holds: marked ${expired} abandoned hold(s) expired`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
