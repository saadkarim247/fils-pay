# 31 · The reconciliation report can't explain any period with refunds

**Severity:** High · **Area:** `apps/api/src/settlement/query.ts` · *Part of FP-300*

**What's wrong.** Merchants and finance use the reconciliation report to
check that the books, the settled payouts and what's still pending agree,
shown as gap = 0. Any period containing a refund that hasn't been settled
yet shows an unexplained gap.

**Why it's wrong.** The report computes gap = ledger net − settled net −
pending. A refund immediately lowers the ledger figure, but "pending"
counted only unsettled **captures**, never unsettled refunds. The function's
own doc comment promises the opposite: "Refund legs are included both in
the ledger figure and in pending, so a period with refunds still explains
to zero."

**Spread / what it breaks.** Every merchant who refunds shows a false
discrepancy, equal to the refund minus the fee given back, until the
refund is settled. That undermines the one report meant to build trust in
the payouts.

**Fix.** Pending now also subtracts the merchant's succeeded refunds in the
window that aren't netted into a batch yet, each net of its fee reversal,
matching how settlement deducts them (bug 30).

**Tests.** New file `apps/api/src/settlement/reconciliationRefunds.test.ts`,
2 tests:
- A sale of 10,000 (fee 250) with an unsettled 4,000 refund (fee back
  100): ledger 5,850, pending 5,850, gap 0.
- A period holding only a refund of an earlier, settled sale: ledger
  −1,950, pending −1,950, explained.

Before the fix pending was 9,750 and 0, so neither period explained. After
it both pass, along with the existing settlement tests. Full suite (fresh
database): no new failures.

**Related, still open.** The pending *fee* estimate uses a float, half-up
rounding, and `merchants.mdr_bps` rather than the effective fee schedule.
That is a separate bug in the list, so these tests use amounts where the
estimate is exact.
