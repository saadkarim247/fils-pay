/**
 * An acquirer callback that is delivered more than once records ONE note
 * (FP-201). Acquirers redeliver callbacks; HANDOVER says redeliveries are
 * dropped via a processed_events table, which does not exist, and
 * acquirer_callback_notes.callback_id had no unique index. Each redelivery
 * added another fraud verdict to the payment's timeline.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";

const SECRET = "acqsec_dedup_test_secret";
const h = createTestHarness({ ACQUIRER_CALLBACK_SIGNING_SECRET: SECRET });

function signedPost(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  return h.app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "content-type": "application/json", "acquirer-callback-signature": `t=${t},v1=${v1}` },
    payload: raw,
  });
}

async function setup() {
  const m = await h.merchant({ label: "callback-dedup" });
  const tx = await h.authorize(m, 4_000);
  const body = {
    callbackId: `acqcb_${randomUUID()}`,
    type: "fraud_review.completed",
    transactionId: tx,
    occurredAt: "2026-10-29T10:00:00.000Z",
    outcome: "cleared",
    note: "reviewed",
  };
  return body;
}

async function notes(callbackId: string): Promise<number> {
  return (await h.pool.query(`SELECT 1 FROM acquirer_callback_notes WHERE callback_id = $1`, [callbackId])).rowCount ?? 0;
}

test("a redelivered callback is acknowledged but recorded only once", async () => {
  const body = await setup();
  assert.equal((await signedPost(body)).statusCode, 200);
  assert.equal((await signedPost(body)).statusCode, 200, "the acquirer must get a 2xx so it stops retrying");
  assert.equal(await notes(body.callbackId), 1);
});

test("two simultaneous deliveries of one callback record one note", async () => {
  const body = await setup();
  const results = await Promise.all([signedPost(body), signedPost(body), signedPost(body)]);
  assert.ok(results.every((r) => r.statusCode === 200), results.map((r) => r.statusCode).join(","));
  assert.equal(await notes(body.callbackId), 1);
});
