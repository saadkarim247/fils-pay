# 59 · Merchants are logged out 10 minutes after signing in

**Severity:** Medium (dashboard unusable for real work; looks like a security timeout) · **Area:** `apps/api/src/routes/auth.ts`

**What's wrong.** A merchant signs in with password and OTP, and about 10
minutes later the dashboard throws them back to the login page, even though
their session is valid for 12 hours. (Observed live while checking bug 58.)

**Why it's wrong.**
- **Two lifetimes.** The password step sets the session cookie with the
  short *pending* lifetime (10 min), which is right, because the session
  isn't authenticated yet.
- **The browser never hears about the upgrade.** OTP verify promotes the
  session to 12 hours on the server but **never re-issues the cookie**, so
  the browser deletes it after 10 minutes and the valid session is
  orphaned.
- **The admin flow does it right.** Admin verify re-sets the cookie for
  exactly this reason. Code comments describe the gap: MK asks "admin
  verify re-sets the cookie after this, merchant verify doesnt. related to
  the 10 min logouts?" and FH says "the merchant flow should do the same".

**Spread / what it breaks.** Every merchant dashboard user, every login.
Any task over 10 minutes (reconciling, issuing refunds, building payment
links) ends in a forced re-login and lost form input.

**Fix.** Merchant verify re-issues the same session token with
`maxAge = sessionTtlHours × 3600`, the same attributes as before (HttpOnly,
SameSite=Lax, Secure per config), mirroring admin verify. The server-side
expiry is unchanged.

**Tests.** New file `apps/api/src/auth/sessionCookieLifetime.test.ts`,
using real signup, login and verify:
- The login cookie has `Max-Age=600`.
- Verify re-issues the **same token** with `Max-Age=43200`, HttpOnly.
- `/v1/auth/me` works with it.

Before the fix it failed (no cookie on verify). After it, it passes, along
with the existing auth and OTP tests. Full suite (fresh database): no new
failures. Checked live through the dashboard proxy: login `Max-Age=600`,
verify `Max-Age=43200`.
