# 64 · 100 undeliverable webhooks stop every merchant's webhooks

**Severity:** Medium (platform-wide webhook outage from one bad endpoint or a key change) · **Area:** `apps/api/src/webhooks/dispatcher.ts`

**What's wrong.** If a delivery fails *before* it is sent (e.g. its
endpoint's signing secret no longer decrypts), the dispatcher skipped it and
left it exactly as it was. Once 100 such deliveries pile up, no webhook for
any merchant is ever sent again.

**Why it's wrong.**
- **The skipped row stays first in line.** Each pass takes the 100 oldest
  due deliveries (`ORDER BY next_attempt_at LIMIT 100`). A skipped row
  keeps its old `next_attempt_at`, so it stays among the oldest forever.
  With 100 of them, every pass picks the same 100, throws on all of them,
  and never reaches anyone else.
- **The comment promises the opposite.** It says a bad row "degrades to
  'this one row never progresses' rather than 'webhook delivery silently
  stops platform-wide'". That's true only below 100.
- **It never shows up anywhere.** The row never gains an attempt, so it
  never becomes `exhausted`, never appears as failed to support, and just
  logs an error every pass.

**Spread / what it breaks.** Every merchant's `transaction.*`,
`settlement.paid` and `refund.succeeded` webhooks. The natural trigger is
rotating `WEBHOOK_SECRET_ENCRYPTION_KEY`: every older endpoint's deliveries
become undecryptable at once. The polluted dev database earlier had 102
such rows, just over the limit.

**Fix.** A throw before or around the send is recorded like any failed
attempt:
- `attempt_count + 1` and the normal backoff on `next_attempt_at`;
- `exhausted` at the attempt limit;
- the error saved in `response_body_excerpt`.

A transient fault still retries; a permanent one ends up `exhausted` and
visible for replay once fixed.

**Tests.** New file `apps/api/src/webhooks/dispatcherPoison.test.ts`: 100
deliveries to an endpoint with a corrupted secret, all older than one
healthy merchant's delivery.
- The healthy webhook is sent within 2 passes.
- The broken rows are backed off with an attempt recorded.

Before the fix the healthy webhook was never sent in 3 passes. The existing
isolation test in `dispatcher.test.ts` required the poisoned row stay
untouched (attempt 0), which is the behaviour that caused this. It now
expects one recorded, backed-off attempt, with a comment. All dispatcher
tests pass.
