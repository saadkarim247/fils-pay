# 06 · Large-credit approval checks names, not people

**Severity:** High (one person can pay out a large credit alone) · **Area:** `apps/api/src/admin/creditApproval.ts`

**What's wrong.** Manual credits above 50.000 BD need a second operator to
approve them (maker-checker). The check that the approver isn't the
requester compares **display names**, so one admin can approve their own
credit if their name has changed.

**Why it's wrong.**
- HANDOVER says the second approver is compared by admin user id.
- Display names are neither stable nor unique:
  - `admin_users.display_name` (0031) has no UNIQUE constraint, so AM's
    claim that names are unique is false.
  - 0060 snapshots the requester's name precisely because names change
    ("renamed when someone's role changes").
- The test comment that "ids are covered too" is false. The same id with a
  different name was allowed.

**Spread / what it breaks.**
- **Self-approval:** after any rename (theirs, or a renamed account), the
  requester's live name no longer matches the snapshot. They approve their
  own credit and money is posted to the merchant's ledger, with no second
  person involved.
- **False blocks:** two different people with the same name (two "Ali
  Hasan"s) can never approve each other's credits.
- The audit trail still shows one admin id as both requester and approver,
  for a control that exists precisely to prevent that.

**Fix (one line).** Compare `adminUserId` instead of `displayName`. Names
stay in the snapshot, for display only.

**Tests.** New file `apps/api/src/admin/creditTwoPerson.test.ts`, 5 tests:
- **Rule level:**
  - The same id with a new name is refused.
  - Different ids with the same name are allowed.
- **End to end, through the real admin routes, with a 60.000 BD credit:**
  - A requester renamed before approving gets 409, the credit stays
    pending, and nothing is posted to the ledger.
  - A requester approving with no rename gets 409.
  - A different admin with the same name can approve, and the credit posts.

Before the fix, 4 of 5 failed: the renamed requester's self-approval
returned 200 and the money posted. After the fix, all pass, and all 22
existing credit tests are unchanged and passing. Full suite: no new
failures. Also replayed on the running stack: a renamed seeded finance
admin now gets 409 on their own credit. The admin's name was restored and
the test credit closed afterwards.

**Noticed, not changed here.** Creating a credit only requires an admin
session. Its JSDoc says "a support caller gets a 403", but nothing enforces
that. That's the next bug.
