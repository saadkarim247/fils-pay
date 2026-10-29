# 33 · The refund summary report is always empty

**Severity:** Medium · **Area:** `db/migrations/0072_refund_merchant_summary.sql` → `0077`, `apps/reporting/src/consumer/applyEvent.ts` · *Part of FP-300 ("correct in … reports")*

**What's wrong.** The per-merchant daily refund summary (count, refunded
amount, fee given back) never shows any refunds.

**Why it's wrong.**
- **The join is wrong.** The view joins `transactions t ON t.id = r.id`,
  comparing a transaction id with a *refund* id. It never matches, so the
  view is always empty.
- **It is never refreshed.** It is a materialized view, and its comment
  says "refreshed by the reporting worker after each settlement run".
  Nothing anywhere refreshed it.
- **It double-counts.** It summed the sale's captured amount once per
  refund, so a sale refunded in two parts counted its sale twice.

**Spread / what it breaks.** Any refund reporting built on it shows zero
refunds, so refund volume and fee reversals are invisible.

**Fix.**
- **New migration** `0077_refund_merchant_summary_fix.sql` recreates the
  view joined on `r.transaction_id`, and counts each sale's captured amount
  once per day. It is numbered after ADR-0005's reserved range, since 0072
  has already applied.
- **The reporting worker refreshes it** on `settlement.batch_closed`, as
  designed.

**Tests.** New file `apps/reporting/src/consumer/refundSummaryRefresh.test.ts`.
A sale of 10,000 is refunded 4,000 + 2,000 (fee back 100 + 50); a real
`settlement.batch_closed` is then applied by the worker. The summary shows
2 refunds, 6,000 refunded, 150 fee back, and 10,000 captured, counted once.

Before the fix: 0 rows. After it, the test passes, along with the existing
`applyEvent` tests. Full suite (fresh database): no new failures, all
typechecks pass.
