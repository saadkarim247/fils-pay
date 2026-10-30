## 3. Capacity

**Estimate: about 1,200 simulated buyers a minute (20 checkouts/s) with no errors. That is ~600 buyers on the site at once if each pauses 30 s before paying.** Above that, extra buyers get an immediate `503` + `Retry-After: 1` and no money moves.

### 3.1 Performance: profiling found N+1 queries in the batch jobs

**How we profiled.**
- `perf/batch-n-plus-1/run.sh` starts a throwaway Postgres with `log_statement=all` and loads one fixed dataset (2,003 merchants, 100 of them active).
- It runs each batch operation 3 times on a fresh copy of that data.
- Every statement Postgres logged is one database round trip. Time is the median of the 3 runs.

The logs showed four jobs issuing **one round trip per row**:
- **Nightly settlement:** about 24 statements per merchant, including the ~95 % that had no sales that day.
- **Scheme file:** one `INSERT` per line, and per residue pair.
- **Webhook replay:** one `INSERT` per delivery.
- **Recompute statuses:** one `UPDATE` per transaction.

**Fix.** Each job became set-based:
- idle merchants get their zero batch in one statement;
- scheme lines and residue are written with `INSERT … SELECT FROM unnest(…)`;
- replays and status changes go in one statement each.

Merchants with sales keep the unchanged per-merchant path.

| Operation | Round trips before → after | Time before → after |
|---|---|---|
| Nightly settlement run (2,003 merchants) | 48,370 → **2,833** (17× fewer) | 21.1 s → **4.0 s** |
| One large batch (2,000 captures) | 3,829 → **31** (124× fewer) | 2.2 s → **0.9 s** |
| Admin replay batch (500 deliveries) | 505 → **6** | 261 → **94 ms** |
| Recompute statuses (2,000 transactions) | 2,003 → **4** (501× fewer) | 727 → **81 ms** |

![Batch N+1: round trips and time, before vs after](../perf/2026-10-30-batch-n-plus-1.png)

**Same results, proven two ways:**
- **Differential run.** The old and new settlement binaries, run on two copies of the data, produced identical totals for every batch, ledger account, scheme line, disbursement and outbox event.
- **Tests.** New tests pin the round-trip counts and fail on the old code.

**Why it matters:** the settlement daemon shares the one vCPU with checkout. It now holds the database for 4 s a night instead of 21 s, and its cost grows with merchants who traded, not with every merchant onboarded.

### 3.2 Live load test: tool, method, results

- **Tool:** k6 with `constant-arrival-rate` (`perf/checkout/checkout.js`). A simulated user opens a payment link, then pays it.
- **Method:** `perf/checkout/run-live.sh` drives the **live box** over HTTPS in 30 s steps. It reads CPU from the kernel's cgroup counters.
- **Money invariants:** after every run, `invariants.sql` checks that:
  - every paid link has exactly one capture for its amount;
  - no link is stuck reserved;
  - no authorization is left open.

| Offered/s | Accepted/s | Refused (503) | Errors | p95 |
|---|---|---|---|---|
| 10 | 10.0 | 0 | 0 | 1.6 s |
| 20 | **20.0** | 0 | 0 | 2.1 s |
| 60 | 21.0 | 1,170 | 0 | 2.6 s |
| 150 | 16.6 | 4,003 | **0** | 3.5 s |

**Users estimate.**
- Users per minute = 20/s × 60 = **1,200**.
- Users on the site at once = 20 × (think time + 1.05 s). At 30 s of think time that is ~620.

### 3.3 Where the bottleneck was, and is

- **The live test exposed bug 75.** Throughput was stuck at ~9/s. The kernel counters showed Postgres throttled at its CPU cap 90 % of the time, while `docker stats` showed it at ~5 %. Postgres's own counters gave the cause: 29,632 full scans of `ledger_entries` and 0 index scans. The balance trigger and the hold release looked up columns with no index.
- **Fix:** three indexes (migration 0085). Postgres CPU per checkout went 29 → 14 ms, and throughput went ~9 → 16–18/s, then 20/s after re-balancing the CPU caps.
- **Now:** the limit is the 20 database connections, each held through the 100–400 ms acquirer call. The single vCPU is next: about 72 % busy at 60/s offered.

![Live capacity before vs after bug 75](../perf/2026-10-30-live-capacity.png)

### 3.4 Turning away excess load, and recovering

- **Load shedding:** when requests are already queued for a connection, a new one gets `503` + `Retry-After: 1` in 3–4 ms instead of waiting. Before this, the original code queued everything:
  - at 40/s offered, p95 was 28.8 s with 410 errors;
  - failed checkouts left 73 links "paid" with the money only authorized (bug 73).
- **Crash recovery:** we killed the API mid-run with `kill -9` (laptop, same limits).
  - Docker restarted it in ~7 s.
  - The recovery pass (bug 74) repaired every interrupted checkout within ~75 s.
  - All money invariants held.

Full detail: `docs/perf/2026-10-30-checkout-capacity.md` and `docs/perf/2026-10-30-batch-n-plus-1.md`.
