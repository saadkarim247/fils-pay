# 52 · One missing rollup row freezes the analytics for every merchant

**Severity:** Medium (all dashboards stop updating) · **Area:** `apps/reporting/src/consumer/applyEvent.ts`

**What's wrong.** If any merchant's daily-volume rollup row is missing when
its settlement batch closes, the reporting worker crashes on that event,
**on every attempt**. No merchant's charts update again until someone fixes
it by hand.

**Why it's wrong.**
- When a batch closes, the worker runs a purely **diagnostic** comparison
  ("rollup lags ground truth") and logs a warning.
- It read the rollup row without checking the row exists, so it threw
  exactly in the most-lagging case: no row at all.
- The worker applies events in one transaction, so the throw rolled back
  the whole pass and the cursor never advanced.

**Spread / what it breaks.** One merchant's missed capture (see bug 51)
turns into a platform-wide reporting outage.

**Fix (one line).** A missing rollup counts as 0 for the warning. The check
still warns, and never fails the pass.

**Tests.** New file `apps/reporting/src/consumer/noWedge.test.ts`, on a
fresh database. A merchant has a real capture but no rollup row; its
`settlement.batch_closed` is followed by another merchant's capture. One
pass applies the payout trend and counts the other merchant's capture.

Before the fix the pass threw "Cannot read properties of undefined". After
it, the test passes. Full suite (fresh database): no new failures.
