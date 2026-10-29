# 13 · CSV balance corrections post one tenth of the amount

**Severity:** Critical (real ledger postings wrong by 10×) · **Area:** `apps/api/src/admin/adjustmentCsvParsing.ts`

**What's wrong.** Finance uploads a CSV of balance corrections in BD
("4.75", "120.00"). Every amount is posted at **one tenth** of its value,
and the third decimal is silently dropped.

**Why it's wrong.** The parser called a helper, `parseDecimalMinor(raw,
decimals = 2)`. It treats amounts as cents, two decimal places, so "4.75"
became 475 fils (0.475 BD). FilsPay money is fils: 1 BD = 1000 fils, with 3
decimals (ADR-0001, the brief). The money package already has the correct,
audited parser, `parseBhdToFils`, and it wasn't used. This is the "money in
cents" rule from the planted CLAUDE.md, made real.

**Spread / what it breaks.** Every imported row writes real ledger legs and
moves the merchant's balance:
- "4.75" → 0.475 BD
- "120.00" → 12.000 BD
- "4.755" → 0.475 BD (the last fil is lost)
- "0.005" → 0 (the row vanishes)
- More than 3 decimals was accepted and truncated.

Evidence: Slack #fp-finance, 27 Aug. A 4,141.90 BD sheet posted 414.190 BD.
The test reproduces that exact figure.

**Fix (one call).** Parse with `parseBhdToFils`. It reads 3 decimals and
rejects anything malformed, so a bad row fails the whole import. The
now-unused cents helper `lib/decimal.ts` is deleted.

**Tests.** New file `apps/api/src/admin/adjustmentCsvAmount.test.ts`,
16 tests:
- **8 parse cases:** 4.75 → 4750 and 4141.90 → 4,141,900 among them, plus a
  negative.
- **5 rejected inputs:** four decimals, a comma decimal, `1e3`, text, and
  empty.
- **3 end-to-end imports through the admin route:**
  - The 4,141.90 sheet credits 4,141.900 BD.
  - Three decimals and a negative net to the exact fil.
  - A four-decimal row rejects the whole import, posting nothing.

Before the fix, 12 of 16 failed: 414,190 instead of 4,141,900. After it,
all pass.

**Existing tests corrected.** `adjustmentImport.test.ts` and
`adminAdjustmentImport.test.ts` asserted the cents values: 475, 125, 600,
350 and 500, each now ×10. Each changed line is commented. All 38 import
tests pass. Full suite (fresh database): no new failures.

**Clean-up needed in production.** Every past import is under-posted. Each
row keeps its `raw_amount_text`, so correcting entries can be computed
exactly: `parseBhdToFils(raw) − parsed_amount_fils`, per row.
