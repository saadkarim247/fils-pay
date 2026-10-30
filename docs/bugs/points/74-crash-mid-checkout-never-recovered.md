# 74 · A crash mid-checkout leaves sales in limbo forever

**Severity:** High ("restarts itself and recovers without losing data") · **Area:** `apps/api/src/paymentLinks/`, `apps/api/src/index.ts`

**What's wrong.** If the API process dies during a checkout (crash, OOM
kill, redeploy), whatever step was running never finishes and no undo code
runs. Killing the API at 20 checkouts/s left, after it restarted:
- 7 links **paid** with the money only **authorized**;
- 17 links stuck **reserved**;
- 9 **authorizations no link points to**.

Nothing ever repaired them: the merchant believes those sales happened, and
the buyers' cards stay held.

**Why it's wrong.** Docker brings the process back, but a payment system
must also bring its *data* back to a consistent state. The only
self-healing was the 60 s reservation timeout, which lets another buyer
reclaim a reserved link but does nothing for money already authorized.

**Spread / what it breaks.** Every checkout in flight at any restart:
crashes, out-of-memory kills, and every routine redeploy.

**Fix.** `recoverAbandonedCheckouts` runs once at boot and then every minute.
It only touches states older than the reservation timeout, since anything
newer may still be in flight. It applies the same undo as a failed capture:
- **Paid link, money only authorized:** un-commit the link and void the
  authorization.
- **Link stuck reserved:** release it.
- **Pay-flow authorization that no link points to:** void it. It's
  identified by its `paylink:…:authorize` idempotency key.

Every change is a guarded conditional `UPDATE` and voiding is idempotent,
so running it repeatedly or concurrently is safe.

**Tests.** New file `apps/api/src/paymentLinks/recoverAbandoned.test.ts`:
- Each abandoned state is repaired.
- A checkout only seconds old, and a finished sale, are left alone.
- A second pass changes nothing.

A no-op implementation fails it (the link stays `paid`).

**Live check (`perf/checkout/crash.sh`).** At 20/s, the API was hard-killed
20 s in. Docker restarted it in ~7 s, and the first periodic pass repaired
7 + 17 + 9 states. All invariants then held. The boot pass also repaired
the debris from the earlier runs (86 + 285 + 42).
