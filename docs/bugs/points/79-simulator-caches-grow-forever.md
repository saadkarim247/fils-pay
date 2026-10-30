# 79 · The acquirer simulator's caches grow until the API restarts

**Severity:** Low (slow memory growth) · **Area:** `apps/api/src/acquirer/simulator.ts`

**What's wrong.** The simulator keeps every authorize, capture and refund
result in in-process maps, so a retried call with the same idempotency key
gets the same answer. Nothing ever removed an entry, so the API's memory
grew with every checkout. A code comment asked "slow leak?", and the reply
was "cleared on restart and we deploy daily. not a leak". Under sustained
load (16–18 checkouts/s live), the growth is constant until the
out-of-memory killer restarts the API.

**Fix.** Each cache keeps the most recent 50,000 entries, evicting the
oldest. That's about 45 minutes of checkouts at full load, while a retry
comes seconds later.

**Tests.** New file `apps/api/src/acquirer/simulatorCacheBound.test.ts`,
with a cap of 3:
- After five keys, a recent key still replays.
- The oldest key no longer replays. Before the fix it did: nothing was
  ever evicted.

The existing simulator idempotency tests pass unchanged.
