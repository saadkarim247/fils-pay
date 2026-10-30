/**
 * Bug 74: a crash in the middle of a checkout (the process dies, so no undo
 * code runs) left sales in limbo forever: links "paid" with the money only
 * authorized (the buyer's card held, nothing captured), links stuck
 * reserved, and authorizations no link points to. The load test's crash run
 * left 13 + 9 such states. Recovery runs at boot and on a timer and undoes
 * any checkout abandoned longer than the reservation timeout, exactly as a
 * failed capture is undone. Anything newer is left alone (may be in flight).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";
import { recoverAbandonedCheckouts } from "./recoverAbandoned.js";

const h = createTestHarness();

async function link(m: TestMerchant): Promise<string> {
  const res = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/payment-links`,
    headers: { ...h.bearer(m), "idempotency-key": randomUUID() },
    payload: { amountFils: 3_000, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}

const linkStatus = async (id: string) =>
  (await h.pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [id])).rows[0]!.status;
const txnStatus = async (id: string) =>
  (await h.pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [id])).rows[0]!.status;

test("abandoned checkouts are undone; recent ones and finished sales are left alone", async () => {
  const m = await h.merchant({ label: "recover-abandoned" });

  // (a) crashed between marking the link paid and capturing.
  const paidLink = await link(m);
  const paidTxn = await h.authorize(m, 3_000);
  await h.pool.query(
    `UPDATE payment_links SET status = 'paid', transaction_id = $2, paid_at = now() - interval '2 minutes' WHERE id = $1`,
    [paidLink, paidTxn],
  );
  // (b) crashed while holding the reservation.
  const reservedLink = await link(m);
  await h.pool.query(
    `UPDATE payment_links SET status = 'reserved', reserved_at = now() - interval '2 minutes', reservation_id = gen_random_uuid() WHERE id = $1`,
    [reservedLink],
  );
  // (c) crashed after authorizing, before the link was committed: an
  //     authorization from the pay flow that no link points to.
  const orphanTxn = await h.authorize(m, 3_000);
  await h.pool.query(`UPDATE transactions SET created_at = now() - interval '2 minutes' WHERE id = $1`, [orphanTxn]);
  await h.pool.query(
    `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, resource_id)
     VALUES ($1, 'transactions.authorize', $2, 'x', $3)`,
    [m.merchantId, `paylink:${randomUUID()}:buyer-key:authorize`, orphanTxn],
  );
  // (d) the same as (a) but only seconds old: may still be in flight.
  const freshLink = await link(m);
  const freshTxn = await h.authorize(m, 3_000);
  await h.pool.query(`UPDATE payment_links SET status = 'paid', transaction_id = $2, paid_at = now() WHERE id = $1`, [freshLink, freshTxn]);
  // (e) a finished sale.
  const soldTxn = await h.authorize(m, 3_000);
  assert.equal((await h.capture(m, soldTxn)).statusCode, 200);

  const result = await recoverAbandonedCheckouts(h.pool, { olderThanSeconds: 60 });

  assert.equal(await linkStatus(paidLink), "active");
  assert.equal(await txnStatus(paidTxn), "voided");
  assert.equal(await linkStatus(reservedLink), "active");
  assert.equal(await txnStatus(orphanTxn), "voided");
  assert.equal(await linkStatus(freshLink), "paid", "a recent checkout may still be in flight");
  assert.equal(await txnStatus(freshTxn), "authorized");
  assert.equal(await txnStatus(soldTxn), "captured");
  assert.ok(result.uncommitted >= 1 && result.released >= 1 && result.orphansVoided >= 1, JSON.stringify(result));

  // Idempotent: a second pass changes nothing of ours.
  await recoverAbandonedCheckouts(h.pool, { olderThanSeconds: 60 });
  assert.deepEqual(
    [await linkStatus(paidLink), await txnStatus(paidTxn), await linkStatus(reservedLink), await txnStatus(orphanTxn), await linkStatus(freshLink)],
    ["active", "voided", "active", "voided", "paid"],
  );
});
