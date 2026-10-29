# 03 · Login can hand you another merchant's account

**Severity:** High alone, Critical alongside bug 02 or the dev OTP leak · **Area:** `apps/api/src/routes/auth.ts`

**What's wrong.** Logging in to merchant X with X's password can create the
session on a different merchant's user, as long as that user has the same
email.

**Why it's wrong.**
- The password is checked for the exact `(merchantId, email)` pair.
- The next line throws that user away. `findOtpRecipient` looks the email
  up again across every active merchant (`LIMIT 1`, no ordering), and the
  OTP challenge and session are created for whatever row comes back.
- Emails are only unique per merchant (0003), and signup lets anyone open a
  merchant with any email. So one password ends up authenticating a
  different account.
- Code comments claim this was checked ("MK: login filters by merchantId.
  verified"). Only the password check does that filtering.

**Spread / what it breaks.**
- **Attack.** Sign up a new merchant using the victim's email and your own
  password, then log in to it. You get a session on the victim's user, with
  their role, data, captures and voids.
  - Before bug 02 was fixed, that cookie needed no OTP at all.
  - On a server without `NODE_ENV=production` (like the current compose
    setup), the OTP comes back in the login response.
  - Either way the victim's inbox gets an OTP they never asked for.
- **Honest users.** Someone with the same email at two merchants (an
  accountant, say) is logged in to whichever merchant the database happens
  to return, not the one they picked.

**Fix.** Remove the extra lookup and create the challenge and session for
the user whose password was just checked (`user`). `findOtpRecipient` had no
other callers, so it is deleted to stop it being reused.

**Tests.** New file `apps/api/src/routes/loginTenant.test.ts`, 4 tests. Each
signs up a victim and an attacker with the same email through the real
endpoints:
- The attacker's full login (password, OTP, `/me`) lands on the attacker's
  merchant.
- The victim's login lands on the victim's merchant.
- The pending session and its OTP challenge belong to the user whose
  password was checked. This is tested in both directions, so it doesn't
  depend on database row order.
- The victim's password is still rejected on the attacker's merchant.

Before the fix, tests 1 and 3 failed: the attacker got the victim's user.
After it, all pass. Full suite: no new failures. Also replayed on the
running stack: the attacker now lands on their own merchant.
