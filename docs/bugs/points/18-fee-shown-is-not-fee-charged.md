# 18 · The fee rate shown is not the fee rate charged

**Severity:** High (staff quote merchants the wrong rate; settlement can disagree with capture) · **Area:** `apps/api/src/fees/currentFeeScheduleDisplay.ts`, `apps/settlement/internal/settlement/fee_schedule.go`

**What's wrong.** A merchant's negotiated fee (MDR) is a dated history in
`fee_schedules`. Three places resolve "the rate", and they disagree:
1. **The admin console** shows the row **entered** most recently.
2. **Capture**, which actually charges, uses the newest row whose
   effective date has arrived, with ties going to the later-entered row.
3. **Settlement (Go)** uses the effective date only, so a same-day tie is
   decided by row order the query doesn't control.

**Why it's wrong.**
- The display's own contract says "the latest row whose effectiveFrom is
  not in the future". Its query is `ORDER BY created_at`, so a backdated
  correction keyed in later shows as "current".
- So does a rate scheduled for the future: a row for 2099 showed as
  current.
- A code comment raised this (MK) and was dismissed ("asked Claude…
  resolved", "display only, nobody bills off this"). But staff quote and
  check merchants against this screen.

**Spread / what it breaks.**
- Seeded Alpha Retail has 225 bps effective 1 Aug, plus a 245 bps
  correction for March entered 15 Aug. The console says 245; capture
  charges 225. The test reproduces exactly that.
- Same-day corrections could be charged at one rate at capture and
  settled at another.

**Fix (two one-liners).**
- Display: `WHERE effective_from <= now() ORDER BY effective_from DESC, created_at DESC`,
  the same rule as capture.
- Go `LoadFeeSchedules`: `ORDER BY effective_from ASC, created_at ASC`, so
  the later-entered row wins a tie, as in capture.

**Tests.**
- New file `apps/api/src/fees/feeDisplayMatchesCharge.test.ts`, 4 tests.
  Each compares the displayed rate with the fee a **real capture** posts:
  - the Alpha backfill case;
  - a future-dated rate;
  - a same-day tie;
  - only future rows, where nothing is shown and capture falls back to the
    merchant's own rate.
- New file `internal/settlement/fee_schedule_tiebreak_test.go`. The later
  correction is inserted first, so physical order disagrees with entry
  order.

Before the fixes: the display showed 245 (vs 225 charged) and 150 for a
2099 rate, and Go picked 230 instead of 210. After them, all pass.

**Existing test corrected.** `currentFeeScheduleDisplay.test.ts` ("…even
when an older period was backfilled later") asserted the 245 row wins. Its
title and three assertions now expect 225. Full suite (fresh database): no
new failures.
