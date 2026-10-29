# 36 · Merchants can't verify webhook signatures

**Severity:** High (merchants reject genuine webhooks or skip verification; FP-240) · **Area:** `apps/api/src/webhooks/dispatcher.ts`, `testSend.ts`

**What's wrong.** Every webhook carries an HMAC signature so the merchant
can prove it came from FilsPay. When a merchant checks it the standard
way, against the raw request body, it fails.

**Why it's wrong.**
- The signature is computed over `canonicalJson(payload)`, with keys
  sorted, but the body actually sent was `JSON.stringify` of the payload
  read back from Postgres `jsonb`, which stores keys in its own order. The
  bytes signed and the bytes sent differ.
- HANDOVER: "the dispatcher should sign exactly the bytes it sends". YA's
  `ya/sign-raw` commit for this is empty.
- The existing tests parse the body back into an object before verifying,
  which hides the mismatch.

**Spread / what it breaks.**
- Every delivery, and the dashboard's "send test event".
- Merchants either reject genuine webhooks, so payouts and captures go
  unprocessed, or switch verification off, which lets anyone forge a
  webhook to them.
- Evidence: Beta's delivery log, 59 of 220 deliveries rejected "invalid
  signature" on every retry.

**Fix.** Send the exact canonical string that was signed: `body:
canonicalJson(payload)`, in the dispatcher and in test-send. The signing
scheme itself is unchanged.

**Tests.** New file `apps/api/src/webhooks/signRawBody.test.ts`. A real
capture is dispatched to a stub receiver, which recomputes
`HMAC(secret, t + "." + rawBody)` exactly as a merchant would and compares
it with the header.

Before the fix the signatures differed. After it, the test passes along
with all signing, test-send and dispatcher tests (except the known flaky
backoff test). Full suite (fresh database): no new failures.
