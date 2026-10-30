# 62 · A webhook endpoint can't be deleted once it has received anything

**Severity:** Medium (merchants can't remove a URL, e.g. a compromised one) · **Area:** `apps/api/src/webhooks/cancel.ts`, migrations 0022/0068

**What's wrong.** A merchant deletes a webhook endpoint from the dashboard
and gets a 500. It happens for every endpoint that has ever been sent a
delivery, which is nearly all of them.

**Why it's wrong.**
- **Docs and schema disagree.** The delete function's own contract says
  the endpoint is "deleted also when the endpoint had deliveries; those
  rows are kept with endpoint_id set to NULL".
- **The schema made that impossible.** `webhook_deliveries.endpoint_id` and
  `webhook_delivery_archives.endpoint_id` are `NOT NULL` with default
  (`NO ACTION`) foreign keys, so the `DELETE` violates them.
- **FH spotted it; YA's reply was false.** FH asked "then the FK blocks the
  DELETE and we 500?". YA answered "FK is ON DELETE SET NULL (0029)", but
  0029 is a payment-links index.
- **Tests only covered the easy case.** The existing delete tests use
  endpoints with no deliveries.

**Spread / what it breaks.** Every merchant with a live webhook. Disabling
still works, but a merchant can't get rid of an endpoint, e.g. a leaked or
wrong URL, and the console can't clean up.

**Fix.**
- **Migration 0082:** both columns become nullable, and both foreign keys
  become `ON DELETE SET NULL`. The history is kept, exactly as documented.
- **No code changes needed:** every reader (delivery log, replay, the
  dispatcher) joins to the endpoint, so detached rows drop out of live
  views and are never sent.
- The false comment is replaced.

**Tests.** New file `apps/api/src/webhooks/endpointDelete.test.ts`. A real
capture is dispatched to the endpoint and an archive is taken, then the
delete is checked:
- It answers 204.
- The deliveries and the archive remain, with `endpoint_id` NULL.

Before the fix: 500 (`webhook_deliveries_endpoint_id_fkey`). After it, it
passes, along with the existing webhook, archive and dispatcher tests.
