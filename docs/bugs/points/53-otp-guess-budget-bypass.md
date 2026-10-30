# 53 · The 5-guess OTP limit can be bypassed

**Severity:** Medium (weakens 2FA for merchants and admins) · **Area:** `apps/api/src/routes/auth.ts`, `adminAuth.ts`

**What's wrong.** A login code allows 5 wrong guesses before the login is
cancelled. There are two ways around that.
1. **Send the guesses at once.** 20 simultaneous guesses were all checked
   against the code.
2. **Ask for a new code.** Each resend gave a fresh 5 guesses.

**Why it's wrong.**
- **Race.** Verify *read* `attempt_count`, compared it with the limit, and
  only *then* incremented it after a wrong guess. Simultaneous requests all
  read the same count. MK's comment describes exactly this ("if i fire 50
  at once they all read attempt_count=0"). The admin path's comment
  claiming the row is read `FOR UPDATE` is false.
- **Resend.** Its own contract says the new challenge "inherits the
  previous challenge's attempt_count". It started from 0.

**Spread / what it breaks.** Merchant and admin logins. With bug 44 (a
predictable random source) fixed, the attempt budget is what stands between
a stolen password and a 6-digit brute force.

**Fix.**
- One atomic statement spends an attempt **before** the code is checked:
  `UPDATE … SET attempt_count = attempt_count + 1 WHERE … attempt_count < max_attempts RETURNING …`.
  No row back means the budget is spent, so the session is revoked (429).
  This applies to both merchant and admin verify.
- Resend copies the attempts already used onto the new challenge.

**Tests.** New file `apps/api/src/auth/otpAttemptBudget.test.ts`, using the
real signup and login flow:
- 20 simultaneous wrong guesses: at most 5 are checked, and afterwards even
  the right code is refused.
- 4 wrong, resend, 1 wrong: the 6th attempt gives 429.
- The right code within budget still logs in.

Before the fix 19 of 20 guesses were checked, and the 6th attempt after a
resend logged in. After it, all pass, along with the existing auth and
admin tests. Full suite (fresh database): no new failures.
