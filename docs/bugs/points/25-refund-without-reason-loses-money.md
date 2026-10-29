# 25 · A refund without a reason sends the money but records nothing

**Severity:** Critical (money leaves with no record) · **Area:** `apps/api/src/payments/processRefund.ts` · *Part of FP-300*

**What's wrong.** A refund with no reason fails, but only **after** the
acquirer has already returned the money to the card. The result:
- no refund row;
- no ledger reversal;
- the merchant's balance never debited;
- the idempotency key stuck, so retries also fail.

**Why it's wrong.**
- Migration 0070 made `refunds.reason` mandatory: a `CHECK (reason IS NOT
  NULL)`, plus a default of `'unspecified'` "so omitting the column… gets a
  sensible value".
- `processRefund` passed an explicit `NULL` (`input.reason ?? null`), which
  bypasses the default and fails the check.
- The insert happens after the acquirer call, so the money is already gone
  when it fails.

**Spread / what it breaks.** Every reason-less refund, which is the API
default. This also broke 11 existing refund tests from the moment 0070
could actually apply (bug 01).

**Fix.** The reason is normalised before anything else: a missing or blank
reason becomes `'unspecified'` (0070's own default), and a real one is
trimmed. The same value goes into the idempotency fingerprint and the row.

**Tests.** New file `apps/api/src/refunds/refundReason.test.ts`, 4 tests
through `initiateMerchantRefund`, the entry point the route uses:
- No reason gives 200, a row with `unspecified`, and the gross legs
  journaled.
- A blank reason is treated as none.
- A real reason is kept.
- A retried key replays the recorded refund, leaving one row.

Before the fix 3 of 4 failed on `chk_refunds_reason_not_null`. After it,
all pass, **and the 11 existing refund tests that had been failing now
pass too.** Full suite (fresh database): the API is down to the 1 known
flaky test.
