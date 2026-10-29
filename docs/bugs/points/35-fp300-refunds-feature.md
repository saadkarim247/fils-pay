# 35 · FP-300: Refunds, built end to end

**What it is.** The missing feature from the brief ("looks easy. it isn't.
it touches everything"). Merchants can refund a captured payment, fully or
in parts, from the API or the dashboard.

**Why it wasn't "just wiring".** HANDOVER, ONBOARDING and the code comments
all said the engine was "done, tested" and needed only a route ("half a
day", "30 min job"). It wasn't safe to expose. Notes 25–34 cover the ten
bugs fixed first:

| # | Bug | Area |
|---|---|---|
| 25 | No reason → money out, nothing recorded | engine |
| 26 | Could refund another merchant's sale | engine |
| 27 | Could refund more than was captured | engine + DB |
| 28 | Concurrent refunds all paid out (FP-209) | engine |
| 29 | Fee reversal didn't add up, ignored discount | engine |
| 30 | Settlement paid out refunded money | Go settlement |
| 31 | Reconciliation couldn't explain refunds | API report |
| 32 | No refund webhook | webhooks |
| 33 | Refund summary always empty | reporting |
| 34 | Refunded transaction page crashed | dashboard |

**What this last step adds.**
- **One route, two paths.** `POST /v1/merchants/:merchantId/refunds`
  (dashboard, and `initiateMerchantRefund`'s contract) and `POST
  /v1/refunds` (HANDOVER/ONBOARDING) run the same handler. This settles the
  documented path conflict.
- **The merchant comes from authentication only.** On the merchant path it
  is scope-checked. The body can't override it, unlike the commented
  "Claude draft", which spread the body over the merchant id.
- **Role and key.** Owner/finance sessions or API keys may refund, and
  impersonation is read-only (bug 04). An `Idempotency-Key` header is
  required and never invented server-side; the draft made a random one per
  request.
- **Strict body.** `transactionId` is a UUID, `amountFils` (optional) a
  positive whole number of fils, and `reason` (optional) a string of at
  most 500 characters.
- **The response includes `refundedFils`**, so clients can show what's
  left. A TODO had deferred this.
- **The drawer is restored and fixed.**
  - What's left is captured − refunded, where it was captured.
  - Partially refunded payments can be refunded again.
  - The amount is entered in BD and parsed exactly.
  - The idempotency key is per submission, so a retry can't refund twice;
    it was a new key per click.
  - There's a reason field, and a "Refunded amount" row on the page.

**Tests.**
- **New `apps/api/src/routes/refundsRoute.test.ts`**, 6 tests over real
  HTTP:
  - a partial refund shows `refund_partial −4000` on the timeline;
  - the documented path refunds everything left;
  - the key is required and replays;
  - the body can't pick the merchant (404), and a foreign path gives 403;
  - malformed bodies are refused with nothing refunded;
  - over-refund gives 422 with the refundable amount.
- **New `apps/web/src/pages/transactions/refundForm.test.ts`**, 4 tests:
  what's left, which statuses are refundable, BD parsing, and refusals.
- **Existing test corrected:** `transactions.test.ts` asserted the 501, and
  its own note said to "flip the assertion". It now expects a 400 without
  an Idempotency-Key.
- **Full suite** (fresh database): no new failures. All 5 typechecks pass,
  and the web app builds.

**Live check on the running stack.** 12.500 BD captured. A cookie refund of
5.000 BD (fee back 125), then an API-key refund of the rest. The status
ends at `refunded` and one more fil is refused (409). Platform fee for the
payment is exactly 0, the timeline reads captured 12500, refund_partial
−5000, refunded −7500, and two `refund.succeeded` events were sent.

**Brief's "done when", point by point.**
- Works end to end through the API: yes.
- Ledger right down to the fils: bugs 28 and 29.
- Fees and payouts right: bugs 29 and 30.
- Shop gets the right webhook: bug 32.
- Correct in timeline, reports and reconciliation: bugs 34, 33 and 31.
- Live on Dilmune Cloud: the deployment step, still to do.
