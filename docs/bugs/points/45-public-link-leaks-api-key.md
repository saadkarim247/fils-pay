# 45 · The public payment-link page leaks the merchant's API key material

**Severity:** Medium · **Area:** `apps/api/src/paymentLinks/read.ts`

**What's wrong.** Anyone who opens a payment link (a buyer, or anyone the
URL is forwarded to) receives the merchant's newest live **API key prefix**
(its first 16 characters) and the key's full **SHA-256 hash**.

**Why it's wrong.**
- `GET /v1/payment-links/:token` is unauthenticated. Its own contract says
  it "contains nothing that identifies or authenticates the merchant beyond
  its display name".
- The query joined the merchant's newest live API key just to return those
  two values. The checkout page never uses them.

**Spread / what it breaks.**
- Every link URL becomes a starting point for an offline brute-force of the
  merchant's live API key: part of the key plus its exact hash.
- An API key can authorize payments and read all of the merchant's data.
- It also lets anyone tell when a merchant rotates its key.

**Fix.** The public read no longer touches `api_keys`. Both fields
(`merchantPublicKey`, `merchantIntegrationId`) are removed from the query
and from the public shape.

**Tests.** New file `apps/api/src/paymentLinks/publicLinkNoKeyLeak.test.ts`:
the public response contains neither the key prefix, nor the hash, nor any
part of the raw key, and the display name still shows.

Before the fix the prefix was in the body. After it, the test passes.

**Existing test corrected.** `routes/paymentLinks.test.ts` asserted the
prefix *is* exposed (`startsWith("fp_")`). It now asserts that it isn't.
All 30 payment-link tests pass. Full suite (fresh database): no new
failures.
