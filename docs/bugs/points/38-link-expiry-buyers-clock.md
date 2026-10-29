# 38 · Anyone can pay an expired payment link by lying about the time

**Severity:** High (FP-187) · **Area:** `apps/api/src/routes/paymentLinks.ts`, `apps/api/src/paymentLinks/pay.ts`

**What's wrong.** A merchant sets an expiry on a payment link, for example
for a time-limited price or a deposit deadline. Any buyer can still pay it
after it expires, by sending an old `submittedAt` time with the payment.

**Why it's wrong.**
- The public pay endpoint took `submittedAt` from the request body and used
  it as "now" for the expiry check, so `"2000-01-01"` never expires.
- The route's own contract says `submittedAt` is "ignored unless the
  request is authenticated with an API key".
- ARCHITECTURE allows it only for offline terminals, which authenticate as
  the merchant.
- The dashboard's checkout page even sends the browser clock with every
  payment.

**Spread / what it breaks.** Every link with an expiry. Merchants are paid
for offers they withdrew, or at stale prices, and expiry stops being a
control.

**Fix.**
- **The route** only passes `submittedAt` when the request carries a valid
  API key.
- **The pay step** uses that client time only if the key belongs to the
  link's own merchant, in the atomic claim and in the error message alike.
- **Everyone else** (public buyers, other merchants' keys) is judged by the
  server clock.

**Tests.** New file `apps/api/src/paymentLinks/linkExpiryClock.test.ts`. A
link expired 10 minutes ago:
- a public buyer claiming year 2000 gets 410, and the link stays active;
- a public buyer claiming 30 minutes ago gets 410;
- the owning merchant's terminal key with 30 minutes ago gets 200 (the
  ARCHITECTURE exception);
- another merchant's key gets 410.

Before the fix all three outsider cases paid the expired link. After it,
all pass, as do all 32 payment-link tests. Full suite (fresh database): no
new failures.
