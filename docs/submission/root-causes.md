### 4.7 Root causes

The 79 findings come from eight underlying causes. The first one kept most of the others in place.

| Root cause | The decision behind it | Findings | Guard that prevents a repeat |
|---|---|---|---|
| **1. Unverified claims beat the ADRs** | AI rule files said money is in cents, settlement is UTC, float32 is "intentional" and tests must never change. "Claude says" comments, locked tests and docs that were wrong did the rest. | 60; kept 13, 14, 15, 16, 18, 27, 39, 49, 50… in place | Rewritten `CLAUDE.md` (ADRs first, every claim verified). Each changed test cites the rule it follows. |
| **2. Money outside integer fils** | Each service did its own maths: a cents parser, float32, int32 counters, each part of a split rounded alone, the fee rule written twice. | 13, 15, 18, 19, 21, 29, 41, 48, 50, 57, 69 | One money library. `BIGINT` fils. Tests that the parts add up to the total. A TS = Go parity table. |
| **3. Trusting the caller** | Ownership was checked against the URL or body, not the row. The code trusted the buyer's clock, unsigned callbacks, display names, file names and `Math.random`. | 02–08, 10–12, 22, 26, 36, 38, 44–47, 54, 59, 61 | Scope by the authenticated merchant. Roles on every admin route. Signatures on exact bytes. Server time. `node:crypto`. |
| **4. Read-then-write, no DB guarantee** | Check, then write in another step. No locks, no `UNIQUE` or `CHECK`. "These never overlap" was assumed. | 14, 20, 23–25, 27, 28, 37, 43, 49, 53, 66, 70, 73, 74 | Row locks, relative updates, unique keys (0074–0078), compensation and a recovery pass. |
| **5. Derived state not rebuilt from the ledger** | Balances came from scheme lines. Paid batches were rewritten. The reporting cursor followed ids. New events weren't carried downstream (refunds). | 09, 16, 30–35, 39, 42, 51, 58, 63, 78 | ADR-0007: rebuild from the ledger. Paid history is immutable. Commit-ordered reads. |
| **6. Bahrain business day** | Day windows came from the UTC date. Unfinished days could be closed. The seed avoided 00:00–03:00. | 17, 40, 56, 65 | One Bahrain-day helper. Half-open ranges. Tests at 00:00–03:00 Bahrain. |
| **7. Migrations, deploys, secrets** | Never migrated a fresh DB. Reserved numbers were reused. Secrets and seed passwords were committed. Missing `NODE_ENV` meant dev mode. | 01, 62, 68, 71, 72, 76 | Fresh-DB migration test. Per-deploy secrets. The API refuses to start without `NODE_ENV`. |
| **8. Never load-tested** | No indexes on hot paths, per-row batch jobs, unbounded exports and caches. One bad row stalled a worker. | 52, 55, 64, 67, 75, 77, 79 + N+1 | Profiling harness, live load test with invariants, indexes (0085, 0086). |
