# 51 · Dashboard analytics permanently miss events that commit late

**Severity:** High (charts and rollups silently under-count) · **Area:** `apps/reporting/src/consumer/runConsumerPass.ts`, `cursor.ts`, `db/migrations/0079_outbox_commit_order.sql`

**What's wrong.** The reporting worker builds the merchant dashboard's daily
volume and payout charts from the outbox. Under normal concurrent load,
some captures are **never counted**, and the chart stays low forever.

**Why it's wrong.**
- The worker reads `WHERE id > cursor`, then moves the cursor to the
  highest id it saw.
- Ids are handed out when a row is **inserted**, not when its transaction
  **commits**. If a slower transaction holding id 10 commits after id 11
  has already been processed, event 10 sits below the cursor and is
  skipped.
- HANDOVER lists the fix as unfinished ("outbox consumption by commit order
  instead of id"). MK's comment "ids… are monotonic. fine for now" is about
  insertion order, which isn't the problem.

**Spread / what it breaks.** Any two overlapping writes: a slow capture and
a fast one, or settlement closing while captures continue. The dashboard
under-reports volume with no error anywhere.

**Fix.** Consume in **commit order**.
- New migration `0079` stamps every outbox row with the id of the
  transaction that wrote it (`txid xid8`, filled by default, so the Go
  service needs no change). The cursor becomes the pair (`txid`, `id`).
- The worker only reads rows whose transaction is older than every
  transaction still running (`pg_snapshot_xmin`). Those are final and can
  never be overtaken. It reads them in (`txid`, `id`) order.
- Existing consumers resume where they were: pre-migration rows share the
  migration's `txid`, and the cursor is set to it.

**Tests.** New file `apps/reporting/src/consumer/lateCommit.test.ts`, on
its own fresh database, with two connections:
- A transaction inserts a capture event and stays open. A second capture
  event commits and the worker runs. Then the first commits and the worker
  runs again. Both captures must be counted.
- Re-running applies nothing twice.

Before the fix only 1 of the 2 was ever counted. After it, both pass. Full
suite (fresh database): no new failures, and all typechecks pass.
