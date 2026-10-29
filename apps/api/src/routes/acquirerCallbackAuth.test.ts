/**
 * The acquirer callback endpoint is public, and its signature is the only
 * thing that authenticates the caller. A callback writes the acquirer's
 * fraud verdict onto a payment's timeline, which support and finance act on
 * (void / refund). So the endpoint must:
 *   - reject a callback with no signature,
 *   - reject a stale timestamp (a replay),
 *   - verify the signature over the exact bytes the acquirer sent,
 *   - reject an outcome that isn't one of the two real verdicts,
 *   - refuse everything when no signing secret is configured.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";

const SECRET = "acqsec_auth_test_secret";
const h = createTestHarness({ ACQUIRER_CALLBACK_SIGNING_SECRET: SECRET });
/** Same app, but nobody configured a signing secret (the dev default). */
const noSecret = createTestHarness({ ACQUIRER_CALLBACK_SIGNING_SECRET: "" });

async function transactionId(): Promise<string> {
  const m = await h.merchant({ label: "callback" });
  return h.authorize(m, 9_000);
}

function body(txId: string, overrides: Record<string, unknown> = {}) {
  return {
    callbackId: `acqcb_${randomUUID()}`,
    type: "fraud_review.completed",
    transactionId: txId,
    occurredAt: "2026-10-29T10:00:00.000Z",
    outcome: "confirmed_fraud",
    note: "card testing pattern",
    ...overrides,
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function sign(raw: string, timestamp = nowSeconds(), secret = SECRET): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
}

async function post(raw: string, signature: string | undefined, app = h.app) {
  return app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "acquirer-callback-signature": signature } : {}),
    },
    payload: raw,
  });
}

async function notesFor(callbackId: string): Promise<number> {
  const r = await h.pool.query(`SELECT 1 FROM acquirer_callback_notes WHERE callback_id = $1`, [callbackId]);
  return r.rowCount ?? 0;
}

test("a callback with no signature is rejected and records nothing", async () => {
  const b = body(await transactionId());
  const res = await post(JSON.stringify(b), undefined);
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(await notesFor(b.callbackId), 0);
});

test("a correctly signed but 10-minute-old callback (a replay) is rejected", async () => {
  const b = body(await transactionId());
  const raw = JSON.stringify(b);
  const res = await post(raw, sign(raw, nowSeconds() - 600));
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(await notesFor(b.callbackId), 0);
});

test("the signature is checked over the exact bytes sent (acquirer's own formatting)", async () => {
  const b = body(await transactionId());
  // The acquirer's JSON: different key order and whitespace from JSON.stringify.
  const raw = `{ "type": "fraud_review.completed", "callbackId": "${b.callbackId}", "transactionId": "${b.transactionId}",
    "occurredAt": "${b.occurredAt}", "outcome": "cleared", "note": "reviewed, looks fine" }`;
  const res = await post(raw, sign(raw));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await notesFor(b.callbackId), 1);
});

test("a fresh, correctly signed callback is accepted and recorded", async () => {
  const b = body(await transactionId());
  const raw = JSON.stringify(b);
  const res = await post(raw, sign(raw));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await notesFor(b.callbackId), 1);
});

test("a signed callback with an outcome that isn't a real verdict is a 400", async () => {
  const b = body(await transactionId(), { outcome: "approved_by_attacker" });
  const raw = JSON.stringify(b);
  const res = await post(raw, sign(raw));
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(await notesFor(b.callbackId), 0);
});

test("with no signing secret configured, nothing is accepted (not even 'signed' with an empty key)", async () => {
  const b = body(await transactionId());
  const raw = JSON.stringify(b);
  assert.equal((await post(raw, undefined, noSecret.app)).statusCode, 401);
  assert.equal((await post(raw, sign(raw, nowSeconds(), ""), noSecret.app)).statusCode, 401);
  assert.equal(await notesFor(b.callbackId), 0);
});
