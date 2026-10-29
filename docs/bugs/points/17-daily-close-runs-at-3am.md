# 17 · The daily settlement close runs at 03:00 Bahrain, not midnight

**Severity:** High · **Area:** `apps/settlement/internal/scheduler/daemon.go`

**What's wrong.** The brief says settlement closes daily at midnight Bahrain
time (UTC+3). The daemon actually closes each day at about **03:00**.

**Why it's wrong.**
- The daemon asks `BusinessDayWindow(time.Now().UTC())` for today's
  business day.
- `BusinessDayWindow` reads the calendar date in the argument's own zone,
  here UTC. It does not convert to Bahrain, despite the comment claiming
  "BusinessDayWindow converts to Bahrain".
- From 00:00 to 03:00 Bahrain, the UTC date is still yesterday. So "today"
  resolves to yesterday, and the day due to close is the one *before* that,
  which is already closed. The run does nothing.
- The day that just ended only closes once the UTC date rolls over, at
  03:00 Bahrain.
- The grace period is skipped too: at 00:10 it is already "due".
- AM's own note in the code: "logs show the close ~03:15 local not 00:15".

**Spread / what it breaks.**
- Every merchant's batch, scheme file and payout runs three hours late,
  every day.
- The audit export shows all 80 September batches paid between 03:05 and
  03:09 Bahrain.
- The brief's group chat: "daily close runs at 3am local not midnight".
- Batch *contents* are correct, because the window boundaries themselves
  are right. Only the timing is wrong.

**Fix.** A new helper, `settlement.BusinessDateOf(instant)`, gives the
Asia/Bahrain calendar date of an instant. The daemon converts "now" with it
before asking for the window. `BusinessDayWindow`'s own "calendar date"
contract, used by the CLI and pinned by its tests, is unchanged. The
"due?" decision was first moved, unchanged, into a small pure function
(`dueBusinessDate`) so it could be tested with exact clock times.

**Tests.** New file `internal/scheduler/due_test.go`, 6 wall-clock cases:
00:10 (inside the grace period, not due), 00:20, 02:59, 03:30, 23:50, and
00:20 on New Year's Day.

Before the fix, 4 failed. At 00:20 it picked 2026-10-27 instead of
10-28, and at 00:10 it was "due". After the fix, all pass, as do all
existing Go tests. Full suite (fresh database): no new failures.

**Left as is.** The daemon's "next check-in" log line is only an estimate;
nothing acts on it.
