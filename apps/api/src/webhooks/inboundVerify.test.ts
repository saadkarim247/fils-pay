/**
 * Unit tests for the inbound acquirer-callback signature verifier. Pure
 * function, no database — the route-level behavior it drives is covered in
 * routes/acquirerCallbacks.test.ts.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";

const SECRET = "acqsec_test_secret";

/** Builds the header the acquirer would send for a given payload — the same
 *  `t=<seconds>,v1=<hex>` shape webhooks/sign.ts uses outbound. */
// Corrected (bug 12): signs at the current time, since stale timestamps are now rejected.
function acquirerHeader(payload: unknown, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${JSON.stringify(payload)}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("a correctly-signed callback verifies", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(JSON.stringify(payload), acquirerHeader(payload, SECRET), SECRET);
  assert.deepEqual(result, { valid: true });
});

test("a tampered payload is rejected (signature_mismatch)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const header = acquirerHeader(payload, SECRET);
  const result = verifyAcquirerCallbackSignature(JSON.stringify({ callbackId: "acqcb_1", outcome: "confirmed_fraud" }), header, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("the wrong secret is rejected (signature_mismatch)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const header = acquirerHeader(payload, "acqsec_someone_elses_secret");
  const result = verifyAcquirerCallbackSignature(JSON.stringify(payload), header, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("a malformed header is rejected (malformed_header)", () => {
  const payload = { callbackId: "acqcb_1" };
  assert.equal(verifyAcquirerCallbackSignature(JSON.stringify(payload), "not-a-real-header", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(JSON.stringify(payload), "t=abc,v1=deadbeef", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(JSON.stringify(payload), "v1=deadbeef", SECRET).reason, "malformed_header");
});

// Corrected (bug 12): this used to assert an unsigned callback is accepted.
// The signature is the endpoint's only authentication, so it is required.
test("an unsigned callback is rejected", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(JSON.stringify(payload), undefined, SECRET);
  assert.deepEqual(result, { valid: false, reason: "missing_signature" });
});
