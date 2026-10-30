# 66 · A failed rollback hides the real error and recycles a dead connection

**Severity:** Low (diagnosis and stability, no money moves) · **Area:** `apps/api/src/db/withTransaction.ts`, `apps/reporting/src/db/withTransaction.ts`

**What's wrong.** Every multi-step write goes through `withTransaction`. If
the work fails *and* the connection is already broken, `ROLLBACK` also
fails. Two things then went wrong:
- **The real error was lost.** The caller (and the logs) got "Connection
  terminated" instead of the actual cause, e.g. a constraint violation.
- **The dead connection went back to the pool.** It was released normally,
  to be handed to the next request, which then fails for no reason of its
  own.

**Why it's wrong.**
- **No guard on `ROLLBACK`.** It ran unguarded inside the `catch`, so its
  exception replaced the original one.
- **The wrong `release`.** `pg` only discards a client when `release()` is
  given an error.
- **The comments argued about it.** FH (quoting Claude) and am flagged
  both problems; MK and YA's replies ("pg handles it on the next query")
  are not how `pg` behaves.

**Spread / what it breaks.** Both services' transactional writes
(payments, refunds, settlement-facing API calls, the reporting worker). It
shows up during database restarts or network blips, exactly when a clear
error matters most.

**Fix.** If `ROLLBACK` throws, keep its error aside and rethrow the original
one. In `finally`, pass the rollback error to `release()` so the broken
client is destroyed. Applied to both copies, which MK's comment asks to
keep in sync.

**Tests.** New `withTransactionRollback.test.ts` in both packages, using a
fake pool whose `ROLLBACK` throws:
- The caller gets the original error, and `release` receives an error.
- A normal rollback and a normal commit release with no error.

Before the fix the caller saw "Connection terminated unexpectedly". After
it, all pass, and both packages typecheck.
