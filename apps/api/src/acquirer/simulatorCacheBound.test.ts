/**
 * Bug 79: the acquirer simulator's idempotency caches kept every result for
 * the life of the process (a code comment asked "slow leak?"), so the API's
 * memory grew with every checkout until a restart. Each cache now keeps the
 * most recent entries only: a retry, which comes seconds later, still
 * replays; a long-gone key no longer occupies memory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAcquirerSimulator } from "./simulator.js";

const config = { acquirerLatencyMinMs: 0, acquirerLatencyMaxMs: 0, acquirerFailureRate: 0, acquirerRngSeed: 7 };
const card = { pan: "4111111111111111", expiryMonth: 12, expiryYear: 2030, cvc: "123" };

test("authorize keeps only the most recent results", async () => {
  const sim = createAcquirerSimulator(config, { idempotencyCacheMax: 3 });
  const auth = (key: string) => sim.authorize({ idempotencyKey: key, amountFils: 1000, card } as never);

  const first = await auth("k1");
  for (const k of ["k2", "k3", "k4", "k5"]) await auth(k);

  const recent = await auth("k5");
  assert.equal(recent.acquirerReference, (await auth("k5")).acquirerReference, "a recent key still replays");
  assert.notEqual((await auth("k1")).acquirerReference, first.acquirerReference, "the oldest key was evicted");
});
