# 63 · "Rebuild one merchant's balance" reports success and changes nothing

**Severity:** Medium (the documented repair silently fails) · **Area:** `apps/settlement/internal/ledger/rebuild.go`, `cmd/settlement/main.go`

**What's wrong.** When one merchant's cached balance is wrong, the RUNBOOK
says to run `settlement rebuild-balances --merchant=<uuid>`. It prints
`rebuilt=<n>` with the correct figure, but the merchant's balance stays
wrong.

**Why it's wrong.**
- **It never writes.** `RebuildMerchantBalance` ran only a `SELECT`: it
  summed the merchant's ledger and returned the number, but never wrote
  `merchant_balances`. The all-merchant rebuild does write.
- **The comment is false.** AM's comment says "--merchant writes the cache
  for that one merchant, same as the full rebuild".
- **The tests never looked.** They checked only the returned number, never
  the cache, so they passed.

**Spread / what it breaks.** Every single-merchant balance repair (the
FP-203 kind of incident). The operator sees the right number on screen,
closes the ticket, and the dashboard and payouts still use the wrong
cached balance.

**Fix.** One statement computes the ledger figure and upserts it into
`merchant_balances`, returning what was written. The CLI output and the
function's signature are unchanged, and the false comment is replaced.

**Tests.** New file `rebuild_merchant_writes_test.go`. A merchant with
ledger legs of +10,000 and −2,750 fils and a cache wrongly set to 1 is
rebuilt:
- The cache becomes 7,250 fils.
- Another merchant's cache is untouched.

Before the fix the cache stayed at 1. After it, it passes, along with every
other ledger test (including bug 39's console-vs-CLI check).
