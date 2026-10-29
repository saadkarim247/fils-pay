# 16 · "Recalculate MDR" rewrites batches that were already paid

**Severity:** High (falsifies payout history; reconciliation breaks) · **Area:** `apps/settlement/internal/settlement/recalculate_mdr.go`

**What's wrong.** When a merchant's fee rate (MDR) changes, finance runs
"Recalculate MDR" over a date range. The tool also rewrites the fee and net
payout of batches that were **already paid out**. Those records then show
an amount that was never actually sent.

**Why it's wrong.**
- The scan selects `status <> 'open'`, which takes both `closed` and `paid`
  batches. It then runs `UPDATE settlement_batches SET fee_fils, net_payout_fils`
  on every one of them.
- The tool's own result type promises the opposite: "the original batch's
  figures stay as they were paid".
- A test comment calls it intended (MK: "history gets rewritten… that's
  intended"). But a paid batch is a statement of money already moved;
  rewriting it breaks reconciliation against the bank.

**Spread / what it breaks.**
- After a rate change, every paid batch in the range disagrees with its
  real payout.
- The rewrite also posts adjustment ledger legs against the paid batch, and
  those are never collected in any later payout.
- Evidence: Delta Marketplace, 11 Sep. One run rewrote 9 paid batches by
  −41.870 BD.

**Fix (one condition).** Recalculate only `status = 'closed'` batches:
closed, not yet paid. Their new net is what will be paid, which is the
tool's legitimate job. Paid batches are left exactly as paid. Correcting a
paid period needs a carry-forward into the next batch, which this tool
never had; that is noted as a follow-up.

**Tests.** New file `internal/settlement/recalculate_mdr_paid_test.go`. It
closes and pays one day, closes another day without paying, raises the
rate, then recalculates both:
- The paid batch's status, fee, net and adjustment legs are unchanged, and
  it is not reported as adjusted.
- The unpaid batch moves to the new fee and net, with its two adjustment
  legs.

Before the fix the paid batch went from net 39,000 to 38,800. After it, the
test passes along with the 4 existing MDR tests. Full suite (fresh
database): no new failures.
