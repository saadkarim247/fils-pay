# 15 · Large payouts are off by fils (float32 arithmetic)

**Severity:** High (wrong payout amounts; grows with merchant size) · **Area:** `apps/settlement/internal/settlement/payable.go`

**What's wrong.** The amount actually paid to a merchant each day is
computed through 32-bit floating point. Above about 16,777 BD a day, the
payout is wrong by 1 fil or more, and the error grows with the batch size.

**Why it's wrong.**
- `NetPayableFils` converted gross and fee to BD as `float32`, subtracted,
  and converted back.
- A `float32` holds 24 bits of precision, so it cannot represent every
  integer above 2^24 (16,777,216 fils).
- ADR-0001: money is integer fils, never floats. `.cursorrules` calls the
  `float32` "intentional"; that's the planted cover.
- The existing test uses 13,333 fils, a size float32 handles exactly, so it
  could never fail.

**Spread / what it breaks.**
- Every batch above about 16,777 BD pays the wrong amount, and the
  ledger's own gross − fee no longer matches what was paid.
- Delta Wholesale, 14 Sep: gross 20,000.123 BD, fee 420.003 BD, paid
  19,580.119 instead of 19,580.120. The test reproduces that exact figure.
- 13 batches in the 1–20 Sep export are off by 1–2 fils. At 10 million BD
  the error is 7 fils.

**Fix (one line).** `return grossFils - feeFils`. It's exact integer
arithmetic, matching ADR-0001.

**Tests.** New file `internal/settlement/payable_exact_test.go`:
- **Five sizes**, including the Delta case, 2^24 + 1, 150,000 BD and
  10 million BD.
- **A sweep** of about 3,000 values between 16 and 40 million fils.
- **A real `CloseBatch`** over a 20,000.123 BD day. Its stored payout must
  equal its own gross − fee.

Before the fix all three tests failed (19,580,119 vs 19,580,120). After it
they pass, as do all existing Go tests. Full suite (fresh database): no new
failures.

**Clean-up needed in production.** Recompute gross − fee for every paid
batch, and pay out or recover the difference per merchant.
