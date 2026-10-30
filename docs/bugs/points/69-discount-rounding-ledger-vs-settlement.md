# 69 · Discounted merchants: ledger and settlement disagree by a fil per payment

**Severity:** Medium (reconciliation gaps that never close, for every discounted merchant) · **Area:** `apps/api/src/payments/discountAdjustment.ts`, `settlement/query.ts`, `payments/capture.ts`

**What's wrong.** Merchants with a negotiated discount have their fee
computed twice, and the two calculations round differently.
- **The ledger (TS)** charges MDR on the full amount, then rebates the
  discount share of that fee.
- **Settlement (Go)** takes the discount off the amount first, then
  charges MDR.

For 602 fils at 275 bps with a 12.5% discount, the ledger keeps **15** fils
of fee and the batch charges **14**. The merchant's ledger balance and
their payout differ by a fil on that payment, every time.

**Why it's wrong.**
- **ARCHITECTURE is explicit:** "Discounts reduce the amount the MDR is
  charged on." That is Go's formula.
- **The TS comment's source doesn't exist.** It cited a "partner-pricing
  addendum" saying the opposite; there is no such document in the repo.
- **Equal on paper, not in practice.** Both formulas equal
  amount × MDR × (1 − discount) in exact arithmetic, but rounding to whole
  fils at different steps gives different answers. Over thousands of
  captures it adds up to unexplained reconciliation gaps.

**Spread / what it breaks.** Every capture (direct or via payment link) for
a merchant with `negotiated_discount_bps > 0`. It also skews reconciliation
and the fee given back on refunds, which reads the fee kept from the ledger.

**Fix.**
- **New `discountedFeeFils`** (`apps/api/src/fees/`) mirrors Go's
  `ComputeSettlementFee` step for step. `packages/money` is not touched.
- **Capture records the rate it applied** (`metadata.mdrBps`).
- **The adjustment rebates exactly** `fee charged − MDR(amount − discount)`,
  so the ledger keeps the batch's fee to the fil.
- **Reconciliation's pending estimate** uses the same rule.
- **Old events keep the old rule:** captures recorded before this change
  don't have `mdrBps`.

**Tests.**
- `apps/api/src/payments/discountRounding.test.ts`: a real 602-fil capture
  keeps 14 fils of fee and reconciliation shows no gap.
- **A shared parity table of 8 cases** (zero discount, zero rate,
  half-to-even ties, tiny and large amounts) is asserted in TS and against
  Go's `ComputeSettlementFee` (`discounted_fee_parity_test.go`), so the two
  can't drift again unnoticed.

Before the fix: kept 15, expected 14. After it, all pass, along with the
existing discount, payment-link discount, reconciliation, settlement and
refund tests.
