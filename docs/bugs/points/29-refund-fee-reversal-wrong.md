# 29 · Refunds give back the wrong amount of fee

**Severity:** High (fee revenue wrong on every partial or discounted refund) · **Area:** `apps/api/src/payments/processRefund.ts` · *Part of FP-300*

**What's wrong.** When a sale is refunded, the merchant gets back the
matching share of the processing fee. The amount given back is wrong in two
ways:
1. **Partial refunds don't add up.** Several partial refunds give back more
   or less than the fee charged.
2. **Discounted merchants get back too much.** They receive the *gross* fee
   back, though they only paid the discounted one.

**Why it's wrong.**
- **Rounding.** Each refund's share was rounded on its own. For 1 BD at
  225 bps (a 22 fil fee), refunds of 333 + 333 + 334 gave back
  7 + 7 + 7 = 21. For 1 BD at 250 bps (25 fils), 300 + 700 gave back
  8 + 18 = **26, more than was charged**. HANDOVER's claim that the shares
  "sum back" is false.
- **Discount.** "The fee charged" was read as the gross MDR credit only.
  The negotiated-discount rebate posted after capture was ignored. A 20%
  discount merchant (fee 0.250 − rebate 0.050 = 0.200 BD kept) got 0.250
  BD back on a full refund.

**Spread / what it breaks.** Fee revenue drifts by a fil or more on any
partial refund. On a full refund for a discounted merchant, the platform
loses the whole discount amount. Fee reports and reconciliation are off to
match.

**Fix.**
- **The fee kept** is read from the ledger as MDR credits minus discount
  rebates, ignoring earlier refund reversals.
- **Each refund reverses** `round(fee kept × refunded so far ÷ captured) −
  already reversed`. The shares then always add up exactly: the last refund
  lands the payment's fee revenue on zero.
- The audited money helper `calculateRefundFee` is used unchanged, and its
  rounding stays half-to-even (ADR-0001).

**Tests.** New file `apps/api/src/refunds/refundFeeReversal.test.ts`, 4
tests, checked against the ledger:
- 225 bps, 333 + 333 + 334: reversed exactly 22, and fee revenue ends at 0.
- 250 bps, 300 + 700: reversed exactly 25, and fee revenue ends at 0.
- 20% discount, full refund: reversed 200 (not 250), and fee revenue ends
  at 0.
- One 25% refund of a 250 fil fee: 62.5 rounds half-to-even to 62.

Before the fix: 21, 26 and 250. After it, all pass, along with all 51
refund tests. Full suite (fresh database): no new failures.
