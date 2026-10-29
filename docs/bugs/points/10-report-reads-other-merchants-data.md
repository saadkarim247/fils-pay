# 10 · Any merchant can read a marketplace sub-merchant's transactions

**Severity:** High (cross-merchant data leak) · **Area:** `apps/api/src/reporting/scope.ts`

**What's wrong.** The transactions report takes an optional `merchantId`
filter, so that a marketplace can report on its own sub-merchants. Any
merchant can pass the id of **any** sub-merchant, even one in someone
else's marketplace, and get that shop's transactions back.

**Why it's wrong.**
- `resolveReportMerchantId` only checks that the requested id is somebody's
  child in `merchant_split_children`.
- It never checks that the parent is the caller. One missing
  `AND parent_merchant_id = $caller`.

**Spread / what it breaks.**
- Every sub-merchant on the platform is exposed to every merchant and API
  key. In the seed that means Delta Marketplace's three shops: Coral Bay,
  Palm Grove and Seef Kiosk.
- A report returns up to 500 transactions, with amounts, statuses, dates and
  the merchant's own order references. That's competitors' sales data, and
  it breaks the "every merchant sees only their own data" promise the whole
  API is built around.
- Merchant ids are not secret: they appear in payment links, receipts and
  webhooks.

**Fix (one line).** Add `AND parent_merchant_id = $2` (the caller) to the
check. Anything else still falls back to the caller's own report, as
before.

**Tests.** New file `apps/api/src/routes/reportingScope.test.ts`, 6 tests.
There are two marketplaces and an unrelated merchant, each calling the real
endpoint with its own API key:
- An outsider, the other marketplace's parent, and the other marketplace's
  child all fail to get marketplace A's child's rows.
- Marketplace A's parent still gets its own child's rows.
- A non-child id, or no id, gives the caller's own report.

Before the fix, the 3 "cannot read" tests failed. After it, all 6 pass, the
existing reporting tests are unchanged and passing, and the full suite (on a
fresh database) shows no new failures.

Also replayed on the running stack. A new outsider merchant asked for
Coral Bay's report, which held a private test order. It got none of Coral
Bay's rows. The test order was removed afterwards.
