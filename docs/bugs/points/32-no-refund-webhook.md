# 32 · Merchants are never told about refunds

**Severity:** High (FP-300 requirement: "shop gets the right webhook") · **Area:** `apps/api/src/webhooks/envelope.ts`, `dispatcher.ts` · *Part of FP-300*

**What's wrong.** Merchants receive webhooks for captures, voids and
payouts, but never for refunds. Their systems (stock, order status,
accounting) never learn that money went back to a customer.

**Why it's wrong.**
- The refund engine does put a `refund.succeeded` event on the outbox.
- The webhook dispatcher only fans out three event types, and the envelope
  builder throws on any other type.
- A comment in the events package claims "the dispatcher handles it? (yes
  per claude)". It doesn't.
- Simply adding the type to the dispatcher's list would have **thrown
  inside the fan-out transaction**, blocking every merchant's webhooks.

**Spread / what it breaks.** Every refund, for every merchant with a
webhook endpoint.

**Fix.**
- `buildEnvelope` maps `refund.succeeded` to a documented public shape:
  `refundId`, `transactionId`, `merchantId`, `amountFils`,
  `feeReversedFils`, `refundedTotalFils`, and `status` (the same public
  name as `transaction.captured`).
- The event type is added to the dispatcher's eligible list and to the
  `WebhookEventType` union.

**Tests.** New file `apps/api/src/webhooks/refundWebhook.test.ts`. A real
merchant endpoint, capture and partial refund, then a dispatch pass. Exactly
one `refund.succeeded` is delivered with the exact figures (4,000 refunded,
100 fee back, status `partially_refunded`), and capture webhooks still
flow.

Before the fix: no refund webhook. After it, the test passes, along with
the existing envelope and dispatcher tests (except the known flaky backoff
test). The API typecheck caught a missing union member that the tests alone
did not. Full suite (fresh database): no new failures, all typechecks pass.
