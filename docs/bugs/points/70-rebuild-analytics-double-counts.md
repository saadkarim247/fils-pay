# 70 · "Rebuild analytics" counts recent payments twice

**Severity:** Medium (merchant dashboards overstate volume after every rebuild) · **Area:** `apps/api/src/admin/reportingRebuild.ts`, `apps/reporting/src/consumer/`

**What's wrong.** An admin presses **Rebuild analytics** to fix the
dashboard figures. Every payment captured since the reporting worker's last
pass then appears **twice** on the merchant's Overview.

**Why it's wrong.**
- **Two counters, no hand-off.** The rebuild recounts all history from the
  source tables (transactions, refunds, batches) but leaves the worker's
  bookmark (cursor) where it was. The worker then processes every event
  after that bookmark, including ones the rebuild just counted.
- **The route's comment is false.** It says the rebuild "replays the
  outbox from the start". It doesn't, and it can't: the outbox does not
  hold all history. In the dev database, 1,423 captures have only 4 outbox
  events.
- **Moving the bookmark to "now" would lose events.** A slow transaction
  that started earlier can commit an event *below* the new bookmark after
  the rebuild.
- **Nothing stopped them running at the same time.** The worker could run
  a pass during the rebuild. "Two processes … serialize on that row" was
  claimed, but the cursor was read without a lock.

**Spread / what it breaks.** Every merchant's daily volume, captured count
and refunds on the Overview after any admin rebuild, which is exactly when
someone is trying to fix those numbers.

**Fix.**
- **One shared lock.** Every worker pass and the admin rebuild take the
  same lock, so they never interleave.
- **One statement, one snapshot.** The rebuild recounts the rollups from
  source, moves the bookmark to the snapshot's oldest still-running
  transaction, and lists in a new table (migration 0084) the few events
  above that point the snapshot could already see.
- **The worker skips listed events.** Each event is counted exactly once:
  by the rebuild if it could see it, by the worker otherwise.
- **Cleanup on reset.** The CLI full replay (`reporting rebuild`) clears
  the list when it resets the cursor.

**Tests.** New file `apps/api/src/admin/analyticsRebuildOnce.test.ts` runs
the real admin route and the real reporting worker (`catch-up`):
- Capture A, which the worker consumes; capture B, not consumed yet.
- Rebuild: 2 captures.
- Worker: still 2 (it was 3 before the fix: "B was counted twice").
- Capture C: 3, so events after the rebuild still flow.

Bug 58's refund-after-rebuild test also passes through the new rebuild.
