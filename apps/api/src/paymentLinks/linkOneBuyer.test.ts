/**
 * A payment link takes exactly one payment (incident 2026-05-14: two
 * customers charged on one link).
 *
 * A pay request reserves the link, authorizes, captures, then finalizes. If
 * one buyer's request outlives the reservation timeout, a second buyer
 * re-claims the "stale" reservation; both then captured, and the loser's
 * finalize matched 0 rows yet still answered 200 "paid". These tests force
 * that overlap (reservation timeout 0 s, 150-250 ms acquirer latency, two
 * concurrent buyers) and check that only one card is ever captured.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness, VALID_CARD, type TestMerchant } from "../testSupport/fixtures.js";

const h = createTestHarness({
  PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: "0",
  ACQUIRER_LATENCY_MIN_MS: "150",
  ACQUIRER_LATENCY_MAX_MS: "250",
});

const DECLINED_CARD = { ...VALID_CARD, pan: "4000000000000002" };

async function link(m: TestMerchant, amountFils = 5_000): Promise<{ id: string; token: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/payment-links`,
    headers: h.bearer(m),
    payload: { amountFils, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; token: string };
}

function pay(token: string, card = VALID_CARD) {
  return h.app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card },
  });
}

async function capturedTransactions(merchantId: string): Promise<string[]> {
  const r = await h.pool.query<{ id: string }>(
    `SELECT id FROM transactions WHERE merchant_id = $1 AND captured_fils > 0`,
    [merchantId],
  );
  return r.rows.map((row) => row.id);
}

test("two buyers paying one link at the same moment: exactly one card is captured", async () => {
  const m = await h.merchant({ label: "one-buyer" });
  const l = await link(m);

  const results = await Promise.all([pay(l.token), pay(l.token)]);
  const codes = results.map((r) => r.statusCode).sort();
  const captured = await capturedTransactions(m.merchantId);

  assert.equal(captured.length, 1, `one link, one capture (got ${captured.length}); responses ${codes}`);
  assert.deepEqual(codes, [200, 409], "the losing buyer is told the link is no longer available");

  const linkRow = await h.pool.query<{ status: string; transaction_id: string }>(
    `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
    [l.id],
  );
  assert.equal(linkRow.rows[0]!.status, "paid");
  assert.equal(linkRow.rows[0]!.transaction_id, captured[0]);
});

test("the losing buyer's authorization is voided, so no hold stays on their card", async () => {
  const m = await h.merchant({ label: "one-buyer" });
  const l = await link(m);
  await Promise.all([pay(l.token), pay(l.token)]);

  const r = await h.pool.query<{ status: string }>(
    `SELECT status FROM transactions WHERE merchant_id = $1 AND captured_fils = 0`,
    [m.merchantId],
  );
  for (const row of r.rows) assert.equal(row.status, "voided");
  const holds = await h.pool.query(`SELECT 1 FROM holds WHERE merchant_id = $1 AND status = 'active'`, [m.merchantId]);
  assert.equal(holds.rowCount, 0, "no active hold may remain on the loser's card");
});

test("a buyer arriving after the link is paid gets a 409 and is not charged", async () => {
  const m = await h.merchant({ label: "one-buyer" });
  const l = await link(m);
  assert.equal((await pay(l.token)).statusCode, 200);
  assert.equal((await pay(l.token)).statusCode, 409);
  assert.equal((await capturedTransactions(m.merchantId)).length, 1);
});

test("a declined card leaves the link payable for the next buyer", async () => {
  const m = await h.merchant({ label: "one-buyer" });
  const l = await link(m);
  assert.notEqual((await pay(l.token, DECLINED_CARD)).statusCode, 200);
  assert.equal((await pay(l.token)).statusCode, 200);
  assert.equal((await capturedTransactions(m.merchantId)).length, 1);
});
