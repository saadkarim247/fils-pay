# 26 · A merchant can refund another merchant's sale

**Severity:** Critical (moves another merchant's money) · **Area:** `apps/api/src/refunds/initiateMerchantRefund.ts`, `apps/api/src/payments/processRefund.ts` · *Part of FP-300*

**What's wrong.** Merchant B can refund merchant A's transaction. A's
customer gets the money back, and A's balance is debited.

**Why it's wrong.**
- The refund entry point looked the transaction up by id alone, then
  called the refund engine with **the transaction's own merchant**. So the
  caller's identity was never compared with the owner.
- The engine also matched by id alone.
- The per-merchant refund hold (`refunds_enabled`) was checked against the
  caller, so B could also refund through A's compliance hold.
- AM's TODO in the test file says "another merchant's … transactionId
  should also 404. currently refunds it". The guarding test was deleted as
  "redundant".

**Spread / what it breaks.**
- Anyone with a merchant account can drain another merchant's balance
  through refunds, given a transaction id. Transaction ids appear in
  receipts, webhooks and links.
- A merchant on a refund hold isn't actually held.

**Fix.** Both lookups now match `id AND merchant_id = <authenticated
merchant>`. Someone else's transaction is "not found" (404), the same as a
non-existent one. That also makes the hold check apply to the owner.

**Tests.** New file `apps/api/src/refunds/refundScope.test.ts`, 4 tests:
- B refunding A's sale gets 404, with no refund row, no ledger legs and
  `refunded_fils` still 0.
- A is on hold, B tries: refused, nothing moves.
- `processRefund` called directly with the wrong merchant gives 404.
- The owner can still refund.

Before the fix the first 3 failed (B's refund succeeded). After it, all
pass, along with the 23 other refund tests. Full suite (fresh database): no
new failures.
