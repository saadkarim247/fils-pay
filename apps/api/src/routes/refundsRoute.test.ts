/**
 * FP-300: refunds work end to end through the API.
 *
 * POST /v1/merchants/:merchantId/refunds (what the dashboard drawer and
 * initiateMerchantRefund's contract use) and POST /v1/refunds (what
 * HANDOVER / ONBOARDING document) are the same operation. These tests drive
 * both with real API keys against real captured payments and check the
 * request contract: an Idempotency-Key is required and replays, the body
 * can never choose the merchant, amounts are validated, and the result
 * shows on the transaction's timeline.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";

const h = createTestHarness();

async function captured(m: TestMerchant, amount = 10_000): Promise<string> {
  const tx = await h.authorize(m, amount);
  assert.equal((await h.capture(m, tx)).statusCode, 200);
  return tx;
}

function post(m: TestMerchant, url: string, payload: Record<string, unknown>, key: string | null = randomUUID()) {
  return h.app.inject({
    method: "POST",
    url,
    headers: { ...h.bearer(m), ...(key ? { "idempotency-key": key } : {}) },
    payload,
  });
}

test("a partial refund through POST /v1/merchants/:id/refunds succeeds and shows on the timeline", async () => {
  const m = await h.merchant({ label: "refund-route" });
  const tx = await captured(m);

  const res = await post(m, `/v1/merchants/${m.merchantId}/refunds`, { transactionId: tx, amountFils: 4_000, reason: "damaged" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { amountFils: number; transactionStatus: string; refundedTotalFils: number };
  assert.equal(body.amountFils, 4_000);
  assert.equal(body.transactionStatus, "partially_refunded");

  const detail = await h.app.inject({ method: "GET", url: `/v1/transactions/${tx}`, headers: h.bearer(m) });
  assert.equal(detail.statusCode, 200, detail.body);
  const events = await h.app.inject({ method: "GET", url: `/v1/transactions/${tx}/events`, headers: h.bearer(m) });
  assert.equal(events.statusCode, 200, events.body);
  const list = events.json() as Array<{ eventType: string; amountFils: number | null }>;
  assert.ok(list.some((e) => e.eventType === "refund_partial" && e.amountFils === -4_000), events.body);
});

test("the documented POST /v1/refunds path is the same operation, scoped to the caller", async () => {
  const m = await h.merchant({ label: "refund-route" });
  const tx = await captured(m);
  const res = await post(m, "/v1/refunds", { transactionId: tx });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { amountFils: number }).amountFils, 10_000, "no amount = everything still refundable");
});

test("an Idempotency-Key is required, and replaying it refunds once", async () => {
  const m = await h.merchant({ label: "refund-route" });
  const tx = await captured(m);
  const url = `/v1/merchants/${m.merchantId}/refunds`;

  assert.equal((await post(m, url, { transactionId: tx, amountFils: 1_000 }, null)).statusCode, 400);
  const key = randomUUID();
  const first = await post(m, url, { transactionId: tx, amountFils: 1_000 }, key);
  const again = await post(m, url, { transactionId: tx, amountFils: 1_000 }, key);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(again.json(), first.json());
  const rows = await h.pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [tx]);
  assert.equal(rows.rowCount, 1);
});

test("the body cannot choose the merchant: another merchant's sale is a 404, another path is a 403", async () => {
  const a = await h.merchant({ label: "refund-victim" });
  const b = await h.merchant({ label: "refund-attacker" });
  const victimTx = await captured(a);

  const viaBody = await post(b, `/v1/merchants/${b.merchantId}/refunds`, { transactionId: victimTx, merchantId: a.merchantId });
  assert.equal(viaBody.statusCode, 404, viaBody.body);
  const viaPath = await post(b, `/v1/merchants/${a.merchantId}/refunds`, { transactionId: victimTx });
  assert.equal(viaPath.statusCode, 403, viaPath.body);
  const rows = await h.pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [victimTx]);
  assert.equal(rows.rowCount, 0);
});

test("malformed requests are rejected before anything is refunded", async () => {
  const m = await h.merchant({ label: "refund-route" });
  const tx = await captured(m);
  const url = `/v1/merchants/${m.merchantId}/refunds`;
  for (const payload of [{}, { transactionId: "not-a-uuid" }, { transactionId: tx, amountFils: 0 }, { transactionId: tx, amountFils: -5 },
    { transactionId: tx, amountFils: 1.5 }, { transactionId: tx, amountFils: "100" }, { transactionId: tx, reason: 42 }]) {
    const res = await post(m, url, payload);
    assert.ok(res.statusCode === 400 || res.statusCode === 422 || res.statusCode === 404, `${JSON.stringify(payload)} -> ${res.statusCode}`);
  }
  const rows = await h.pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [tx]);
  assert.equal(rows.rowCount, 0);
});

test("a refund larger than what is left is a 422 with the refundable amount", async () => {
  const m = await h.merchant({ label: "refund-route" });
  const tx = await captured(m, 5_000);
  const res = await post(m, `/v1/merchants/${m.merchantId}/refunds`, { transactionId: tx, amountFils: 6_000 });
  assert.equal(res.statusCode, 422, res.body);
  assert.equal((res.json() as { refundableFils: number }).refundableFils, 5_000);
});
