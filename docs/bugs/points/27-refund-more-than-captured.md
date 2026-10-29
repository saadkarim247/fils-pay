# 27 · A refund can return more than was ever captured

**Severity:** Critical (pays out money the merchant never received) · **Area:** `apps/api/src/payments/processRefund.ts`, `db/migrations/0076_transactions_refund_ceiling.sql` · *Part of FP-300*

**What's wrong.** When a payment was only partly captured (for example,
authorize 10 BD and capture 4 BD for a partial shipment), a refund of the
**full 10 BD** is accepted. Six BD that the merchant never received goes
back to the card, out of the merchant's balance.

**Why it's wrong.**
- The refundable amount was computed as `authorized − refunded`; it should
  be `captured − refunded`.
- Nothing in the database stopped it: 0043 deliberately left the ceiling to
  the application.
- After a refund the status stays `partially_captured` (finance's rule), so
  the transaction kept looking refundable.
- YA's comment that the validator "stops the second refund since refunded
  == captured" is false.

**Spread / what it breaks.** Every partially captured payment: hotels,
pre-orders, split shipments. An amount-less refund ("refund the rest")
defaulted to 8.5 BD when only 2.5 BD was left.

**Fix.**
- Refundable is now `captured − refunded`.
- New migration `0076` adds `CHECK (refunded_fils <= captured_fils)` as a
  database backstop. It is `NOT VALID`, so historic rows don't block the
  migration while every new write is checked.

**Tests.** New file `apps/api/src/refunds/refundCeiling.test.ts`, 3 tests
on authorize 10,000 / capture 4,000:
- A 10,000 refund gives 422 `refund_exceeds_refundable`, with refundable
  4,000.
- Exactly 4,000 works, and then nothing more can be refunded.
- After 1,500, an amount-less refund returns the remaining 2,500.

Before the fix all 3 failed (the 10,000 refund succeeded; the default was
8,500). After it, all pass, along with all 45 refund tests. Full suite
(fresh database): no new failures.
