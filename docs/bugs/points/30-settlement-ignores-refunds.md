# 30 · Settlement pays merchants for money already refunded

**Severity:** Critical (the platform pays out refunded money) · **Area:** `apps/settlement/internal/settlement/batch.go`, `recalculate_mdr.go` · *Part of FP-300*

**What's wrong.** When a sale is refunded, the money goes back to the
buyer's card. The merchant's next payout should be reduced by that refund,
but the daily settlement batch ignores refunds entirely. The merchant is
paid for the sale as if it were never refunded.

**Why it's wrong.**
- `CloseBatch` adds up only capture events: net = captures − fees.
- Refunds live in their own table with a `settlement_batch_id` that 0042
  says "a later settlement pass claims". No pass ever claimed it, so it
  stayed NULL forever.
- The refund itself debits the merchant's payable in the ledger, so every
  payout drives the books further negative.

**Spread / what it breaks.**
- Every refund is effectively paid twice: once back to the buyer, then
  again to the merchant.
- Payouts, the ledger and reconciliation all disagree.

**Fix.**
- **Refunds come out of the payout.** `CloseBatch` now claims the
  merchant's unbatched refunds up to the end of the day, oldest first. Each
  reduces the payout by its net: the refund minus the fee given back.
- **Each refund is netted once.** It is marked with the batch it was
  deducted from, so it can never be deducted twice.
- **Refunds that don't fit roll forward.** A refund bigger than what is
  left of the day's payout stays unbatched and comes out of the next day's.
  A payout is never negative.
- **MDR recalculation keeps the deduction.** It now recomputes an unpaid
  batch's net as gross − new fee − the refunds netted into it.

**Tests.** New file `internal/settlement/batch_refunds_test.go`, 4 tests:
- A same-day refund of 4,000 (100 fee back) against 10,000 at 250 bps
  gives net 5,850. The refund is marked to the batch, and a re-run changes
  nothing.
- A refund after a day closed comes out of the next day's payout.
- A refund larger than the day's net waits (day 1 pays 975), then nets
  into day 2.
- MDR recalculation keeps the netted refunds.

Before the fix all 4 failed (refunds ignored). After it, all pass with
every existing Go test. Full suite (fresh database): no new failures.
