# 46 · The export-summary endpoint has no authentication (and always crashes)

**Severity:** Low · **Area:** `apps/api/src/routes/reporting.ts`

**What's wrong.** `GET /v1/reporting/export-summary` was registered without
any authentication guard. It reads `request.merchantAuth`, which nothing
had set, so every request crashed with a 500, with or without valid
credentials.

**Why it's wrong.** Every other `/v1/reporting` route takes
`requireMerchantAuth`, and this one is merchant data too. The missing guard
is a latent data leak waiting for the next small code change: one fallback
for the merchant id and it would answer anyone.

**Spread / what it breaks.** The endpoint is unusable for merchants, and it
fails open in design.

**Fix (one argument).** Add `{ preHandler: requireMerchantAuth }`.

**Tests.** New file `apps/api/src/routes/reportingExportSummaryAuth.test.ts`:
- no credentials gives 401;
- the merchant's API key gives 200 with that merchant's own figures (1 day,
  7,500 fils).

Before the fix both returned 500. After it, both pass. Full suite (fresh
database): no new failures.
