# 58 · Refunds never show in the dashboard's analytics

**Severity:** Medium (FP-300 "shows up right in … the reports") · **Area:** `apps/reporting/src/consumer/`, `apps/api/src/admin/reportingRebuild.ts`, `analytics/query.ts`, web Overview

**What's wrong.** After FP-300 a merchant can refund, but the Overview's
daily volumes never show it. A day with 10 BD captured and 4 BD refunded
looks like a clean 10 BD day.

**Why it's wrong.**
- **The worker ignores refunds.** The reporting worker only consumes the
  event types on its list, and `refund.succeeded` wasn't on it.
- **The obvious fix is a trap.** AM's comment says "when refunds ship just
  add it to the list". Doing only that would **stop all analytics**:
  `applyEvent` throws on any type it has no case for, and the whole pass
  rolls back on every retry.
- **The prepared helper was broken.** `applyDailySummaryRollup` wrote
  `refund_count`/`refund_gross_fils`, which `merchant_daily_volume` doesn't
  have, and keyed by the **UTC** date while captures use the Bahrain
  business day. Nothing called it.
- **The admin rebuild dropped them too.** "Rebuild analytics" (from source
  tables) only counted captures and voids.

**Spread / what it breaks.** Every merchant's Overview after any refund.
The brief's FP-300 checklist requires refunds to show correctly in the
reports.

**Fix.**
- **Migration 0081:** adds `refund_count` and `refund_gross_fils` to
  `merchant_daily_volume`. No backfill: refunds returned 501 in production
  until FP-300, and anywhere they ran earlier, `reporting rebuild` replays
  them.
- **Worker:** `refund.succeeded` is on the list and has its own case,
  bucketed by the Bahrain day like captures. The broken helper is replaced.
- **Admin rebuild:** adds succeeded refunds per Bahrain day, merged into
  the same rows.
- **API and web:** `GET /v1/analytics/volumes` returns `refundCount` and
  `refundGrossFils`, and the Overview has a "Refunded" column.

**Tests.**
- `apps/reporting/src/consumer/refundRollup.test.ts` (own database): a
  capture and two refunds whose outbox times straddle UTC midnight all land
  on the same Bahrain day: 2 refunds, 5.500 BD. A second pass processes
  nothing.
- `apps/api/src/analytics/refundAnalytics.test.ts`: a real capture and
  refund through the API, then the admin rebuild, then
  `/v1/analytics/volumes` reports 1 refund of 4.000 BD.

Before the fix both failed (no refund fields). After it, both pass. Full
suite (fresh database): no new failures. Checked live: a 26.987 BD refund
from the dashboard drawer appeared on the Overview as "26.987 BHD (1)".
