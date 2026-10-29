# 40 · Running settlement for "today" silently drops the rest of the day's sales

**Severity:** High (captures never paid out) · **Area:** `apps/settlement/internal/settlement/batch.go`, `internal/internalapi/server.go`

**What's wrong.** An operator can run the daily batch for a business day
that hasn't finished yet: today, from the CLI, the console "run batch", or
the internal API. The batch closes with the sales so far. **Every capture
later that day is then never batched**, so those merchants are never paid
for them.

**Why it's wrong.**
- `CloseBatch` takes any date. Once a day's batch is closed, re-running
  that day is a deliberate no-op, so the late captures are stranded.
- ADMIN.md says re-running "is always safe", which encourages exactly this.
- The daemon itself only closes yesterday, so this hits manual runs.

**Spread / what it breaks.** Any manual run for the current day. The
stranded captures sit unbatched indefinitely, and the merchant is simply
never paid for them.

**Fix.** `CloseBatch` and `RunDailyBatch` refuse a business date whose
Asia/Bahrain window hasn't ended (`ErrBusinessDayNotEnded`). Nothing is
created or locked. The internal API answers **409**
`business_day_not_ended` instead of a generic 500. Past days work exactly
as before.

**Tests.**
- New file `internal/settlement/unfinished_day_test.go`:
  - `CloseBatch(today)` is refused, with no batch row and the capture still
    unbatched;
  - `RunDailyBatch(today)` is refused, while yesterday still runs.
- New file `internal/internalapi/unfinished_day_test.go`: run-batch for
  today gives 409.

Before the fix today closed (200 and no error). After it, all pass, as do
all existing Go tests. Full suite (fresh database): no new failures.
