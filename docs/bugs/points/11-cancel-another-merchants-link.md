# 11 · Any merchant can cancel another merchant's payment links

**Severity:** High · **Area:** `apps/api/src/paymentLinks/cancel.ts`

**What's wrong.** Merchant B can cancel merchant A's payment links, and can
probe the status of any link id.

**Why it's wrong.** The route checks that the merchant in the URL is the
caller. The cancel query then matches the link by id alone:
`WHERE id = $1 AND status = 'active'`, with no `merchant_id`. A code comment
claims the route's check "is the ownership check"; it only checks the URL,
not the link. A failed cancel also returns 409 with the link's status, so a
foreign link's state leaks.

**Spread / what it breaks.**
- A competitor or a disgruntled ex-partner can kill a merchant's live
  checkout links: invoices, donation pages, deposits. Buyers then can't pay.
- Link ids appear in URLs and emails, so they are easy to collect.
- The brief's group chat: "merchant A cancelled merchant B's payment link".

**Fix.** Both queries in `cancelPaymentLink` now take the merchant id and
filter on it. A link that belongs to someone else is "not found" (404), the
same as one that doesn't exist.

**Tests.** New file `apps/api/src/routes/paymentLinkCancelScope.test.ts`,
with links created through the real API by two merchants:
- B cancelling A's active link gets 404, and the link stays active.
- B probing A's cancelled link gets 404 with no status in the body.
- The owner can still cancel (204), and cancelling twice gives 409.

Before the fix, B's cancel returned 204 and the probe returned 409
`canceled`. After it, all pass, along with the existing payment-link tests.
Full suite (fresh database): no new failures.
