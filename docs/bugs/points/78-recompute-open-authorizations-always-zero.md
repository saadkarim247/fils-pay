# 78 · "Recompute statuses" always reports 0 open authorizations

**Severity:** Low (wrong figure in an admin response) · **Area:** `apps/api/src/admin/transactionStatusRecompute.ts`

**What's wrong.** The tool reports how many of the merchant's transactions
are still only authorized. It counted them among its candidate rows, but
the candidate query excludes `authorized` (and `voided`) rows, so the count
was always 0. Bug 09's note left this as a follow-up.

**Fix.** A separate count of the merchant's authorized transactions.

**Tests.** New file `apps/api/src/admin/recomputeOpenAuthorizations.test.ts`
uses a merchant with 2 authorized, 1 voided and 1 captured transaction. It
failed before the fix (expected 2, got 0) and passes after it. The existing
recompute tests (set-based, sandbox, stale-status) still pass.
