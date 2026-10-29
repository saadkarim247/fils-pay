# 20 · The same balance-correction file can be applied twice

**Severity:** High (double ledger postings) · **Area:** `apps/api/src/admin/adjustmentImport.ts`, `db/migrations/0074_adjustment_imports_content_hash.sql`

**What's wrong.** Uploading the same adjustment CSV again posts every row
again: real ledger legs, real balance changes. Nothing detects the
duplicate.

**Why it's wrong.**
- `adjustment_imports` has no uniqueness of any kind.
- AM's comment says "re-upload is blocked by the unique
  original_filename"; no such constraint exists, and a filename would be
  the wrong key anyway.
- A question about it went unanswered (FH: "asked in #fp-backend 14/8, no
  answer").
- ADMIN.md admits the gap: "Don't submit the same file twice; there's no
  duplicate detection yet."

**Spread / what it breaks.**
- Any double-click, retry, or "did it go through?" resubmit doubles a whole
  batch of corrections.
- Evidence: the September audit export. `aug-adjustments-v3-FINAL.csv`
  (31 rows) was applied twice by the same person, 22 seconds apart.

**Fix.**
- **New migration** `0074_adjustment_imports_content_hash.sql`. It adds
  `content_sha256` with a partial unique index; older rows stay NULL.
  Numbered after ADR-0005's reserved range.
- **Fingerprint in `applyAdjustmentImport`.** Each import's rows are
  reduced to (merchant, exact fils, reason) and sorted, so a renamed,
  re-saved or re-sorted copy is still the same import.
- **Rejection happens in the database.** A second copy fails on the index
  before any leg is posted (409 `duplicate_import`), even when two
  submissions race. A failed import rolls back, so it can be resubmitted.

**Tests.** New file `apps/api/src/admin/adjustmentImportDuplicate.test.ts`,
6 tests through the real admin route, each checking the ledger:
- The same file twice gives 409, and it is posted once.
- A renamed copy gives 409.
- CRLF line endings plus extra spaces give 409.
- Two simultaneous submissions give exactly one 201 and one 409.
- A file with one amount changed still applies.
- A rolled-back failed import doesn't block resubmitting.

Before the fix, 4 failed: every copy posted again. After it, all pass, as
do the 38 existing import tests. Full suite (fresh database): no new
failures.

**Trade-off.** A genuinely identical correction can't be applied twice.
Finance can change the reason text if that is ever truly needed.
