# 42 · The settlement summary overstates captured sales

**Severity:** High (merchant-facing figure inflated) · **Area:** `apps/api/src/settlement/query.ts` (`getSettlementSummary`)

**What's wrong.** The settlement summary's "total captured" for a period is
too high whenever a payment was captured in more than one part, or partly
captured on an earlier day.

**Why it's wrong.**
- It added up `transactions.captured_fils`, the payment's **running
  total**, once for every capture event in the window. A payment captured
  as 4 BD and then 6 BD counted 10 + 10 = 20 BD.
- A payment whose first capture was last week and whose rest was captured
  today counted its whole 10 BD today.
- The function's own description promises "batch parity", but batches sum
  the capture events.
- The perf doc blames the gap on "timing"; that's a decoy.

**Spread / what it breaks.** Every merchant who captures in parts (split
shipments, hotels). The summary disagrees with the settled batches and with
reconciliation.

**Fix (one query).** Sum the capture **events'** own amounts in the window
and count distinct transactions. That is exactly what a batch settles.

**Tests.** New file `apps/api/src/settlement/settlementSummaryCount.test.ts`:
- A payment captured as 4,000 + 6,000, plus one of 3,000: 2 transactions
  and 13,000 (was 23,000).
- A first capture last week and 6,000 today: today shows 6,000 (was
  10,000).

Before the fix both failed. After it, both pass with the other settlement
tests. Full suite (fresh database): no new failures.
