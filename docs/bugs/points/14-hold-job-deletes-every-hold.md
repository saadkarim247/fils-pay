# 14 · The nightly hold job deletes every hold on a quiet night

**Severity:** Critical (wipes the record of reserved card money) · **Area:** `scripts/expire_holds.ts`

**What's wrong.** A hold is money reserved on a buyer's card between
authorize and capture. The nightly job is meant to mark abandoned holds as
`expired`. Instead it **deletes** them, and on any night when nothing has
expired it deletes **every hold in the table**.

**Why it's wrong.**
- HANDOVER: the job "flips `active` to `expired` with one UPDATE. Holds are
  never deleted."
- The script instead SELECTs the expired ids, then builds a DELETE with a
  shared helper, `buildWhere`.
- That helper **skips empty arrays**. With zero expired ids the WHERE clause
  disappears, and the query becomes `DELETE FROM holds`.
- It is also a read-then-write race: a hold captured between the SELECT and
  the DELETE is deleted anyway. A code comment waves this away
  ("negligible window, fine").
- The existing tests only checked the SQL text for non-empty lists, so they
  could never see this.

**Spread / what it breaks.**
- Every quiet night, all live holds vanish. Captures, voids and support no
  longer have a record of what is reserved on each card.
- Expired holds are erased instead of kept, so there is no audit trail of
  reservations.

**Fix.** One atomic statement:
`UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`.
The DELETE helper (`scripts/lib/sqlFilter.ts`) and its text-only test
(`scripts/expire_holds.test.ts`) are removed; nothing else used them.

**Tests.** New file `scripts/expire_holds.behaviour.test.ts`. It creates
its own fresh, migrated database, because the old job wiped the whole
table, and runs the real script:
- On a quiet night, the hold count is unchanged and states are untouched.
- An expired active hold becomes `expired` and is kept. Valid, released and
  already-expired holds are untouched.
- Running twice is harmless.

Before the fix the quiet night went from 2 holds to 0. After it, all pass.
Full suite (fresh database): no new failures, and all typechecks pass.
