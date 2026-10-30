# 57 · Lifetime payout total drifts for big merchants (float32)

**Severity:** Low (monitoring figure, no money moves on it) · **Area:** `apps/settlement/internal/settlement/payout_estimate.go`, migration 0040

**What's wrong.** Ops watches a running "lifetime net payout" per merchant,
plus a 30-day estimate, to spot unusual settlement runs. Both were kept in
float32 (the column is `REAL`). Above 2^24 fils (16,777.216 BD) float32
can't represent every fil.
- A big merchant's total moves in steps of 2, 4, … 256 fils, so small
  payouts disappear entirely.
- In the test, adding 1 fil three times to 19,580,120 changed nothing.
- At 3 billion fils the figure is only good to about 256 fils.

**Why it's wrong.**
- **ADR-0001:** money is integer fils.
- **Comments admit the drift.** FH's test comment says "big ones drift but
  nobody reads it". The group chat confirms that ops does read it
  ("lifetime payout estimate drifts for high-volume merchants").
- **The planted cover.** `.cursorrules`/CLAUDE.md "float32 for display-only"
  is the same cover as bug 15.

**Spread / what it breaks.** The ops anomaly check compares a payout
against a total that is wrong by up to hundreds of fils, and gets worse as
the merchant grows. No payout uses it.

**Fix.**
- **Migration 0080:** the column becomes `BIGINT` fils and is recomputed
  from the paid batches it sums. `PayoutBatch` is its only writer.
- **Go:** the bump is `int64`, and `EstimateMonthlyPayout` sums
  `money.Fils`. It has no callers today.

**Tests.** New file `payout_estimate_exact_test.go`:
- Payouts of 19,580,120 + 1 + 1 + 1 + 7 + 3,000,000,001 fils give the
  exact sum.
- The 30-day estimate over 19,580,120 + 1 + 1 + 1 gives exactly 19,580,123.

Before the fix both failed (3.0195802e+09 and 1.958012e+07). After it, both
pass, along with the existing small-values test. Full suite (fresh
database): no new failures.
