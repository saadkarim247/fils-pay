# 75 · Every checkout reads the whole ledger

**Severity:** High (capacity; gets worse every day) · **Area:** `db/migrations/0007_ledger_double_entry.sql`, `apps/api/src/payments/`

**What's wrong.** The ledger's balance check is a deferred trigger that runs
at commit **once per inserted leg** and sums that leg's group:
`… FROM ledger_entries WHERE entry_group_id = $1`. Nothing indexes
`entry_group_id`, so each leg is a full scan of the ledger. Two other hot
lookups have the same gap:
- capture and void release the hold with `… holds WHERE transaction_id = $1`;
- the discount adjustment and refunds read a transaction's legs with
  `… ledger_entries WHERE transaction_id = $1`.

**How it was found.** The live box sustained only ~11 checkouts/s, falling
to ~9.5/s on the next run. The kernel's cgroup counters showed Postgres
throttled at its 0.3 vCPU limit in 90–95 % of scheduling periods, even at
10/s. (`docker stats` had reported ~5 %, which is why the first diagnosis
missed it.) `pg_stat_user_tables` then showed:

| table | rows | seq scans | rows read by seq scans | index scans |
|---|---|---|---|---|
| `ledger_entries` | 23,154 | 29,632 | **331,682,812** | 0 |
| `holds` | 4,390 | 4,380 | 9,636,328 | 0 |

**Why it's wrong.** Each checkout's cost is proportional to the size of the
ledger, so total work grows quadratically. Capacity falls as the business
grows: after one day of load tests it had already dropped by a sixth.

**Spread.** Every ledger write (capture, refund, settlement legs, discount
adjustments), and every capture and void.

**Fix.** Migration `0085_ledger_lookup_indexes.sql` adds three indexes:
- `ledger_entries (entry_group_id)`
- `ledger_entries (transaction_id)`
- `holds (transaction_id)`

The trigger and the queries are unchanged.

**Tests.** New file `apps/api/src/payments/ledgerLookupIndexes.test.ts`
runs `EXPLAIN` on the three lookups with sequential scans disabled. The
planner still has to seq-scan when no index fits, so the test does not
depend on table size. All three fail without 0085 and pass with it.

My first version used `gen_random_uuid()` as the value and still failed
after the migration. A volatile function can't be an index condition, so
it measured nothing. It now binds a parameter, as the real queries do.
