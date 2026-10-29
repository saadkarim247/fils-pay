# 34 · Opening a refunded transaction crashes the merchant dashboard

**Severity:** High (FP-300: "correct in timeline") · **Area:** `apps/web/src/format.ts` · *Part of FP-300*

**What's wrong.** The merchant's transaction page crashes as soon as the
transaction has a refund. So does the reconciliation page when the gap is
negative.

**Why it's wrong.**
- The dashboard's money formatter `bhd()` converts with `toFils(amount)`,
  which **throws on a negative number** unless it is told to allow one.
- A refund is recorded on the timeline as a negative amount, by design: the
  timeline sums to the payment's net movement (0044).
- FH flagged exactly this; MK replied "amounts are never negative in the
  dashboard. ignore."

**Spread / what it breaks.** Every refunded transaction's detail page, and
any reconciliation with a negative gap. Merchants can't see their refunds
at all.

**Fix (one argument).** `bhd()` allows signed amounts:
`toFils(amount, { allowNegative: true })`. The audited money formatter
already prints the minus sign correctly. Fractional fils are still
rejected.

**Tests.** New file `apps/web/src/format.negative.test.ts`:
- −4,000 renders as `-4.000 BHD`, and −5 as `-0.005 BHD`.
- Positive and zero amounts are unchanged.
- 1.5 fils is still rejected.

Before the fix the negative case threw. After it, all pass, along with the
existing web tests. The web typecheck passes.
