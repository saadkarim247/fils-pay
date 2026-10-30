# 56 · Manual credits rewrite closed days, and can be dated in the future

**Severity:** Medium (reconciled history changes after sign-off) · **Area:** `apps/api/src/admin/credits.ts`, `creditRequestValidation.ts`

**What's wrong.** When finance issues a manual credit they pick an
"effective date". The ledger legs were written *at that date*, which causes
two problems.
- **Back-dating.** A credit dated 40 days ago landed inside a day that was
  long since reconciled and paid. That old day's reconciliation suddenly
  showed a gap.
- **Future dates.** These were accepted. The cached balance moved today,
  but the ledger rows sat in the future, so windowed views disagreed with
  the balance until the date arrived.

**Why it's wrong.**
- **HANDOVER:** "The effective date is metadata; ledger rows go in at now()."
- **The validator's own contract:** "today or earlier; future dates are
  rejected". The code only checked the format.
- **Precedent.** Every other posting (fees, payouts, MDR recalculation,
  residue) is at `now()`. Closed periods aren't reopened; corrections land
  in the open one.
- **MK's comment** calling the back-dating test "the spec… finance sign-off"
  conflicts with the handover. ARCHITECTURE's line about the effective date
  of the period corrected is the one judgement call here (see below).

**Spread / what it breaks.** Daily reconciliation (`GET
/v1/settlement/reconciliation`) for past days, ledger activity views, and any
month-end figures already reported to finance or the acquirer.

**Fix.**
- Credit legs post at `now()`. `effective_date` stays on `credit_requests`
  and is shown in the console as before.
- An effective date after *today in Bahrain* is refused
  (`invalid_effective_date`). Bahrain, not UTC: just after midnight local,
  UTC is still "yesterday".
- **Not applied:** YA's comment mentions a "not older than 35 days" test
  that doesn't exist. Worth confirming with finance.

**Tests.** New file `apps/api/src/admin/creditEffectiveDate.test.ts`:
- Tomorrow and +30 days are refused; Bahrain-today is accepted.
- A credit dated 40 days back posts its legs now, keeps the date on the
  record, and leaves that old day's reconciliation gap at 0.

The existing test that pinned back-dated legs (`credits.test.ts`) now
asserts legs at now(), with a comment. Before the fix 2 of 3 new tests
failed (future accepted; legs dated 19 Sep). After it, all 44 credit tests
pass. Full suite (fresh database): no new failures.
