# 37 · Replayed webhooks look like new events, so merchants process them twice

**Severity:** High (duplicate processing on the merchant's side) · **Area:** `apps/api/src/webhooks/replay.ts`

**What's wrong.** When support or a merchant replays a webhook, for
example after the merchant's server was down, each replay goes out with a
**new** `Webhook-Delivery-Id`. The merchant's system can't tell it is the
same event and processes it again.

**Why it's wrong.**
- ARCHITECTURE and CHANGELOG 1.9.1 tell receivers to "dedupe on
  `Webhook-Delivery-Id`". Migration 0022 calls it "the stable id… receivers
  dedupe on this", and YA's note says "replay must reuse
  delivery_event_id".
- The replay code minted a fresh id ("on purpose", per MK), claiming
  receivers dedupe on the outbox event. That id is never sent to them.

**Spread / what it breaks.**
- All three replay paths (single, admin batch, archive restore) share this
  function.
- A replayed `settlement.paid` can make a merchant book a payout twice.
- Evidence: Beta's September export shows one payout's `settlement.paid`
  delivered with 5 different delivery ids, and two others with 3.

**Fix.** A replay reuses the original delivery id, which is also the
envelope's `id`. The dispatcher still signs each attempt with a fresh
timestamp, so freshness checks pass. The original row is untouched, and the
attempt history is kept in the new row.

**Tests.** New file `apps/api/src/webhooks/replayStableId.test.ts`. A real
delivery, then two replays through the merchant route and a dispatch: all
three sends carry the same `Webhook-Delivery-Id` and body `id`.

Before the fix the ids differed. After it, the test passes.

**Existing test corrected.** `routes/webhooks.test.ts` asserted the
replay's id is *different*. Its title and that assertion are flipped.
Webhook, archive and admin tests all pass. Full suite (fresh database): no
new failures.
