# 22 · Reusing a capture key "succeeds" without capturing the payment

**Severity:** High (merchant told a payment is captured when it isn't) · **Area:** `apps/api/src/payments/capture.ts`

**What's wrong.** Merchants send an `Idempotency-Key` with each capture, so
a retried request doesn't capture twice. If the same key is sent for a
**different** transaction (a common integration bug, such as using the
order id as the key across split shipments), the API replays the first
transaction's 200 response. The second transaction is never captured, but
the merchant is told it was.

**Why it's wrong.**
- Keys are scoped by (merchant, endpoint, key). The request fingerprint
  that detects a reused key covered only the amount, not the transaction
  id.
- Migration 0019's own comment states the intended rule: "request_hash
  covers the transaction id… reusing a key on a different transaction is a
  422."

**Spread / what it breaks.**
- Uncaptured authorizations expire, so the merchant ships goods they are
  never paid for.
- The reply belongs to another transaction, so the merchant's books record
  the wrong payment as captured.

**Fix (one line).** Include `transactionId` in the capture request hash. A
reuse on another transaction is now a 422 `idempotency_key_reused`. A true
retry (same key, same transaction) still replays.

**Tests.** New file `apps/api/src/payments/captureIdempotencyScope.test.ts`,
3 tests through the real API:
- Key reused on transaction B gives 422, and B stays uncaptured.
- The same key on the same transaction replays the identical response and
  captures once.
- A fresh key captures B normally.

Before the fix, B's "capture" returned 200 with A's body. After it, all
pass, along with the existing capture and transaction tests. Full suite
(fresh database): no new failures.

**Deploy note.** A key in flight from before the deploy, retried after it,
fingerprints differently and gets a 422 instead of a replay. Rare, and
safe: nothing is charged twice.
