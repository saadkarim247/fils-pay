# 41 · Marketplace split payouts lose or invent fils

**Severity:** Medium (wrong amounts to sub-merchants; worse with bad setup) · **Area:** `apps/settlement/internal/splits/shares.go`, `allocate.go`, `internal/settlement/batch.go`

**What's wrong.** A marketplace's daily payout is split between its
sub-merchants by percentage. The parts don't add up to the payout:
- 50/30/20 of 17 fils paid out 16, losing a fil.
- 3,333/3,333/3,334 bps of 1,001 fils paid out **1,002**, inventing a fil
  the platform doesn't have.
- A split configured to only 90% was paid out regardless.

**Why it's wrong.**
- Each child's share was rounded on its own, and the leftover was never
  assigned.
- The weights were never checked to total 100%. 0045 left that to "a
  future admin tool"; the AM note says "FP-250 closed, the seed always
  writes 10000".
- The TypeScript money package already has the correct method
  (`allocateRemainder`); the Go code didn't use it.
- The existing `ChildShares_SumToNet` test only tried amounts that divide
  exactly.

**Spread / what it breaks.**
- Every marketplace payout, such as Delta Marketplace's three shops:
  sub-merchants are paid wrong amounts, and the ledger and payout records
  disagree.
- A misconfigured split pays out the wrong total.

**Fix.**
- `ChildShares` uses **largest remainder**: each child gets the floor of
  its share, and the leftover fils go to the largest remainders, with ties
  to the lowest index, like `allocateRemainder`. The shares always add up
  to the net exactly.
- `PayoutSplitBatch` uses it, and **refuses** a split whose weights don't
  total 10,000 bps. That batch is left closed and unpaid for someone to fix.
- The daily run **skips** that one batch, with a log line, instead of
  aborting every other merchant's payout.

**Tests.**
- New file `internal/splits/shares_exact_test.go`: the exact cases (17 →
  9/5/3, and 1,001 → 334/333/334), plus a sweep across 5 splits and about
  700 amounts where the sum always equals the net.
- New file `internal/settlement/split_payout_exact_test.go`:
  - a real 1,001 split payout allocates and pays exactly 1,001;
  - a 90% split is refused and the batch stays closed;
  - one misconfigured marketplace doesn't stop another merchant from being
    paid.

Before the fix: 20 for 21, 1,002 for 1,001, the 90% split accepted, and a
bad split aborted the run. After it, all pass with all Go tests. Full suite
(fresh database): no new failures.
