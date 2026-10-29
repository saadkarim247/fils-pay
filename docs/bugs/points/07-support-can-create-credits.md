# 07 · Support staff can pay merchants with manual credits

**Severity:** High (a support login can move money) · **Area:** `apps/api/src/routes/adminCredits.ts`

**What's wrong.** Any admin, including the lowest role `support`, can
create a manual credit through the API. A credit at or below 50.000 BD posts
to the merchant's ledger the moment it is created.

**Why it's wrong.**
- The create route sits in a scope that only checks "is an admin". Approve
  and reject, next to it, are correctly gated to finance and super_admin.
- Everything else says create is finance-only:
  - The console shows the form only to finance and super_admin ("Your role
    cannot issue credits. Ask a finance admin.").
  - `createCreditRequest`'s doc says "a support caller gets a 403". Nothing
    enforced that.
  - ADMIN.md gives finance "anything that touches money".
  - ARCHITECTURE says roles are "checked server-side per route".
- The brief's hints include "some admin actions lack role checks".
- One contradiction: ADMIN.md's support row says "issue small credits". It
  is outweighed by its own finance row, the UI, the code contract and
  ARCHITECTURE.

**Spread / what it breaks.**
- A support account can credit any merchant up to 50.000 BD per request,
  as many times as it likes, with no second person involved, because only
  credits above the threshold need approval.
- Hiding the button in the console gave false comfort. Anyone calling the
  API directly bypasses it.

**Fix (one line).** Add `requireAdminRole("finance", "super_admin")` to the
create route, matching approve and reject.

**Tests.** New file `apps/api/src/routes/adminCreditsCreateRole.test.ts`,
5 tests:
- Support creating a 10.000 BD credit gets 403, with no credit request and
  no ledger legs for the merchant.
- Support creating a 60.000 BD credit gets 403, with nothing queued.
- Finance and super_admin can still create a credit, and it posts with
  balanced legs.
- Support can still read the credits queue.

Before the fix, support's 10.000 BD credit returned 201 and posted. After
the fix, all pass, along with all 25 other credit tests (bug 06's and the
existing ones). Full suite: no new failures. Also replayed on the running
stack: a seeded support admin gets 403 on create, 200 on reading the queue,
and no row is written.
