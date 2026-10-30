# 50 · The scheme file always overstates sales, and rounding residue is never booked

**Severity:** High ("always over, never under") · **Area:** `apps/settlement/internal/settlement/batch.go`, `scheme_export.go`

**What's wrong.** The daily file sent to the card scheme quotes each sale in
BD with 2 decimals. Every line was **rounded up**, while the books
truncate. On top of that, the leftover 0–9 fils per line (the residue) was
never journaled.

**Why it's wrong.**
- Each line stores `amount_fils` truncated to 10 fils, plus an `amount`
  column holding the *untruncated* gross as a float. Postgres `NUMERIC(10,2)`
  rounds that on insert, and the exporter sent `amount`. So 4,747 fils
  became "4.75" (the books say 4.74), 1,005 became "1.01" and 93,277 became
  "93.28".
- ADR-0002 requires the file to quote "exactly `amount_fils / 1000`", and
  each line's residue to be journaled (credit `card_scheme_clearing`, debit
  `scheme_rounding_residue`).
- ADR-0002's status says "Accepted, implemented (CloseBatch, 2026-03)".
  Nothing in Go ever posted it, and YA's HANDOVER says so. AM's comment on
  the test ("4747 -> 4.75… it rounds. whatever") saw it.

**Spread / what it breaks.**
- Every exported line is over by up to 5 fils, and never under, so the
  scheme file, the books and finance's statement can't agree.
- Evidence: Delta Wholesale, 14 Sep. Its 260 lines' `amount_fils` total
  19,998.970 BD, while the file says 20,000.200 BD (+1.230), with line 1 at
  93,270 fils against "93.28".

**Fix.**
- **Lines store the truncated figure, exactly.** `amount` is written from
  the truncated fils as an exact string, with no float.
- **The exporter quotes the integer the books hold.** It formats
  `amount_fils` with the existing integer formatter.
- **Residue is journaled per line.** `CloseBatch` posts ADR-0002's group
  for every line with residue (credit clearing, debit residue). The merchant
  isn't touched, so payouts are unchanged.
- **The unused float converter is removed.**

**Tests.** New file `internal/settlement/scheme_residue_test.go`:
- every exported line quotes exactly its own `amount_fils`: "4.74", "1.00",
  "12.34", "93.27";
- residue legs: 7 + 5 + 4 = 16 fils posted to clearing and residue in 3
  groups (the line with no residue gets none), with no merchant leg and the
  payout unchanged.

Before the fix the file said "4.75", "1.01" and "93.28", and no residue was
posted. After it, both pass with every Go test, including the existing
2-decimal format test. Full suite (fresh database): no new failures.
