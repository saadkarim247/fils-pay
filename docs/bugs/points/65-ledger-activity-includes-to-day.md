# 65 · Recent ledger activity returns one day too many

**Severity:** Low (wrong range on a dashboard API) · **Area:** `apps/api/src/analytics/query.ts` (`getRecentLedgerActivity`)

**What's wrong.** `GET /v1/analytics/recent-ledger-activity?from=…&to=…`
also returns everything on the `to` day.

**Why it's wrong.** Every analytics endpoint takes `to` as **exclusive**:
- the shared `parseDateRange` says so;
- the dashboard labels the field "To (exclusive)";
- volumes, payout trends and top links all use `< to`.

This one used `BETWEEN from AND to`, which includes both ends.

**Spread / what it breaks.** A merchant (or an integration) asking for one
day gets two. Its totals disagree with the other analytics for the same
range, and a "day by day" export double-counts each boundary day.

**Fix.** `>= from AND < to`, still in Bahrain calendar days. The doc comment
now states the bound.

**Tests.** New file `apps/api/src/analytics/ledgerActivityRange.test.ts`.
One ledger pair at noon on 1 July and one at 00:30 Bahrain on 2 July (21:30
UTC on 1 July, so it also checks the Bahrain boundary). With
`from=2026-07-01&to=2026-07-02`, only the 1 July pair comes back. Before the
fix the 2 July pair leaked in. After it, it passes, along with the existing
analytics route tests.
