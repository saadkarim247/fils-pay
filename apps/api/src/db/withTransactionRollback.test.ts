/**
 * Bug 66: when ROLLBACK itself failed (e.g. the connection dropped), the
 * caller got the ROLLBACK error instead of the real one, and the dead client
 * went back to the pool with a plain release(), to be handed to the next
 * caller. pg discards a client only when release() is given an error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./withTransaction.js";

function fakePool(failRollback: boolean) {
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql === "ROLLBACK" && failRollback) throw new Error("Connection terminated unexpectedly");
      return { rows: [], rowCount: 0 };
    },
    release: (err?: unknown) => {
      released.push(err);
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, released };
}

test("the caller sees the original error when ROLLBACK also fails, and the client is discarded", async () => {
  const { pool, released } = fakePool(true);
  await assert.rejects(
    withTransaction(pool, async (_c: PoolClient) => {
      throw new Error("insert failed: the real cause");
    }),
    /the real cause/,
  );
  assert.equal(released.length, 1);
  assert.ok(released[0] instanceof Error, "release(err) so pg destroys the broken client");
});

test("a normal rollback still releases the client back to the pool", async () => {
  const { pool, released } = fakePool(false);
  await assert.rejects(withTransaction(pool, async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(released, [undefined]);
});

test("a commit returns the result and releases normally", async () => {
  const { pool, released } = fakePool(false);
  assert.equal(await withTransaction(pool, async () => 42), 42);
  assert.deepEqual(released, [undefined]);
});
