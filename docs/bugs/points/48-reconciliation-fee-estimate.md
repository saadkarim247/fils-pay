# 48 · The reconciliation report invents gaps from its own fee guess

**Severity:** Medium · **Area:** `apps/api/src/settlement/query.ts`, removed `apps/api/src/fees/estimate.ts`

**What's wrong.** For captures not yet settled, the reconciliation report
**re-estimates** the fee instead of using what was actually charged. Its
guess differs from the real fee, so the report shows gaps that don't
exist.

**Why it's wrong.** The estimate differs from capture in two ways.
- **Rounding.** It used floating point and `Math.round` (half up), while
  capture uses integer `applyRateFils` (half to even). For 1.300 BD at
  250 bps, capture charged 32 fils and the estimate said 33.
- **Rate.** It used `merchants.mdr_bps`, not the merchant's effective fee
  schedule. MK's comment that a "0046 trigger" keeps them in sync is false:
  0046 creates split tables, and no such trigger exists.

The report's own doc comment promises "the same rate the capture path
used".

**Spread / what it breaks.** Any merchant on a negotiated schedule (a gap
on every unsettled sale), and any amount whose fee lands on a half fil.
Finance chases differences that aren't real.

**Fix.** Each capture event already records the fee it charged
(`metadata.feeFils`, the value the discount adjustment reads). Pending now
uses that, minus the discount rebate computed exactly as it is posted. The
float estimator had no other users, so it is removed.

**Tests.** New file `apps/api/src/settlement/reconciliationFees.test.ts`:
- 1,300 at 250 bps: pending 1,268, gap 0 (was 1,267).
- A 225 bps schedule on a merchant whose rate on file is 250: pending
  9,775, explained (was 9,750).
- A 20% discount: pending 9,800, gap 0.

Before the fix the first two failed. After it, all pass, as do the other
settlement tests. Full suite (fresh database): no new failures.
