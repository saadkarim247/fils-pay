# Checkout capacity (2026-10-30)

The judges' scenario is a fixed checkout under load. Ours: a buyer opens a
payment link and pays it (`GET /v1/payment-links/:token`, then
`POST …/pay`). This ran on the production-shaped stack (`ops/docker-compose.yml`
alone: API 0.5 vCPU / 512 MB, whole stack 1 vCPU, `NODE_ENV=production`),
30 s per load step, each step on fresh links.

## Our estimate (live box)

Measured on the Dilmune server (1 vCPU / 2 GB, API 0.5 vCPU / 512 MB) with k6
over HTTPS from a laptop, after bug 75. Times are client-side, so they
include ~0.2 s of network round trip per request.

| | |
|---|---|
| **Sustained** | **~16 checkouts/s** (~58,000 an hour), 0 errors |
| **Peak accepted** | ~18 checkouts/s |
| **Below the limit** | 10/s offered: all 301 served, none turned away, p95 3.0 s |
| **Past the limit** | Excess gets `503` + `Retry-After`: 1–3 ms on the server, ~0.2 s at the client (network); 0 errors at 60/s offered |
| **Correctness** | All four money invariants hold after every run |
| **Bottleneck** | Postgres CPU at its 0.3 vCPU limit (~14 ms of CPU per checkout); the API uses ~19 % of a core out of its 50 % |

![Live capacity before vs after bug 75](2026-10-30-live-capacity.png)

**Bug 75, found on the live box.** The first live ramp accepted only ~9/s,
and less on each run. Postgres was throttled at its limit 90–95 % of the
time (kernel cgroup counters; `docker stats` showed ~5 %), because the
balance check on every ledger leg scanned the whole ledger: 29,632 full
scans, 0 index scans. Migration 0085 adds the missing indexes. Postgres CPU
per checkout went 29 → 14 ms, accepted throughput ~9 → 16–18/s, and there
were 0 full scans afterwards.

| Offered (per s) | Before 75: accepted, p95 | After 75: accepted, p95 |
|---|---|---|
| 10 | 9.7, 4.8 s | **10.0, 3.0 s** |
| 20 | 10.5, 4.6 s | **16.3, 3.1 s** |
| 30 | 8.9, 6.0 s | **18.1, 2.9 s** |
| 40 | 8.9, 5.3 s | **17.4, 3.1 s** |
| 60 | 9.3, 5.2 s | **15.5, 3.2 s** |

Accepted throughput eases slightly at 60/s offered: the box also spends CPU
terminating TLS and answering ~45 refusals a second.

## The laptop runs (before the live box)

![Checkout capacity before vs after](2026-10-30-checkout-capacity.png)

Measured on the laptop before bug 75 was found; the "Postgres CPU"
bottleneck named below was largely that bug.

| | |
|---|---|
| **Sustained (laptop)** | **20 checkouts/s** (~72,000 an hour): all served, p95 1.3 s, 0 errors |
| **Peak served** | ~22–23 checkouts/s (p95 2.0–2.5 s) |
| **Past the limit** | Excess gets `503` + `Retry-After` in **1 ms** (p95); 0 errors at 3× capacity (60/s offered) |
| **Crash** | Docker restarts the API in ~7 s; checkouts cut off mid-flight are repaired within ~60–75 s; no money lost, none charged twice |
| **Bottleneck** | Postgres CPU at its 0.3 vCPU cap. API: 10–20 % of its 0.5 vCPU, ~100–115 MB of 512 MB |

## What the first measurement found

| Offered (per s) | Before: served, p95, errors | Shedding, pool 5 | Shedding, pool 20 |
|---|---|---|---|
| 10 | 10.0, 2.4 s, 0 | 9.5, 1.0 s, 0 | **10.0, 0.7 s, 0** |
| 20 | 15.2, **20.7 s**, 0 | 10.2, 1.1 s, 0 | **20.0, 1.3 s, 0** |
| 30 | 15.2, **27.5 s**, **161** | 9.6, 1.2 s, 0 | 23.7, 2.0 s, 0 |
| 40 | 14.4, **28.8 s**, **410** | 9.9, 1.2 s, 0 | 21.6, 2.5 s, 0 |
| 60 | — | — | 21.5, 2.3 s, 0 |

**Before** (original code): past ~10/s nothing was turned away. Requests
queued for a database connection (pool of 5, held through each 100–400 ms
acquirer call), waited up to 5 s, then failed. Worse, **money went wrong**:
checkouts that failed part-way left 73 links "paid" with the money only
authorized, 41 open authorizations holding buyers' cards, and 276 links
stuck reserved. The CPU was nearly idle; the pool was the limit.

## Fixes, in order

1. **Bug 73:** each checkout step now undoes what came before it when it
   *throws* (e.g. a pool timeout), as it already did for a returned failure.
2. **Load shedding:** once requests are already queued for a database
   connection, new ones get an immediate `503` + `Retry-After` (health
   checks exempt). Latency stays flat instead of climbing to 28 s.
3. **Pool size 5 → 20** (`PG_POOL_MAX`): connections mostly wait on the
   acquirer, so more of them double throughput on the same CPU, until
   Postgres CPU becomes the limit.
4. **Bug 74:** a crash kills checkouts where no undo can run. Recovery at
   boot and every minute undoes any checkout abandoned longer than the
   60 s reservation timeout.

## Correctness checks after every run (`perf/checkout/invariants.sql`)

- Every paid link has exactly its captured transaction, for its amount.
- No link is left reserved.
- No captured sale sits behind an unpaid link.
- No authorization is left open.

The original code failed three of these under load. After the fixes, every
run passes, including the crash run (checked after the recovery pass).

## Reproduce

```bash
docker compose -f ops/docker-compose.yml up -d                 # production-only stack
perf/checkout/run.sh <label> "10 20 30 40 50 60" 30s           # ramp; writes results-<label>.jsonl
perf/checkout/crash.sh 20                                      # kill the API mid-load, then check
node perf/checkout/chart.mjs                                   # laptop chart
perf/checkout/run-live.sh live-after75 "10 20 30 40 60" 30s  # live ramp over HTTPS
node perf/checkout/chart-live.mjs                              # live chart
```

**Caveats.** The load generator ran on the same laptop. Docker's CPU limits
copy the *share* of a CPU, not the live box's core speed: the live numbers
above are the ones to submit. The acquirer is the in-process
simulator (100–400 ms per call, ~2 % declines). Its idempotency caches are
unbounded maps, which stayed flat at test scale but grow without limit over
a long life.
