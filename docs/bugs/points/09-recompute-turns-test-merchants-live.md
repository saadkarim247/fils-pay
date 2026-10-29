# 09 · "Recompute statuses" puts test merchants into real settlement

**Severity:** High (sandbox payments get paid out as real money) · **Area:** `apps/api/src/routes/adminMerchantsRecompute.ts`, `apps/api/src/admin/merchantFlags.ts`

**What's wrong.** "Recompute transaction statuses" is a support tool for
tidying old refund-era statuses. As a side effect it switches sandbox (test)
merchants to live, and the next settlement run then pays out their test
captures.

**Why it's wrong.**
- After recomputing, the route calls `reconcileSandboxFlag`. That clears
  `test_mode` when the merchant "has no open authorizations".
- The count is always 0. The scan excludes `authorized` rows and then counts
  rows whose status is `authorized`. So any sandbox merchant with at least
  one other transaction is flipped to live.
- Even with a correct count, the rule makes no sense: having no open
  authorizations says nothing about being ready to take real money.
  ADMIN.md describes the tool as status clean-up only ("safe to run more
  than once").
- This was the **only** code path that ever cleared `test_mode`.

**Spread / what it breaks.**
- Settlement only leaves out merchants with `test_mode = true`
  (`batch.go:117`, `:408`). Once the flag is cleared, sandbox captures are
  batched, fees are charged, and a real payout is sent.
- Evidence:
  - Slack, 19 Sep: support ran Recompute on Gamma and got
    `testModeCleared: true`. Huda asked, "Gamma is the test merchant… Will
    they be [in settlement] now?" They would.
  - The audit export has the matching row.
  - The brief's hints: "test merchants show up in the real settlement run",
    "test merchants when certain admin tools run".

**Fix.** Remove the side effect. The route only recomputes statuses and
never touches merchant flags. `merchantFlags.ts` had no other callers, so it
is deleted, and the stale `flagsUpdated` field is dropped from the response
and the admin UI type.

**Tests.** New file `apps/api/src/routes/adminRecomputeStatuses.test.ts`,
5 tests through the real admin route:
- A sandbox merchant with only captured payments stays sandbox (the Gamma
  case).
- So does one with an open authorization, which proves the count bug.
- Running the tool twice is still safe.
- A live merchant stays live.
- The tool still fixes a stale status: fully refunded but labelled
  `captured` becomes `refunded`.

Before the fix, the 3 sandbox tests failed (`test_mode` became false).
After it, all 5 pass. Full suite, on a fresh database: no new failures.
Both typechecks pass. Also replayed on the running stack: Recompute on
seeded Gamma leaves `test_mode = true`.

**Left as is.** The response's `openAuthorizations` still always reads 0.
Nothing acts on it any more, but it is wrong data on screen. This is a
one-line follow-up if wanted.

**Clean-up needed in production.** Find every `transaction_status_recompute`
audit row with `testModeCleared: true` (Gamma on 19 Sep). Restore
`test_mode`, and reverse any payouts made to those merchants since.
