# 21 · Payment-link sales are charged without the merchant's negotiated discount

**Severity:** High (merchants overcharged on every link sale) · **Area:** `apps/api/src/paymentLinks/pay.ts`

**What's wrong.** Merchants with a negotiated discount on their processing
fee get it on API captures, but **not** when a buyer pays one of their
payment links. Link sales are charged the full fee.

**Why it's wrong.**
- The discount is applied after capture by `applyCaptureDiscountAdjustment`,
  and only the API capture route calls it.
- The payment-link flow captures through the same `captureTransaction` but
  never calls it.
- `pay.ts` carries the false claim that settled the question: "it's applied
  for both now (moved into capture.ts in July)". It wasn't moved.

**Spread / what it breaks.**
- Every link payment by a merchant with a discount. That's the whole point
  of payment links: invoices, social sales.
- Example: 250 bps fee with a 20% discount. A 10 BD link sale is charged
  0.250 BD instead of 0.200 BD.
- The merchant's statement also disagrees with their pricing agreement.

**Fix (one call).** After a successful link capture, call
`applyCaptureDiscountAdjustment`, the same idempotent step the API route
uses. A dead cents-based parser in the same module,
`parsePromotionalDiscountFils` (`parseFloat × 100`, no callers), is
removed.

**Tests.** New file `apps/api/src/paymentLinks/linkDiscount.test.ts`, 2
tests:
- A merchant with a 20% discount: an API capture and a real link payment
  (through the public pay endpoint) of 10,000 fils must both net 200 fils
  of fee.
- A merchant with no discount: the link nets the plain 250.

Before the fix the link netted 250 against the API's 200. After it, both
pass, along with all payment-link and discount tests. Full suite (fresh
database): no new failures.
