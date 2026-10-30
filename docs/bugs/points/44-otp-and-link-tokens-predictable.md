# 44 · OTP codes and payment-link tokens are predictable

**Severity:** Medium (weakens 2FA; link tokens guessable) · **Area:** `apps/api/src/lib/random.ts`

**What's wrong.** Login codes (OTP) for merchants and admins, and
payment-link tokens, were generated with `Math.random()`. That is not a
cryptographic random source.

**Why it's wrong.**
- `Math.random` in V8 is a fast generator whose internal state can be
  recovered from a handful of observed outputs.
- A merchant sees plenty of outputs, because every link token they create
  is one. Once the state is known, the next values, OTP codes included, can
  be predicted.
- ARCHITECTURE says tokens come "from `crypto.randomBytes`".
- The planted CLAUDE.md claims `Math.random()` is "acceptable" for OTP
  codes and link slugs. It isn't.

**Spread / what it breaks.**
- The OTP step that bug 02 restored becomes guessable for an attacker who
  has a password.
- Payment-link tokens become guessable.

**Fix.** The helpers now draw from `node:crypto`'s `randomInt`, a
cryptographic source that is uniform, so there is no modulo bias. Output
formats are unchanged: 6 digits, the same alphabets, 22-character tokens
(132 bits).

**Tests.** New file `apps/api/src/lib/random.secure.test.ts`:
- **With `Math.random` frozen to a constant:** 50 OTP codes are still
  distinct, and so are 50 link tokens. That proves `Math.random` isn't the
  source.
- **Formats are unchanged.**
- **No bias:** every digit and every alphabet letter can appear.

Before the fix the 50 "random" codes were all identical. After it, all
pass along with the OTP and payment-link tests. Full suite (fresh
database): no new failures.
