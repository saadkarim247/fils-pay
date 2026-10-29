/**
 * An Idempotency-Key used to capture one transaction must not "replay" onto
 * a different transaction.
 *
 * Keys are scoped (merchant, endpoint, key). The capture request hash only
 * covered the amount, so capturing transaction B with A's key returned A's
 * cached 200 and B was never captured, though the caller was told it was.
 * 0019 says the hash covers the transaction id and a reuse is a 422.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";

const h = createTestHarness();

function capture(m: TestMerchant, transactionId: string, key: string) {
  return h.app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { ...h.bearer(m), "idempotency-key": key },
    payload: {},
  });
}

async function captured(transactionId: string): Promise<number> {
  const r = await h.pool.query<{ c: string }>(`SELECT captured_fils::text AS c FROM transactions WHERE id = $1`, [transactionId]);
  return Number(r.rows[0]!.c);
}

test("reusing a capture key on a different transaction is a 422, not a fake success", async () => {
  const m = await h.merchant({ label: "idem-scope" });
  const a = await h.authorize(m, 6_000);
  const b = await h.authorize(m, 9_000);
  const key = randomUUID();

  assert.equal((await capture(m, a, key)).statusCode, 200);
  const reused = await capture(m, b, key);
  assert.equal(reused.statusCode, 422, reused.body);
  assert.equal(reused.json().error, "idempotency_key_reused");
  assert.equal(await captured(b), 0, "B must not be reported captured when it wasn't");
});

test("the same key on the same transaction still replays the original response, capturing once", async () => {
  const m = await h.merchant({ label: "idem-scope" });
  const a = await h.authorize(m, 6_000);
  const key = randomUUID();
  const first = await capture(m, a, key);
  const again = await capture(m, a, key);
  assert.equal(first.statusCode, 200);
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), first.json());
  assert.equal(await captured(a), 6_000);
});

test("a fresh key captures the second transaction normally", async () => {
  const m = await h.merchant({ label: "idem-scope" });
  const a = await h.authorize(m, 6_000);
  const b = await h.authorize(m, 9_000);
  assert.equal((await capture(m, a, randomUUID())).statusCode, 200);
  assert.equal((await capture(m, b, randomUUID())).statusCode, 200);
  assert.equal(await captured(b), 9_000);
});
