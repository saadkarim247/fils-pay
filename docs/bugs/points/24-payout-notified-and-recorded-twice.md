# 24 · Payouts get duplicate notifications and duplicate disbursement records

**Severity:** Critical (a disbursement row is a payout-rail instruction; incident 2026-08-21) · **Area:** `apps/settlement/internal/settlement/payout_notify.go`, `batch.go`, `splits/allocate.go`, `apps/api/src/webhooks/dispatcher.ts`

**What's wrong.** When a batch is paid, the merchant should get exactly one
"payout sent" notification (`settlement.paid`), and the payout should have
exactly one disbursement record. Both can happen several times.

**Why it's wrong.** There are two separate faults.
1. **Duplicate events.** The notify scan checks `NOT EXISTS`, then INSERTs,
   with no lock and no unique key. The daemon and an operator's CLI run at
   the same time both insert. The code comment's reassurance that
   "outbox_events has a unique index on (event_type, aggregate_id)" is
   false.
2. **Disbursements written by the wrong component.** The API's webhook
   dispatcher wrote the disbursement as a side effect of delivering the
   webhook, once per delivery row. That means once per merchant endpoint,
   again for every replay, again for each duplicate event, and **never**
   for a merchant with no webhook endpoint. ARCHITECTURE says the *pay*
   step records the disbursement.

**Spread / what it breaks.**
- Merchants see the same payout announced twice and may book it twice.
- Duplicate disbursement rows are duplicate payout instructions.
- Evidence: the 2026-08-21 review in ADMIN.md ("two disbursement records
  each"). Its stated root cause, a NOTIFY replay, is contradicted by AM's
  own note that the two deliveries had *different outbox event ids*. That
  is fault 1.

**Fix.**
- **Disbursement at payout.** It is now recorded inside `PayoutBatch` and
  `PayoutSplitBatch`, in the same transaction that holds the batch lock and
  marks it paid: exactly once per paid batch, whether or not the merchant
  has webhooks. The shared insert lives in a new small package,
  `internal/disbursement`.
- **Delivery only notifies.** The dispatcher's disbursement side effect is
  removed, along with `payoutDisbursement.ts` and its unit test.
- **Notify serialised per batch.** Each insert takes the batch row lock and
  re-checks under it, so concurrent scans enqueue one event. There is no
  new unique index, which couldn't be built over the duplicates already in
  production.

**Tests.**
- New file `internal/settlement/payout_disbursement_test.go`:
  - `PayoutBatch` (run twice) records exactly one disbursement, for the net
    payout.
  - A split payout records exactly one.
  - Four concurrent notify runs over 12 paid batches: each batch gets
    exactly one `settlement.paid`.
- New file `apps/api/src/webhooks/settlementPaidNoDisbursement.test.ts`:
  delivering to two endpoints notifies both and writes no disbursement.

Before the fix: 0 disbursements at payout, 4 events per batch, and 2
disbursements from the dispatcher. After it, all pass, as do the existing
notify and dispatcher tests (except the known flaky backoff test). Full
suite (fresh database): no new failures.
