# 01 · A fresh database cannot be migrated

**Severity:** High (it blocks every new deployment) · **Area:** `db/migrations`

**What's wrong.** You can't set up FilsPay on an empty database. The
migration runner stops at `0054_views.sql`, so migrations 0054–0072 are never
applied.

**Why it's wrong.**
- `0054` creates the view `v_unbatched_capture_events` on top of
  `settlement_batch_events`. No migration creates that table; it belongs to
  the unmerged settlement-v2 branch. Nothing in the code reads the view.
- `0055` inserts into `chart_of_accounts` using columns `code`,
  `account_type` and `description`, but the table (from `0007`) has
  `(id, name, kind)`. It also uses the kind `'suspense'`, which the table's
  CHECK rule rejects (only asset, liability or revenue are allowed). Neither
  account is used anywhere.
- `db/migrate.ts` stops at the first failure, so the broken 0054 also hid
  the broken 0055.

**Spread / what it breaks.** Any new environment (the Dilmune Cloud host,
CI, a new laptop) is missing 15 later migrations. The services start anyway,
then fail at runtime:
- Merchant session lookup (`live_sessions`, 0058) fails.
- Payout disbursements (0057) fail.
- Credit approvals (0060) fail.
- CSV adjustment imports (0065–0066) fail.
- Webhook archives (0068) fail.
- The refund rules and summary (0070–0072), which FP-300 needs, are missing.

**Fix (smallest change).** Comment out the broken view in 0054 and the
`INSERT` in 0055, with a note explaining why. No working object is removed.
- Files that are now empty are still recorded, so databases that already
  applied them are unaffected.
- Not done on purpose: ADR-0005 reserves 0054–0056 for settlement v2, so
  these files shouldn't be using those numbers at all. Renaming them is the
  proper long-term fix, but `migrate.ts` tracks migrations by filename, so a
  rename would re-run them on every existing database. That needs a planned
  migration of `schema_migrations`, not a hotfix.

**Tests.** New file `db/migrate.fresh.test.ts`, now part of `npm test`. It
runs the real runner against a throwaway empty database and checks four
things:
- Every file applies and is recorded.
- The objects from the late migrations exist.
- `chart_of_accounts` only contains allowed kinds.
- A second run applies nothing.

Before the fix it failed at 0054. With only 0054 fixed it failed at 0055.
With both fixed it passes.

**Side effect worth knowing.** With 0070 now actually applied, 11 existing
refund tests fail on `chk_refunds_reason_not_null`, because refunds are
written without a reason. That's a real refund bug (FP-300), now visible.
It's handled in the refunds work, not here.
