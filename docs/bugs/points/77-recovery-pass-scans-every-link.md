# 77 · The recovery pass reads every link, every minute

**Severity:** Medium (cost grows forever) · **Area:** `apps/api/src/paymentLinks/recoverAbandoned.ts`

**What's wrong.** The abandoned-checkout recovery from bug 74 runs every
minute to find a handful of rows, but read whole tables to do it. On the
live box (34k links), `EXPLAIN ANALYZE` showed:
- **Stuck reservations:** a full scan of `payment_links`, 78 ms.
- **Orphaned authorizations:** another full scan of `payment_links`, plus
  every `idempotency_keys` row, 96 ms. The join cast two UUID columns to
  text, so no index could ever serve it.

That's ~185 ms of Postgres time every minute, growing with every link ever
created, on the database that limits checkout capacity.

**Fix.**
- Migration `0086_recovery_pass_indexes.sql` adds four indexes:
  - partial: reserved links by `reserved_at`;
  - partial: still-authorized transactions by `created_at`;
  - `payment_links (transaction_id)`;
  - `idempotency_keys (resource_id)`.
- The orphan query compares the UUIDs directly, through `EXISTS`.
- The statements are exported as `RECOVERY_SQL`, so the test plans exactly
  what runs.

**Tests.** New file `apps/api/src/paymentLinks/recoverAbandonedIndexes.test.ts`
plans each statement with sequential scans disabled. Before the migration,
`stuckReserved` and `orphans` failed (`stuckPaid` was already served by an
existing partial index). With it, all three pass, and the existing
recovery behaviour test still passes on the rewritten query.
