# 08 · Bulk KYC approve lets un-vetted and rejected merchants take payments

**Severity:** High (KYC/AML control bypass) · **Area:** `apps/api/src/admin/bulkKyc.ts`

**What's wrong.** The admin "bulk approve" button approves every merchant
ticked in the list, whatever their state:
- merchants that never submitted for review (`submitted`);
- merchants that **failed** KYC (`rejected`).

It also leaves no per-merchant review record.

**Why it's wrong.**
- ADMIN.md: "Only merchants currently `under_review` are affected." The
  result type's own doc says rejected and already-approved ids are skipped.
- Migration 0016: `merchant_kyc_reviews` is "the single source of truth for
  KYC approval", and "no other code path should ever
  `UPDATE merchants SET kyc_passed = ...` directly".
- The code does exactly that: one bare `UPDATE … WHERE id = ANY($1)`, with
  no state filter and no review rows. AM's note ("goes through the same
  review function, one row per merchant") is false.

**Spread / what it breaks.**
- Approval is the gate for taking money (`authorize` refuses any merchant
  not `approved`). One click turns a merchant that failed KYC into one that
  can take card payments.
- No `merchant_kyc_reviews` row means no record of who approved the
  merchant, or when. For a payments company that is a regulatory problem.
- Already-approved merchants are counted again as "approved", so the
  response overstates what changed.
- Evidence: the September audit export has one bulk run (6 requested, 6
  approved). Without review rows there is no way to tell what state those 6
  were in.

**Fix (small).** Lock and select only the requested merchants that are
`under_review`, then approve each one through `recordKycReviewInTx`, the one
sanctioned review function. The admin's id and email are recorded as the
reviewer. Everything stays in the existing transaction with the audit row.

**Tests.** New file `apps/api/src/admin/bulkKycApprove.test.ts`, 7 tests
through the real admin route:
- `under_review` merchants are approved, each with one review row naming
  the admin.
- `submitted`, `rejected` and already-`approved` merchants are left exactly
  as they were, and are not reported as approved.
- In a mixed batch only the `under_review` merchant moves.
- A rejected merchant swept into a bulk approve still gets 403
  `merchant_not_approved` when it tries to take a payment.
- If the audit write fails, the approvals and their review rows all roll
  back.

Before the fix all 6 behaviour tests failed. The rejected merchant took a
payment (201). After the fix, all 7 pass, and the existing bulk and KYC
tests are unchanged and passing. Full suite: no new failures. Also replayed
on the running stack: a batch of one rejected and one waiting merchant
approved only the waiting one, with its review row.

**Note on an existing test.** The existing audit-rollback test uses
`submitted` merchants. These are now never eligible, so it still passes but
no longer exercises a rollback. The new rollback test covers that.
