# 28 · Simultaneous refunds all pay out, and the books lose track

**Severity:** Critical (refunds beyond the captured amount; lost updates; FP-209) · **Area:** `apps/api/src/payments/processRefund.ts` · *Part of FP-300*

**What's wrong.** Several refunds of the same payment sent at the same time
(a double-click, a retry with a new key, two staff members) **all** succeed,
even when together they exceed what was captured. The transaction's
refunded total then records only one of them.

**Why it's wrong.** The refund ran in three separate steps:
1. Read and validate the transaction **without a lock**, then commit.
2. Call the acquirer outside any transaction.
3. Write `refunded_fils = <total from step 1 + this refund>`, an absolute
   value.

Every concurrent refund validated against the same untouched row, and
each overwrote the others' totals. Idempotency keys only protect a retry of
the *same* key. Capture already solved this: its row lock is held across
the acquirer call, "on purpose" (YA).

**Spread / what it breaks.** Five 3 BD refunds of a 10 BD sale all paid out
(15 BD). The ledger reversed 15 BD, while the transaction said 3 BD was
refunded. This is FP-209.

**Fix.** The refund now runs as **one transaction**, exactly like capture:
1. Claim the key.
2. Lock the transaction row (`FOR UPDATE`).
3. Validate against the locked row.
4. Call the acquirer **while holding the lock**.
5. Journal, with `refunded_fils = refunded_fils + n`.

A second concurrent refund waits, then validates against the first's
result. The `refunded ≤ captured` constraint from bug 27 backs this up in
the database.

**Tests.** New file `apps/api/src/refunds/refundConcurrency.test.ts`. The
acquirer is slowed to 60–120 ms so the refunds truly overlap.
- Five simultaneous 3,000 refunds of a 10,000 capture: at most 3 succeed.
  The refund rows, `refunded_fils` and the ledger reversal each equal
  exactly the successful refunds.
- Two simultaneous full refunds: exactly one goes through.

Before the fix: 5 of 5 succeeded, and both full refunds succeeded. After
it, both tests pass, 3 of 3 runs, along with all 47 refund tests. Full
suite (fresh database): no new failures.
