# 04 · "View as merchant" can move money

**Severity:** High · **Area:** `apps/api/src/admin/impersonation.ts`, `apps/api/src/auth/requireMerchantAuth.ts`

**What's wrong.** Admins can "view as merchant" to help with support
tickets. The rule (HANDOVER) is that impersonation always gets the
merchant's `support` role and is read-only. In practice an impersonating
admin can capture and void payments, and finance or super-admin staff can
also create payment links and webhook endpoints as the merchant.

**Why it's wrong.** Two separate gaps:
1. **The role map ignores the rule.** It maps `super_admin` → `owner` and
   `finance` → `finance`. The lookup's own JSDoc says the role is "always
   support". So those grants pass every owner/finance gate.
2. **Capture and void have no role gate at all**, just
   `requireMerchantAuth`. So even a `support` grant can capture. A comment
   claims "impersonation can't reach write routes"; it can.

**Spread / what it breaks.**
- Any of the 3 admin roles can capture or void real payments on any
  merchant. Finance and super-admin can also create payment links and
  webhook endpoints, and a webhook endpoint redirects the merchant's
  payment data to a URL of the admin's choosing.
- These writes are recorded as `merchant_session`, so the merchant's audit
  trail shows the merchant did it.
- Evidence: in `docs/exports/admin-audit-2026-09.csv` there are 38
  impersonation starts. All 16 by super-admins ran as `owner`, and all 16 by
  finance staff ran as `finance`. Only the 6 by support staff ran as
  `support`.

**Fix (small, in two parts).**
1. Every grant resolves to `support`. The role map is removed.
2. `requireMerchantAuth` refuses any non-GET/HEAD request that carries an
   impersonation grant (403 `forbidden`). This closes routes with no role
   gate of their own, and any added later.

Real merchant sessions and API keys are unaffected.

**Tests.** New file `apps/api/src/admin/impersonationReadOnly.test.ts`. It
runs 4 checks for each of the 3 admin roles, using a real grant on a real
authorized payment:
- The role resolves to `support`.
- Reads still work.
- Capture and void return 403, the payment is unchanged, and the merchant's
  own API key can still capture it.
- Creating a payment link or webhook endpoint returns 403.

The existing suite only ever impersonated as `support` and never tried
capture or void. Before the fix, 7 of the 12 tests failed, including
`support` capturing successfully. After the fix, all 12 pass, the existing
admin impersonation test is unchanged and passing, and the full suite has no
new failures.

Also replayed on the running stack: a seeded super-admin grant gets 200 on
reads and 403 on capture and on link creation, and the payment stays
`authorized`.

**Related, not changed here.** Capture and void also have no role check for
real merchant users (`TODO(FH): finance role users shouldn't void`). That
is a separate product decision about merchant roles.
