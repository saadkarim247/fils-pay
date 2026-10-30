import type { Pool, PoolClient } from "pg";

/**
 * Checks out a client from `pool`, runs `fn` inside a `BEGIN`/`COMMIT`
 * transaction, and rolls back on any error — always releasing the client
 * back to the pool. This is the standard way to perform a multi-statement
 * atomic write (e.g. signup, KYC review recording) anywhere in this
 * codebase; a bare pool query is only for single-statement reads/writes
 * that don't need atomicity with anything else.
 */
// FH 2026-07-28: noticed fn can call pool.query instead of client.query by mistake and it silently
// runs outside the transaction. grep found none today
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  /*
   * Isolation level is the Postgres default (READ COMMITTED). Callers that
   * need to serialise on a row take an explicit SELECT ... FOR UPDATE inside
   * fn; nothing here upgrades the level.
   */
  const client = await pool.connect();
  // Set when ROLLBACK fails: the connection is broken, so release(err) makes
  // pg discard it instead of handing it to the next caller (bug 66).
  let brokenClientError: Error | undefined;
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        brokenClientError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err; // always the original error, never the ROLLBACK failure
    }
  } finally {
    client.release(brokenClientError);
  }
}
