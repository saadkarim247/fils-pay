# 12 · Anyone can post fake fraud verdicts to the acquirer callback

**Severity:** High · **Area:** `apps/api/src/webhooks/inboundVerify.ts`, `apps/api/src/routes/acquirerCallbacks.ts`

**What's wrong.** The public acquirer endpoint records the acquirer's fraud
verdict (`cleared` / `confirmed_fraud`) on a payment's timeline. Support
and finance act on that verdict when deciding to void or refund. Anyone on
the internet can post one.

**Why it's wrong.** The route itself says the signature is "the only
authentication this endpoint has", yet:
1. **It fails open.** A request with no signature header is accepted
   unless `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true`, and the default is
   false. With no secret configured, the empty-key HMAC is accepted too.
2. **It can be replayed.** The timestamp is parsed but never checked, so
   one captured request can be resent forever.
3. **It checks the wrong bytes.** The HMAC is computed over
   `JSON.stringify(parsed body)` instead of the raw body. A real acquirer's
   formatting (key order, spaces) fails, so turning the requirement on would
   have broken genuine callbacks. That is probably why it was left off.
4. **`outcome` is never validated,** although the code says it is. Any
   string is stored as a verdict.
5. The compare uses `Buffer.compare`, which is not constant-time.

**Spread / what it breaks.** Anyone can mark any merchant's good sales as
"confirmed fraud", nudging staff into voiding or refunding them, or mark
real fraud as "cleared". A merchant id is all it takes. (The signing secret
also sits committed in `ops/.env.docker`; that is fixed with the hosting
work.)

**Fix.** Verification now always requires a configured secret and a
signature. It rejects timestamps more than 5 minutes off, hashes the exact
raw body (captured by a JSON parser scoped to this route only), and
compares with `timingSafeEqual`. The route rejects any `outcome` other than
`cleared` or `confirmed_fraud`. The `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE`
flag is now ignored.

**Tests.** New file `apps/api/src/routes/acquirerCallbackAuth.test.ts`,
6 tests:
- Unsigned → 401, with nothing recorded.
- 10 minutes old → 401.
- The acquirer's own formatting → 200.
- Fresh and signed → 200.
- A bogus outcome → 400.
- No secret configured → 401, even "signed" with an empty key.

Before the fix 5 of 6 failed. After it, all pass.

**Existing tests corrected.** In `inboundVerify.test.ts` and
`acquirerCallbacks.test.ts`:
- Both signing helpers now sign at the current time instead of a fixed 2025
  timestamp.
- The unit tests pass the JSON string rather than an object.
- The two "unsigned callback is accepted" tests now expect rejection.

All 20 callback tests pass. Full suite (fresh database): no new failures.
