# 02 · Merchant login never actually requires the OTP

**Severity:** Critical (account takeover with a password alone) · **Area:** `apps/api/src/auth/sessions.ts`

**What's wrong.** Merchant login is meant to be two steps: password, then a
one-time code (OTP). In practice the password is enough. The cookie handed
out after step 1 already gives full dashboard and API access.

**Why it's wrong.**
- Step 1 creates the session row and sets the cookie straight away, with
  `authenticated = false`. Only the OTP step flips it to `true`.
- Migration `0012` states the rule: every authenticating query must check
  `authenticated = true`.
- `lookupSession` reads the `live_sessions` view (0058), which only filters
  out revoked and expired sessions, and the query never added the
  `authenticated` check. Its doc comment ("only ever returned for a session
  that completed OTP verification") is false.
- The admin side does check it, and has a test for it. A test comment claims
  the merchant side is covered in `routes/auth.test.ts`; that file doesn't
  exist.

**Spread / what it breaks.**
- Every merchant session check goes through this one function, through both
  guards: `requireSession` (dashboard account endpoints) and
  `requireMerchantAuth` (transactions, links, settlement, reports,
  webhooks).
- A stolen or reused password, from phishing or a breach, is enough to read
  a merchant's data and act as them, including captures and voids. 2FA is
  silently switched off for every merchant.

**Fix (one line).** Add `AND s.authenticated = true` to `lookupSession`'s
query, as 0012 requires. The OTP verify step uses `lookupPendingSession`,
which is unchanged.

**Tests.** New file `apps/api/src/auth/pendingSession.test.ts`, 6 tests:
- **Query level:** a pending session is rejected. The same session is
  accepted once marked authenticated. The OTP step can still find it.
- **HTTP level (real signup and `/login`):** the password-only cookie gets
  401 on `/v1/auth/me` and on `/v1/transactions`. After OTP verify, the same
  cookie gets 200 on both.

Before the fix, the three "reject" tests failed (the endpoints returned 200).
After it, all 6 pass. The full suite has no new failures. Also checked on the
running stack with curl: a password-only cookie now gets 401 on both
endpoints.
