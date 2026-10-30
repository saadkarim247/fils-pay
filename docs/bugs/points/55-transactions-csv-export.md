# 55 · Transactions CSV export: whole history in memory, formulas run in Excel

**Severity:** Medium (API crash for big merchants; spreadsheet injection) · **Area:** `apps/api/src/transactions/exportCsv.ts`, `routes/transactions.ts`

**What's wrong.**
1. **Memory.** The export loads every matching row, builds one big string
   and sends it. `from`/`to` are optional, so "export all" on a large
   merchant does this for its entire history.
2. **Formulas.** A reference like `=HYPERLINK("http://evil…","Click")` or
   `+971…` is written as-is. A finance user opening the file in Excel or
   Sheets runs it as a formula.

**Why it's wrong.**
- **CHANGELOG 1.8.0** says the export "streams rows, so it is safe for
  large merchants on the 512 MB container". It doesn't.
  `.cursorrules`/`AGENTS.md` telling tools not to stream are the cover.
- **The unused streamer was also broken.** A paginated version existed
  but nothing called it. It paged on `occurred_at > last`, which drops
  every row sharing the boundary timestamp: 5 of 1,005 rows were lost in
  the test.
- **References are caller-supplied text.** References come from API callers
  and payment links, but the only escaping was for commas and quotes. AM's
  test comment flags it: "no test for a reference starting with `=`".

**Spread / what it breaks.** One large export can take the API container
down for every merchant. A malicious or careless reference turns the
merchant's own export into a phishing link or data-exfiltration formula.

**Fix.**
- The route now sends the paginated generator as a stream (`Readable.from`),
  holding one page of 1,000 rows at a time.
- Pagination keys on `(occurred_at, id)`, so ties are neither skipped nor
  repeated.
- References starting with `= + - @`, tab or CR get a leading `'` so the
  spreadsheet shows them as text. CR now also triggers quoting.

**Tests.** New file `apps/api/src/transactions/exportCsvSafety.test.ts`:
- Five formula-shaped references come out quote-prefixed (both builders);
  ordinary ones are unchanged.
- 1,005 rows at the same timestamp: all 1,005 exported, no duplicates.
- `GET /v1/transactions/export` returns a streamed body (no
  `content-length`) with the formula neutralised.

Before the fix 3 of 4 failed (formula raw, 1,000 of 1,005 rows, buffered
body). After it, all pass, along with the existing export and transaction
route tests. Full suite (fresh database): no new failures.
